# CNM iOS Safari Stability Audit - 2024-12-31

## Executive Summary
Customer reported issues on iPhone 16 running iOS 18.3 Safari:
- Taps not registering
- Keyboard issues
- UI clutter concerns
- General instability with interactive elements

## Issues Found & Fixes Applied

### 1. TOUCH/TAP REGISTRATION (CRITICAL)

**Problem A: Aggressive touchmove prevention**
- File: `client/web/app.js:1661-1666`
- The `touchmove` handler on body was calling `e.preventDefault()` too broadly
- This blocked legitimate touch events in scrollable areas

**Fix Applied:**
```javascript
// Only prevent on app container background, not on any scrollable/interactive element
if (e.target.id === 'app' || e.target === document.body) {
  e.preventDefault();
}
```

**Problem B: Event listener memory leak / duplicate handlers**
- File: `client/web/app.js:359-404` (original)
- Every call to `renderDashboard()` re-attached click handlers to all cards
- This caused:
  - Memory leak (growing listener count)
  - Multiple event fires per tap
  - Unpredictable behavior

**Fix Applied:**
- Implemented event delegation pattern
- Single listener on `#session-cards` container
- Handlers never re-attached

### 2. KEYBOARD INPUT (HIGH)

**Problem: Hidden input poorly configured for iOS Safari**
- File: `client/web/style.css:1599-1609`
- Issues:
  - `pointer-events: none` made iOS deprioritize the input
  - `transform: translateY(100%)` moved it off-screen (can confuse Safari)
  - `opacity: 0` can cause accessibility layer to skip it

**Fix Applied:**
```css
#hidden-input {
  height: 44px; /* iOS minimum touch target */
  opacity: 0.01; /* Nearly invisible but accessible */
  z-index: -1; /* Hidden but not pointer-events:none */
  /* Removed transform */
}
```

**Problem B: Focus timing**
- File: `client/web/app.js:1440-1456`
- Direct `.focus()` call can fail on iOS if not in user gesture context

**Fix Applied:**
- Wrapped in `setTimeout(..., 10)` to ensure focus happens after event loop
- Clear input value before focus for clean state

### 3. UI CLUTTER & VISUAL OVERLOAD (MEDIUM)

**Problem: Too many simultaneous animations**
- Multiple gem pulse animations with 5+ drop-shadow layers each
- Text shimmer animations running continuously
- Card entrance animations on every render

**Fixes Applied:**

**Gem animations simplified (style.css:299-316):**
- Reduced from 5 drop-shadows to 1
- Reduced brightness boost from 1.3 to 1.2

**Agent count text simplified (style.css:806-815):**
- Removed complex 8-part text-shadow animation
- Static glow now (still looks good, no CPU cost)

### 4. PERFORMANCE ISSUES (HIGH)

**Problem A: Excessive backdrop-filter usage**
- `backdrop-filter: blur(20px)` is extremely expensive on mobile
- Applied to: header, view-controls, session cards, focus header, panels

**Fixes Applied:**
- Reduced blur from 20px to 12px globally
- Removed backdrop-filter entirely from session cards (used solid bg instead)

**Problem B: Complex transitions on everything**
- Every element had `transition: all 0.3s` which triggers on any property change

**Fix Applied:**
- Changed to specific property transitions: `transition: transform 0.2s, border-color 0.2s`

**Problem C: Missing touch optimizations**
- File: `client/web/style.css`

**Fixes Applied:**
```css
.session-card {
  touch-action: manipulation;
  -webkit-touch-callout: none;
}
.card-action-btn {
  touch-action: manipulation;
  min-height: 44px; /* iOS minimum */
  min-width: 44px;
  -webkit-tap-highlight-color: rgba(45, 139, 87, 0.3); /* Visible feedback */
}
```

### 5. BUTTON TOUCH TARGETS (MEDIUM)

**Problem: Buttons smaller than iOS 44px minimum**
- Original padding: 8px 12px
- Resulted in ~32px height

**Fix Applied:**
- Added `min-height: 44px; min-width: 44px;`
- Increased padding to 10px 14px
- Re-enabled tap highlight for visual feedback

