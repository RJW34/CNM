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

// Connected clients
const clients = new Set();

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
    if (scrollbackLines.length >= MAX_SCROLLBACK) {
      scrollbackLines.shift();
    }
    scrollbackLines.push(line);
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

    // Process complete JSON messages (newline-delimited)
    const lines = buffer.split('\n');
    buffer = lines.pop(); // Keep incomplete line in buffer

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        handleMessage(msg);
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
function handleMessage(msg) {
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

    default:
      console.log(`[Pipe] Unknown message type: ${msg.type}`);
  }
}

// Start listening on named pipe
server.listen(pipeName, () => {
  console.log(`[Pipe] Listening on ${pipeName}`);

  // Register session
  const sessionInfo = {
    id: sessionId,
    pipe: pipeName,
    cwd: workingDir,
    pid: ptyProcess.pid,
    started: Date.now()
  };

  writeFileSync(registryFile, JSON.stringify(sessionInfo, null, 2));
  console.log(`[Registry] Session registered`);
});

server.on('error', (err) => {
  console.error(`[Pipe] Server error: ${err.message}`);
  cleanup();
  process.exit(1);
});

// Cleanup function
function cleanup() {
  console.log('[Cleanup] Removing session from registry...');
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
