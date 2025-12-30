#!/usr/bin/env node
// Attach Tool - Run this BEFORE starting Claude in a terminal
// It wraps the session and makes it accessible via the relay
//
// Usage: node attach.js <session-name> [command]
// Example: node attach.js my-project claude
//          node attach.js my-project  (then manually run claude)

import pty from 'node-pty';
import net from 'net';
import { writeFileSync, unlinkSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { execSync } from 'child_process';
import readline from 'readline';
import config from './config.js';

// Get args
const sessionId = process.argv[2];
let command = process.argv[3] || null;

// Parse --init flag for initial input to send after startup
let initInput = null;
const initIndex = process.argv.indexOf('--init');
if (initIndex !== -1 && process.argv[initIndex + 1]) {
  initInput = process.argv[initIndex + 1].replace(/\\n/g, '\r');
}

// Resolve claude command
function resolveClaudeCommand() {
  // 1. Use config (which checks env var first)
  if (config.CLAUDE_CMD && existsSync(config.CLAUDE_CMD)) {
    return config.CLAUDE_CMD;
  }

  // 2. Try to find in PATH using 'where' (Windows) or 'which' (Unix)
  try {
    const cmd = process.platform === 'win32' ? 'where claude' : 'which claude';
    const result = execSync(cmd, { encoding: 'utf8' }).trim().split('\n')[0];
    if (result && existsSync(result)) {
      return result;
    }
  } catch {}

  // 3. Common Windows locations
  if (process.platform === 'win32') {
    const commonPaths = [
      join(homedir(), '.local', 'bin', 'claude.exe'),
      join(homedir(), 'AppData', 'Local', 'Programs', 'claude', 'claude.exe'),
      'C:\\Program Files\\Claude\\claude.exe'
    ];
    for (const p of commonPaths) {
      if (existsSync(p)) return p;
    }
  }

  // 4. Fallback - assume it's in PATH
  return 'claude';
}

// Resolve command if it's 'claude'
if (command === 'claude') {
  command = resolveClaudeCommand();
  console.log(`[Resolve] Claude command: ${command}`);
}

if (!sessionId) {
  console.log('Usage: node attach.js <session-name> [command]');
  console.log('');
  console.log('Examples:');
  console.log('  node attach.js my-project claude');
  console.log('  node attach.js my-project');
  console.log('');
  console.log('If no command is specified, you can type commands interactively.');
  process.exit(1);
}

const registryDir = join(homedir(), '.claude-relay', 'sessions');
const pipeName = `\\\\.\\pipe\\claude-relay-${sessionId}`;
const registryFile = join(registryDir, `${sessionId}.json`);

// Ensure registry directory exists
mkdirSync(registryDir, { recursive: true });

console.log('═══════════════════════════════════════════════════════');
console.log(' Claude Code Session Attach');
console.log('═══════════════════════════════════════════════════════');
console.log(`  Session ID:  ${sessionId}`);
console.log(`  Working Dir: ${process.cwd()}`);
console.log(`  Pipe:        ${pipeName}`);
if (command) {
  console.log(`  Command:     ${command}`);
}
console.log('═══════════════════════════════════════════════════════');

// Scrollback buffer
const scrollbackLines = [];
const MAX_SCROLLBACK = 10000;
const MAX_SCROLLBACK_SEND = 200; // Only send last 200 lines to prevent mobile jitter
const MAX_SCROLLBACK_BYTES = 50000; // Max 50KB to send
const PREVIEW_LINES = 12; // Lines to store in registry for dashboard preview
const REGISTRY_UPDATE_INTERVAL = 3000; // Update registry every 3 seconds

// Connected relay clients
const clients = new Set();

// Preview buffer for registry (stripped of ANSI)
let previewBuffer = '';
let lastActivity = Date.now();
let registryUpdateTimer = null;

// Strip ANSI escape codes
function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
}

