import 'dotenv/config';
import { createServer } from 'https';
import { readFileSync, existsSync, readdirSync, unlinkSync, writeFileSync, mkdirSync } from 'fs';
import { WebSocketServer } from 'ws';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { homedir, hostname } from 'os';
import net from 'net';
import { spawn, execSync } from 'child_process';
import config from './config.js';
import { MachineRegistry } from './machineRegistry.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const registryDir = join(homedir(), '.claude-relay', 'sessions');

// Resolve certificate paths
const keyPath = join(__dirname, config.SSL_KEY);
const certPath = join(__dirname, config.SSL_CERT);

// Check for certificates
if (!existsSync(keyPath) || !existsSync(certPath)) {
  console.error('SSL certificates not found!');
  console.error(`Expected key at: ${keyPath}`);
  console.error(`Expected cert at: ${certPath}`);
  console.error('\nGenerate certificates with:');
  console.error('  cd certs && openssl req -x509 -newkey rsa:4096 -keyout key.pem -out cert.pem -days 365 -nodes -subj "/CN=localhost"');
  process.exit(1);
}

// Load SSL certificates
const httpsOptions = {
  key: readFileSync(keyPath),
  cert: readFileSync(certPath)
};

// Health check constants
const SESSION_TIMEOUT_MS = 30000; // Consider session dead if no update in 30 seconds

// Auth session cleanup constants (prevents memory leak from growing activeSessions Map)
const AUTH_SESSION_CLEANUP_INTERVAL = 60 * 60 * 1000; // 1 hour
const AUTH_SESSION_MAX_IDLE = 24 * 60 * 60 * 1000; // 24 hours

// Pipe buffer protection (prevents DoS from unbounded buffer growth)
const MAX_PIPE_BUFFER_SIZE = 1024 * 1024; // 1MB

// Track spawned launcher processes for cleanup on shutdown
const spawnedLaunchers = new Set();

// Periodic cleanup of dead launcher PIDs (prevents memory leak from growing Set)
const LAUNCHER_CLEANUP_INTERVAL = 5 * 60 * 1000; // 5 minutes
setInterval(() => {
  if (spawnedLaunchers.size === 0) return;

  let cleaned = 0;
  for (const pid of spawnedLaunchers) {
    try {
      // process.kill(pid, 0) throws if process doesn't exist
      process.kill(pid, 0);
    } catch (err) {
      // Process no longer exists, remove from tracking
      spawnedLaunchers.delete(pid);
      cleaned++;
    }
  }
  if (cleaned > 0) {
    console.log(`[Launchers] Cleaned ${cleaned} dead PIDs, ${spawnedLaunchers.size} active`);
  }
}, LAUNCHER_CLEANUP_INTERVAL);

// Machine registry for multi-machine support
const machineRegistry = new MachineRegistry();
const LOCAL_MACHINE_ID = machineRegistry.LOCAL_MACHINE_ID;