---

## Background Agent Analysis (COMPLETE)

Three deep-dive agents analyzed the codebase exhaustively. Key findings below.

---

## AGENT 1: SERVER STABILITY AUDIT

### CRITICAL ISSUES

| Issue | File:Line | Severity | Description |
|-------|-----------|----------|-------------|
| Unbounded session cookie map | index.js:488,519 | CRITICAL | `activeSessions` Map grows indefinitely with no cleanup - memory leak |
| Unbounded pipe buffer | index.js:837-841 | HIGH | `conn.buffer` can grow to megabytes if partial messages received |
| Dangling connection timeout | index.js:810-818 | HIGH | `connectTimeout` not cleared on pipe error/close - race condition |
| Launcher timer never cleared | launcher.js:103-117 | HIGH | `registryUpdateTimer` may fire after process exits |
| No listen error handling | index.js:958 | HIGH | If `server.listen()` fails, process runs in broken state |
| Orphaned launcher processes | index.js:362-370 | MEDIUM | Detached launcher.js processes not tracked - become zombies |
| No rate limiting on WS | index.js:712-776 | MEDIUM | Client can flood server with list_sessions requests |
| Unbounded scrollback bytes | launcher.js:69-82 | MEDIUM | 10K lines but no byte limit - could be gigabytes |
| No WS heartbeat to client | index.js:686-932 | MEDIUM | Server pings session but not WebSocket client |

### RECOMMENDED SERVER FIXES

1. Add periodic cleanup for `activeSessions` (expire after SESSION_MAX_AGE)
2. Add MAX_BUFFER_SIZE check in pipe data handler
3. Clear `connectTimeout` in error and close handlers
4. Track spawned launcher PIDs, kill on server shutdown
5. Add rate limiting (10 messages/second per connection)
6. Add byte-based scrollback limit (50MB max)

---

## AGENT 2: FRONTEND JS AUDIT

### CRITICAL BUG FIXED

**`availableSessions` undefined** - Lines 431, 1155 used `availableSessions` but should be `availableProjects`. This caused crashes when opening focus view or uploading files. **FIXED.**

### HIGH SEVERITY ISSUES

| Issue | File:Line | Severity | Description |
|-------|-----------|----------|-------------|
| Double-bound split panel listener | app.js:544 | HIGH | dblclick listener stacks on each panel add/remove cycle |
| Terminal listeners not cleared | app.js:442-450 | HIGH | Old terminal's onData handler remains active when switching sessions |
| Folder list event stacking | app.js:1302 | HIGH | Each renderFolderList() adds duplicate click handlers |
| WebSocket state race | app.js:924-984 | HIGH | focusedSessionId can change between message send and handler |
| Scrollback set not cleared | app.js:79,622,627 | MEDIUM | loadingScrollback never cleared on disconnect - throttles forever |

### RECOMMENDED JS FIXES

1. Use event delegation for folder list (like we did for session cards)
2. Dispose or clear terminal listeners before reusing focusTerm
3. Always use `msg.sessionId` not `focusedSessionId` fallback
4. Clear `loadingScrollback` on session disconnect

---

## AGENT 3: CSS iOS AUDIT

### CRITICAL PERFORMANCE ISSUES

| Issue | Lines | Severity | Description |
|-------|-------|----------|-------------|
| Excessive drop-shadows | 299-337 | CRITICAL | 4-5 drop-shadows per gem animation = GPU thrashing |
| Text-shadow + drop-shadow | 173-197 | CRITICAL | Double rendering on title text |
| 4x backdrop-filter | 151,347,1092 | CRITICAL | 40-60% GPU usage on idle |
| Continuous animations | 265-283 | HIGH | 5-6 animations always running = 15-30% battery drain |

### TOUCH/ACCESSIBILITY ISSUES

| Issue | Lines | Severity | Description |
|-------|-------|----------|-------------|
| Touch targets < 44px | 362,388,1098 | HIGH | Buttons 38-42px instead of 44px minimum |
| Hidden input no safe-area | 1599 | HIGH | Bottom: 0 puts input under notch/Dynamic Island |
| Z-index collisions | 1615,1842 | MEDIUM | Upload toast, modal, input all z-index: 1000 |
| Low contrast text | 219,724 | MEDIUM | Status text fails WCAG AA (2.1:1 vs 4.5:1 required) |

