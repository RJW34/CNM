#!/usr/bin/env node
/**
 * CNM Agent - Remote Machine Connector
 *
 * Runs on remote machines to:
 * 1. Register with the CNM hub
 * 2. Serve direct P2P connections from clients
 * 3. Manage local Claude Code sessions
 */

import 'dotenv/config';
import { createServer } from 'https';
import { readFileSync, existsSync, readdirSync, unlinkSync, writeFileSync, mkdirSync } from 'fs';
import { WebSocket, WebSocketServer } from 'ws';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { homedir, hostname, networkInterfaces } from 'os';
import net from 'net';
import { spawn } from 'child_process';
import config from './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const registryDir = join(homedir(), '.claude-relay', 'sessions');

// Ensure registry directory exists
if (!existsSync(registryDir)) {
  mkdirSync(registryDir, { recursive: true });
}

// State
let hubSocket = null;
let hubReconnectTimer = null;
let heartbeatTimer = null;
let projectRefreshTimer = null;
let isShuttingDown = false;

// Active session connections (for P2P clients)
const clientSessions = new Map(); // clientWs -> { sessionId, pipeSocket }

// Track spawned launcher processes
const spawnedLaunchers = new Set();

// Get local IP address for registration
function getLocalIP() {
  const interfaces = networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

const LOCAL_IP = getLocalIP();
const AGENT_ADDRESS = `wss://${LOCAL_IP}:${config.AGENT_PORT}`;

console.log('');
console.log('  ========================================');
console.log('  CNM Agent - Celio\'s Network Machine');
console.log('  ========================================');
console.log(`  Machine:  ${config.MACHINE_ID}`);
console.log(`  IP:       ${LOCAL_IP}`);
console.log(`  Port:     ${config.AGENT_PORT}`);
console.log(`  Projects: ${config.PROJECTS_PATH}`);
console.log(`  Hub:      ${config.HUB_URL}`);
console.log('  ========================================');
console.log('');

// ============================================================================
// PROJECT & SESSION DISCOVERY
// ============================================================================

/**
 * Check if a directory is a Claude Code project (has .claude/ folder)
 */
function isClaudeProject(projectPath) {
  try {
    return existsSync(join(projectPath, '.claude'));
  } catch {
    return false;
  }
}

/**
 * List local projects in the configured directory
 */
function listLocalProjects() {
  try {
    if (!existsSync(config.PROJECTS_PATH)) {
      console.log(`[Projects] Path does not exist: ${config.PROJECTS_PATH}`);
      return [];
    }

    const entries = readdirSync(config.PROJECTS_PATH, { withFileTypes: true });
    const sessions = listLocalSessions();
    const sessionMap = new Map(sessions.map(s => [s.id, s]));

    const projects = entries
      .filter(entry => entry.isDirectory())
      .filter(entry => !entry.name.startsWith('.'))
      .map(entry => {
        const session = sessionMap.get(entry.name);
        const projectPath = join(config.PROJECTS_PATH, entry.name);
        const isClaude = isClaudeProject(projectPath);

        return {
          id: entry.name,
          cwd: projectPath,
          isActive: !!session,
          isClaudeProject: isClaude,
          pid: session?.pid || null,
          started: session?.started || null,
          lastSeen: session?.lastSeen || null,
          preview: session?.preview || '',
          clientCount: session?.clientCount || 0
        };
      })
      .sort((a, b) => {
        if (a.isActive && !b.isActive) return -1;
        if (!a.isActive && b.isActive) return 1;
        if (a.isClaudeProject && !b.isClaudeProject) return -1;
        if (!a.isClaudeProject && b.isClaudeProject) return 1;
        return a.id.localeCompare(b.id);
      });

    return projects;
  } catch (err) {
    console.error('[Projects] Error listing:', err.message);
    return [];
  }
}

/**
 * List local sessions from registry
 */
function listLocalSessions() {
  const SESSION_TIMEOUT_MS = 30000;
  try {
    if (!existsSync(registryDir)) return [];

    const now = Date.now();
    const sessions = [];

    for (const f of readdirSync(registryDir).filter(f => f.endsWith('.json'))) {
      try {
        const filePath = join(registryDir, f);
        const data = JSON.parse(readFileSync(filePath, 'utf8'));

        const lastSeen = data.lastSeen || data.started || 0;
        const age = now - lastSeen;

        if (age > SESSION_TIMEOUT_MS) {
          console.log(`[Sessions] Removing stale: ${data.id}`);
          try { unlinkSync(filePath); } catch {}
          continue;
        }

        sessions.push({
          id: data.id,
          cwd: data.cwd,
          pid: data.pid,
          started: data.started,
          lastSeen: data.lastSeen,
          pipe: data.pipe,
          preview: data.preview || '',
          clientCount: data.clientCount || 0,
          status: data.status || 'unknown'
        });
      } catch {
        // Skip invalid files
      }
    }

    return sessions;
  } catch {
    return [];
  }
}

/**
 * Get a session by ID
 */
function getSession(sessionId) {
  return listLocalSessions().find(s => s.id === sessionId);
}

// ============================================================================
// HUB CONNECTION
// ============================================================================

/**
 * Connect to the CNM hub
 */
function connectToHub() {
  if (isShuttingDown) return;
  if (hubSocket && hubSocket.readyState === WebSocket.OPEN) return;

  const url = `${config.HUB_URL}?agentToken=${config.AGENT_TOKEN}&machineId=${config.MACHINE_ID}`;

  console.log('[Hub] Connecting...');

  hubSocket = new WebSocket(url, {
    rejectUnauthorized: config.REJECT_UNAUTHORIZED
  });

  hubSocket.on('open', () => {
    console.log('[Hub] Connected');

    // Register with hub
    hubSocket.send(JSON.stringify({
      type: 'agent:register',
      machineId: config.MACHINE_ID,
      hostname: hostname(),
      address: AGENT_ADDRESS,
      agentVersion: '1.0.0'
    }));

    // Send initial data
    sendProjectsToHub();
    sendSessionsToHub();

    // Start heartbeat
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => {
      if (hubSocket && hubSocket.readyState === WebSocket.OPEN) {
        hubSocket.send(JSON.stringify({
          type: 'agent:heartbeat',
          machineId: config.MACHINE_ID,
          timestamp: Date.now()
        }));
      }
    }, config.HEARTBEAT_INTERVAL);

    // Start periodic project refresh
    if (projectRefreshTimer) clearInterval(projectRefreshTimer);
    projectRefreshTimer = setInterval(() => {
      sendProjectsToHub();
      sendSessionsToHub();
    }, config.PROJECT_REFRESH_INTERVAL);
  });

  hubSocket.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());

      switch (msg.type) {
        case 'hub:registered':
          if (msg.success) {
            console.log(`[Hub] Registered as ${msg.machineId}`);
          } else {
            console.error(`[Hub] Registration failed: ${msg.error}`);
          }
          break;

        case 'hub:pong':
          // Heartbeat acknowledged
          break;

        default:
          console.log(`[Hub] Unknown message: ${msg.type}`);
      }
    } catch (err) {
      console.error('[Hub] Message parse error:', err.message);
    }
  });

  hubSocket.on('close', (code, reason) => {
    console.log(`[Hub] Disconnected (${code}): ${reason || 'unknown'}`);
    cleanup();
    scheduleHubReconnect();
  });

  hubSocket.on('error', (err) => {
    console.error('[Hub] Error:', err.message);
  });
}