// List available sessions from registry (with health filtering)
function listSessions(includePreview = true) {
  try {
    if (!existsSync(registryDir)) return [];

    const now = Date.now();
    const sessions = [];

    for (const f of readdirSync(registryDir).filter(f => f.endsWith('.json'))) {
      try {
        const filePath = join(registryDir, f);
        const data = JSON.parse(readFileSync(filePath));

        // Health check: skip sessions that haven't updated recently
        const lastSeen = data.lastSeen || data.started || 0;
        const age = now - lastSeen;

        if (age > SESSION_TIMEOUT_MS) {
          // Session is stale - clean it up
          console.log(`[Registry] Removing stale session: ${data.id} (last seen ${Math.round(age / 1000)}s ago)`);
          try {
            unlinkSync(filePath);
          } catch {}
          continue;
        }

        sessions.push({
          id: data.id,
          cwd: data.cwd,
          pid: data.pid,
          started: data.started,
          lastSeen: data.lastSeen,
          pipe: data.pipe,
          preview: includePreview ? (data.preview || '') : undefined,
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

// Get session by ID
function getSession(sessionId) {
  const sessions = listSessions();
  return sessions.find(s => s.id === sessionId);
}

// Sanitize filename to prevent path traversal attacks
function sanitizeFilename(filename) {
  if (!filename || typeof filename !== 'string') return null;

  // Extract basename only (strip any path components)
  let name = filename.split(/[/\\]/).pop();

  // Remove reserved characters (Windows + Unix)
  name = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');

  // Remove leading/trailing dots and spaces
  name = name.replace(/^[\s.]+|[\s.]+$/g, '');

  // Prevent empty or dot-only names
  if (!name || name === '.' || name === '..') {
    return null;
  }

  // Truncate to 255 chars while preserving extension
  if (name.length > 255) {
    const lastDot = name.lastIndexOf('.');
    const ext = lastDot > 0 ? name.slice(lastDot) : '';
    name = name.slice(0, 255 - ext.length) + ext;
  }

  return name;
}

// Handle file upload from client
function handleFileUpload(ws, msg, activeSessionId) {
  const { sessionId, filename, data } = msg;
  const targetSessionId = sessionId || activeSessionId;

  // Check if uploads are enabled
  if (!config.UPLOAD_ENABLED) {
    ws.send(JSON.stringify({
      type: 'upload_result',
      sessionId: targetSessionId,
      success: false,
      filename,
      error: 'File uploads are disabled'
    }));
    return;
  }

  // Validate session exists and get cwd
  const session = getSession(targetSessionId);
  if (!session) {
    ws.send(JSON.stringify({
      type: 'upload_result',
      sessionId: targetSessionId,
      success: false,
      filename,
      error: 'Session not found'
    }));
    return;
  }

  // Sanitize filename
  const safeName = sanitizeFilename(filename);
  if (!safeName) {
    ws.send(JSON.stringify({
      type: 'upload_result',
      sessionId: targetSessionId,
      success: false,
      filename,
      error: 'Invalid filename'
    }));
    return;
  }

  // Decode base64 and validate size
  let buffer;
  try {
    buffer = Buffer.from(data, 'base64');
  } catch (err) {
    ws.send(JSON.stringify({
      type: 'upload_result',
      sessionId: targetSessionId,
      success: false,
      filename: safeName,
      error: 'Invalid file data'
    }));
    return;
  }

  if (buffer.length > config.MAX_UPLOAD_SIZE) {
    const maxMB = Math.round(config.MAX_UPLOAD_SIZE / 1024 / 1024);
    ws.send(JSON.stringify({
      type: 'upload_result',
      sessionId: targetSessionId,
      success: false,
      filename: safeName,
      error: `File exceeds maximum size of ${maxMB}MB`
    }));
    return;
  }

  // Construct destination path
  const destPath = join(session.cwd, safeName);

  // Security: verify destination is within session cwd
  const resolvedDest = join(session.cwd, safeName);
  if (!resolvedDest.startsWith(session.cwd)) {
    ws.send(JSON.stringify({
      type: 'upload_result',
      sessionId: targetSessionId,
      success: false,
      filename: safeName,
      error: 'Invalid destination path'
    }));
    return;
  }

  // Write file
  try {
    writeFileSync(destPath, buffer);
    console.log(`[Upload] Saved ${safeName} (${buffer.length} bytes) to ${session.cwd}`);

    ws.send(JSON.stringify({
      type: 'upload_result',
      sessionId: targetSessionId,
      success: true,
      filename: safeName,
      path: destPath,
      size: buffer.length
    }));
  } catch (err) {
    console.error(`[Upload] Failed to save ${safeName}:`, err.message);
    ws.send(JSON.stringify({
      type: 'upload_result',
      sessionId: targetSessionId,
      success: false,
      filename: safeName,
      error: 'Failed to save file: ' + err.message
    }));
  }
}

// Base directory for new projects
const PROJECTS_BASE_DIR = join(homedir(), 'Documents', 'Code');

// List folders in Documents\Code (legacy, kept for compatibility)
function listCodeFolders() {
  try {
    if (!existsSync(PROJECTS_BASE_DIR)) {
      return [];
    }

    const entries = readdirSync(PROJECTS_BASE_DIR, { withFileTypes: true });
    const activeSessions = listSessions();
    const activeSessionIds = new Set(activeSessions.map(s => s.id));

    const folders = entries
      .filter(entry => entry.isDirectory())
      .filter(entry => !entry.name.startsWith('.')) // Skip hidden folders
      .map(entry => ({
        name: entry.name,
        path: join(PROJECTS_BASE_DIR, entry.name),
        hasSession: activeSessionIds.has(entry.name)
      }))
      .sort((a, b) => {
        // Sessions with active links first
        if (a.hasSession && !b.hasSession) return -1;
        if (!a.hasSession && b.hasSession) return 1;
        return a.name.localeCompare(b.name);
      });

    return folders;
  } catch (err) {
    console.error('[Folders] Error listing folders:', err.message);
    return [];
  }
}

// Check if a directory is a Claude Code project (has .claude/ folder)
function isClaudeProject(projectPath) {
  try {
    const claudeDir = join(projectPath, '.claude');
    return existsSync(claudeDir);
  } catch {
    return false;
  }
}

// List all projects (unified view: folders merged with session data)
// Detects Claude Code projects (those with .claude/ directory)
function listProjects() {
  try {
    if (!existsSync(PROJECTS_BASE_DIR)) {
      return [];
    }

    const entries = readdirSync(PROJECTS_BASE_DIR, { withFileTypes: true });
    const activeSessions = listSessions(true); // Include preview
    const sessionMap = new Map(activeSessions.map(s => [s.id, s]));

    const projects = entries
      .filter(entry => entry.isDirectory())
      .filter(entry => !entry.name.startsWith('.')) // Skip hidden folders
      .map(entry => {
        const session = sessionMap.get(entry.name);
        const projectPath = join(PROJECTS_BASE_DIR, entry.name);
        const isClaude = isClaudeProject(projectPath);

        return {
          id: entry.name,
          cwd: session?.cwd || projectPath,
          isActive: !!session,
          isClaudeProject: isClaude, // Flag for Claude Code projects
          // Include session data if active
          pid: session?.pid || null,
          started: session?.started || null,
          lastSeen: session?.lastSeen || null,
          preview: session?.preview || '',
          clientCount: session?.clientCount || 0
        };
      })
      .sort((a, b) => {
        // Active projects first
        if (a.isActive && !b.isActive) return -1;
        if (!a.isActive && b.isActive) return 1;
        // Then Claude projects before regular folders
        if (a.isClaudeProject && !b.isClaudeProject) return -1;
        if (!a.isClaudeProject && b.isClaudeProject) return 1;
        // Then by name
        return a.id.localeCompare(b.id);
      });

    // Log discovery stats periodically (not every call to avoid spam)
    const claudeCount = projects.filter(p => p.isClaudeProject).length;
    const activeCount = projects.filter(p => p.isActive).length;
    if (claudeCount > 0 || activeCount > 0) {
      console.log(`[Projects] Found ${projects.length} total, ${claudeCount} Claude projects, ${activeCount} active`);
    }

    return projects;
  } catch (err) {
    console.error('[Projects] Error listing projects:', err.message);
    return [];
  }
}

// Handle start folder session request
function handleStartFolderSession(ws, msg) {
  const { folderName, skipPermissions } = msg;

  // Validate folder name
  const safeName = sanitizeProjectName(folderName);
  if (!safeName) {
    ws.send(JSON.stringify({
      type: 'start_folder_session_result',
      success: false,
      folderName,
      error: 'Invalid folder name'
    }));
    return;
  }

  // Check if folder exists
  const folderPath = join(PROJECTS_BASE_DIR, safeName);
  if (!existsSync(folderPath)) {
    ws.send(JSON.stringify({
      type: 'start_folder_session_result',
      success: false,
      folderName: safeName,
      error: 'Folder does not exist'
    }));
    return;
  }

  // Check if session already exists
  const existingSessions = listSessions();
  const existing = existingSessions.find(s => s.id === safeName);
  if (existing) {
    ws.send(JSON.stringify({
      type: 'start_folder_session_result',
      success: true,
      folderName: safeName,
      path: folderPath,
      alreadyRunning: true
    }));
    return;
  }

  // Spawn launcher.js with the session name, directory, and optional skip-permissions
  const launcherPath = join(__dirname, 'launcher.js');
  const launcherArgs = [launcherPath, safeName, folderPath];
  if (skipPermissions) {
    launcherArgs.push('--skip-permissions');
  }

  try {
    // Spawn detached so it survives if relay restarts
    // Use windowsHide to prevent console window from appearing
    const child = spawn('node', launcherArgs, {
      detached: true,
      stdio: 'ignore',
      cwd: __dirname,
      windowsHide: true
    });

    // Unref so parent doesn't wait for child
    child.unref();

    // Track the PID for cleanup on shutdown
    if (child.pid) {
      spawnedLaunchers.add(child.pid);
      console.log(`[Session] Spawned launcher for ${safeName} (PID: ${child.pid}, tracking ${spawnedLaunchers.size} launchers)${skipPermissions ? ' [skip-permissions]' : ''}`);
    } else {
      console.log(`[Session] Spawned launcher for ${safeName}${skipPermissions ? ' [skip-permissions]' : ''}`);
    }

    ws.send(JSON.stringify({
      type: 'start_folder_session_result',
      success: true,
      folderName: safeName,
      path: folderPath,
      skipPermissions: !!skipPermissions
    }));
  } catch (err) {
    console.error(`[Session] Failed to spawn launcher: ${err.message}`);
    ws.send(JSON.stringify({
      type: 'start_folder_session_result',
      success: false,
      folderName: safeName,
      error: 'Failed to start Claude session: ' + err.message
    }));
  }
}

// Sanitize project name to prevent path traversal and invalid characters
function sanitizeProjectName(name) {
  if (!name || typeof name !== 'string') return null;

  // Only allow alphanumeric, hyphens, underscores
  let sanitized = name.replace(/[^a-zA-Z0-9_-]/g, '');

  // Must not be empty and have reasonable length
  if (!sanitized || sanitized.length > 50) return null;

  // Prevent reserved names
  const reserved = ['con', 'prn', 'aux', 'nul', 'com1', 'lpt1'];
  if (reserved.includes(sanitized.toLowerCase())) return null;

  return sanitized;
}

// Handle create session request
function handleCreateSession(ws, msg) {
  const { projectName } = msg;

  // Validate project name
  const safeName = sanitizeProjectName(projectName);
  if (!safeName) {
    ws.send(JSON.stringify({
      type: 'create_session_result',
      success: false,
      projectName,
      error: 'Invalid project name (use only letters, numbers, hyphens, underscores)'
    }));
    return;
  }

  // Create project directory path
  const projectDir = join(PROJECTS_BASE_DIR, safeName);

  // Check if directory already exists
  if (existsSync(projectDir)) {
    // Directory exists - still spawn Claude there, but warn user
    console.log(`[Session] Directory already exists: ${projectDir}`);
  } else {
    // Create the directory
    try {
      mkdirSync(projectDir, { recursive: true });
      console.log(`[Session] Created directory: ${projectDir}`);
    } catch (err) {
      console.error(`[Session] Failed to create directory: ${err.message}`);
      ws.send(JSON.stringify({
        type: 'create_session_result',
        success: false,
        projectName: safeName,
        error: 'Failed to create project directory: ' + err.message
      }));
      return;
    }
  }

  // Spawn launcher.js with the session name and directory
  const launcherPath = join(__dirname, 'launcher.js');

  try {
    // Spawn detached so it survives if relay restarts
    // Use windowsHide to prevent console window from appearing
    const child = spawn('node', [launcherPath, safeName, projectDir], {
      detached: true,
      stdio: 'ignore',
      cwd: __dirname,
      windowsHide: true
    });

    // Unref so parent doesn't wait for child
    child.unref();

    // Track the PID for cleanup on shutdown
    if (child.pid) {
      spawnedLaunchers.add(child.pid);
      console.log(`[Session] Spawned launcher for ${safeName} (PID: ${child.pid}, tracking ${spawnedLaunchers.size} launchers)`);
    } else {
      console.log(`[Session] Spawned launcher for ${safeName}`);
    }

    ws.send(JSON.stringify({
      type: 'create_session_result',
      success: true,
      projectName: safeName,
      path: projectDir
    }));
  } catch (err) {
    console.error(`[Session] Failed to spawn launcher: ${err.message}`);
    ws.send(JSON.stringify({
      type: 'create_session_result',
      success: false,
      projectName: safeName,
      error: 'Failed to start Claude session: ' + err.message
    }));
  }
}

// Generate a session ID for cookie-based auth
import crypto from 'crypto';
const SESSION_COOKIE_NAME = 'relay_session';
const SESSION_MAX_AGE = 24 * 60 * 60; // 24 hours in seconds
const activeSessions = new Map(); // sessionToken -> { created, lastSeen }

// Periodic cleanup of expired auth sessions (prevents memory leak)
setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  for (const [token, session] of activeSessions.entries()) {
    if (now - session.lastSeen > AUTH_SESSION_MAX_IDLE) {
      activeSessions.delete(token);
      cleaned++;
    }
  }
  if (cleaned > 0) {
    console.log(`[Auth] Cleaned ${cleaned} expired sessions, ${activeSessions.size} active`);
  }
}, AUTH_SESSION_CLEANUP_INTERVAL);

// Parse cookies from request
function parseCookies(req) {
  const cookies = {};
  const cookieHeader = req.headers.cookie || '';
  cookieHeader.split(';').forEach(cookie => {
    const [name, ...rest] = cookie.trim().split('=');
    if (name) cookies[name] = rest.join('=');
  });
  return cookies;
}

// Validate token (from URL or cookie)
function validateAuth(req) {
  const url = new URL(req.url, `https://${req.headers.host}`);
  const urlToken = url.searchParams.get('token');
  const cookies = parseCookies(req);
  const sessionToken = cookies[SESSION_COOKIE_NAME];

  // Check session cookie first
  if (sessionToken && activeSessions.has(sessionToken)) {
    const session = activeSessions.get(sessionToken);
    session.lastSeen = Date.now();
    return { valid: true, isNewSession: false, sessionToken };
  }

  // Check URL token
  if (urlToken === config.AUTH_TOKEN) {
    // Create new session
    const newSessionToken = crypto.randomBytes(32).toString('hex');
    activeSessions.set(newSessionToken, { created: Date.now(), lastSeen: Date.now() });
    return { valid: true, isNewSession: true, sessionToken: newSessionToken };
  }

  return { valid: false };
}

// GitHub webhook secret (optional, for signature verification)
const WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET || null;

// Verify GitHub webhook signature
function verifyGitHubSignature(payload, signature) {
  if (!WEBHOOK_SECRET) return true; // Skip if no secret configured
  if (!signature) return false;

  const hmac = crypto.createHmac('sha256', WEBHOOK_SECRET);
  const digest = 'sha256=' + hmac.update(payload).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(signature));
}

// Handle GitHub webhook
function handleGitHubWebhook(req, res) {
  let body = '';

  req.on('data', chunk => {
    body += chunk.toString();
  });

  req.on('end', () => {
    // Verify signature if secret is configured
    const signature = req.headers['x-hub-signature-256'];
    if (WEBHOOK_SECRET && !verifyGitHubSignature(body, signature)) {
      console.log('[Webhook] Invalid signature');
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid signature' }));
      return;
    }

    // Parse payload to check event type
    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }

    const event = req.headers['x-github-event'];
    console.log(`[Webhook] Received ${event} event`);

    // Only pull on push events
    if (event !== 'push') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: `Ignored ${event} event` }));
      return;
    }

    // Execute git pull
    const repoDir = join(__dirname, '..');
    try {
      const output = execSync('git pull origin master', {
        cwd: repoDir,
        encoding: 'utf8',
        timeout: 30000
      });
      console.log('[Webhook] Git pull successful:', output.trim());
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        message: 'Updated successfully',
        output: output.trim()
      }));
    } catch (err) {
      console.error('[Webhook] Git pull failed:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: false,
        error: 'Git pull failed',
        message: err.message
      }));
    }
  });
}