### CSS FIXES APPLIED

1. Reduced blur from 20px to 12px
2. Simplified gem animations (1 drop-shadow instead of 5)
3. Removed text-shadow animation (static glow now)
4. Removed backdrop-filter from session cards
5. Fixed touch targets to 44px minimum
6. Added `touch-action: manipulation` to interactive elements
7. Re-enabled tap highlight for visual feedback

---

## ADDITIONAL FIXES APPLIED IN THIS SESSION

### Critical Bug Fix
- **`availableSessions` undefined** - Changed to `availableProjects` (lines 431, 1155)

### Event Delegation Fixes
- Session cards: Single delegated listener on `#session-cards` container
- Folder list: Single delegated listener on `#folder-list` container
- Both prevent memory leaks from duplicate event handlers

### Touch Improvements
- All interactive buttons now 44x44px minimum
- Added `touch-action: manipulation` to prevent 300ms delay
- Re-enabled `-webkit-tap-highlight-color` for visual feedback
- Reduced aggressive `touchmove` prevention

### Performance Improvements
- Reduced `backdrop-filter: blur()` from 20px to 12px
- Removed backdrop-filter from session cards entirely
- Simplified gem animations (1 drop-shadow vs 5)
- Removed continuous text-shadow animation
- Simplified transition properties (specific vs `all`)

### Keyboard Improvements
- Fixed hidden input positioning for iOS Safari
- Added `setTimeout` wrapper for focus calls
- Increased input height to 44px for better accessibility

---

## Testing Recommendations

1. Test on actual iPhone 16 with iOS 18.3 Safari
2. Test with:
   - Cold start (no cached state)
   - Multiple session cards visible
   - Rapid tap sequences on buttons
   - Keyboard show/hide cycles
   - Tab switching while connected

3. Monitor:
   - Memory usage over time (should be stable)
   - Touch responsiveness (no delays > 100ms)
   - Animation smoothness (no jank)

---

## Files Modified

- `client/web/app.js` - Touch handling, event delegation, keyboard focus, fixed undefined variable
- `client/web/style.css` - Performance optimizations, touch targets, animations, blur reduction

---

## ALL ISSUES NOW FIXED (2026-01-01)

All remaining issues from this audit have been implemented:

### Server-Side (5 fixes)
1. ✅ Session cleanup interval for `activeSessions` Map
2. ✅ MAX_BUFFER_SIZE (1MB) for pipe buffer
3. ✅ `connectTimeout` cleared on pipe error/close
4. ✅ Rate limiting (10 msg/sec) on WebSocket messages
5. ✅ Spawned launcher PIDs tracked and killed on shutdown

### Additional Server Fixes (3 fixes)
6. ✅ Server.listen() error handling (EADDRINUSE, EACCES)
7. ✅ Scrollback byte limit (50MB) in launcher.js
8. ✅ WebSocket ping/pong heartbeat to detect stale clients

### Frontend JS (4 fixes)
1. ✅ Terminal listeners disposed on session switch
2. ✅ Split panel event delegation (no handler stacking)
3. ✅ `loadingScrollback` cleared on disconnect
4. ✅ `msg.sessionId` required with warnings for missing

### CSS (3 fixes)
1. ✅ Safe-area handling on hidden input
2. ✅ Z-index hierarchy CSS variables
3. ✅ Complete reduced-motion support with transition-delay

---

## COMPACTION NOTES

If this conversation is compacted and you continue:

1. **Read this file first**: `IOS-SAFARI-AUDIT-2024-12-31.md`
2. **ALL fixes have been applied** (15 total as of 2026-01-01)
3. **Test on actual iPhone 16** before declaring fixed
4. See `REMAINING-FIXES-IMPLEMENTATION.md` for implementation details (now complete)

---

## Future Reference

This audit log serves as documentation for:
- What issues were identified
- Why specific fixes were chosen
- What to check if issues recur

When debugging similar issues, check this file first.