// Append to scrollback and update preview
function appendScrollback(data) {
  const lines = data.split('\n');
  for (const line of lines) {
    if (scrollbackLines.length >= MAX_SCROLLBACK) {
      scrollbackLines.shift();
    }
    scrollbackLines.push(line);
  }

  // Update preview buffer (stripped of ANSI, last N lines)
  const cleanData = stripAnsi(data);
  previewBuffer = (previewBuffer + cleanData).split('\n').slice(-PREVIEW_LINES).join('\n');
  lastActivity = Date.now();
}

// Update registry file with preview and health info
function updateRegistry() {
  try {
    const sessionInfo = {
      id: sessionId,
      pipe: pipeName,
      cwd: process.cwd(),
      pid: ptyProcess ? ptyProcess.pid : process.pid,
      started: startTime,
      lastSeen: Date.now(),
      preview: previewBuffer.slice(-2000), // Max 2KB preview
      clientCount: clients.size,
      status: ptyProcess ? 'running' : 'interactive'
    };
    writeFileSync(registryFile, JSON.stringify(sessionInfo, null, 2));
  } catch (err) {
    // Ignore write errors
  }
}

// Start periodic registry updates
function startRegistryUpdates() {
  if (registryUpdateTimer) clearInterval(registryUpdateTimer);
  registryUpdateTimer = setInterval(updateRegistry, REGISTRY_UPDATE_INTERVAL);
}

// Session start time
const startTime = Date.now();

// Get limited scrollback for sending to clients (prevents mobile jitter)
function getScrollback() {
  // Take last N lines
  const linesToSend = scrollbackLines.slice(-MAX_SCROLLBACK_SEND);
  let result = linesToSend.join('\n');

  // Also limit by bytes
  if (result.length > MAX_SCROLLBACK_BYTES) {
    result = result.slice(-MAX_SCROLLBACK_BYTES);
    // Find first newline to avoid partial line
    const firstNewline = result.indexOf('\n');
    if (firstNewline > 0) {
      result = result.slice(firstNewline + 1);
    }
  }

  return result;
}

// Broadcast to all connected clients
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

// If a command is specified, spawn it in a PTY
let ptyProcess = null;

if (command) {
  // Filter out --init args from command args
  let cmdArgs = process.argv.slice(4);
  const initIdx = cmdArgs.indexOf('--init');
  if (initIdx !== -1) {
    cmdArgs.splice(initIdx, 2); // Remove --init and its value
  }

  // Spawn the command in a PTY
  ptyProcess = pty.spawn(command, cmdArgs, {
    name: 'xterm-256color',
    cols: process.stdout.columns || 120,
    rows: process.stdout.rows || 30,
    cwd: process.cwd(),
    env: process.env,
    useConpty: true
  });

  console.log(`[PTY] Spawned "${command}" with PID: ${ptyProcess.pid}`);

  // PTY output -> local terminal + relay clients
  ptyProcess.onData((data) => {
    process.stdout.write(data);
    appendScrollback(data);
    broadcast(data);
  });

  // PTY exit
  ptyProcess.onExit(({ exitCode }) => {
    console.log(`\n[PTY] Process exited with code ${exitCode}`);
    cleanup();
    process.exit(exitCode || 0);
  });

  // Local terminal input -> PTY (only if TTY)
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', (data) => {
      ptyProcess.write(data);
    });
  }

  // Handle resize
  process.stdout.on('resize', () => {
    ptyProcess.resize(process.stdout.columns, process.stdout.rows);
  });

  // Send initial input after delay if specified
  // Format: "input1\ninput2\ninput3" - each sent with delays between
  if (initInput) {
    const inputs = initInput.replace(/\\n/g, '\n').split('\n');
    let totalDelay = 2000;

    inputs.forEach((input) => {
      if (input.trim()) {
        const text = input.trim();
        // Type each character with small delay
        for (let i = 0; i < text.length; i++) {
          setTimeout(() => {
            ptyProcess.write(text[i]);
          }, totalDelay + (i * 50));
        }
        // Send Enter after all characters
        setTimeout(() => {
          console.log(`[PTY] Sent: "${text}" + Enter`);
          ptyProcess.write('\r');
        }, totalDelay + (text.length * 50) + 100);

        totalDelay += (text.length * 50) + 2000;
      }
    });
  }

} else {
  // Interactive mode - just capture terminal I/O
  console.log('[Attach] Interactive mode - type commands below');
  console.log('[Attach] Relay clients can see output and send input');
  console.log('');

  // Create readline interface
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true
  });

  rl.on('line', (line) => {
    appendScrollback(line + '\n');
    broadcast(line + '\n');
  });

  rl.on('close', () => {
    cleanup();
    process.exit(0);
  });
}

