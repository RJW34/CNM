import pty from 'node-pty';
import config from './config.js';
import { homedir } from 'os';

// Control key mappings
const CONTROL_KEYS = {
  'CTRL_C': '\x03',
  'CTRL_D': '\x04',
  'ESC': '\x1b'
};

export class PtyManager {
  constructor() {
    this.ptyProcess = null;
    this.scrollback = [];
    this.maxScrollback = config.SCROLLBACK_LINES;
    this.onData = null;
    this.onExit = null;
    this.isAlive = false;
  }

  // Spawn Claude Code in a PTY
  spawn() {
    if (this.ptyProcess) {
      throw new Error('PTY already spawned');
    }

    const shell = config.CLAUDE_CMD;
    const args = config.CLAUDE_ARGS;
    const cwd = config.WORKING_DIR || homedir();

    console.log(`[PTY] Spawning: ${shell} ${args.join(' ')} in ${cwd}`);

    this.ptyProcess = pty.spawn(shell, args, {
      name: 'xterm-256color',
      cols: config.PTY_COLS,
      rows: config.PTY_ROWS,
      cwd: cwd,
      env: process.env,
      useConpty: process.platform === 'win32' // Use ConPTY on Windows
    });

    this.isAlive = true;

    this.ptyProcess.onData((data) => {
      this.appendToScrollback(data);
      if (this.onData) {
        this.onData(data);
      }
    });

    this.ptyProcess.onExit(({ exitCode, signal }) => {
      console.log(`[PTY] Process exited with code ${exitCode}, signal ${signal}`);
      this.isAlive = false;
      if (this.onExit) {
        this.onExit(exitCode, signal);
      }
    });

    console.log(`[PTY] Process spawned with PID: ${this.ptyProcess.pid}`);
    return this.ptyProcess.pid;
  }

  // Append data to scrollback buffer
  appendToScrollback(data) {
    // Split by newlines and add to buffer
    const lines = data.split('\n');
    for (const line of lines) {
      if (this.scrollback.length >= this.maxScrollback) {
        this.scrollback.shift(); // Remove oldest line
      }
      this.scrollback.push(line);
    }
  }

  // Get full scrollback as string
  getScrollback() {
    return this.scrollback.join('\n');
  }

  // Write input to PTY
  write(data) {
    if (this.ptyProcess && this.isAlive) {
      this.ptyProcess.write(data);
    }
  }

  // Send control key
  sendControl(key) {
    const sequence = CONTROL_KEYS[key];
    if (sequence && this.ptyProcess && this.isAlive) {
      this.ptyProcess.write(sequence);
      console.log(`[PTY] Sent control key: ${key}`);
    }
  }

  // Resize PTY
  resize(cols, rows) {
    if (this.ptyProcess && this.isAlive) {
      this.ptyProcess.resize(cols, rows);
      console.log(`[PTY] Resized to ${cols}x${rows}`);
    }
  }

  // Kill the PTY process
  kill() {
    if (this.ptyProcess) {
      console.log('[PTY] Killing process');
      this.ptyProcess.kill();
      this.ptyProcess = null;
      this.isAlive = false;
    }
  }

  // Check if process is alive
  get alive() {
    return this.isAlive;
  }
}
