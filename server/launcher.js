#!/usr/bin/env node
// Session Launcher - Starts Claude Code in a managed PTY with named pipe access
// Usage: node launcher.js [session-name] [working-directory] [--skip-permissions]

import pty from 'node-pty';
import net from 'net';
import { writeFileSync, unlinkSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import config from './config.js';

// Session configuration
const sessionId = process.argv[2] || `claude-${Date.now()}`;
const workingDir = process.argv[3] || process.cwd();
const skipPermissions = process.argv[4] === '--skip-permissions';
const registryDir = join(homedir(), '.claude-relay', 'sessions');
const pipeName = `\\\\.\\pipe\\claude-relay-${sessionId}`;
const registryFile = join(registryDir, `${sessionId}.json`);

// Scrollback buffer
const scrollbackLines = [];
const MAX_SCROLLBACK = config.SCROLLBACK_LINES;
const MAX_SCROLLBACK_BYTES = 50 * 1024 * 1024; // 50MB byte limit
let scrollbackBytes = 0;

// Per-socket buffer protection (prevents DoS from unbounded buffer growth)
const MAX_SOCKET_BUFFER_SIZE = 64 * 1024; // 64KB max incomplete message

// Connected clients
const clients = new Set();

// Registry update interval (keep session alive in server's view)
const REGISTRY_UPDATE_INTERVAL = 5000; // Update every 5 seconds
let registryUpdateTimer = null;

// Ensure registry directory exists
mkdirSync(registryDir, { recursive: true });

console.log('═══════════════════════════════════════════════════════');
console.log(` Claude Code Session Launcher`);
console.log('═══════════════════════════════════════════════════════');
console.log(`  Session ID:  ${sessionId}`);
console.log(`  Working Dir: ${workingDir}`);
console.log(`  Pipe:        ${pipeName}`);
if (skipPermissions) {
  console.log(`  Mode:        --dangerously-skip-permissions`);
}
console.log('═══════════════════════════════════════════════════════');

// Build Claude args
const claudeArgs = [...config.CLAUDE_ARGS];
if (skipPermissions) {
  claudeArgs.push('--dangerously-skip-permissions');
}

// Spawn Claude in PTY
let ptyProcess;
try {
  ptyProcess = pty.spawn(config.CLAUDE_CMD, claudeArgs, {
    name: 'xterm-256color',
    cols: config.PTY_COLS,
    rows: config.PTY_ROWS,
    cwd: workingDir,
    env: process.env,
    useConpty: true
  });
  console.log(`[PTY] Spawned with PID: ${ptyProcess.pid}`);
} catch (err) {
  console.error(`[PTY] Failed to spawn: ${err.message}`);
  process.exit(1);
}

// Append to scrollback
function appendScrollback(data) {
  const lines = data.split('\n');
  for (const line of lines) {
    const lineBytes = Buffer.byteLength(line, 'utf8');

    // Enforce line count limit
    if (scrollbackLines.length >= MAX_SCROLLBACK) {
      const removed = scrollbackLines.shift();
      scrollbackBytes -= Buffer.byteLength(removed, 'utf8');
    }

    // Enforce byte limit - remove old lines until under limit
    while (scrollbackBytes + lineBytes > MAX_SCROLLBACK_BYTES && scrollbackLines.length > 0) {
      const removed = scrollbackLines.shift();
      scrollbackBytes -= Buffer.byteLength(removed, 'utf8');
    }

    scrollbackLines.push(line);
    scrollbackBytes += lineBytes;
  }
}

// Get full scrollback
function getScrollback() {
  return scrollbackLines.join('\n');
}

// Broadcast to all clients
function broadcast(data) {
  const message = JSON.stringify({ type: 'output', data });
  for (const client of clients) {
    try {
      client.write(message + '\n');
    } catch (err) {
      // Client disconnected
    }
  }
}

// Handle PTY output
ptyProcess.onData((data) => {
  appendScrollback(data);
  broadcast(data);
});

// Handle PTY exit
ptyProcess.onExit(({ exitCode, signal }) => {
  console.log(`[PTY] Exited with code ${exitCode}, signal ${signal}`);

  // Notify clients
  const message = JSON.stringify({ type: 'status', state: 'disconnected', reason: `Process exited (${exitCode})` });
  for (const client of clients) {
    try {
      client.write(message + '\n');
      client.end();
    } catch (err) {}
  }

  cleanup();
  process.exit(exitCode || 0);
});

// Create named pipe server
const server = net.createServer((socket) => {
  console.log(`[Pipe] Client connected (total: ${clients.size + 1})`);
  clients.add(socket);

  // Send scrollback on connect
  const scrollback = getScrollback();
  if (scrollback) {
    socket.write(JSON.stringify({ type: 'scrollback', data: scrollback }) + '\n');
  }
  socket.write(JSON.stringify({ type: 'status', state: 'connected' }) + '\n');

  // Buffer for incomplete messages
  let buffer = '';

  // Handle incoming data
  socket.on('data', (data) => {
    buffer += data.toString();

    // Prevent unbounded buffer growth (DoS protection)
    if (buffer.length > MAX_SOCKET_BUFFER_SIZE) {
      console.error(`[Pipe] Buffer overflow for client, resetting buffer`);
      buffer = '';
      return;
    }

    // Process complete JSON messages (newline-delimited)
    const lines = buffer.split('\n');
    buffer = lines.pop(); // Keep incomplete line in buffer

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        handleMessage(msg, socket);
      } catch (err) {
        console.error(`[Pipe] Parse error: ${err.message}`);
      }
    }
  });

  socket.on('close', () => {
    clients.delete(socket);
    console.log(`[Pipe] Client disconnected (remaining: ${clients.size})`);
  });

  socket.on('error', (err) => {
    clients.delete(socket);
    console.error(`[Pipe] Socket error: ${err.message}`);
  });
});

