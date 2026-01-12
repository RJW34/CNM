// CNM Agent Configuration
import { hostname, homedir } from 'os';
import { join } from 'path';

export default {
  // Hub connection
  HUB_URL: process.env.CNM_HUB_URL || 'wss://192.168.1.204:3001/agent',
  AGENT_TOKEN: process.env.CNM_AGENT_TOKEN || 'change-this-agent-token',

  // Machine identity
  MACHINE_ID: process.env.CNM_MACHINE_ID || hostname(),

  // Agent server settings (for direct P2P connections)
  AGENT_PORT: parseInt(process.env.CNM_AGENT_PORT) || 3002,
  AGENT_HOST: process.env.CNM_AGENT_HOST || '0.0.0.0',

  // SSL certificate paths (relative to agent directory)
  SSL_KEY: process.env.SSL_KEY || '../certs/key.pem',
  SSL_CERT: process.env.SSL_CERT || '../certs/cert.pem',

  // Project discovery
  PROJECTS_PATH: process.env.CNM_PROJECTS_PATH || join(homedir(), 'Documents', 'Code'),

  // Connection settings
  RECONNECT_DELAY: 5000,        // 5 seconds
  HEARTBEAT_INTERVAL: 15000,    // 15 seconds
  PROJECT_REFRESH_INTERVAL: 30000, // 30 seconds

  // SSL (for self-signed certs when connecting to hub)
  REJECT_UNAUTHORIZED: process.env.CNM_REJECT_UNAUTHORIZED === 'true',

  // Claude Code command (full path required for node-pty on Windows)
  CLAUDE_CMD: process.env.CLAUDE_PATH || 'claude',
  CLAUDE_ARGS: [],

  // Session settings
  SCROLLBACK_LINES: 10000,
  PTY_COLS: 120,
  PTY_ROWS: 30
};
