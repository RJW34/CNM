# CNM Remaining Fixes Implementation Guide

This document contains everything needed to complete the remaining stability fixes from the iOS Safari audit conducted 2024-12-31.

---

## Prerequisites

Before starting, read `IOS-SAFARI-AUDIT-2024-12-31.md` for full context on issues already fixed.

---

## SERVER-SIDE FIXES

### 1. Add Cleanup for `activeSessions` Map

**File:** `server/index.js`
**Lines:** Around 488, 519
**Problem:** The `activeSessions` Map grows indefinitely - each auth creates a new session token that never expires.

**Current Code (approximate):**
```javascript
const activeSessions = new Map();
// ... sessions added but never removed
```

**Implementation:**
```javascript
// Add near the top with other constants
const SESSION_CLEANUP_INTERVAL = 60 * 60 * 1000; // 1 hour
const SESSION_MAX_IDLE = 24 * 60 * 60 * 1000; // 24 hours

// Add after activeSessions Map is created
setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  for (const [token, session] of activeSessions.entries()) {
    if (now - session.lastSeen > SESSION_MAX_IDLE) {
      activeSessions.delete(token);
      cleaned++;
    }
  }
  if (cleaned > 0) {
    console.log(`[Auth] Cleaned ${cleaned} expired sessions, ${activeSessions.size} active`);
  }
}, SESSION_CLEANUP_INTERVAL);
```

---

### 2. Add MAX_BUFFER_SIZE for Pipe Buffer

**File:** `server/index.js`
**Lines:** Around 837-841
**Problem:** `conn.buffer` accumulates data with no limit - can grow to gigabytes if partial messages received.

**Current Code:**
```javascript
pipeSocket.on('data', (data) => {
  conn.buffer += data.toString();
  // ... process buffer
});
```

**Implementation:**
```javascript
// Add constant near top
const MAX_PIPE_BUFFER_SIZE = 1024 * 1024; // 1MB

// Replace in pipeSocket.on('data', ...)
pipeSocket.on('data', (data) => {
  conn.buffer += data.toString();

  // Prevent unbounded buffer growth
  if (conn.buffer.length > MAX_PIPE_BUFFER_SIZE) {
    console.error(`[Pipe] Buffer exceeded ${MAX_PIPE_BUFFER_SIZE} bytes for ${sessionId}, disconnecting`);
    pipeSocket.destroy();
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Buffer overflow - connection reset',
      sessionId
    }));
    ws.send(JSON.stringify({
      type: 'status',
      state: 'disconnected',
      reason: 'Buffer overflow',
      sessionId
    }));
    return;
  }

  // ... rest of existing code
});
```

---

### 3. Clear `connectTimeout` on Pipe Error/Close

**File:** `server/index.js`
**Lines:** Around 810-818 (timeout definition), 869-876 (error/close handlers)
**Problem:** Dangling timeout fires after pipe already closed, causing undefined behavior.

**Current Code (error handler):**
```javascript
pipeSocket.on('error', (err) => {
  console.error(`[Pipe] Error for ${sessionId}: ${err.message}`);
  cleanupPipeConnection(sessionId, conn);
  // ... send error to client
});

pipeSocket.on('close', () => {
  console.log(`[Pipe] Disconnected from ${sessionId}`);
  cleanupPipeConnection(sessionId, conn);
  // ... send status to client
});
```

**Implementation:**
```javascript
pipeSocket.on('error', (err) => {
  // Clear connect timeout to prevent double-handling
  if (connectTimeout) {
    clearTimeout(connectTimeout);
    connectTimeout = null;
  }

  console.error(`[Pipe] Error for ${sessionId}: ${err.message}`);
  cleanupPipeConnection(sessionId, conn);
  ws.send(JSON.stringify({ type: 'error', message: `Pipe error: ${err.message}`, sessionId }));
  ws.send(JSON.stringify({ type: 'status', state: 'disconnected', reason: err.message, sessionId }));
});

pipeSocket.on('close', () => {
  // Clear connect timeout to prevent double-handling
  if (connectTimeout) {
    clearTimeout(connectTimeout);
    connectTimeout = null;
  }

  console.log(`[Pipe] Disconnected from ${sessionId}`);
  cleanupPipeConnection(sessionId, conn);
  ws.send(JSON.stringify({ type: 'status', state: 'disconnected', reason: 'Session ended', sessionId }));
});
```