// Create HTTPS server (serves static files for the client)
const server = createServer(httpsOptions, (req, res) => {
  const clientDir = join(__dirname, '..', 'client', 'web');

  // Parse URL to strip query string
  const url = new URL(req.url, `https://${req.headers.host}`);
  let pathname = url.pathname;

  // Handle /cnm prefix for Cloudflare routing via walterfam.xyz/cnm
  if (pathname === '/cnm') {
    // Redirect /cnm to /cnm/ so relative paths work correctly
    const redirectUrl = url.pathname + '/' + url.search;
    res.writeHead(301, { 'Location': redirectUrl });
    res.end();
    return;
  }
  if (pathname.startsWith('/cnm/')) {
    pathname = pathname.substring(4) || '/';
  }

  // GitHub webhook endpoint (no auth required - uses GitHub signature)
  if (pathname === '/webhook/github' && req.method === 'POST') {
    handleGitHubWebhook(req, res);
    return;
  }

  // For static files, check auth first
  const auth = validateAuth(req);

  // Allow unauthenticated access to static assets (CSS, JS) but not HTML
  const isStaticAsset = pathname.match(/\.(css|js|png|ico|svg|woff|woff2)$/);

  if (!auth.valid && !isStaticAsset) {
    res.writeHead(401, { 'Content-Type': 'text/plain' });
    res.end('Unauthorized - token required');
    return;
  }

  let filePath;
  if (pathname === '/' || pathname === '/index.html') {
    filePath = join(clientDir, 'index.html');
  } else {
    filePath = join(clientDir, pathname);
  }

  // Security: prevent directory traversal
  if (!filePath.startsWith(clientDir)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  if (existsSync(filePath)) {
    const ext = filePath.split('.').pop();
    const contentTypes = {
      'html': 'text/html',
      'css': 'text/css',
      'js': 'application/javascript',
      'json': 'application/json',
      'png': 'image/png',
      'ico': 'image/x-icon'
    };

    const headers = { 'Content-Type': contentTypes[ext] || 'text/plain' };

    // Set session cookie for new sessions
    if (auth.isNewSession && auth.sessionToken) {
      headers['Set-Cookie'] = `${SESSION_COOKIE_NAME}=${auth.sessionToken}; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_MAX_AGE}; Path=/`;
    }

    res.writeHead(200, headers);
    res.end(readFileSync(filePath));
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
});

// Create WebSocket server for clients
const wss = new WebSocketServer({ noServer: true });

// Create WebSocket server for agents
const wssAgent = new WebSocketServer({ noServer: true });

// Handle HTTP upgrade - route to client or agent WebSocket server
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `https://${req.headers.host}`);
  let pathname = url.pathname;

  // Handle /cnm prefix for Cloudflare routing
  if (pathname.startsWith('/cnm/')) {
    pathname = pathname.substring(4);
  }

  if (pathname === '/agent' || pathname === '/agent/') {
    // Agent connection - verify agent token
    const agentToken = url.searchParams.get('agentToken');
    if (agentToken !== config.AGENT_TOKEN) {
      console.log('[Agent] Invalid agent token');
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wssAgent.handleUpgrade(req, socket, head, (ws) => {
      wssAgent.emit('connection', ws, req);
    });
  } else {
    // Client connection
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  }
});