// Create named pipe server for relay connections
const pipeServer = net.createServer((socket) => {
  console.log(`[Pipe] Relay client connected (total: ${clients.size + 1})`);
  clients.add(socket);

  // Send scrollback on connect
  const scrollback = getScrollback();
  if (scrollback) {
    socket.write(JSON.stringify({ type: 'scrollback', data: scrollback }) + '\n');
  }
  socket.write(JSON.stringify({ type: 'status', state: 'connected' }) + '\n');

  let buffer = '';

  socket.on('data', (data) => {
    buffer += data.toString();

    const lines = buffer.split('\n');
    buffer = lines.pop();

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        handleRelayMessage(msg);
      } catch (err) {
        console.error(`[Pipe] Parse error: ${err.message}`);
      }
    }
  });

  socket.on('close', () => {
    clients.delete(socket);
    console.log(`[Pipe] Relay client disconnected (remaining: ${clients.size})`);
  });

  socket.on('error', (err) => {
    clients.delete(socket);
    console.error(`[Pipe] Socket error: ${err.message}`);
  });
});

// Handle messages from relay
function handleRelayMessage(msg) {
  switch (msg.type) {
    case 'input':
      if (typeof msg.data === 'string') {
        if (ptyProcess) {
          ptyProcess.write(msg.data);
        } else {
          // Echo to terminal in interactive mode
          process.stdout.write(msg.data);
          appendScrollback(msg.data);
          broadcast(msg.data);
        }
      }
      break;

    case 'control':
      const controlKeys = {
        'CTRL_C': '\x03',
        'CTRL_D': '\x04',
        'ESC': '\x1b'
      };
      if (controlKeys[msg.key] && ptyProcess) {
        ptyProcess.write(controlKeys[msg.key]);
      }
      break;

    case 'resize':
      if (ptyProcess && typeof msg.cols === 'number' && typeof msg.rows === 'number') {
        ptyProcess.resize(msg.cols, msg.rows);
      }
      break;
  }
}

// Start pipe server
pipeServer.listen(pipeName, () => {
  console.log(`[Pipe] Listening on ${pipeName}`);

  // Register session with initial info
  updateRegistry();
  console.log(`[Registry] Session registered`);

  // Start periodic registry updates (for preview + health)
  startRegistryUpdates();
  console.log(`[Registry] Periodic updates started (every ${REGISTRY_UPDATE_INTERVAL / 1000}s)`);
  console.log('');
  console.log('Session is now accessible from iPhone relay!');
  console.log('');
});

pipeServer.on('error', (err) => {
  console.error(`[Pipe] Server error: ${err.message}`);
  cleanup();
  process.exit(1);
});

// Cleanup
function cleanup() {
  console.log('[Cleanup] Stopping registry updates...');
  if (registryUpdateTimer) {
    clearInterval(registryUpdateTimer);
    registryUpdateTimer = null;
  }
  console.log('[Cleanup] Removing session from registry...');
  try {
    if (existsSync(registryFile)) {
      unlinkSync(registryFile);
    }
  } catch (err) {}
  pipeServer.close();
  for (const client of clients) {
    client.destroy();
  }
}

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n[Shutdown] Received SIGINT...');
  if (ptyProcess) ptyProcess.kill();
  cleanup();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n[Shutdown] Received SIGTERM...');
  if (ptyProcess) ptyProcess.kill();
  cleanup();
  process.exit(0);
});
