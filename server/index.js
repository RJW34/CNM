import { createServer } from 'https';
import { readFileSync, existsSync, readdirSync, unlinkSync } from 'fs';
import { WebSocketServer } from 'ws';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { homedir } from 'os';
import net from 'net';
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

// Create HTTPS server (serves static files for the client)
const server = createServer(httpsOptions, (req, res) => {
  const clientDir = join(__dirname, '..', 'client', 'web');

  // Parse URL to strip query string
  const url = new URL(req.url, `https://${req.headers.host}`);
  let pathname = url.pathname;

  // Strip /cnm prefix if present (for Cloudflare routing via walterfam.xyz/cnm)
  if (pathname.startsWith('/cnm')) {
    pathname = pathname.substring(4) || '/';
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
  console.log('    Connect from mobile at:');
  console.log(`      https://<your-ip>:${config.PORT}/?token=${config.AUTH_TOKEN}`);
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