---

### 4. Add Rate Limiting on WebSocket Messages

**File:** `server/index.js`
**Lines:** Around 712-776 (ws.on('message') handler)
**Problem:** Client can flood server with requests, causing CPU spikes from filesystem scans.

**Implementation:**
```javascript
// Add inside wss.on('connection', (ws, req) => { ... })
// Near the beginning, after auth validation

// Rate limiting state
let messageCount = 0;
let lastRateReset = Date.now();
const MAX_MESSAGES_PER_SECOND = 10;

ws.on('message', (message) => {
  // Rate limiting check
  const now = Date.now();
  if (now - lastRateReset >= 1000) {
    messageCount = 0;
    lastRateReset = now;
  }

  messageCount++;
  if (messageCount > MAX_MESSAGES_PER_SECOND) {
    console.warn(`[WS] Rate limit exceeded for client`);
    ws.send(JSON.stringify({ type: 'error', message: 'Rate limit exceeded' }));
    // Don't close connection, just drop the message
    return;
  }

  // ... rest of existing message handling
});
```

---

### 5. Track Spawned Launcher PIDs for Cleanup

**File:** `server/index.js`
**Lines:** Around 362-370, 455-463 (spawn calls), and SIGINT handler
**Problem:** Detached launcher processes become orphans if server crashes.

**Implementation:**
```javascript
// Add near top with other state
const spawnedLaunchers = new Set();

// In handleStartFolderSession and handleCreateSession, after spawn:
const child = spawn('node', launcherArgs, {
  detached: true,
  stdio: 'ignore',
  cwd: __dirname,
  windowsHide: true
});

// Track the PID
if (child.pid) {
  spawnedLaunchers.add(child.pid);
  console.log(`[Session] Spawned launcher PID ${child.pid}, tracking ${spawnedLaunchers.size} launchers`);
}

child.unref();

// Update SIGINT handler (find existing one around line 940+)
process.on('SIGINT', () => {
  console.log('\n[Server] Shutting down...');

  // Close all WebSocket connections
  wss.clients.forEach(ws => ws.close());

  // Attempt to kill spawned launchers (best effort)
  for (const pid of spawnedLaunchers) {
    try {
      process.kill(pid, 'SIGTERM');
      console.log(`[Server] Sent SIGTERM to launcher PID ${pid}`);
    } catch (err) {
      // Process may have already exited
    }
  }
  spawnedLaunchers.clear();

  server.close(() => {
    console.log('[Server] Closed');
    process.exit(0);
  });

  // Force exit after 5 seconds if graceful shutdown fails
  setTimeout(() => {
    console.error('[Server] Forced exit after timeout');
    process.exit(1);
  }, 5000);
});
```

---

## FRONTEND FIXES

### 6. Clear Terminal Listeners on Session Switch

**File:** `client/web/app.js`
**Lines:** Around 432-490 (openFocusView function)
**Problem:** Old terminal's `onData` and `click` handlers remain active when switching sessions.

**Current Code:**
```javascript
function openFocusView(sessionId) {
  // ...
  if (!focusTerm) {
    const { term, fitAddon } = createTerminal();
    focusTerm = term;
    focusFitAddon = fitAddon;
    term.open(focusTerminal);

    term.onData((data) => {
      if (focusedSessionId) {
        sendInput(data);
      }
    });

    term.element.addEventListener('click', () => {
      showKeyboard();
    });
  } else if (!isReturningToSameSession) {
    focusTerm.clear();
  }
  // ...
}
```

