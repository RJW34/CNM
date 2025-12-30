# CNM Installation Instructions for Claude Code

**IMPORTANT**: This file contains instructions for Claude Code CLI to integrate Celio's Network Machine (CNM) into the WalterfamWebsite stack.

## Task Overview

Add CNM (Celio's Network Machine) to the WalterfamWebsite deployment alongside Zarchon and MealPlanner.

- **CNM Repo**: https://github.com/RJW34/CNM.git
- **Target Path**: `WalterfamWebsite/cnm/`
- **Target URL**: `https://walterfam.xyz/cnm`
- **Port**: 3001

## Step-by-Step Instructions

### Step 1: Clone CNM Repository

Clone the CNM repo into the WalterfamWebsite directory:

```bash
cd <WalterfamWebsite-root>
git clone https://github.com/RJW34/CNM.git cnm
```

### Step 2: Install Dependencies

```bash
cd cnm/server
npm install
```

### Step 3: Generate SSL Certificates

```bash
cd cnm/certs
openssl req -x509 -newkey rsa:4096 -keyout key.pem -out cert.pem -days 365 -nodes -subj "/CN=localhost"
```

### Step 4: Update cloudflared-config.yml

Add these routes to `cloudflared-config.yml` **BEFORE** the catch-all rule (`- service: http://localhost:8080`):

```yaml
  # Celio's Network Machine (CNM) - Claude Remote Terminal
  - hostname: walterfam.xyz
    path: /cnm/*
    service: http://localhost:3001

  - hostname: walterfam.xyz
    path: /CNM/*
    service: http://localhost:3001

  - hostname: walterfam.xyz
    path: /cnm
    service: http://localhost:3001
    originRequest:
      noTLSVerify: true
```

### Step 5: Set Auth Token (REQUIRED)

**CRITICAL**: Generate a secure auth token. Do NOT use the default token.

```bash
# Generate a secure token
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Create `cnm/server/.env` with the generated token:

```env
RELAY_AUTH_TOKEN=<paste-generated-token-here>
```

### Step 6: Update START-WEBSITE.bat

Add CNM startup **AFTER** the Zarchon startup section and **BEFORE** the Cloudflare Tunnel section:

```batch
echo Starting Celio's Network Machine...
start "CNM" cmd /c "cd /d %~dp0cnm\server && node index.js"
timeout /t 2 /nobreak >nul
```

Also update the "All services started" echo section to include:
```
echo  CNM:         https://walterfam.xyz/cnm
```

### Step 7: Update SETUP-WEBSITE.bat

Add CNM setup **AFTER** the Zarchon server build section (Step 7 in existing script):

```batch
REM ============================================
REM STEP 8: Setup CNM (Celio's Network Machine)
REM ============================================
echo ================================================
echo   STEP 8: Setting Up CNM
echo ================================================
echo.

cd cnm\server

echo Installing CNM dependencies...
call npm install

if %errorlevel% neq 0 (
    echo [ERROR] Failed to install CNM dependencies
    cd ..\..
    goto :error_exit
)

echo.
echo Generating SSL certificates for CNM...
cd ..\certs
if not exist "key.pem" (
    openssl req -x509 -newkey rsa:4096 -keyout key.pem -out cert.pem -days 365 -nodes -subj "/CN=localhost"
)

echo.
echo [OK] CNM setup complete
cd ..\..

echo.
echo [STEP 8 COMPLETE]
echo.
```

**Note**: Increment subsequent step numbers if needed.

### Step 8: Create start-cnm.bat

Create `cnm/start-cnm.bat`:

```batch
@echo off
:: Start Celio's Network Machine Server
title CNM Server - Celio's Network Machine

cd /d "%~dp0server"

echo ===============================================
echo  Celio's Network Machine
echo  Ruby ^& Sapphire Link Server
echo ===============================================
echo  Port: 3001
echo  URL:  https://walterfam.xyz/cnm
echo ===============================================
echo.

node index.js
```

### Step 9: Update README.md

Add CNM to the services list in README.md:

```markdown
- **CNM**: https://walterfam.xyz/cnm - Celio's Network Machine (requires auth token)
```

## Verification Checklist

After completing all steps, verify:

- [ ] `cnm/` directory exists with server/, client/, certs/ subdirectories
- [ ] `cnm/server/node_modules/` exists (npm install succeeded)
- [ ] `cnm/certs/key.pem` and `cnm/certs/cert.pem` exist
- [ ] `cloudflared-config.yml` contains `/cnm` routes
- [ ] `START-WEBSITE.bat` includes CNM startup
- [ ] `SETUP-WEBSITE.bat` includes CNM setup step

## Testing

After starting all services:

1. Access `https://walterfam.xyz/cnm/?token=change-this-secret-token`
2. Should see "Celio's Network Machine" dashboard
3. No active sessions until you run `node attach.js <name> claude` on the server

## Security Note

The auth token MUST be set via `.env` file (Step 5). The `.env` file is gitignored and will NOT be committed.

## Port Reference

| Service | Port |
|---------|------|
| MealPlanner | 8080 |
| Zarchon | 3000 |
| **CNM** | **3001** |
| MongoDB | 27017 |
