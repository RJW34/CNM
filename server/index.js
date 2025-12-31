import 'dotenv/config';
import { createServer } from 'https';
import { readFileSync, existsSync, readdirSync, unlinkSync, writeFileSync, mkdirSync } from 'fs';
import { WebSocketServer } from 'ws';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { homedir } from 'os';
import net from 'net';
import { spawn, execSync } from 'child_process';
import config from './config.js';

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

// List folders in Documents\Code
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
    const child = spawn('node', launcherArgs, {
      detached: true,
      stdio: 'ignore',
      cwd: __dirname
    });

    // Unref so parent doesn't wait for child
    child.unref();

    console.log(`[Session] Spawned launcher for ${safeName} (PID: ${child.pid})${skipPermissions ? ' [skip-permissions]' : ''}`);

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
    const child = spawn('node', [launcherPath, safeName, projectDir], {
      detached: true,
      stdio: 'ignore',
      cwd: __dirname
    });

    // Unref so parent doesn't wait for child
    child.unref();

    console.log(`[Session] Spawned launcher for ${safeName} (PID: ${child.pid})`);

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

// Create WebSocket server
const wss = new WebSocketServer({ server });

// Handle WebSocket connections
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

  // Send available sessions
  const sessions = listSessions();
  ws.send(JSON.stringify({ type: 'sessions', sessions }));
  console.log(`[WS] Sent ${sessions.length} available sessions`);

  // Handle messages from client
  ws.on('message', (message) => {
    try {
      const msg = JSON.parse(message.toString());

      switch (msg.type) {
        case 'list_sessions':
          const currentSessions = listSessions();
          ws.send(JSON.stringify({ type: 'sessions', sessions: currentSessions }));
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
          // Forward to active session's pipe
          if (activeSessionId) {
            const conn = pipeSockets.get(activeSessionId);
            if (conn && conn.pipe && !conn.pipe.destroyed) {
              conn.pipe.write(JSON.stringify(msg) + '\n');
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

        case 'list_folders':
          // List folders in Documents\Code
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
      // Resend scrollback for the session
      const conn = pipeSockets.get(sessionId);
      if (conn) {
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

    // Connect to the named pipe
    const pipeSocket = net.connect(session.pipe);
    let buffer = '';

    const conn = { pipe: pipeSocket, buffer: '' };
    pipeSockets.set(sessionId, conn);
    activeSessionId = sessionId;

    pipeSocket.on('connect', () => {
      console.log(`[Pipe] Connected to ${sessionId}`);

      // Send resize immediately
      const resizeMsg = { type: 'resize', cols: 120, rows: 30 };
      pipeSocket.write(JSON.stringify(resizeMsg) + '\n');
    });

    pipeSocket.on('data', (data) => {
      conn.buffer += data.toString();

      // Process complete JSON messages (newline-delimited)
      const lines = conn.buffer.split('\n');
      conn.buffer = lines.pop();

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
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
      console.error(`[Pipe] Error for ${sessionId}: ${err.message}`);
      ws.send(JSON.stringify({ type: 'error', message: `Pipe error: ${err.message}`, sessionId }));
    });

    pipeSocket.on('close', () => {
      console.log(`[Pipe] Disconnected from ${sessionId}`);
      pipeSockets.delete(sessionId);
      ws.send(JSON.stringify({ type: 'status', state: 'disconnected', reason: 'Session ended', sessionId }));
    });
  }

  // Cleanup all connections
  function cleanup() {
    for (const [sessionId, conn] of pipeSockets) {
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
  console.error('[Server] Error:', err.message);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n[Server] Shutting down...');
  wss.clients.forEach(ws => ws.close());
  server.close(() => {
    console.log('[Server] Closed');
    process.exit(0);
  });
});

process.on('SIGTERM', () => {
  console.log('\n[Server] Received SIGTERM, shutting down...');
  wss.clients.forEach(ws => ws.close());
  server.close(() => {
    process.exit(0);
  });
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