**Implementation:**
```javascript
// Add state variable near top with other state
let focusTermDataDisposable = null;

function openFocusView(sessionId) {
  const isReturningToSameSession = (sessionId === lastFocusedSessionId && focusTerm);
  focusedSessionId = sessionId;

  const session = availableProjects.find(s => s.id === sessionId);
  focusSessionName.textContent = sessionId;

  if (!focusTerm) {
    const { term, fitAddon } = createTerminal();
    focusTerm = term;
    focusFitAddon = fitAddon;
    term.open(focusTerminal);

    // Store disposable so we can clean up later
    focusTermDataDisposable = term.onData((data) => {
      if (focusedSessionId) {
        sendInput(data);
      }
    });

    term.element.addEventListener('click', () => {
      showKeyboard();
    });
  } else if (!isReturningToSameSession) {
    // Dispose old data handler before clearing
    if (focusTermDataDisposable) {
      focusTermDataDisposable.dispose();
    }

    focusTerm.clear();

    // Re-attach data handler for new session
    focusTermDataDisposable = focusTerm.onData((data) => {
      if (focusedSessionId) {
        sendInput(data);
      }
    });
  }

  // ... rest of function unchanged
}
```

---

### 7. Split Panel dblclick Event Delegation

**File:** `client/web/app.js`
**Lines:** Around 498-562 (addToSplitView function)
**Problem:** Each split panel adds its own dblclick listener that stacks.

**Implementation:**
```javascript
// Add new function near setupCardEventDelegation
function setupSplitEventDelegation() {
  if (!splitContainer) return;

  splitContainer.addEventListener('dblclick', (e) => {
    const panel = e.target.closest('.split-panel');
    if (!panel) return;

    // Only trigger on terminal area, not header
    if (!e.target.closest('.split-panel-terminal')) return;

    const sessionId = panel.dataset.sessionId;
    if (sessionId) {
      openFocusView(sessionId);
    }
  });

  splitContainer.addEventListener('click', (e) => {
    const closeBtn = e.target.closest('.split-panel-close');
    if (!closeBtn) return;

    const panel = closeBtn.closest('.split-panel');
    if (panel) {
      const sessionId = panel.dataset.sessionId;
      if (sessionId) {
        removeSplitPanel(sessionId);
      }
    }
  });
}

// Call in setupEventListeners, after setupFolderEventDelegation
setupSplitEventDelegation();

// Remove inline listeners from addToSplitView:
// DELETE these lines:
//   panel.querySelector('.split-panel-close').addEventListener('click', () => {
//     removeSplitPanel(sessionId);
//   });
//   panel.querySelector('.split-panel-terminal').addEventListener('dblclick', () => {
//     openFocusView(sessionId);
//   });
```

---

### 8. Clear `loadingScrollback` on Session Disconnect

**File:** `client/web/app.js`
**Lines:** Around 79, 622, 627, and handleMessage status case (~971-981)
**Problem:** Set never cleared on disconnect, causing permanent throttle.

**Implementation:**
```javascript
// In handleMessage, in the 'status' case where state === 'disconnected':
case 'status':
  const statusSessionId = msg.sessionId || focusedSessionId;
  if (msg.state === 'connected') {
    // ... existing connected handling
  } else if (msg.state === 'disconnected') {
    // Clear any pending scrollback loading for this session
    loadingScrollback.delete(statusSessionId);

    if (statusSessionId === focusedSessionId) {
      updateFocusStatus('disconnected');
    }
    const disconnectedSession = sessions.get(statusSessionId);
    if (disconnectedSession) {
      disconnectedSession.connected = false;
      disconnectedSession.status = 'disconnected';
    }
  }
  break;
```

---

### 9. Use `msg.sessionId` Not Fallback in Message Handlers

**File:** `client/web/app.js`
**Lines:** Around 924-984 (handleMessage output/scrollback/status cases)
**Problem:** Using `focusedSessionId` as fallback can route messages to wrong session.

**Implementation:**
```javascript
case 'output':
  // REQUIRE sessionId from server, log warning if missing
  if (!msg.sessionId) {
    console.warn('[WS] Output message missing sessionId, using focusedSessionId');
  }
  const outputSessionId = msg.sessionId || focusedSessionId;
  if (outputSessionId) {
    writeOutput(outputSessionId, msg.data);
    sessionConnectionPending = false;
    // Only update focus status if this IS the focused session
    if (msg.sessionId && msg.sessionId === focusedSessionId) {
      updateFocusStatus('connected');
    }
    // ... rest unchanged
  }
  break;

case 'scrollback':
  if (!msg.sessionId) {
    console.warn('[WS] Scrollback message missing sessionId');
  }
  const scrollbackSessionId = msg.sessionId || focusedSessionId;
  // ... rest similar pattern
  break;
```