// Handle agent connections
wssAgent.on('connection', (ws, req) => {
  const url = new URL(req.url, `https://${req.headers.host}`);
  const machineId = url.searchParams.get('machineId') || 'unknown';
  console.log(`[Agent] New connection from ${machineId}`);

  let registeredMachineId = null;

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());

      switch (msg.type) {
        case 'agent:register':
          const result = machineRegistry.registerAgent(msg, ws);
          if (result.success) {
            registeredMachineId = msg.machineId;
            ws.send(JSON.stringify({ type: 'hub:registered', success: true, machineId: msg.machineId }));
          } else {
            ws.send(JSON.stringify({ type: 'hub:registered', success: false, error: result.error }));
          }
          break;

        case 'agent:projects':
          machineRegistry.updateProjects(msg.machineId, msg.projects);
          break;

        case 'agent:sessions':
          machineRegistry.updateSessions(msg.machineId, msg.sessions);
          break;

        case 'agent:heartbeat':
          machineRegistry.updateHeartbeat(msg.machineId);
          ws.send(JSON.stringify({ type: 'hub:pong' }));
          break;

        default:
          console.log(`[Agent] Unknown message type: ${msg.type}`);
      }
    } catch (err) {
      console.error('[Agent] Message parse error:', err.message);
    }
  });

  ws.on('close', () => {
    if (registeredMachineId) {
      machineRegistry.unregisterAgent(registeredMachineId);
    }
    console.log(`[Agent] Connection closed: ${registeredMachineId || 'unregistered'}`);
  });

  ws.on('error', (err) => {
    console.error(`[Agent] WebSocket error: ${err.message}`);
  });
});

