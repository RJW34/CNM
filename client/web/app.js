// Celio's Network Machine - Remote Terminal Relay Client
(function() {
  'use strict';

  // Check dependencies
  if (typeof Terminal === 'undefined') {
    document.title = 'ERR:no-xterm';
    console.error('xterm.js not loaded');
    return;
  }

  // Configuration
  const RECONNECT_DELAY = 5000;  // Longer delay for iOS self-signed cert stability
  const MAX_RECONNECT_DELAY = 60000;
  const ACTIVITY_TIMEOUT = 5000; // ms to consider session "active"
  const PREVIEW_LINES = 8;
  const SCROLLBACK_CHUNK_SIZE = 8000; // Write scrollback in chunks to prevent jitter
  const SCROLLBACK_CHUNK_DELAY = 16; // ms between chunks (one frame)

  // DOM elements
  const connectionStatus = document.getElementById('connection-status');
  if (!connectionStatus) {
    document.title = 'ERR:no-dom';
    return;
  }
  const statusTextEl = connectionStatus.querySelector('.status-text');
  const viewBtns = document.querySelectorAll('.view-btn');
  const refreshBtn = document.getElementById('refresh-btn');
  const dashboardView = document.getElementById('dashboard-view');
  const sessionCards = document.getElementById('session-cards');
  const splitView = document.getElementById('split-view');
  const splitContainer = document.getElementById('split-container');
  const focusView = document.getElementById('focus-view');
  const focusTerminal = document.getElementById('focus-terminal');
  const focusSessionName = document.getElementById('focus-session-name');
  const focusSessionStatus = document.getElementById('focus-session-status');
  const backBtn = document.getElementById('back-btn');
  const expandBtn = document.getElementById('expand-btn');
  const inputBar = document.getElementById('input-bar');
  const controlBtns = document.querySelectorAll('.header-ctrl-btn[data-key]');
  const keyboardToggle = document.getElementById('keyboard-toggle');
  const hiddenInput = document.getElementById('hidden-input');

  // State
  let ws = null;
  let reconnectDelay = RECONNECT_DELAY;
  let reconnectTimeout = null;
  let pingInterval = null;
  let availableSessions = [];
  let currentView = 'dashboard';

  // Sessions state: Map of sessionId -> { term, fitAddon, status, lastActivity, preview, connected }
  const sessions = new Map();
  let focusedSessionId = null;
  let lastFocusedSessionId = null; // Track which session the terminal was last showing (to avoid jitter on re-entry)
  let focusTerm = null;
  let focusFitAddon = null;

  // Split view state
  const splitPanels = new Map(); // sessionId -> { term, fitAddon, panel }

  // Performance: track scrollback loading state
  const loadingScrollback = new Set(); // sessionIds currently loading scrollback
  let dashboardRenderPending = false;

  // Get token from URL
  function getToken() {
    const params = new URLSearchParams(window.location.search);
    return params.get('token');
  }

  // Clear token from URL (after successful auth, cookie is set)
  function clearTokenFromUrl() {
    const url = new URL(window.location.href);
    if (url.searchParams.has('token')) {
      url.searchParams.delete('token');
      // Use replaceState to update URL without adding history entry
      window.history.replaceState({}, document.title, url.pathname + url.search + url.hash);
      console.log('[Auth] Token cleared from URL (using session cookie)');
    }
  }

  // Update connection status UI
  function setConnectionStatus(status, text) {
    // Toggle connected class on container to light up gems
    if (status === 'connected') {
      connectionStatus.classList.add('connected');
    } else {
      connectionStatus.classList.remove('connected');
    }
    statusTextEl.textContent = text;
  }

  // Create a terminal instance
  function createTerminal(options = {}) {
    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: 'block',
      fontSize: options.fontSize || 14,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      theme: {
        background: '#1a1e24',
        foreground: '#f0f8ff',
        cursor: '#2D8B57',
        cursorAccent: '#1a1e24',
        selectionBackground: 'rgba(45, 139, 87, 0.3)',
        black: '#1e2228',
        red: '#e0115f',
        green: '#2D8B57',
        yellow: '#F0A830',
        blue: '#0F52BA',
        magenta: '#9060C0',
        cyan: '#40B8B0',
        white: '#a0d0e8',
        brightBlack: '#405060',
        brightRed: '#ff3080',
        brightGreen: '#3CA870',
        brightYellow: '#FFD050',
        brightBlue: '#3070DD',
        brightMagenta: '#B080E0',
        brightCyan: '#60D8D0',
        brightWhite: '#f0f8ff'
      },
      allowProposedApi: true,
      scrollback: 10000
    });

    const fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);

    const webLinksAddon = new WebLinksAddon.WebLinksAddon();
    term.loadAddon(webLinksAddon);

    return { term, fitAddon };
  }

  // Switch view
  function switchView(viewName) {
    currentView = viewName;

    // Update view buttons
    viewBtns.forEach(btn => {
      btn.classList.toggle('active', btn.dataset.view === viewName);
    });

    // Show/hide views
    dashboardView.classList.toggle('active', viewName === 'dashboard');
    splitView.classList.toggle('active', viewName === 'split');
    focusView.classList.toggle('active', viewName === 'focus');

    // If going to dashboard, disconnect focus terminal
    if (viewName === 'dashboard') {
      focusedSessionId = null;
    }

    // Fit terminals when switching views
    if (viewName === 'focus' && focusTerm) {
      setTimeout(() => {
        focusFitAddon.fit();
        sendResize();
      }, 50);
    }

    if (viewName === 'split') {
      setTimeout(() => {
        for (const [, panel] of splitPanels) {
          panel.fitAddon.fit();
        }
      }, 50);
    }
  }

  // Render session cards in dashboard
  function renderDashboard() {
    // Update link count text
    const agentCountEl = document.getElementById('agent-count');
    if (agentCountEl) {
      if (availableSessions.length === 0) {
        agentCountEl.textContent = 'Waiting for connection';
      } else if (availableSessions.length === 1) {
        agentCountEl.textContent = '1 active link';
      } else {
        agentCountEl.textContent = `${availableSessions.length} active links`;
      }
    }

    if (availableSessions.length === 0) {
      sessionCards.innerHTML = '';
      return;
    }

    sessionCards.innerHTML = availableSessions.map(s => {
      const localSession = sessions.get(s.id) || {};

      // Use server-provided preview, fall back to local session preview, then clean it
      const rawPreview = s.preview || localSession.preview || '';
      const preview = cleanPreview(rawPreview) || 'Waiting for output...';

      // Determine activity from lastSeen timestamp
      const lastSeenAge = s.lastSeen ? (Date.now() - s.lastSeen) : Infinity;
      const isActive = lastSeenAge < ACTIVITY_TIMEOUT;
      const isHealthy = lastSeenAge < 15000; // Updated within 15s

      const activityClass = isActive ? 'active' : (isHealthy ? 'idle' : '');

      // Better status text based on actual state
      let badgeClass, badgeText;
      if (isActive) {
        badgeClass = 'working';
        badgeText = 'Active';
      } else if (isHealthy) {
        badgeClass = 'waiting';
        badgeText = 'Idle';
      } else {
        badgeClass = '';
        badgeText = 'Available';
      }

      const started = new Date(s.started);
      const ago = formatTimeAgo(started);

      // Show connected clients count
      const clientInfo = s.clientCount > 0 ? ` · ${s.clientCount} viewing` : '';

      // Truncate path smartly (show start and end)
      const maxPathLen = 45;
      let displayPath = s.cwd;
      if (displayPath.length > maxPathLen) {
        const start = displayPath.substring(0, 15);
        const end = displayPath.substring(displayPath.length - 25);
        displayPath = `${start}...${end}`;
      }

      return `
        <div class="session-card ${isActive ? 'has-activity' : ''}" data-session-id="${s.id}">
          <div class="session-card-header">
            <div class="session-card-title">
              <span class="activity-dot ${activityClass}"></span>
              <span class="session-card-name">${escapeHtml(s.id)}</span>
            </div>
            <span class="session-card-badge ${badgeClass}">${badgeText}</span>
          </div>
          <div class="session-card-path" title="${escapeHtml(s.cwd)}">${escapeHtml(displayPath)}</div>
          <div class="session-card-preview">${escapeHtml(preview)}</div>
          <div class="session-card-footer">
            <span class="session-card-time">Started ${ago}${clientInfo}</span>
            <div class="session-card-actions">
              <button class="card-action-btn" data-action="split" title="Add to split view">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                  <rect x="3" y="3" width="8" height="18" rx="1"/>
                  <rect x="13" y="3" width="8" height="18" rx="1"/>
                </svg>
              </button>
              <button class="card-action-btn" data-action="focus" title="Open in focus mode">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                  <rect x="3" y="3" width="18" height="18" rx="2"/>
                </svg>
              </button>
            </div>
          </div>
        </div>
      `;
    }).join('');

    // Add click handlers
    document.querySelectorAll('.session-card').forEach(card => {
      const sessionId = card.dataset.sessionId;

      card.addEventListener('click', (e) => {
        // If clicked on action button, don't trigger card click
        if (e.target.closest('.card-action-btn')) return;
        openFocusView(sessionId);
      });

      card.querySelector('[data-action="focus"]').addEventListener('click', (e) => {
        e.stopPropagation();
        openFocusView(sessionId);
      });

      card.querySelector('[data-action="split"]').addEventListener('click', (e) => {
        e.stopPropagation();
        addToSplitView(sessionId);
      });
    });
  }

  // Open focus view for a session
  function openFocusView(sessionId) {
    const isReturningToSameSession = (sessionId === lastFocusedSessionId && focusTerm);
    focusedSessionId = sessionId;

    const session = availableSessions.find(s => s.id === sessionId);
    focusSessionName.textContent = sessionId;

    // Create or reuse terminal
    if (!focusTerm) {
      const { term, fitAddon } = createTerminal();
      focusTerm = term;
      focusFitAddon = fitAddon;
      term.open(focusTerminal);

      // Handle terminal input
      term.onData((data) => {
        if (focusedSessionId) {
          sendInput(data);
        }
      });

      // Click to focus keyboard
      term.element.addEventListener('click', () => {
        showKeyboard();
      });
    } else if (!isReturningToSameSession) {
      // Only clear terminal when switching to a DIFFERENT session
      focusTerm.clear();
    }

    // Track which session the terminal is showing
    lastFocusedSessionId = sessionId;

    // Only reconnect if this is a new session or we don't have an active connection
    if (!isReturningToSameSession) {
      connectToSession(sessionId);
      updateFocusStatus('connecting');
    } else {
      // Returning to same session - just update status based on current state
      const sessionState = sessions.get(sessionId);
      updateFocusStatus(sessionState?.connected ? 'connected' : 'connecting');
    }

    // Switch to focus view
    switchView('focus');

    setTimeout(() => {
      focusFitAddon.fit();
      sendResize();
    }, 100);
  }

  // Update focus view status
  function updateFocusStatus(status) {
    focusSessionStatus.textContent = status.charAt(0).toUpperCase() + status.slice(1);
    focusSessionStatus.className = 'status-badge ' + status;
  }

  // Add session to split view
  function addToSplitView(sessionId) {
    // Max 4 panels
    if (splitPanels.size >= 4) {
      // Remove oldest panel
      const oldest = splitPanels.keys().next().value;
      removeSplitPanel(oldest);
    }

    // Don't add duplicates
    if (splitPanels.has(sessionId)) {
      switchView('split');
      return;
    }

    // Create panel
    const panel = document.createElement('div');
    panel.className = 'split-panel';
    panel.dataset.sessionId = sessionId;
    panel.innerHTML = `
      <div class="split-panel-header">
        <div class="split-panel-title">
          <span class="activity-dot"></span>
          <span>${sessionId}</span>
        </div>
        <button class="split-panel-close" title="Close">×</button>
      </div>
      <div class="split-panel-terminal"></div>
    `;

    // Create terminal
    const { term, fitAddon } = createTerminal({ fontSize: 11 });
    const termContainer = panel.querySelector('.split-panel-terminal');
    term.open(termContainer);

    // Store panel
    splitPanels.set(sessionId, { term, fitAddon, panel });

    // Close button
    panel.querySelector('.split-panel-close').addEventListener('click', () => {
      removeSplitPanel(sessionId);
    });

    // Click to open in focus
    panel.querySelector('.split-panel-terminal').addEventListener('dblclick', () => {
      openFocusView(sessionId);
    });

    // Add to container
    splitContainer.appendChild(panel);

    // Connect to session
    connectToSession(sessionId);

    // Switch to split view
    switchView('split');

    setTimeout(() => {
      fitAddon.fit();
    }, 50);
  }

  // Remove split panel
  function removeSplitPanel(sessionId) {
    const panel = splitPanels.get(sessionId);
    if (!panel) return;

    panel.term.dispose();
    panel.panel.remove();
    splitPanels.delete(sessionId);

    // If no panels left, go back to dashboard
    if (splitPanels.size === 0) {
      switchView('dashboard');
    }
  }

  // Connect to a session via WebSocket
  function connectToSession(sessionId) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'connect_session', sessionId }));

      // Initialize session state if not exists
      if (!sessions.has(sessionId)) {
        sessions.set(sessionId, {
          status: 'connecting',
          lastActivity: null,
          preview: '',
          connected: false
        });
      }
    }
  }

  // Write scrollback data in chunks to prevent UI jitter
  function writeScrollbackChunked(sessionId, data) {
    if (!data || data.length === 0) return;

    loadingScrollback.add(sessionId);
    let offset = 0;

    function writeChunk() {
      if (offset >= data.length) {
        loadingScrollback.delete(sessionId);
        // Render dashboard once after all scrollback loaded
        if (currentView === 'dashboard' && !dashboardRenderPending) {
          dashboardRenderPending = true;
          requestAnimationFrame(() => {
            dashboardRenderPending = false;
            renderDashboard();
          });
        }
        return;
      }

      const chunk = data.slice(offset, offset + SCROLLBACK_CHUNK_SIZE);
      offset += SCROLLBACK_CHUNK_SIZE;

      // Write to terminals without updating preview/dashboard
      if (focusedSessionId === sessionId && focusTerm) {
        focusTerm.write(chunk);
      }
      const splitPanel = splitPanels.get(sessionId);
      if (splitPanel) {
        splitPanel.term.write(chunk);
      }

      // Update preview only with last chunk
      if (offset >= data.length) {
        let session = sessions.get(sessionId);
        if (!session) {
          session = { status: 'connected', lastActivity: Date.now(), preview: '', connected: true };
          sessions.set(sessionId, session);
        }
        const cleanData = stripAnsi(data);
        session.preview = cleanData.split('\n').slice(-PREVIEW_LINES).join('\n');
        session.connected = true;
      }

      // Schedule next chunk
      setTimeout(writeChunk, SCROLLBACK_CHUNK_DELAY);
    }

    writeChunk();
  }

  // Write output to appropriate terminal(s)
  function writeOutput(sessionId, data) {
    // Update session state
    let session = sessions.get(sessionId);
    if (!session) {
      session = { status: 'connected', lastActivity: Date.now(), preview: '', connected: true };
      sessions.set(sessionId, session);
    }
    session.lastActivity = Date.now();
    session.connected = true;

    // Update preview (strip ANSI codes for preview)
    const cleanData = stripAnsi(data);
    session.preview = (session.preview + cleanData).split('\n').slice(-PREVIEW_LINES).join('\n');

    // Write to focus terminal
    if (focusedSessionId === sessionId && focusTerm) {
      focusTerm.write(data);
    }

    // Write to split panel
    const splitPanel = splitPanels.get(sessionId);
    if (splitPanel) {
      splitPanel.term.write(data);

      // Update activity indicator
      const dot = splitPanel.panel.querySelector('.activity-dot');
      dot.classList.add('active');
      clearTimeout(splitPanel.activityTimeout);
      splitPanel.activityTimeout = setTimeout(() => {
        dot.classList.remove('active');
      }, ACTIVITY_TIMEOUT);
    }

    // Update dashboard if visible (throttled during scrollback loading)
    if (currentView === 'dashboard' && !loadingScrollback.has(sessionId)) {
      if (!dashboardRenderPending) {
        dashboardRenderPending = true;
        requestAnimationFrame(() => {
          dashboardRenderPending = false;
          renderDashboard();
          // Trigger activity pulse on the card that received data
          triggerActivityPulse(sessionId);
        });
      }
    }
  }

  // Trigger activity pulse animation on a session card
  function triggerActivityPulse(sessionId) {
    const card = document.querySelector(`.session-card[data-session-id="${sessionId}"]`);
    if (card && !card.classList.contains('activity-pulse')) {
      card.classList.add('activity-pulse');
      // Remove after animation completes
      setTimeout(() => card.classList.remove('activity-pulse'), 600);
    }
  }

  // Strip ANSI escape codes
  function stripAnsi(str) {
    return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
  }

  // Clean preview text for display
  function cleanPreview(str) {
    if (!str) return '';

    return str
      // Remove common prompt patterns
      .replace(/^[>$#%]\s*/gm, '')
      .replace(/^>>\s*/gm, '')
      .replace(/^claude>\s*/gm, '')
      // Remove box drawing characters
      .replace(/[─│┌┐└┘├┤┬┴┼═║╔╗╚╝╠╣╦╩╬]/g, '')
      // Remove excessive whitespace
      .replace(/\n{3,}/g, '\n\n')
      // Trim lines
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0)
      .slice(-8)
      .join('\n')
      .trim();
  }

  // Escape HTML
  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // Format time ago
  function formatTimeAgo(date) {
    const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
    if (seconds < 60) return 'just now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
  }

  // Connect to WebSocket server
  function connect() {
    // Prevent multiple simultaneous connections
    if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
      return;
    }

    const token = getToken();

    if (!token) {
      setConnectionStatus('error', 'No token');
      return;
    }

    setConnectionStatus('', 'Connecting');

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';

    // Handle both local dev and Cloudflare deployment (walterfam.xyz/cnm)
    let wsUrl;
    if (window.location.pathname.startsWith('/cnm')) {
      // Cloudflare deployment - include /cnm prefix in WebSocket URL
      wsUrl = `${protocol}//${window.location.host}/cnm/?token=${encodeURIComponent(token)}`;
    } else {
      // Local development
      wsUrl = `${protocol}//${window.location.host}/?token=${encodeURIComponent(token)}`;
    }

    try {
      ws = new WebSocket(wsUrl);
    } catch (err) {
      setConnectionStatus('error', 'Connection failed');
      scheduleReconnect();
      return;
    }

    ws.onopen = () => {
      setConnectionStatus('connected', 'Connected');
      reconnectDelay = RECONNECT_DELAY;

      // Keep connection alive with pings (iOS Safari may close idle connections)
      if (pingInterval) clearInterval(pingInterval);
      pingInterval = setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'ping' }));
        }
      }, 25000); // Ping every 25 seconds

      // Note: We keep the token in URL for now since server sessions are in-memory
      // and would be lost on server restart. Token in URL allows easy reconnection.

      // Reconnect to active sessions
      if (focusedSessionId) {
        connectToSession(focusedSessionId);
      }
      for (const sessionId of splitPanels.keys()) {
        connectToSession(sessionId);
      }
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        handleMessage(msg);
      } catch (err) {
        console.error('[WS] Parse error:', err);
      }
    };

    ws.onclose = (event) => {
      // Clear ping interval
      if (pingInterval) {
        clearInterval(pingInterval);
        pingInterval = null;
      }

      if (event.code === 4001) {
        setConnectionStatus('error', 'Auth failed');
      } else {
        setConnectionStatus('error', 'Disconnected');
        scheduleReconnect();
      }

      // Mark sessions as disconnected
      for (const [, session] of sessions) {
        session.connected = false;
      }

      if (focusedSessionId) {
        updateFocusStatus('disconnected');
      }
    };

    ws.onerror = (err) => {
      setConnectionStatus('error', 'WS Error');
    };
  }

  // Handle incoming messages
  function handleMessage(msg) {
    switch (msg.type) {
      case 'sessions':
        availableSessions = msg.sessions || [];
        renderDashboard();
        autoConnectSessions();
        break;

      case 'output':
        // Route to correct session based on sessionId
        const outputSessionId = msg.sessionId || focusedSessionId;
        if (outputSessionId) {
          writeOutput(outputSessionId, msg.data);
          // Receiving output means we're connected
          if (outputSessionId === focusedSessionId) {
            updateFocusStatus('connected');
          }
        }
        break;

      case 'scrollback':
        // Write scrollback in chunks to prevent UI jitter
        const scrollbackSessionId = msg.sessionId || focusedSessionId;
        if (scrollbackSessionId && msg.data) {
          writeScrollbackChunked(scrollbackSessionId, msg.data);
          // Receiving scrollback means we're connected
          if (scrollbackSessionId === focusedSessionId) {
            updateFocusStatus('connected');
          }
          const scrollbackSession = sessions.get(scrollbackSessionId);
          if (scrollbackSession) scrollbackSession.connected = true;
        }
        break;

      case 'status':
        const statusSessionId = msg.sessionId || focusedSessionId;
        if (msg.state === 'connected') {
          if (statusSessionId === focusedSessionId) {
            updateFocusStatus('connected');
          }
          const session = sessions.get(statusSessionId);
          if (session) session.connected = true;
        } else if (msg.state === 'disconnected') {
          if (statusSessionId === focusedSessionId) {
            updateFocusStatus('disconnected');
          }
        }
        break;

      case 'error':
        console.error('[Server]', msg.message);
        break;

      default:
        console.log('[WS] Unknown message:', msg);
    }
  }

  // Auto-connect to all sessions for preview (disabled - causes jitter from repeated scrollback)
  function autoConnectSessions() {
    // Don't auto-connect - let user click to view session
    // This prevents 700KB+ scrollback from being sent repeatedly
  }

  // Request session list
  function requestSessions() {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'list_sessions' }));
    }
  }

  // Send input to server
  function sendInput(data) {
    if (ws && ws.readyState === WebSocket.OPEN && focusedSessionId) {
      ws.send(JSON.stringify({ type: 'input', data }));
    }
  }

  // Send control key
  function sendControl(key) {
    if (ws && ws.readyState === WebSocket.OPEN && focusedSessionId) {
      ws.send(JSON.stringify({ type: 'control', key }));
    }
  }

  // Send resize
  function sendResize() {
    if (ws && ws.readyState === WebSocket.OPEN && focusedSessionId && focusTerm) {
      ws.send(JSON.stringify({
        type: 'resize',
        cols: focusTerm.cols,
        rows: focusTerm.rows
      }));
    }
  }

  // Schedule reconnection
  function scheduleReconnect() {
    if (reconnectTimeout) {
      clearTimeout(reconnectTimeout);
    }

    reconnectTimeout = setTimeout(() => {
      connect();
      reconnectDelay = Math.min(reconnectDelay * 1.5, MAX_RECONNECT_DELAY);
    }, reconnectDelay);
  }

  // Show iOS keyboard
  function showKeyboard() {
    hiddenInput.focus();
    document.body.classList.add('keyboard-visible');
  }

  // Hide iOS keyboard
  function hideKeyboard() {
    hiddenInput.blur();
    document.body.classList.remove('keyboard-visible');
  }

  // Toggle fullscreen
  function toggleFullscreen() {
    document.body.classList.toggle('fullscreen');
    if (focusTerm) {
      setTimeout(() => {
        focusFitAddon.fit();
        sendResize();
      }, 100);
    }
  }

  // Setup mobile input
  function setupMobileInput() {
    let composing = false;

    hiddenInput.addEventListener('compositionstart', () => {
      composing = true;
    });

    hiddenInput.addEventListener('compositionend', (e) => {
      composing = false;
      if (e.data && focusedSessionId) {
        sendInput(e.data);
      }
      hiddenInput.value = '';
    });

    hiddenInput.addEventListener('input', (e) => {
      if (composing) return;

      const value = hiddenInput.value;
      if (value && focusedSessionId) {
        sendInput(value);
        hiddenInput.value = '';
      }
    });

    hiddenInput.addEventListener('keydown', (e) => {
      if (!focusedSessionId) return;

      if (e.key === 'Enter') {
        e.preventDefault();
        sendInput('\r');
        hiddenInput.value = '';
        return;
      }

      if (e.key === 'Backspace') {
        e.preventDefault();
        sendInput('\x7f');
        return;
      }

      if (e.key === 'Tab') {
        e.preventDefault();
        sendInput('\t');
        return;
      }

      const arrowKeys = {
        'ArrowUp': '\x1b[A',
        'ArrowDown': '\x1b[B',
        'ArrowRight': '\x1b[C',
        'ArrowLeft': '\x1b[D'
      };
      if (arrowKeys[e.key]) {
        e.preventDefault();
        sendInput(arrowKeys[e.key]);
        return;
      }
    });

    hiddenInput.addEventListener('blur', () => {
      document.body.classList.remove('keyboard-visible');
    });
  }

  // Setup event listeners
  function setupEventListeners() {
    // View toggle buttons
    viewBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        const view = btn.dataset.view;
        if (view === 'focus' && !focusedSessionId) {
          // If no session focused, stay on current view
          return;
        }
        switchView(view);
      });
    });

    // Refresh button with spin animation
    refreshBtn.addEventListener('click', () => {
      refreshBtn.classList.add('spinning');
      requestSessions();
      // Remove class after animation completes
      setTimeout(() => refreshBtn.classList.remove('spinning'), 800);
    });

    // Back button
    backBtn.addEventListener('click', () => {
      switchView('dashboard');
    });

    // Expand button
    expandBtn.addEventListener('click', toggleFullscreen);

    // Control buttons (in header)
    controlBtns.forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const key = btn.dataset.key;
        sendControl(key);
        // Keep keyboard open if it was open
      });
    });

    // Keyboard toggle
    keyboardToggle.addEventListener('click', (e) => {
      e.preventDefault();
      if (document.body.classList.contains('keyboard-visible')) {
        hideKeyboard();
      } else {
        showKeyboard();
      }
    });

    // Tap input bar to show keyboard
    inputBar.addEventListener('click', (e) => {
      if (e.target === keyboardToggle || e.target.closest('#keyboard-toggle')) return;
      showKeyboard();
    });

    // Window resize
    window.addEventListener('resize', () => {
      if (currentView === 'focus' && focusTerm) {
        focusFitAddon.fit();
        sendResize();
      }

      for (const [, panel] of splitPanels) {
        panel.fitAddon.fit();
      }
    });

    // Prevent iOS bounce scrolling
    document.body.addEventListener('touchmove', (e) => {
      if (e.target.closest('#dashboard-view')) return;
      if (e.target.closest('.split-panel-terminal')) return;
      if (e.target.closest('#focus-terminal')) return;
      e.preventDefault();
    }, { passive: false });
  }

  // Initialize icons - apply random icon to pull-refresh indicator
  function initIcons() {
    // Check if icons.js loaded successfully
    if (typeof getRandomIcon !== 'function') {
      console.warn('[Icons] icons.js not loaded, using default icon');
      return;
    }

    const icon = getRandomIcon();
    console.log('[Icons] Selected:', icon.name);

    // Apply to pull-refresh icon
    const pullRefreshPath = document.getElementById('pull-refresh-path');
    if (pullRefreshPath && icon) {
      pullRefreshPath.setAttribute('d', icon.path);
    }
  }

  // Pull-to-refresh functionality
  function setupPullToRefresh() {
    const dashboard = document.getElementById('dashboard-view');
    const pullRefresh = document.getElementById('pull-refresh');
    if (!dashboard || !pullRefresh) return;

    let startY = 0;
    let pulling = false;
    const threshold = 80; // pixels to pull before triggering refresh

    dashboard.addEventListener('touchstart', (e) => {
      // Only enable pull-to-refresh when scrolled to top
      if (dashboard.scrollTop === 0) {
        startY = e.touches[0].pageY;
        pulling = true;
      }
    }, { passive: true });

    dashboard.addEventListener('touchmove', (e) => {
      if (!pulling) return;

      const currentY = e.touches[0].pageY;
      const pullDistance = currentY - startY;

      if (pullDistance > 0 && dashboard.scrollTop === 0) {
        // Show pull indicator proportionally
        const progress = Math.min(pullDistance / threshold, 1);
        pullRefresh.style.height = `${Math.min(pullDistance * 0.6, 70)}px`;
        pullRefresh.style.opacity = progress;

        if (pullDistance > threshold) {
          pullRefresh.classList.add('pulling');
        } else {
          pullRefresh.classList.remove('pulling');
        }
      }
    }, { passive: true });

    dashboard.addEventListener('touchend', () => {
      if (!pulling) return;
      pulling = false;

      if (pullRefresh.classList.contains('pulling')) {
        // Trigger refresh
        pullRefresh.classList.remove('pulling');
        pullRefresh.classList.add('refreshing');

        // Pick a new random icon for next time
        if (typeof getRandomIcon === 'function') {
          const icon = getRandomIcon();
          const pullRefreshPath = document.getElementById('pull-refresh-path');
          if (pullRefreshPath && icon) {
            pullRefreshPath.setAttribute('d', icon.path);
          }
        }

        // Request sessions refresh
        requestSessions();

        // Hide after delay
        setTimeout(() => {
          pullRefresh.classList.remove('refreshing');
          pullRefresh.style.height = '0';
          pullRefresh.style.opacity = '0';
        }, 800);
      } else {
        // Snap back
        pullRefresh.style.height = '0';
        pullRefresh.style.opacity = '0';
      }
    }, { passive: true });
  }

  // Initialize
  function init() {
    initIcons();
    setupMobileInput();
    setupEventListeners();
    setupPullToRefresh();

    // Connect immediately - iOS self-signed cert stability handled by session cookie
    connect();

    // Periodic refresh of sessions
    setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        requestSessions();
      }
    }, 10000);

    // Periodic dashboard update for activity indicators (disabled - causes jitter)
    // setInterval(() => {
    //   if (currentView === 'dashboard') {
    //     renderDashboard();
    //   }
    // }, 2000);
  }

  // Start when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