// Handle messages from relay
function handleMessage(msg, socket) {
  switch (msg.type) {
    case 'input':
      if (typeof msg.data === 'string') {
        ptyProcess.write(msg.data);
      }
      break;

    case 'control':
      const controlKeys = {
        'CTRL_C': '\x03',
        'CTRL_D': '\x04',
        'ESC': '\x1b'
      };
      if (controlKeys[msg.key]) {
        ptyProcess.write(controlKeys[msg.key]);
      }
      break;

    case 'resize':
      if (typeof msg.cols === 'number' && typeof msg.rows === 'number') {
        ptyProcess.resize(msg.cols, msg.rows);
        console.log(`[PTY] Resized to ${msg.cols}x${msg.rows}`);
      }
      break;

    case 'ping':
      // Respond to keepalive pings from relay server
      try {
        socket.write(JSON.stringify({ type: 'pong' }) + '\n');
      } catch (err) {
        // Socket may be closing
      }
      break;

    default:
      console.log(`[Pipe] Unknown message type: ${msg.type}`);
  }
}

// Update registry with current state (keeps session alive in server's view)
function updateRegistry() {
  try {
    // Get preview from last few lines of scrollback
    const previewLines = scrollbackLines.slice(-8);
    const preview = previewLines.join('\n').slice(-500); // Limit preview size

    const sessionInfo = {
      id: sessionId,
      pipe: pipeName,
      cwd: workingDir,
      pid: ptyProcess.pid,
      started: startTime,
      lastSeen: Date.now(),
      clientCount: clients.size,
      preview: preview,
      status: clients.size > 0 ? 'connected' : 'idle'
    };

    writeFileSync(registryFile, JSON.stringify(sessionInfo, null, 2));
  } catch (err) {
    // Ignore write errors - server will detect stale session eventually
  }
}

// Session start time
const startTime = Date.now();

// Start listening on named pipe
server.listen(pipeName, () => {
  console.log(`[Pipe] Listening on ${pipeName}`);

  // Register session initially
  updateRegistry();
  console.log(`[Registry] Session registered`);

  // Start periodic registry updates to keep session alive
  registryUpdateTimer = setInterval(updateRegistry, REGISTRY_UPDATE_INTERVAL);
});

server.on('error', (err) => {
  console.error(`[Pipe] Server error: ${err.message}`);
  cleanup();
  process.exit(1);
});

// Cleanup function
function cleanup() {
  console.log('[Cleanup] Removing session from registry...');

  // Stop registry updates
  if (registryUpdateTimer) {
    clearInterval(registryUpdateTimer);
    registryUpdateTimer = null;
  }

  try {
    if (existsSync(registryFile)) {
      unlinkSync(registryFile);
    }
  } catch (err) {
    console.error(`[Cleanup] Error: ${err.message}`);
  }
  server.close();
}

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n[Shutdown] Received SIGINT...');
  ptyProcess.kill();
  cleanup();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n[Shutdown] Received SIGTERM...');
  ptyProcess.kill();
  cleanup();
  process.exit(0);
});

// Keep process alive
process.stdin.resume();
