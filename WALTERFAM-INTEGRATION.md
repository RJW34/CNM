# Integration Guide: Claude Relay → WalterfamWebsite

This document outlines the modifications needed to integrate the Claude Code Relay (ABCL - Agent Bridge for Claude Liaison) into the WalterfamWebsite repository for deployment at `walterfam.xyz/abcl`.

## Overview

**Target URL**: `https://walterfam.xyz/abcl`
**Local Port**: 3001
**Service Name**: ABCL (Agent Bridge for Claude Liaison)

## Files to Copy

Copy these directories from `iphone bridge` to `WalterfamWebsite`:

```
WalterfamWebsite/
├── abcl/                          # NEW - Claude Relay
│   ├── server/
│   │   ├── index.js               # Main relay server
│   │   ├── attach.js              # Session attach wrapper
│   │   ├── launcher.js            # Session launcher
│   │   ├── config.js              # Configuration (UPDATE PORT!)
│   │   └── package.json           # Dependencies
│   ├── client/
│   │   └── web/
│   │       ├── index.html         # Agent Monitor UI
│   │       ├── app.js             # Client JavaScript
│   │       └── style.css          # Styles
│   ├── certs/                     # SSL certs (local dev only)
│   └── scripts/
│       ├── Start-RelayServer.ps1
│       └── Attach-Session.ps1
├── cloudflared-config.yml         # UPDATE - Add /abcl route
├── START-WEBSITE.bat              # UPDATE - Add ABCL startup
├── SETUP-WEBSITE.bat              # UPDATE - Add ABCL setup
└── ... (existing files)
```

## Step-by-Step Modifications

### 1. Update `abcl/server/config.js`

Change port from 3000 to 3001:

```javascript
export default {
  PORT: parseInt(process.env.ABCL_PORT) || 3001,
  HOST: process.env.ABCL_HOST || '0.0.0.0',
  AUTH_TOKEN: process.env.ABCL_AUTH_TOKEN || 'change-this-secret-token',
  SSL_KEY: '../certs/key.pem',
  SSL_CERT: '../certs/cert.pem',
  CLAUDE_CMD: process.env.CLAUDE_PATH || 'C:\\Users\\mtoli\\.local\\bin\\claude.exe',
  CLAUDE_ARGS: [],
  PTY_COLS: 120,
  PTY_ROWS: 30,
  SCROLLBACK_LINES: 10000
};
```

### 2. Update `cloudflared-config.yml`

Add these routes BEFORE the catch-all:

```yaml
ingress:
  # ... existing Zarchon routes ...

  # Route /abcl (case-insensitive) to Claude Relay (port 3001)
  - hostname: walterfam.xyz
    path: /abcl/*
    service: http://localhost:3001

  - hostname: walterfam.xyz
    path: /ABCL/*
    service: http://localhost:3001

  # WebSocket upgrade for ABCL terminal connections
  - hostname: walterfam.xyz
    path: /abcl
    service: http://localhost:3001
    originRequest:
      noTLSVerify: true

  # ... existing catch-all ...
  - service: http://localhost:8080
```

### 3. Update `abcl/server/index.js`

Modify static file serving to handle `/abcl` prefix:

```javascript
// Replace the static file serving section with:
const server = createServer(httpsOptions, (req, res) => {
  const clientDir = join(__dirname, '..', 'client', 'web');

  const url = new URL(req.url, `https://${req.headers.host}`);
  let pathname = url.pathname;

  // Strip /abcl prefix if present (for Cloudflare routing)
  if (pathname.startsWith('/abcl')) {
    pathname = pathname.substring(5) || '/';
  }

  let filePath;
  if (pathname === '/' || pathname === '/index.html') {
    filePath = join(clientDir, 'index.html');
  } else {
    filePath = join(clientDir, pathname);
  }

  // ... rest of static file handling ...
});
```

### 4. Update `abcl/client/web/app.js`

Update WebSocket URL to use `/abcl` path:

```javascript
// In connect() function, update WebSocket URL:
function connect() {
  const token = getToken();
  if (!token) {
    setConnectionStatus('error', 'No token');
    return;
  }

  setConnectionStatus('', 'Connecting...');

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';

  // Handle both local and Cloudflare deployment
  let wsUrl;
  if (window.location.pathname.startsWith('/abcl')) {
    // Cloudflare deployment
    wsUrl = `${protocol}//${window.location.host}/abcl/?token=${encodeURIComponent(token)}`;
  } else {
    // Local development
    wsUrl = `${protocol}//${window.location.host}/?token=${encodeURIComponent(token)}`;
  }

  // ... rest of connect function ...
}
```

### 5. Create `abcl/start-abcl.bat`

```batch
@echo off
:: Start ABCL (Agent Bridge for Claude Liaison) Server
title ABCL Server

cd /d "%~dp0server"

echo ===============================================
echo  ABCL - Agent Bridge for Claude Liaison
echo ===============================================
echo  Port: 3001
echo  URL:  https://walterfam.xyz/abcl
echo ===============================================

node index.js
```

### 6. Update `START-WEBSITE.bat`

Add ABCL startup after Zarchon:

```batch
@echo off
:: START-WEBSITE.bat - Updated with ABCL

echo Starting MongoDB...
start "MongoDB" cmd /c "cd /d %~dp0zarchon\mongodb\bin && mongod --config ..\mongod.conf"
timeout /t 3 /nobreak >nul