function sendProjectsToHub() {
  if (!hubSocket || hubSocket.readyState !== WebSocket.OPEN) return;

  const projects = listLocalProjects();
  hubSocket.send(JSON.stringify({
    type: 'agent:projects',
    machineId: config.MACHINE_ID,
    projects
  }));
}

function sendSessionsToHub() {
  if (!hubSocket || hubSocket.readyState !== WebSocket.OPEN) return;

  const sessions = listLocalSessions();
  hubSocket.send(JSON.stringify({
    type: 'agent:sessions',
    machineId: config.MACHINE_ID,
    sessions
  }));
}

function scheduleHubReconnect() {
  if (isShuttingDown) return;
  if (hubReconnectTimer) clearTimeout(hubReconnectTimer);
  hubReconnectTimer = setTimeout(connectToHub, config.RECONNECT_DELAY);
}

function cleanup() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  if (projectRefreshTimer) {
    clearInterval(projectRefreshTimer);
    projectRefreshTimer = null;
  }
}

// ============================================================================
// P2P CLIENT SERVER (Direct connections)
// ============================================================================

// Resolve certificate paths
const keyPath = join(__dirname, config.SSL_KEY);
const certPath = join(__dirname, config.SSL_CERT);

// Check for certificates
if (!existsSync(keyPath) || !existsSync(certPath)) {
  console.error('[Agent] SSL certificates not found!');
  console.error(`Expected key at: ${keyPath}`);
  console.error(`Expected cert at: ${certPath}`);
  console.error('\nGenerate certificates with:');
  console.error('  cd certs && openssl req -x509 -newkey rsa:4096 -keyout key.pem -out cert.pem -days 365 -nodes -subj "/CN=localhost"');
  process.exit(1);
}