---

## CSS FIXES

### 10. Add Safe-Area Handling to Hidden Input

**File:** `client/web/style.css`
**Lines:** Around 1598-1617

**Implementation:**
```css
#hidden-input {
  position: fixed;
  left: 0;
  bottom: env(safe-area-inset-bottom, 0); /* Respect notch/Dynamic Island */
  width: 100%;
  height: 44px;
  opacity: 0.01;
  font-size: 16px;
  background: transparent;
  border: none;
  outline: none;
  z-index: -1;
}

body.keyboard-visible #hidden-input {
  z-index: 1000;
  bottom: 0; /* Keyboard handles safe area when visible */
}
```

---

### 11. Create Z-Index Hierarchy Variables

**File:** `client/web/style.css`
**Lines:** Add to :root block (around line 7-97)

**Implementation:**
```css
:root {
  /* ... existing variables ... */

  /* Z-index hierarchy - prevents collisions */
  --z-base: 1;
  --z-cards: 10;
  --z-header: 50;
  --z-modal-backdrop: 90;
  --z-modal: 100;
  --z-toast: 500;
  --z-input: 1000;
  --z-keyboard: 1001;
}

/* Then update these selectors: */
.panel-overlay { z-index: var(--z-modal-backdrop); }
.panel-content { z-index: var(--z-modal); }
.upload-status { z-index: var(--z-toast); }
#hidden-input { z-index: calc(var(--z-base) * -1); }
body.keyboard-visible #hidden-input { z-index: var(--z-keyboard); }
```

---

### 12. Complete Reduced-Motion Support

**File:** `client/web/style.css`
**Lines:** Around 2097-2130 (@media prefers-reduced-motion)

**Implementation:**
```css
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    transition-delay: 0ms !important;
  }

  /* Explicitly disable all motion-based effects */
  .session-card,
  .view.active,
  #focus-view.active,
  .status-gem,
  .activity-dot,
  .session-card-badge,
  .music-btn.playing,
  .status-badge.connecting,
  #pull-refresh-icon,
  .card-action-btn,
  .header-ctrl-btn {
    animation: none !important;
    transition: none !important;
  }

  /* Keep functional visual changes but make them instant */
  .session-card:hover,
  .card-action-btn:hover,
  .card-action-btn:active {
    transition: none;
  }
}
```

---

## TESTING CHECKLIST

After implementing all fixes, verify:

### Server
- [ ] `activeSessions` Map size stays bounded over 24+ hours
- [ ] Large file uploads don't crash server (buffer limit works)
- [ ] Rapid connect/disconnect cycles don't leave dangling timeouts
- [ ] Flooding with messages returns rate limit error, not crash
- [ ] Server shutdown kills child launcher processes

### Frontend
- [ ] Switching sessions rapidly doesn't send input to wrong session
- [ ] Split panel add/remove cycles don't accumulate event handlers
- [ ] Disconnecting during scrollback load doesn't break dashboard updates
- [ ] Messages without sessionId log warnings but still work

### iOS Safari
- [ ] Hidden input respects notch on iPhone 14/15 Pro
- [ ] Modals and toasts don't overlap incorrectly
- [ ] Reduced Motion setting disables all animations
- [ ] Touch targets all register taps reliably

---

## VERIFICATION COMMANDS

```bash
# Check for any remaining event listener issues
grep -n "addEventListener" client/web/app.js | grep -v "delegation\|once\|passive"

# Check for unbounded Maps/Sets
grep -n "new Map\|new Set" server/index.js client/web/app.js

# Check for missing clearTimeout/clearInterval
grep -n "setTimeout\|setInterval" server/index.js | head -20
grep -n "clearTimeout\|clearInterval" server/index.js | head -20
```

---

## ESTIMATED TIME

| Category | Fixes | Time |
|----------|-------|------|
| Server | 5 fixes | 45-60 min |
| Frontend JS | 4 fixes | 30-45 min |
| CSS | 3 fixes | 15-20 min |
| Testing | Full suite | 30-45 min |
| **Total** | **12 fixes** | **2-3 hours** |