// Handle client WebSocket connections
wss.on('connection', (ws, req) => {
  console.log('[WS] New connection attempt');

  // Validate auth (cookie or URL token)
  const auth = validateAuth(req);

  if (!auth.valid) {
    console.log('[WS] Authentication failed');
    ws.send(JSON.stringify({ type: 'error', message: 'Authentication failed' }));
    ws.close(4001, 'Unauthorized');
    return;
  }

  console.log(`[WS] Authentication successful (${auth.isNewSession ? 'new session' : 'existing session'})`);

  // Track multiple pipe connections (for tabs)
  // Map of sessionId -> { pipe, buffer }
  const pipeSockets = new Map();
  let activeSessionId = null;

  // Rate limiting state (prevents flooding with requests)
  let messageCount = 0;
  let lastRateReset = Date.now();
  const MAX_MESSAGES_PER_SECOND = 10;

  // WebSocket heartbeat to detect stale connections
  let isAlive = true;
  ws.on('pong', () => { isAlive = true; });

  const wsPingInterval = setInterval(() => {
    if (!isAlive) {
      console.log('[WS] Client heartbeat timeout, terminating');
      clearInterval(wsPingInterval);
      return ws.terminate();
    }
    isAlive = false;
    ws.ping();
  }, 30000); // Ping every 30 seconds

  // Send available sessions
  const sessions = listSessions();
  ws.send(JSON.stringify({ type: 'sessions', sessions }));
  console.log(`[WS] Sent ${sessions.length} available sessions`);

  // Handle messages from client
  ws.on('message', (message) => {
    // Rate limiting check
    const now = Date.now();
    if (now - lastRateReset >= 1000) {
      messageCount = 0;
      lastRateReset = now;
    }

    messageCount++;
    if (messageCount > MAX_MESSAGES_PER_SECOND) {
      console.warn(`[WS] Rate limit exceeded for client`);
      ws.send(JSON.stringify({ type: 'error', message: 'Rate limit exceeded' }));
      return; // Drop the message, don't close connection
    }

    try {
      const msg = JSON.parse(message.toString());

      switch (msg.type) {
        case 'list_sessions':
          const currentSessions = listSessions();
          ws.send(JSON.stringify({ type: 'sessions', sessions: currentSessions }));
          break;

        case 'list_machines':
          // List all connected machines (hub + agents)
          // Update local machine data first
          machineRegistry.updateLocalMachine(listProjects(), listSessions());
          const machines = machineRegistry.listMachines();
          ws.send(JSON.stringify({ type: 'machines', machines }));
          console.log(`[WS] Sent ${machines.length} machines`);
          break;

        case 'connect_session':
          connectToSession(msg.sessionId);
          break;

        case 'ping':
          // Keep-alive ping from client, respond with pong
          ws.send(JSON.stringify({ type: 'pong' }));
          break;

        case 'input':
        case 'control':
        case 'resize':
          // Forward to active session's pipe with error handling
          if (activeSessionId) {
            const conn = pipeSockets.get(activeSessionId);
            if (conn && conn.connected) {
              writeToPipe(conn, msg);
            }
          }
          break;

        case 'upload_file':
          // Handle file upload to session's working directory
          handleFileUpload(ws, msg, activeSessionId);
          break;

        case 'create_session':
          // Create new project folder and spawn Claude session
          handleCreateSession(ws, msg);
          break;

        case 'list_projects':
          // List all projects (folders + active session data)
          const projects = listProjects();
          ws.send(JSON.stringify({ type: 'projects', projects }));
          break;

        case 'list_folders':
          // List folders in Documents\Code (legacy)
          const folders = listCodeFolders();
          ws.send(JSON.stringify({ type: 'folders', folders }));
          break;

        case 'start_folder_session':
          // Start Claude session in existing folder
          handleStartFolderSession(ws, msg);
          break;

        default:
          console.log(`[WS] Unknown message type: ${msg.type}`);
      }
    } catch (err) {
      console.error('[WS] Error parsing message:', err.message);
    }
  });

  // Connect to a session's named pipe
  function connectToSession(sessionId) {
    // If already connected to this session, just make it active
    if (pipeSockets.has(sessionId)) {
      activeSessionId = sessionId;
      console.log(`[WS] Switched to existing session: ${sessionId}`);
      // Resend status for the session
      const conn = pipeSockets.get(sessionId);
      if (conn && conn.connected) {
        ws.send(JSON.stringify({ type: 'status', state: 'connected', sessionId }));
      }
      return;
    }

    const session = getSession(sessionId);
    if (!session) {
      ws.send(JSON.stringify({ type: 'error', message: `Session "${sessionId}" not found`, sessionId }));
      return;
    }

    console.log(`[WS] Connecting to session: ${sessionId}`);

    // Connect to the named pipe with timeout
    const PIPE_CONNECT_TIMEOUT = 10000; // 10 seconds
    const pipeSocket = net.connect(session.pipe);
    let connectTimeout = null;

    const conn = { pipe: pipeSocket, buffer: '', connected: false, pingInterval: null };
    pipeSockets.set(sessionId, conn);
    activeSessionId = sessionId;

    // Set connection timeout
    connectTimeout = setTimeout(() => {
      if (!conn.connected) {
        console.error(`[Pipe] Connection timeout for ${sessionId}`);
        pipeSocket.destroy();
        pipeSockets.delete(sessionId);
        ws.send(JSON.stringify({ type: 'error', message: 'Connection timeout', sessionId }));
        ws.send(JSON.stringify({ type: 'status', state: 'disconnected', reason: 'Connection timeout', sessionId }));
      }
    }, PIPE_CONNECT_TIMEOUT);

    pipeSocket.on('connect', () => {
      clearTimeout(connectTimeout);
      conn.connected = true;
      console.log(`[Pipe] Connected to ${sessionId}`);

      // Send resize immediately
      writeToPipe(conn, { type: 'resize', cols: 120, rows: 30 });

      // Start heartbeat pings to session (every 15 seconds)
      conn.pingInterval = setInterval(() => {
        if (conn.connected && !conn.pipe.destroyed) {
          writeToPipe(conn, { type: 'ping' });
        }
      }, 15000);
    });

    pipeSocket.on('data', (data) => {
      conn.buffer += data.toString();

      // Prevent unbounded buffer growth (DoS protection)
      if (conn.buffer.length > MAX_PIPE_BUFFER_SIZE) {
        console.error(`[Pipe] Buffer exceeded ${MAX_PIPE_BUFFER_SIZE} bytes for ${sessionId}, disconnecting`);
        pipeSocket.destroy();
        ws.send(JSON.stringify({
          type: 'error',
          message: 'Buffer overflow - connection reset',
          sessionId
        }));
        ws.send(JSON.stringify({
          type: 'status',
          state: 'disconnected',
          reason: 'Buffer overflow',
          sessionId
        }));
        return;
      }

      // Process complete JSON messages (newline-delimited)
      const lines = conn.buffer.split('\n');
      conn.buffer = lines.pop();

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);

          // Handle pong (heartbeat response) - don't forward to client
          if (msg.type === 'pong') {
            continue;
          }

          // Always forward with sessionId so client can route appropriately
          msg.sessionId = sessionId;

          // Log scrollback receipt
          if (msg.type === 'scrollback') {
            console.log(`[Pipe] Received scrollback for ${sessionId} (${msg.data?.length || 0} chars)`);
          }

          ws.send(JSON.stringify(msg));
        } catch (err) {
          // Raw output, wrap it with sessionId
          ws.send(JSON.stringify({ type: 'output', data: line, sessionId }));
        }
      }
    });

    pipeSocket.on('error', (err) => {
      // Clear connect timeout to prevent double-handling
      if (connectTimeout) {
        clearTimeout(connectTimeout);
        connectTimeout = null;
      }

      console.error(`[Pipe] Error for ${sessionId}: ${err.message}`);
      cleanupPipeConnection(sessionId, conn);
      ws.send(JSON.stringify({ type: 'error', message: `Pipe error: ${err.message}`, sessionId }));
      ws.send(JSON.stringify({ type: 'status', state: 'disconnected', reason: err.message, sessionId }));
    });

    pipeSocket.on('close', () => {
      // Clear connect timeout to prevent double-handling
      if (connectTimeout) {
        clearTimeout(connectTimeout);
        connectTimeout = null;
      }

      console.log(`[Pipe] Disconnected from ${sessionId}`);
      cleanupPipeConnection(sessionId, conn);
      ws.send(JSON.stringify({ type: 'status', state: 'disconnected', reason: 'Session ended', sessionId }));
    });
  }

  // Safely write to pipe with error handling
  function writeToPipe(conn, msg) {
    if (!conn || !conn.pipe || conn.pipe.destroyed) {
      return false;
    }
    try {
      const success = conn.pipe.write(JSON.stringify(msg) + '\n');
      // Handle backpressure - if write returns false, buffer is full
      if (!success) {
        console.warn('[Pipe] Write buffer full, message may be delayed');
      }
      return success;
    } catch (err) {
      console.error('[Pipe] Write error:', err.message);
      return false;
    }
  }

  // Clean up pipe connection resources
  function cleanupPipeConnection(sessionId, conn) {
    if (conn.pingInterval) {
      clearInterval(conn.pingInterval);
      conn.pingInterval = null;
    }
    conn.connected = false;
    pipeSockets.delete(sessionId);
  }

  // Cleanup all connections
  function cleanup() {
    // Clear WebSocket ping interval
    if (wsPingInterval) {
      clearInterval(wsPingInterval);
    }

    for (const [sessionId, conn] of pipeSockets) {
      cleanupPipeConnection(sessionId, conn);
      if (conn.pipe) {
        conn.pipe.destroy();
      }
    }
    pipeSockets.clear();
  }

  // Handle client disconnect
  ws.on('close', () => {
    console.log('[WS] Client disconnected');
    cleanup();
  });

  ws.on('error', (err) => {
    console.error('[WS] Error:', err.message);
    cleanup();
  });
});

