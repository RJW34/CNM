# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Celio's Network Machine** - a secure WebSocket-based terminal relay system named after [Celio's Network Machine](https://bulbapedia.bulbagarden.net/wiki/Celio) from Pokémon FireRed/LeafGreen, which connects distant regions using Ruby & Sapphire gemstones.

This project enables remote terminal access from an iPhone to Claude Code CLI sessions running on a trusted host machine. Sessions are launched independently and persist across disconnects.

## Quick Start (Batch Files)

**Double-click these from the project root:**

| File | Purpose |
|------|---------|
| `start-server.bat` | Start relay server (run once) |
| `attach-session.bat <name> [dir]` | Attach generic Claude session |
| `attach-gboperator.bat` | Quick-start GBOperatorHelper |
| `start-all.bat <name> [dir]` | Server + session in one command |

**PowerShell alternatives:**
```powershell
.\scripts\Start-RelayServer.ps1 [-Background]
.\scripts\Attach-Session.ps1 -SessionName "myproject" [-WorkingDirectory "C:\Path"]
```

**Manual setup:**
```bash
# Install dependencies (first time)
cd server && npm install

# Generate SSL certificates (first time)
cd certs && openssl req -x509 -newkey rsa:4096 -keyout key.pem -out cert.pem -days 365 -nodes -subj "//CN=localhost"

# Start relay server
cd server && npm start

# Attach a session (from project directory)
node attach.js my-project claude

# Connect from iPhone (token configured in server/.env)
# https://<your-ip>:3001/?token=YOUR_TOKEN
```

## Architecture

```
[Session Launcher] -- PTY + named pipe --> [Session Registry]
                                                   |
[iPhone Client] <-- WebSocket --> [Relay Server] --+-- connects to any session
```

- **Session Launcher** (`launcher.js`): Spawns Claude in a PTY, exposes via named pipe, registers in `~/.claude-relay/sessions/`
- **Relay Server** (`index.js`): Lists available sessions, bridges WebSocket clients to session pipes
- **Web Client** (`client/web/`): Session picker UI + xterm.js terminal

## Key Files

```
server/
├── index.js          # Relay server - session discovery, WebSocket-to-pipe bridge
├── launcher.js       # Session launcher - spawns Claude in managed PTY
├── config.js         # Configuration (auth token, ports, paths)
├── session.js        # Legacy direct-spawn session management
└── pty-manager.js    # PTY utilities

client/web/
├── index.html        # Session picker + terminal UI
├── app.js            # WebSocket client, session selection, xterm.js
└── style.css         # Mobile-optimized styles

~/.claude-relay/sessions/   # Session registry (auto-managed)
├── my-project.json
└── another-project.json
```

## Commands

```bash
# Start relay server (run once)
cd server && npm start

# Option 1: launcher.js - Start session in specific directory
node launcher.js <session-name> [working-directory]

# Option 2: attach.js - Wrap command with relay access (recommended)
node attach.js <session-name> claude

# Examples:
node launcher.js frontend "C:\Code\my-app\frontend"
node attach.js my-project claude   # Run from project directory
```

## Two Ways to Start Sessions

| Tool | Use Case |
|------|----------|
| `launcher.js` | Start Claude in a specific directory from anywhere |
| `attach.js` | Run from within your project directory, wraps Claude with relay access |

**Recommended workflow**: `cd` to your project, then `node attach.js project-name claude`

## Messaging Protocol

**Client → Server:**
```json
{"type": "list_sessions"}
{"type": "connect_session", "sessionId": "my-project"}
{"type": "input", "data": "string"}
{"type": "control", "key": "CTRL_C | CTRL_D | ESC"}
{"type": "resize", "cols": 120, "rows": 30}
```

**Server → Client:**
```json
{"type": "sessions", "sessions": [...]}
{"type": "output", "data": "string"}
{"type": "scrollback", "data": "string"}
{"type": "status", "state": "connected | disconnected | error"}
```

## Configuration

Create `server/.env` with your settings (see `server/config.js` for defaults):

| Variable | Default | Description |
|----------|---------|-------------|
| `RELAY_AUTH_TOKEN` | (required) | Bearer token for authentication |
| `RELAY_PORT` | `3001` | Server port |
| `CLAUDE_PATH` | Auto-detected | Full path to claude.exe |

**Generate a secure token**:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Critical Constraints

- HTTPS required - no exceptions
- Sessions persist independently of relay server
- Each session has its own 10K line scrollback buffer
- Named pipes used for IPC (Windows: `\\.\pipe\claude-relay-<name>`)

## Production Deployment

CNM is deployed via Cloudflare Tunnel for secure remote access.

**Architecture:**
```
[PC1: CNM Server]     [PC2: Cloudflare Tunnel]     [Users]
 192.168.1.204:3001  <----  cloudflared  ---->  walterfam.xyz/cnm
```

**Access URLs:**
- **Production**: `https://walterfam.xyz/cnm?token=<AUTH_TOKEN>`
- **LAN fallback**: `https://192.168.1.204:3001/?token=<AUTH_TOKEN>`

**How it works:**
1. CNM server runs on PC1 (this machine) on port 3001
2. Cloudflare Tunnel on PC2 routes `walterfam.xyz/cnm/*` to `192.168.1.204:3001`
3. Server strips `/cnm` prefix from incoming requests (see `index.js` lines 141-144)
4. Client detects `/cnm` path and includes it in WebSocket connections

## Windows Firewall Setup

Allow incoming connections on port 3001:

```cmd
netsh advfirewall firewall add rule name="CNM Server" dir=in action=allow protocol=tcp localport=3001
```

To remove the rule later:
```cmd
netsh advfirewall firewall delete rule name="CNM Server"
```

## Deployment Protocol for walterfam.xyz (IMPORTANT)

**If you are Claude Code CLI running on the walterfam.xyz hosting machine (PC2), follow this protocol BEFORE launching or updating the website:**

### Pre-Launch Checklist

1. **Pull latest CNM version**:
   ```bash
   cd /path/to/CNM
   git fetch origin master
   git pull origin master
   ```

2. **Install/update dependencies** (if package.json changed):
   ```bash
   cd server && npm install
   ```

3. **Verify .env exists** with valid `RELAY_AUTH_TOKEN`:
   ```bash
   test -f server/.env && echo "OK" || echo "MISSING - create server/.env with RELAY_AUTH_TOKEN"
   ```

4. **Ensure Cloudflare Tunnel routes `/cnm/*` to PC1**:
   - Target: `https://192.168.1.204:3001`
   - The tunnel should proxy WebSocket connections
   - CNM server handles `/cnm` prefix stripping internally

### Sync Protocol

When updating walterfam.xyz, always sync CNM first:

```bash
# 1. Update CNM repo
git -C /path/to/CNM pull origin master

# 2. Restart tunnel if CNM server config changed
# (Tunnel config should route /cnm/* to 192.168.1.204:3001)

# 3. Verify CNM is reachable
curl -k https://192.168.1.204:3001/ || echo "CNM server not responding on PC1"
```

### Important Notes

- CNM server runs on **PC1** (192.168.1.204:3001), NOT on the walterfam.xyz machine
- The walterfam.xyz machine only runs the Cloudflare Tunnel that proxies to PC1
- Auth token must match between PC1's `server/.env` and bookmark URLs
- If CNM features are added/changed, pull updates before restarting the tunnel

## Local Development

For local-only access (no Cloudflare), the server works directly on the LAN.