const httpsOptions = {
  key: readFileSync(keyPath),
  cert: readFileSync(certPath)
};

// Create HTTPS server for P2P clients
const server = createServer(httpsOptions, (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end(`CNM Agent: ${config.MACHINE_ID}`);
});

// Create WebSocket server for P2P clients
const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `https://${req.headers.host}`);
  const token = url.searchParams.get('token');

  // Validate client token (same as hub's client token)
  // For now, we'll use the agent token - in production you might want a separate client token
  if (token !== config.AGENT_TOKEN) {
    console.log('[P2P] Invalid client token');
    ws.send(JSON.stringify({ type: 'error', message: 'Authentication failed' }));
    ws.close(4001, 'Unauthorized');
    return;
  }

  console.log('[P2P] Client connected');

  let activeSessionId = null;
  let pipeSocket = null;
  let pipeBuffer = '';

  // Send available projects/sessions
  ws.send(JSON.stringify({ type: 'projects', projects: listLocalProjects() }));

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());

      switch (msg.type) {
        case 'list_projects':
          ws.send(JSON.stringify({ type: 'projects', projects: listLocalProjects() }));
          break;

        case 'list_sessions':
          ws.send(JSON.stringify({ type: 'sessions', sessions: listLocalSessions() }));
          break;

        case 'connect_session':
          connectToLocalSession(msg.sessionId);
          break;

        case 'start_folder_session':
          startLocalSession(msg.folderName, msg.skipPermissions);
          break;

        case 'ping':
          ws.send(JSON.stringify({ type: 'pong' }));
          break;

        case 'input':
        case 'control':
        case 'resize':
          if (pipeSocket && !pipeSocket.destroyed) {
            pipeSocket.write(JSON.stringify(msg) + '\n');
          }
          break;

        default:
          console.log(`[P2P] Unknown message: ${msg.type}`);
      }
    } catch (err) {
      console.error('[P2P] Message error:', err.message);
    }
  });

  function connectToLocalSession(sessionId) {
    const session = getSession(sessionId);
    if (!session) {
      ws.send(JSON.stringify({ type: 'error', message: 'Session not found', sessionId }));
      ws.send(JSON.stringify({ type: 'status', state: 'disconnected', reason: 'Session not found', sessionId }));
      return;
    }

    // Close existing connection
    if (pipeSocket) {
      pipeSocket.destroy();
    }

    console.log(`[P2P] Connecting to session: ${sessionId}`);
    activeSessionId = sessionId;

    pipeSocket = net.connect(session.pipe);

    pipeSocket.on('connect', () => {
      console.log(`[P2P] Connected to pipe: ${sessionId}`);
      ws.send(JSON.stringify({ type: 'status', state: 'connected', sessionId }));

      // Send initial resize
      pipeSocket.write(JSON.stringify({ type: 'resize', cols: config.PTY_COLS, rows: config.PTY_ROWS }) + '\n');
    });

    pipeSocket.on('data', (data) => {
      pipeBuffer += data.toString();

      const lines = pipeBuffer.split('\n');
      pipeBuffer = lines.pop();

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.type === 'pong') continue;
          msg.sessionId = sessionId;
          ws.send(JSON.stringify(msg));
        } catch {
          ws.send(JSON.stringify({ type: 'output', data: line, sessionId }));
        }
      }
    });

    pipeSocket.on('error', (err) => {
      console.error(`[P2P] Pipe error: ${err.message}`);
      ws.send(JSON.stringify({ type: 'status', state: 'disconnected', reason: err.message, sessionId }));
    });

    pipeSocket.on('close', () => {
      console.log(`[P2P] Pipe closed: ${sessionId}`);
      ws.send(JSON.stringify({ type: 'status', state: 'disconnected', reason: 'Session ended', sessionId }));
      pipeSocket = null;
    });
  }

  function startLocalSession(folderName, skipPermissions) {
    const folderPath = join(config.PROJECTS_PATH, folderName);

    if (!existsSync(folderPath)) {
      ws.send(JSON.stringify({
        type: 'start_folder_session_result',
        success: false,
        folderName,
        error: 'Folder does not exist'
      }));
      return;
    }

    // Check if session already exists
    const existing = getSession(folderName);
    if (existing) {
      ws.send(JSON.stringify({
        type: 'start_folder_session_result',
        success: true,
        folderName,
        path: folderPath,
        alreadyRunning: true
      }));
      return;
    }

    // Use the server's launcher.js
    const launcherPath = join(__dirname, '..', 'server', 'launcher.js');
    const args = [launcherPath, folderName, folderPath];
    if (skipPermissions) {
      args.push('--skip-permissions');
    }

    try {
      const child = spawn('node', args, {
        detached: true,
        stdio: 'ignore',
        cwd: join(__dirname, '..', 'server'),
        windowsHide: true
      });
      child.unref();

      if (child.pid) {
        spawnedLaunchers.add(child.pid);
      }

      console.log(`[P2P] Started session: ${folderName}${skipPermissions ? ' [skip-permissions]' : ''}`);

      ws.send(JSON.stringify({
        type: 'start_folder_session_result',
        success: true,
        folderName,
        path: folderPath,
        skipPermissions: !!skipPermissions
      }));

      // Refresh hub data after delay
      setTimeout(() => {
        sendProjectsToHub();
        sendSessionsToHub();
      }, 2000);
    } catch (err) {
      console.error(`[P2P] Failed to start session: ${err.message}`);
      ws.send(JSON.stringify({
        type: 'start_folder_session_result',
        success: false,
        folderName,
        error: err.message
      }));
    }
  }

  ws.on('close', () => {
    console.log('[P2P] Client disconnected');
    if (pipeSocket) {
      pipeSocket.destroy();
    }
  });

  ws.on('error', (err) => {
    console.error('[P2P] WebSocket error:', err.message);
  });
});

// ============================================================================
// STARTUP & SHUTDOWN
// ============================================================================

// Start P2P server
server.listen(config.AGENT_PORT, config.AGENT_HOST, () => {
  console.log(`[Agent] P2P server listening on ${config.AGENT_HOST}:${config.AGENT_PORT}`);
  console.log(`[Agent] Direct connect URL: ${AGENT_ADDRESS}?token=${config.AGENT_TOKEN.substring(0, 8)}...`);
  console.log('');

  // Connect to hub after server is ready
  connectToHub();
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n[Agent] Shutting down...');
  isShuttingDown = true;

  // Cleanup timers
  cleanup();
  if (hubReconnectTimer) clearTimeout(hubReconnectTimer);

  // Close hub connection
  if (hubSocket) {
    hubSocket.close(1000, 'Agent shutting down');
  }

  // Close all client connections
  wss.clients.forEach(ws => ws.close());

  // Kill spawned launchers
  for (const pid of spawnedLaunchers) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {}
  }

  server.close(() => {
    console.log('[Agent] Stopped');
    process.exit(0);
  });

  setTimeout(() => process.exit(1), 5000);
});

process.on('SIGTERM', () => {
  process.emit('SIGINT');
});