// Handle server errors
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[Server] FATAL: Port ${config.PORT} is already in use`);
    console.error('[Server] Another instance may be running. Exiting.');
    process.exit(1);
  } else if (err.code === 'EACCES') {
    console.error(`[Server] FATAL: Permission denied for port ${config.PORT}`);
    process.exit(1);
  } else {
    console.error('[Server] Error:', err.message);
  }
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n[Server] Shutting down...');

  // Shutdown machine registry (closes agent connections)
  machineRegistry.shutdown();

  // Close all WebSocket connections
  wss.clients.forEach(ws => ws.close());
  wssAgent.clients.forEach(ws => ws.close());

  // Attempt to kill spawned launchers (best effort)
  for (const pid of spawnedLaunchers) {
    try {
      process.kill(pid, 'SIGTERM');
      console.log(`[Server] Sent SIGTERM to launcher PID ${pid}`);
    } catch (err) {
      // Process may have already exited
    }
  }
  spawnedLaunchers.clear();

  server.close(() => {
    console.log('[Server] Closed');
    process.exit(0);
  });

  // Force exit after 5 seconds if graceful shutdown fails
  setTimeout(() => {
    console.error('[Server] Forced exit after timeout');
    process.exit(1);
  }, 5000);
});

process.on('SIGTERM', () => {
  console.log('\n[Server] Received SIGTERM, shutting down...');

  // Shutdown machine registry (closes agent connections)
  machineRegistry.shutdown();

  // Close all WebSocket connections
  wss.clients.forEach(ws => ws.close());
  wssAgent.clients.forEach(ws => ws.close());

  // Attempt to kill spawned launchers (best effort)
  for (const pid of spawnedLaunchers) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch (err) {
      // Process may have already exited
    }
  }
  spawnedLaunchers.clear();

  server.close(() => {
    process.exit(0);
  });

  // Force exit after 5 seconds if graceful shutdown fails
  setTimeout(() => {
    process.exit(1);
  }, 5000);
});

// Start server
server.listen(config.PORT, config.HOST, () => {
  console.log('');
  console.log('  ╔═══════════════════════════════════════════════════╗');
  console.log('  ║       CELIO\'S NETWORK MACHINE                     ║');
  console.log('  ║       Ruby & Sapphire Link Server                 ║');
  console.log('  ╚═══════════════════════════════════════════════════╝');
  console.log('');
  console.log(`    Server:  https://${config.HOST}:${config.PORT}`);
  console.log(`    Token:   ${config.AUTH_TOKEN.substring(0, 8)}...`);
  console.log('');
  console.log('    Start a link with:');
  console.log('      node launcher.js <name> [working-dir]');
  console.log('');
  console.log('    Connect from:');
  console.log(`      Production:  https://walterfam.xyz/cnm?token=${config.AUTH_TOKEN}`);
  console.log(`      LAN:         https://192.168.1.204:${config.PORT}/?token=${config.AUTH_TOKEN}`);
  console.log('');

  // Show existing sessions
  const sessions = listSessions();
  if (sessions.length > 0) {
    console.log(`    Active links (${sessions.length}):`);
    for (const s of sessions) {
      console.log(`      → ${s.id} (${s.cwd})`);
    }
    console.log('');
  }
});
