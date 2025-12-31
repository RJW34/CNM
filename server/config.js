// Server configuration
// IMPORTANT: Change AUTH_TOKEN before deploying
export default {
  // Authentication token - clients must send this to connect
  AUTH_TOKEN: process.env.RELAY_AUTH_TOKEN || 'change-this-secret-token',

  // Server settings
  PORT: parseInt(process.env.RELAY_PORT) || 3001,
  HOST: process.env.RELAY_HOST || '0.0.0.0',

  // SSL certificate paths (relative to server directory)
  SSL_KEY: process.env.SSL_KEY || '../certs/key.pem',
  SSL_CERT: process.env.SSL_CERT || '../certs/cert.pem',

  // Session settings
  IDLE_TIMEOUT_MS: 24 * 60 * 60 * 1000, // 24 hours
  SCROLLBACK_LINES: 10000,

  // PTY settings
  PTY_COLS: 120,
  PTY_ROWS: 30,

  // Claude Code command (full path required for node-pty on Windows)
  CLAUDE_CMD: process.env.CLAUDE_PATH || 'C:\\Users\\mtoli\\.local\\bin\\claude.exe',
  CLAUDE_ARGS: [],

  // Working directory for Claude Code (null = user home)
  WORKING_DIR: null,

  // File upload settings
  UPLOAD_ENABLED: true,
  MAX_UPLOAD_SIZE: 10 * 1024 * 1024,  // 10MB max file size
};
