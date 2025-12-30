# Integration Guide: Celio's Network Machine → WalterfamWebsite

This document outlines the modifications needed to integrate Celio's Network Machine (CNM) into the WalterfamWebsite repository for deployment at `walterfam.xyz/cnm`.

## Overview

**Target URL**: `https://walterfam.xyz/cnm`
**Local Port**: 3001
**Service Name**: CNM (Celio's Network Machine)

## Current State

The CNM codebase is **already compatible** with Cloudflare deployment:
- `server/index.js` handles `/cnm` prefix stripping for static files
- `client/web/app.js` handles `/cnm` prefix for WebSocket connections
- `server/config.js` uses port 3001 by default

## Files to Copy

Copy these directories from the CNM repo to `WalterfamWebsite`:

```
WalterfamWebsite/
├── cnm/                           # NEW - Celio's Network Machine
│   ├── server/
│   │   ├── index.js               # Main relay server (handles /cnm prefix)
│   │   ├── attach.js              # Session attach wrapper
│   │   ├── launcher.js            # Session launcher
│   │   ├── config.js              # Configuration (port 3001)
│   │   └── package.json           # Dependencies
│   ├── client/
│   │   └── web/
│   │       ├── index.html         # Link Monitor UI
│   │       ├── app.js             # Client JavaScript (handles /cnm prefix)
│   │       └── style.css          # Styles
│   ├── certs/                     # SSL certs (generate for local dev)
│   └── scripts/
│       ├── Start-RelayServer.ps1
│       └── Attach-Session.ps1
├── cloudflared-config.yml         # UPDATE - Add /cnm route
├── START-WEBSITE.bat              # UPDATE - Add CNM startup
├── SETUP-WEBSITE.bat              # UPDATE - Add CNM setup
└── ... (existing files)
```

## Step-by-Step Modifications

### 1. Update `cloudflared-config.yml`

Add these routes BEFORE the catch-all:

```yaml
ingress:
  # ... existing Zarchon routes ...

  # Route /cnm (case-insensitive) to Celio's Network Machine (port 3001)
  - hostname: walterfam.xyz
    path: /cnm/*
    service: http://localhost:3001

  - hostname: walterfam.xyz
    path: /CNM/*
    service: http://localhost:3001

  # WebSocket upgrade for CNM terminal connections
  - hostname: walterfam.xyz
    path: /cnm
    service: http://localhost:3001
    originRequest:
      noTLSVerify: true

  # ... existing catch-all ...
  - service: http://localhost:8080
```

### 2. Create `cnm/start-cnm.bat`

```batch
@echo off
:: Start Celio's Network Machine Server
title CNM Server

cd /d "%~dp0server"

echo ===============================================
echo  Celio's Network Machine
echo  Ruby ^& Sapphire Link Server
echo ===============================================
echo  Port: 3001
echo  URL:  https://walterfam.xyz/cnm
echo ===============================================

node index.js
```

### 3. Update `START-WEBSITE.bat`

Add CNM startup after Zarchon:

```batch
echo Starting Celio's Network Machine...
start "CNM" cmd /c "cd /d %~dp0cnm\server && node index.js"
timeout /t 2 /nobreak >nul
```

### 4. Update `SETUP-WEBSITE.bat`

Add CNM dependencies installation:

```batch
:: Add after Zarchon npm install section:

echo.
echo ========================================
echo Installing CNM dependencies...
echo ========================================
cd /d "%~dp0cnm\server"
call npm install
if errorlevel 1 (
    echo ERROR: CNM npm install failed
    pause
    exit /b 1
)
echo CNM dependencies installed successfully.
```

### 5. Create `cnm/.env.example`

```env
# Celio's Network Machine Configuration
CNM_PORT=3001
CNM_HOST=0.0.0.0
RELAY_AUTH_TOKEN=your-secure-token-here

# Claude CLI path (Windows)
CLAUDE_PATH=C:\Users\mtoli\.local\bin\claude.exe
```

## Security Considerations

### Authentication
The current static token authentication is suitable for personal use. For public deployment:

1. **Environment Variables**: Store token in `.env`, never commit
2. **Token Rotation**: Change token periodically
3. **IP Whitelisting**: Consider Cloudflare Access rules
4. **Rate Limiting**: Add to Cloudflare or server-side

### Cloudflare Access (Recommended)

Add Cloudflare Access policy for `/cnm/*`:

1. Go to Cloudflare Zero Trust → Access → Applications
2. Create new application for `walterfam.xyz/cnm/*`
3. Add authentication policy (email OTP, Google OAuth, etc.)
4. This adds an extra layer before reaching the token auth

## Testing Checklist

After integration:

- [ ] `npm install` succeeds in `cnm/server/`
- [ ] CNM server starts on port 3001
- [ ] Local access works: `https://localhost:3001/?token=...`
- [ ] Cloudflare routes `/cnm` correctly
- [ ] WebSocket connections work through Cloudflare
- [ ] Session attach works: `node attach.js test-session claude`
- [ ] Dashboard shows connected sessions
- [ ] Terminal input/output works in Focus mode

## Quick Reference

| Service | Local Port | Cloudflare Path |
|---------|------------|-----------------|
| MealPlanner | 8080 | /MealPlanner |
| Zarchon | 3000 | /Zarchon |
| **CNM** | **3001** | **/cnm** |
| MongoDB | 27017 | (internal) |
