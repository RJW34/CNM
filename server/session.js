import { PtyManager } from './pty-manager.js';
import config from './config.js';

export class Session {
  constructor(id) {
    this.id = id;
    this.pty = new PtyManager();
    this.clients = new Set(); // Connected WebSocket clients
    this.createdAt = Date.now();
    this.lastActivity = Date.now();
    this.idleTimer = null;
  }

  // Start the Claude Code process
  start() {
    this.pty.spawn();

    // Forward PTY output to all connected clients
    this.pty.onData = (data) => {
      this.broadcast({ type: 'output', data });
      this.touch();
    };

    // Handle PTY exit
    this.pty.onExit = (exitCode) => {
      this.broadcast({ type: 'status', state: 'disconnected', reason: `Process exited (${exitCode})` });
    };

    this.resetIdleTimer();
  }

  // Add a client to this session
  addClient(ws) {
    this.clients.add(ws);
    this.touch();

    // Send scrollback on connect
    const scrollback = this.pty.getScrollback();
    if (scrollback) {
      ws.send(JSON.stringify({ type: 'scrollback', data: scrollback }));
    }

    ws.send(JSON.stringify({ type: 'status', state: 'connected' }));
    console.log(`[Session ${this.id}] Client connected (total: ${this.clients.size})`);
  }

  // Remove a client from this session
  removeClient(ws) {
    this.clients.delete(ws);
    console.log(`[Session ${this.id}] Client disconnected (remaining: ${this.clients.size})`);
  }

  // Handle input from client
  handleInput(data) {
    this.pty.write(data);
    this.touch();
  }

  // Handle control key from client
  handleControl(key) {
    this.pty.sendControl(key);
    this.touch();
  }

  // Handle resize from client
  handleResize(cols, rows) {
    this.pty.resize(cols, rows);
    this.touch();
  }

  // Broadcast message to all clients
  broadcast(message) {
    const data = JSON.stringify(message);
    for (const client of this.clients) {
      if (client.readyState === 1) { // WebSocket.OPEN
        client.send(data);
      }
    }
  }

  // Update last activity time
  touch() {
    this.lastActivity = Date.now();
    this.resetIdleTimer();
  }

  // Reset idle timeout
  resetIdleTimer() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
    }
    this.idleTimer = setTimeout(() => {
      console.log(`[Session ${this.id}] Idle timeout reached, terminating`);
      this.destroy();
    }, config.IDLE_TIMEOUT_MS);
  }

  // Check if PTY is alive
  get alive() {
    return this.pty.alive;
  }

  // Destroy session
  destroy() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
    }
    this.pty.kill();
    for (const client of this.clients) {
      client.close(1000, 'Session terminated');
    }
    this.clients.clear();
  }
}

// Session manager - maintains all active sessions
export class SessionManager {
  constructor() {
    this.sessions = new Map();
    this.nextId = 1;
  }

  // Create a new session
  create() {
    const id = `session-${this.nextId++}`;
    const session = new Session(id);
    this.sessions.set(id, session);
    session.start();
    console.log(`[SessionManager] Created session ${id}`);
    return session;
  }

  // Get session by ID
  get(id) {
    return this.sessions.get(id);
  }

  // Get or create default session (single-session mode)
  getOrCreateDefault() {
    let session = this.sessions.get('default');
    if (!session || !session.alive) {
      if (session) {
        session.destroy();
        this.sessions.delete('default');
      }
      session = new Session('default');
      this.sessions.set('default', session);
      session.start();
      console.log('[SessionManager] Created default session');
    }
    return session;
  }

  // Destroy a session
  destroy(id) {
    const session = this.sessions.get(id);
    if (session) {
      session.destroy();
      this.sessions.delete(id);
      console.log(`[SessionManager] Destroyed session ${id}`);
    }
  }

  // Destroy all sessions
  destroyAll() {
    for (const [id, session] of this.sessions) {
      session.destroy();
    }
    this.sessions.clear();
  }
}