echo Starting MealPlanner...
start "MealPlanner" cmd /c "cd /d %~dp0meal-planner && call venv\Scripts\activate && python server.py"
timeout /t 2 /nobreak >nul

echo Starting Zarchon...
start "Zarchon" cmd /c "cd /d %~dp0zarchon\server && node dist\index.js"
timeout /t 2 /nobreak >nul

echo Starting ABCL (Claude Relay)...
start "ABCL" cmd /c "cd /d %~dp0abcl\server && node index.js"
timeout /t 2 /nobreak >nul

echo Starting Cloudflare Tunnel...
start "Cloudflare" cmd /c "cloudflared tunnel --config %~dp0cloudflared-config.yml run"

echo.
echo ===============================================
echo  All services started!
echo ===============================================
echo  MealPlanner: https://walterfam.xyz/MealPlanner
echo  Zarchon:     https://walterfam.xyz/Zarchon
echo  ABCL:        https://walterfam.xyz/abcl
echo ===============================================
pause
```

### 7. Update `SETUP-WEBSITE.bat`

Add ABCL dependencies installation:

```batch
:: Add after Zarchon npm install section:

echo.
echo ========================================
echo Installing ABCL dependencies...
echo ========================================
cd /d "%~dp0abcl\server"
call npm install
if errorlevel 1 (
    echo ERROR: ABCL npm install failed
    pause
    exit /b 1
)
echo ABCL dependencies installed successfully.
```

### 8. Create `abcl/.env.example`

```env
# ABCL Configuration
ABCL_PORT=3001
ABCL_HOST=0.0.0.0
ABCL_AUTH_TOKEN=your-secure-token-here

# Claude CLI path (Windows)
CLAUDE_PATH=C:\Users\mtoli\.local\bin\claude.exe
```

### 9. Update `README.md`

Add ABCL to the documentation:

```markdown
## 🌐 Live Website

- **MealPlanner**: https://walterfam.xyz/MealPlanner - Weekly meal planning
- **Zarchon**: https://walterfam.xyz/Zarchon - Multiplayer strategy game
- **ABCL**: https://walterfam.xyz/abcl - Claude Agent Monitor (requires auth token)
```

### 10. Create NSSM Service (Optional)

For Windows Service installation:

```batch
nssm install WalterfamABCL "C:\Program Files\nodejs\node.exe"
nssm set WalterfamABCL AppParameters "D:\Project Files\WalterfamWebsite\abcl\server\index.js"
nssm set WalterfamABCL AppDirectory "D:\Project Files\WalterfamWebsite\abcl\server"
nssm set WalterfamABCL DisplayName "WalterfamWebsite - ABCL"
nssm set WalterfamABCL Description "Agent Bridge for Claude Liaison - Remote Claude Monitor"
nssm set WalterfamABCL Start SERVICE_AUTO_START
nssm start WalterfamABCL
```

## Security Considerations

### Authentication
The current static token authentication is suitable for personal use. For public deployment:

1. **Environment Variables**: Store token in `.env`, never commit
2. **Token Rotation**: Change token periodically
3. **IP Whitelisting**: Consider Cloudflare Access rules
4. **Rate Limiting**: Add to Cloudflare or server-side

### Cloudflare Access (Recommended)

Add Cloudflare Access policy for `/abcl/*`:

1. Go to Cloudflare Zero Trust → Access → Applications
2. Create new application for `walterfam.xyz/abcl/*`
3. Add authentication policy (email OTP, Google OAuth, etc.)
4. This adds an extra layer before reaching the token auth

## File Structure After Integration

```
WalterfamWebsite/
├── abcl/
│   ├── server/
│   │   ├── index.js
│   │   ├── attach.js
│   │   ├── launcher.js
│   │   ├── config.js
│   │   ├── package.json
│   │   └── package-lock.json
│   ├── client/
│   │   └── web/
│   │       ├── index.html
│   │       ├── app.js
│   │       └── style.css
│   ├── certs/
│   │   ├── key.pem
│   │   └── cert.pem
│   ├── scripts/
│   │   ├── Start-RelayServer.ps1
│   │   └── Attach-Session.ps1
│   ├── start-abcl.bat
│   ├── .env.example
│   └── CLAUDE.md
├── meal-planner/
├── zarchon/
├── cloudflared-config.yml      # Updated
├── START-WEBSITE.bat           # Updated
├── SETUP-WEBSITE.bat           # Updated
└── README.md                   # Updated
```

## Testing Checklist

After integration:

- [ ] `npm install` succeeds in `abcl/server/`
- [ ] ABCL server starts on port 3001
- [ ] Local access works: `https://localhost:3001/?token=...`
- [ ] Cloudflare routes `/abcl` correctly
- [ ] WebSocket connections work through Cloudflare
- [ ] Session attach works: `node attach.js test-session claude`
- [ ] Dashboard shows connected sessions
- [ ] Terminal input/output works in Focus mode

## Quick Reference

| Service | Local Port | Cloudflare Path |
|---------|------------|-----------------|
| MealPlanner | 8080 | /MealPlanner |
| Zarchon | 3000 | /Zarchon |
| **ABCL** | **3001** | **/abcl** |
| MongoDB | 27017 | (internal) |

## Commands for Claude CLI

When a Claude CLI session in WalterfamWebsite needs to add ABCL support:

```
Copy the abcl directory from "C:\Users\mtoli\Documents\Code\iphone bridge"
to the WalterfamWebsite repository, then apply the modifications listed
in WALTERFAM-INTEGRATION.md sections 1-10.
```
