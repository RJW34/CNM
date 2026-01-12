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
  const refreshBtn = document.getElementById('refresh-btn');
  const dashboardView = document.getElementById('dashboard-view');
  const sessionCards = document.getElementById('session-cards');
  const splitView = document.getElementById('split-view');
  const splitContainer = document.getElementById('split-container');
  const splitBackBtn = document.getElementById('split-back-btn');
  const splitTitle = document.getElementById('split-title');
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
  const uploadBtn = document.getElementById('upload-btn');
  const fileInput = document.getElementById('file-input');
  const uploadStatusEl = document.getElementById('upload-status');
  const newSessionName = document.getElementById('new-session-name');
  const createSessionBtn = document.getElementById('create-session-btn');
  const folderBtn = document.getElementById('folder-btn');
  const folderPanel = document.getElementById('folder-panel');
  const folderPanelClose = document.getElementById('folder-panel-close');
  const folderList = document.getElementById('folder-list');
  const skipPermissionsToggle = document.getElementById('skip-permissions-toggle');
  const musicBtn = document.getElementById('music-btn');
  const ambientAudio = document.getElementById('ambient-audio');

  // Machine selector DOM elements
  const machineView = document.getElementById('machine-view');
  const machineCards = document.getElementById('machine-cards');
  const machineConnectionStatus = document.getElementById('machine-connection-status');
  const machineStatusText = machineConnectionStatus?.querySelector('.status-text');
  const noMachines = document.getElementById('no-machines');
  const backToMachinesBtn = document.getElementById('back-to-machines-btn');
  const currentMachineNameEl = document.getElementById('current-machine-name');

  // State
  let ws = null;  // Hub WebSocket (for machine discovery)
  let agentWs = null;  // Direct P2P WebSocket to selected agent
  let reconnectDelay = RECONNECT_DELAY;
  let reconnectTimeout = null;
  let agentReconnectTimeout = null;
  let pingInterval = null;
  let agentPingInterval = null;
  let availableProjects = []; // Unified list: all folders + active session data
  let currentView = 'machines';  // Start on machine selector

  // Machine selector state
  let availableMachines = [];
  let selectedMachine = null;  // Currently selected machine { id, hostname, address, ... }
  let lastSelectedMachineId = localStorage.getItem('cnm-machine') || null;
  const startupTime = Date.now();
  const STARTUP_GRACE_PERIOD = 15000; // 15s grace period for server startup

  // Sessions state: Map of sessionId -> { term, fitAddon, status, lastActivity, preview, connected }
  const sessions = new Map();
  let focusedSessionId = null;
  let lastFocusedSessionId = null; // Track which session the terminal was last showing (to avoid jitter on re-entry)
  let focusTerm = null;
  let focusFitAddon = null;
  let focusTermDataDisposable = null; // Disposable for terminal onData listener (prevents memory leaks)
  let sessionConnectionPending = false; // Track if we're waiting for session connection

  // Split view state
  const splitPanels = new Map(); // sessionId -> { term, fitAddon, panel }

  // Performance: track scrollback loading state
  const loadingScrollback = new Set(); // sessionIds currently loading scrollback
  let dashboardRenderPending = false;

  // Upload state
  let uploadInProgress = false;
  let uploadStatusTimeout = null;
  let pendingUploadSessionId = null; // Session ID for pending file upload

  // Create session state
  let createSessionPending = false;

  // Folder browser state
  let availableFolders = [];
  let folderSessionPending = false;

  // Ambient music state
  let musicEnabled = localStorage.getItem('cnm-music') !== 'off';
  let musicPlaying = false;
  let musicPausedByVisibility = false;  // Track if we paused due to tab hidden

  // Get token from URL
  function getToken() {
    const params = new URLSearchParams(window.location.search);
    return params.get('token');
  }

  // Safe WebSocket send with error handling
  function wsSend(data) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      console.warn('[WS] Cannot send - not connected');
      return false;
    }
    try {
      ws.send(typeof data === 'string' ? data : JSON.stringify(data));
      return true;
    } catch (err) {
      console.error('[WS] Send error:', err.message);
      return false;
    }
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
    // 'connected' = full connected, 'refreshing' = keep connected but show text, '' = disconnected
    if (status === 'connected' || status === 'refreshing') {
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

    // Show/hide views
    if (machineView) machineView.classList.toggle('active', viewName === 'machines');
    dashboardView.classList.toggle('active', viewName === 'dashboard');
    splitView.classList.toggle('active', viewName === 'split');
    focusView.classList.toggle('active', viewName === 'focus');

    // If going to dashboard, disconnect focus terminal
    if (viewName === 'dashboard') {
      focusedSessionId = null;
    }

    // If going back to machines, disconnect from agent
    if (viewName === 'machines') {
      disconnectFromAgent();
      selectedMachine = null;
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

  // ============================================================================
  // MACHINE SELECTOR
  // ============================================================================

  // Set machine connection status
  function setMachineConnectionStatus(status, text) {
    if (!machineConnectionStatus) return;

    if (status === 'connected') {
      machineConnectionStatus.classList.add('connected');
    } else {
      machineConnectionStatus.classList.remove('connected');
    }
    if (machineStatusText) machineStatusText.textContent = text;
  }

  // Render machine cards
  function renderMachineCards() {
    if (!machineCards) return;

    // Show/hide empty state
    if (noMachines) {
      noMachines.style.display = availableMachines.length === 0 ? '' : 'none';
    }

    if (availableMachines.length === 0) {
      machineCards.innerHTML = '';
      return;
    }

    machineCards.innerHTML = availableMachines.map(machine => {
      const statusClass = machine.status === 'connected' ? 'connected' : 'disconnected';
      const localClass = machine.isLocal ? 'local' : '';
      const badgeClass = machine.isLocal ? 'local' : statusClass;
      const badgeText = machine.isLocal ? 'Hub' : (machine.status === 'connected' ? 'Online' : 'Offline');

      return `
        <div class="machine-card ${statusClass} ${localClass}" data-machine-id="${escapeHtml(machine.id)}">
          <div class="machine-card-header">
            <div class="machine-card-title">
              <span class="machine-dot ${machine.isLocal ? 'local' : statusClass}"></span>
              <span class="machine-card-name">${escapeHtml(machine.hostname)}</span>
            </div>
            <span class="machine-card-badge ${badgeClass}">${badgeText}</span>
          </div>
          <div class="machine-card-info">
            <span class="machine-card-address">${escapeHtml(machine.address || 'localhost')}</span>
            <div class="machine-card-stats">
              <span class="machine-card-stat">
                <span class="count">${machine.sessionCount || 0}</span> active
              </span>
              <span class="machine-card-stat">
                <span class="count">${machine.projectCount || 0}</span> projects
              </span>
            </div>
          </div>
          <div class="machine-card-footer">
            <button class="machine-card-action" ${machine.status !== 'connected' ? 'disabled' : ''}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <path d="M8 5v14l11-7z"/>
              </svg>
              <span>Connect</span>
            </button>
          </div>
        </div>
      `;
    }).join('');
  }

  // Setup machine card click handlers (event delegation)
  function setupMachineCardDelegation() {
    if (!machineCards) return;

    machineCards.addEventListener('click', (e) => {
      const card = e.target.closest('.machine-card');
      if (!card) return;

      const machineId = card.dataset.machineId;
      const machine = availableMachines.find(m => m.id === machineId);

      if (!machine || machine.status !== 'connected') {
        showUploadStatus('error', 'Machine is offline');
        return;
      }

      selectMachine(machine);
    });
  }

  // Select a machine and connect to it
  function selectMachine(machine) {
    selectedMachine = machine;
    lastSelectedMachineId = machine.id;
    localStorage.setItem('cnm-machine', machine.id);

    // Update current machine display
    if (currentMachineNameEl) {
      currentMachineNameEl.textContent = machine.hostname;
    }

    console.log(`[Machine] Selected: ${machine.hostname} (${machine.id})`);

    // Connect to agent (P2P or local)
    if (machine.isLocal) {
      // Local machine - use the hub WebSocket directly for projects
      // The hub already has the projects/sessions
      requestProjects();
      switchView('dashboard');
    } else {
      // Remote machine - connect directly to agent
      connectToAgent(machine);
    }
  }

  // ============================================================================
  // P2P AGENT CONNECTION
  // ============================================================================

  // Connect to a remote agent
  function connectToAgent(machine) {
    if (!machine || !machine.address) {
      console.error('[Agent] No address for machine');
      return;
    }

    // Disconnect existing agent connection
    disconnectFromAgent();

    const token = getToken();
    // Use agent token (same as hub's AGENT_TOKEN for now)
    const agentUrl = `${machine.address}?token=${encodeURIComponent(token)}`;

    console.log(`[Agent] Connecting to ${machine.hostname} at ${machine.address}`);
    setConnectionStatus('', 'Connecting to ' + machine.hostname);

    try {
      agentWs = new WebSocket(agentUrl);
    } catch (err) {
      console.error('[Agent] Connection error:', err);
      showUploadStatus('error', 'Failed to connect to ' + machine.hostname);
      return;
    }

    agentWs.onopen = () => {
      console.log(`[Agent] Connected to ${machine.hostname}`);
      setConnectionStatus('connected', 'Connected to ' + machine.hostname);

      // Start agent ping
      if (agentPingInterval) clearInterval(agentPingInterval);
      agentPingInterval = setInterval(() => {
        if (agentWs && agentWs.readyState === WebSocket.OPEN) {
          agentWs.send(JSON.stringify({ type: 'ping' }));
        }
      }, 25000);

      // Request projects from agent
      agentWs.send(JSON.stringify({ type: 'list_projects' }));

      // Switch to dashboard
      switchView('dashboard');
    };

    agentWs.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        handleAgentMessage(msg);
      } catch (err) {
        console.error('[Agent] Parse error:', err);
      }
    };

    agentWs.onclose = (event) => {
      console.log(`[Agent] Disconnected from ${machine.hostname}`);
      if (agentPingInterval) {
        clearInterval(agentPingInterval);
        agentPingInterval = null;
      }

      // If we're still on dashboard for this machine, show error
      if (currentView === 'dashboard' && selectedMachine?.id === machine.id) {
        setConnectionStatus('', 'Disconnected');
        // Schedule reconnect
        scheduleAgentReconnect(machine);
      }
    };

    agentWs.onerror = (err) => {
      console.error('[Agent] WebSocket error');
      showUploadStatus('error', 'Connection error to ' + machine.hostname);
    };
  }

  // Disconnect from agent
  function disconnectFromAgent() {
    if (agentReconnectTimeout) {
      clearTimeout(agentReconnectTimeout);
      agentReconnectTimeout = null;
    }
    if (agentPingInterval) {
      clearInterval(agentPingInterval);
      agentPingInterval = null;
    }
    if (agentWs) {
      agentWs.close();
      agentWs = null;
    }
  }

  // Schedule agent reconnect
  function scheduleAgentReconnect(machine) {
    if (agentReconnectTimeout) clearTimeout(agentReconnectTimeout);
    agentReconnectTimeout = setTimeout(() => {
      if (selectedMachine?.id === machine.id && currentView === 'dashboard') {
        connectToAgent(machine);
      }
    }, RECONNECT_DELAY);
  }

  // Handle messages from agent
  function handleAgentMessage(msg) {
    switch (msg.type) {
      case 'projects':
        availableProjects = msg.projects || [];
        sessionCards.classList.remove('loading');
        renderDashboard();
        break;

      case 'sessions':
        // Legacy - convert to projects
        availableProjects = (msg.sessions || []).map(s => ({ ...s, isActive: true }));
        renderDashboard();
        break;

      case 'output':
      case 'scrollback':
      case 'status':
        // Forward to existing handlers
        handleMessage(msg);
        break;

      case 'start_folder_session_result':
      case 'upload_result':
        handleMessage(msg);
        break;

      case 'pong':
        // Heartbeat response
        break;

      case 'error':
        console.error('[Agent]', msg.message);
        break;

      default:
        console.log('[Agent] Unknown message:', msg.type);
    }
  }

  // Get the active WebSocket (agent if connected, else hub)
  function getActiveWs() {
    if (selectedMachine && !selectedMachine.isLocal && agentWs && agentWs.readyState === WebSocket.OPEN) {
      return agentWs;
    }
    return ws;
  }

  // Render project cards in dashboard (unified: active + inactive projects)
  function renderDashboard() {
    // Update link count text
    const agentCountEl = document.getElementById('agent-count');
    const emptyHintEl = document.getElementById('empty-hint');
    const activeCount = availableProjects.filter(p => p.isActive).length;
    const claudeCount = availableProjects.filter(p => p.isClaudeProject && !p.isActive).length;

    if (agentCountEl) {
      if (availableProjects.length === 0) {
        agentCountEl.textContent = 'No Projects Found';
        if (emptyHintEl) emptyHintEl.style.display = '';
      } else if (activeCount === 0 && claudeCount === 0) {
        agentCountEl.textContent = `${availableProjects.length} projects`;
        if (emptyHintEl) emptyHintEl.style.display = 'none';
      } else if (activeCount === 0) {
        // No active, but have Claude projects ready
        agentCountEl.textContent = `${claudeCount} ready · ${availableProjects.length} projects`;
        if (emptyHintEl) emptyHintEl.style.display = 'none';
      } else {
        // Show active count, and optionally Claude ready count
        const readyText = claudeCount > 0 ? ` · ${claudeCount} ready` : '';
        agentCountEl.textContent = `${activeCount} active${readyText} · ${availableProjects.length} projects`;
        if (emptyHintEl) emptyHintEl.style.display = 'none';
      }
    }

    if (availableProjects.length === 0) {
      sessionCards.innerHTML = '';
      return;
    }

    sessionCards.innerHTML = availableProjects.map(p => {
      const localSession = sessions.get(p.id) || {};

      if (p.isActive) {
        // Active project - show session info
        const rawPreview = p.preview || localSession.preview || '';
        const preview = cleanPreview(rawPreview) || 'Waiting for output...';

        // Determine activity from lastSeen timestamp
        const lastSeenAge = p.lastSeen ? (Date.now() - p.lastSeen) : Infinity;
        const isRecentlyActive = lastSeenAge < ACTIVITY_TIMEOUT;
        const isHealthy = lastSeenAge < 15000;

        const activityClass = isRecentlyActive ? 'active' : (isHealthy ? 'idle' : '');

        let badgeClass, badgeText;
        if (isRecentlyActive) {
          badgeClass = 'working';
          badgeText = 'Active';
        } else if (isHealthy) {
          badgeClass = 'waiting';
          badgeText = 'Idle';
        } else {
          badgeClass = '';
          badgeText = 'Running';
        }

        const started = new Date(p.started);
        const ago = formatTimeAgo(started);
        const clientInfo = p.clientCount > 0 ? ` · ${p.clientCount} viewing` : '';

        // Truncate path smartly
        const maxPathLen = 45;
        let displayPath = p.cwd;
        if (displayPath.length > maxPathLen) {
          const start = displayPath.substring(0, 15);
          const end = displayPath.substring(displayPath.length - 25);
          displayPath = `${start}...${end}`;
        }

        return `
          <div class="session-card ${isRecentlyActive ? 'has-activity' : ''}" data-session-id="${p.id}" data-active="true">
            <div class="session-card-header">
              <div class="session-card-title">
                <span class="activity-dot ${activityClass}"></span>
                <span class="session-card-name">${escapeHtml(p.id)}</span>
              </div>
              <span class="session-card-badge ${badgeClass}">${badgeText}</span>
            </div>
            <div class="session-card-path" title="${escapeHtml(p.cwd)}">${escapeHtml(displayPath)}</div>
            <div class="session-card-preview">${escapeHtml(preview)}</div>
            <div class="session-card-footer">
              <span class="session-card-time">Started ${ago}${clientInfo}</span>
              <div class="session-card-actions">
                <button class="card-action-btn card-upload-btn" data-action="upload" title="Upload file to project">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M9 16h6v-6h4l-7-7-7 7h4zm-4 2h14v2H5z"/>
                  </svg>
                </button>
                <button class="card-action-btn" data-action="split" title="Add to split view">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M3 5v14h8V5H3zm10 0v6h8V5h-8zm0 8v6h8v-6h-8z"/>
                  </svg>
                </button>
                <button class="card-action-btn primary" data-action="focus" title="Open in focus mode">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                    <rect x="3" y="3" width="18" height="18" rx="2"/>
                  </svg>
                  <span>Open</span>
                </button>
              </div>
            </div>
          </div>
        `;
      } else {
        // Inactive project - show start options
        const maxPathLen = 45;
        let displayPath = p.cwd;
        if (displayPath.length > maxPathLen) {
          const start = displayPath.substring(0, 15);
          const end = displayPath.substring(displayPath.length - 25);
          displayPath = `${start}...${end}`;
        }

        // Claude project indicator
        const isClaudeProject = p.isClaudeProject;
        const claudeClass = isClaudeProject ? 'claude-project' : '';
        const claudeBadge = isClaudeProject ? '<span class="claude-badge" title="Claude Code project">Claude</span>' : '';
        const hintText = isClaudeProject
          ? 'Claude Code project - ready to attach'
          : 'Click to start a Claude session';

        return `
          <div class="session-card inactive ${claudeClass}" data-session-id="${p.id}" data-active="false">
            <div class="session-card-header">
              <div class="session-card-title">
                <span class="activity-dot ${isClaudeProject ? 'claude' : 'offline'}"></span>
                <span class="session-card-name">${escapeHtml(p.id)}</span>
                ${claudeBadge}
              </div>
              <span class="session-card-badge ${isClaudeProject ? 'claude' : 'offline'}">${isClaudeProject ? 'Ready' : 'Offline'}</span>
            </div>
            <div class="session-card-path" title="${escapeHtml(p.cwd)}">${escapeHtml(displayPath)}</div>
            <div class="session-card-preview inactive-hint">${hintText}</div>
            <div class="session-card-footer">
              <span class="session-card-time">${isClaudeProject ? 'Not attached' : 'Not running'}</span>
              <div class="session-card-actions">
                <button class="card-action-btn" data-action="start" title="Start Claude session">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M8 5v14l11-7z"/>
                  </svg>
                  <span>Start</span>
                </button>
                <button class="card-action-btn" data-action="start-skip" title="Start with --dangerously-skip-permissions">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M13 3v6h4l-5 7v-6H8l5-7z"/>
                  </svg>
                  <span>Quick</span>
                </button>
              </div>
            </div>
          </div>
        `;
      }
    }).join('');

    // Event handlers are now managed via delegation in setupCardEventDelegation()
  }

  // Event delegation for session cards - single listener, no memory leaks
  function setupCardEventDelegation() {
    sessionCards.addEventListener('click', (e) => {
      const card = e.target.closest('.session-card');
      if (!card) return;

      const sessionId = card.dataset.sessionId;
      const isActive = card.dataset.active === 'true';
      const actionBtn = e.target.closest('.card-action-btn');

      if (actionBtn) {
        const action = actionBtn.dataset.action;

        if (isActive) {
          switch (action) {
            case 'focus':
              openFocusView(sessionId);
              break;
            case 'upload':
              pendingUploadSessionId = sessionId;
              fileInput.click();
              break;
            case 'split':
              addToSplitView(sessionId);
              break;
          }
        } else {
          switch (action) {
            case 'start':
              startProjectSession(sessionId, false);
              break;
            case 'start-skip':
              startProjectSession(sessionId, true);
              break;
          }
        }
        return; // Action button handled, don't trigger card click
      }

      // Card body click (not on action button)
      if (isActive) {
        openFocusView(sessionId);
      } else {
        startProjectSession(sessionId, false);
      }
    });
  }

  // Start a session for an inactive project (uses active WebSocket)
  function startProjectSession(projectId, skipPermissions) {
    const activeWs = getActiveWs();
    if (!activeWs || activeWs.readyState !== WebSocket.OPEN) {
      showUploadStatus('error', 'Not connected to server');
      return;
    }

    showUploadStatus('uploading', `Starting ${projectId}...`);

    activeWs.send(JSON.stringify({
      type: 'start_folder_session',
      folderName: projectId,
      skipPermissions
    }));
  }

  // Open focus view for a session
  function openFocusView(sessionId) {
    const isReturningToSameSession = (sessionId === lastFocusedSessionId && focusTerm);
    focusedSessionId = sessionId;

    const session = availableProjects.find(s => s.id === sessionId);
    focusSessionName.textContent = sessionId;

    // Create or reuse terminal
    if (!focusTerm) {
      const { term, fitAddon } = createTerminal();
      focusTerm = term;
      focusFitAddon = fitAddon;
      term.open(focusTerminal);

      // Handle terminal input - store disposable so we can clean up later
      focusTermDataDisposable = term.onData((data) => {
        if (focusedSessionId) {
          sendInput(data);
        }
      });

      // Click to focus keyboard
      term.element.addEventListener('click', () => {
        showKeyboard();
      });
    } else if (!isReturningToSameSession) {
      // Dispose old data handler before clearing
      if (focusTermDataDisposable) {
        focusTermDataDisposable.dispose();
      }

      // Only clear terminal when switching to a DIFFERENT session
      focusTerm.clear();

      // Re-attach data handler for new session
      focusTermDataDisposable = focusTerm.onData((data) => {
        if (focusedSessionId) {
          sendInput(data);
        }
      });
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

    // Skip animation if returning to same session
    if (isReturningToSameSession) {
      focusView.classList.add('no-animate');
    } else {
      focusView.classList.remove('no-animate');
    }

    // Switch to focus view
    switchView('focus');

    // Only fit terminal if needed (not when returning to same session with stable size)
    if (!isReturningToSameSession) {
      setTimeout(() => {
        focusFitAddon.fit();
        sendResize();
      }, 100);
    } else {
      // Just ensure terminal is focused without resize jitter
      setTimeout(() => {
        if (focusTerm) focusTerm.focus();
      }, 50);
    }
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

    // Event handlers managed via delegation in setupSplitEventDelegation()

    // Add to container
    splitContainer.appendChild(panel);

    // Connect to session
    connectToSession(sessionId);

    // Update split title with count
    if (splitTitle) {
      splitTitle.textContent = `Split View (${splitPanels.size} session${splitPanels.size !== 1 ? 's' : ''})`;
    }

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

    // Clear activity timeout to prevent memory leak
    if (panel.activityTimeout) {
      clearTimeout(panel.activityTimeout);
      panel.activityTimeout = null;
    }

    panel.term.dispose();
    panel.panel.remove();
    splitPanels.delete(sessionId);

    // Update split title
    if (splitTitle) {
      splitTitle.textContent = `Split View (${splitPanels.size} session${splitPanels.size !== 1 ? 's' : ''})`;
    }

    // If no panels left, go back to dashboard
    if (splitPanels.size === 0) {
      switchView('dashboard');
    }
  }

  // Connect to a session via WebSocket
  function connectToSession(sessionId) {
    const activeWs = getActiveWs();
    if (activeWs && activeWs.readyState === WebSocket.OPEN) {
      // Mark connection as pending until we receive confirmation
      sessionConnectionPending = true;

      activeWs.send(JSON.stringify({ type: 'connect_session', sessionId }));

      // Initialize session state if not exists
      if (!sessions.has(sessionId)) {
        sessions.set(sessionId, {
          status: 'connecting',
          lastActivity: null,
          preview: '',
          connected: false
        });
      } else {
        // Reset connected state when reconnecting
        const session = sessions.get(sessionId);
        session.connected = false;
        session.status = 'connecting';
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

  // Strip ANSI escape codes (comprehensive)
  function stripAnsi(str) {
    return str
      // CSI sequences (including private modes with ?)
      .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
      // OSC sequences (terminated by BEL or ST)
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
      // Other escape sequences
      .replace(/\x1b[PX^_][^\x1b]*\x1b\\/g, '')
      .replace(/\x1b[@-Z\\-_]/g, '')
      // Remaining escape character followed by anything
      .replace(/\x1b./g, '')
      // Control characters (except newline, tab)
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
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
    const now = new Date();
    const seconds = Math.floor((now - date) / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(seconds / 3600);
    const days = Math.floor(seconds / 86400);

    if (seconds < 60) return 'just now';
    if (minutes < 60) return `${minutes} min ago`;
    if (hours < 2) return '1 hour ago';
    if (hours < 24) return `${hours} hours ago`;
    if (days === 1) return 'yesterday';
    if (days < 7) return `${days} days ago`;

    // For older dates, show the actual date
    const options = { month: 'short', day: 'numeric' };
    if (date.getFullYear() !== now.getFullYear()) {
      options.year = 'numeric';
    }
    return date.toLocaleDateString('en-US', options);
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
      const inStartup = (Date.now() - startupTime) < STARTUP_GRACE_PERIOD;
      setConnectionStatus('', inStartup ? 'Starting...' : 'Connection failed');
      scheduleReconnect();
      return;
    }

    ws.onopen = () => {
      setConnectionStatus('connected', 'Connected');
      setMachineConnectionStatus('connected', 'Connected to Hub');
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

      // Request machine list from hub (multi-machine support)
      ws.send(JSON.stringify({ type: 'list_machines' }));

      // Reconnect to active sessions (if we're already past machine selection)
      if (selectedMachine) {
        if (focusedSessionId) {
          connectToSession(focusedSessionId);
        }
        for (const sessionId of splitPanels.keys()) {
          connectToSession(sessionId);
        }
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
        // During startup grace period, show friendlier message
        const inStartup = (Date.now() - startupTime) < STARTUP_GRACE_PERIOD;
        setConnectionStatus('', inStartup ? 'Starting...' : 'Reconnecting...');
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
      // During startup, errors are expected while server starts
      const inStartup = (Date.now() - startupTime) < STARTUP_GRACE_PERIOD;
      if (!inStartup) {
        setConnectionStatus('error', 'Connection error');
      }
    };
  }

  // Handle incoming messages
  function handleMessage(msg) {
    switch (msg.type) {
      case 'machines':
        availableMachines = msg.machines || [];
        setMachineConnectionStatus('connected', 'Connected to Hub');
        clearTokenFromUrl();
        renderMachineCards();

        // Auto-select previously selected machine if available and connected
        if (lastSelectedMachineId && currentView === 'machines') {
          const savedMachine = availableMachines.find(m => m.id === lastSelectedMachineId && m.status === 'connected');
          if (savedMachine) {
            console.log(`[Machine] Auto-selecting saved machine: ${savedMachine.hostname}`);
            selectMachine(savedMachine);
          }
        }
        break;

      case 'projects':
        availableProjects = msg.projects || [];
        sessionCards.classList.remove('loading');
        setConnectionStatus('connected', 'Connected');
        clearTokenFromUrl();  // Security: remove token from URL after successful auth
        renderDashboard();
        break;

      case 'sessions':
        // Legacy fallback - convert to projects format
        availableProjects = (msg.sessions || []).map(s => ({
          ...s,
          isActive: true
        }));
        sessionCards.classList.remove('loading');
        setConnectionStatus('connected', 'Connected');
        clearTokenFromUrl();
        renderDashboard();
        break;

      case 'output':
        // REQUIRE sessionId from server, log warning if missing
        if (!msg.sessionId) {
          console.warn('[WS] Output message missing sessionId, using focusedSessionId');
        }
        const outputSessionId = msg.sessionId || focusedSessionId;
        if (outputSessionId) {
          writeOutput(outputSessionId, msg.data);
          // Receiving output means we're connected - clear pending state
          sessionConnectionPending = false;
          // Only update focus status if this IS the focused session (and we know the sessionId)
          if (msg.sessionId && msg.sessionId === focusedSessionId) {
            updateFocusStatus('connected');
          }
          // Mark session as connected
          const outputSession = sessions.get(outputSessionId);
          if (outputSession) {
            outputSession.connected = true;
            outputSession.status = 'connected';
          }
        }
        break;

      case 'scrollback':
        // REQUIRE sessionId from server, log warning if missing
        if (!msg.sessionId) {
          console.warn('[WS] Scrollback message missing sessionId, using focusedSessionId');
        }
        const scrollbackSessionId = msg.sessionId || focusedSessionId;
        if (scrollbackSessionId && msg.data) {
          writeScrollbackChunked(scrollbackSessionId, msg.data);
          // Receiving scrollback means we're connected - clear pending state
          sessionConnectionPending = false;
          // Only update focus status if this IS the focused session (and we know the sessionId)
          if (msg.sessionId && msg.sessionId === focusedSessionId) {
            updateFocusStatus('connected');
          }
          const scrollbackSession = sessions.get(scrollbackSessionId);
          if (scrollbackSession) {
            scrollbackSession.connected = true;
            scrollbackSession.status = 'connected';
          }
        }
        break;

      case 'status':
        const statusSessionId = msg.sessionId || focusedSessionId;
        if (msg.state === 'connected') {
          // Clear pending state - connection confirmed
          sessionConnectionPending = false;
          if (statusSessionId === focusedSessionId) {
            updateFocusStatus('connected');
          }
          const session = sessions.get(statusSessionId);
          if (session) {
            session.connected = true;
            session.status = 'connected';
          }
        } else if (msg.state === 'disconnected') {
          // Clear any pending scrollback loading for this session (prevents permanent throttle)
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

      case 'upload_result':
        uploadInProgress = false;
        if (msg.success) {
          showUploadStatus('success', `Uploaded ${msg.filename}`);
          console.log(`[Upload] Success: ${msg.filename} -> ${msg.path}`);
        } else {
          showUploadStatus('error', msg.error || 'Upload failed');
          console.error('[Upload] Failed:', msg.error);
        }
        break;

      case 'create_session_result':
        createSessionPending = false;
        if (createSessionBtn) createSessionBtn.disabled = false;

        if (msg.success) {
          showUploadStatus('success', `Created ${msg.projectName}`);
          console.log(`[Session] Created: ${msg.projectName} at ${msg.path}`);
          // Clear input and refresh sessions
          if (newSessionName) newSessionName.value = '';
          requestSessions();
        } else {
          showUploadStatus('error', msg.error || 'Failed to create session');
          console.error('[Session] Creation failed:', msg.error);
        }
        break;

      case 'folders':
        availableFolders = msg.folders || [];
        renderFolderList();
        break;

      case 'start_folder_session_result':
        folderSessionPending = false;
        if (msg.success) {
          if (msg.alreadyRunning) {
            showUploadStatus('success', `${msg.folderName} already running`);
          } else {
            const mode = msg.skipPermissions ? ' (skip permissions)' : '';
            showUploadStatus('success', `Started ${msg.folderName}${mode}`);
          }
          console.log(`[Session] Started: ${msg.folderName}`);
          // Refresh project list after short delay to let session register
          setTimeout(() => requestProjects(), 1500);
        } else {
          showUploadStatus('error', msg.error || 'Failed to start session');
          console.error('[Session] Start failed:', msg.error);
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

  // Request project list (unified: all folders + active session data)
  function requestProjects() {
    const activeWs = getActiveWs();
    if (activeWs && activeWs.readyState === WebSocket.OPEN) {
      // Show loading state
      sessionCards.classList.add('loading');
      setConnectionStatus('refreshing', 'Connecting');
      activeWs.send(JSON.stringify({ type: 'list_projects' }));
    }
  }

  // Legacy alias
  function requestSessions() {
    requestProjects();
  }

  // Send input to server (uses active WebSocket - hub or agent)
  function sendInput(data) {
    if (!focusedSessionId) return;

    const activeWs = getActiveWs();
    if (!activeWs || activeWs.readyState !== WebSocket.OPEN) {
      console.warn('[Input] Cannot send - not connected');
      return;
    }

    // Check if session is connected before sending
    const session = sessions.get(focusedSessionId);
    if (!session || !session.connected) {
      // Still send - server will buffer if connection is establishing
      console.log('[Input] Session not connected yet, input may be delayed');
    }
    activeWs.send(JSON.stringify({ type: 'input', data }));
  }

  // Send control key (uses active WebSocket - hub or agent)
  function sendControl(key) {
    if (!focusedSessionId) return;

    const activeWs = getActiveWs();
    if (activeWs && activeWs.readyState === WebSocket.OPEN) {
      activeWs.send(JSON.stringify({ type: 'control', key }));
    }
  }

  // Send resize (uses active WebSocket - hub or agent)
  function sendResize() {
    if (!focusedSessionId || !focusTerm) return;

    const activeWs = getActiveWs();
    if (activeWs && activeWs.readyState === WebSocket.OPEN) {
      activeWs.send(JSON.stringify({
        type: 'resize',
        cols: focusTerm.cols,
        rows: focusTerm.rows
      }));
    }
  }

  // Show upload status toast
  function showUploadStatus(type, message) {
    if (!uploadStatusEl) return;

    // Clear any existing timeout
    if (uploadStatusTimeout) {
      clearTimeout(uploadStatusTimeout);
      uploadStatusTimeout = null;
    }

    uploadStatusEl.textContent = message;
    uploadStatusEl.className = `upload-status ${type} visible`;

    // Auto-hide success/error after 3 seconds
    if (type !== 'uploading') {
      uploadStatusTimeout = setTimeout(() => {
        uploadStatusEl.classList.remove('visible');
      }, 3000);
    }
  }

  // Hide upload status toast
  function hideUploadStatus() {
    if (uploadStatusEl) {
      uploadStatusEl.classList.remove('visible');
    }
    if (uploadStatusTimeout) {
      clearTimeout(uploadStatusTimeout);
      uploadStatusTimeout = null;
    }
  }

  // Upload a file to a session's working directory (uses active WebSocket)
  function uploadFile(file, sessionId) {
    if (!sessionId) {
      showUploadStatus('error', 'No session selected');
      return;
    }

    const activeWs = getActiveWs();
    if (!activeWs || activeWs.readyState !== WebSocket.OPEN) {
      showUploadStatus('error', 'Not connected to server');
      return;
    }

    if (uploadInProgress) {
      showUploadStatus('error', 'Upload already in progress');
      return;
    }

    // Check file size client-side (10MB limit)
    const maxSize = 10 * 1024 * 1024;
    if (file.size > maxSize) {
      const maxMB = Math.round(maxSize / 1024 / 1024);
      showUploadStatus('error', `File too large (max ${maxMB}MB)`);
      return;
    }

    // Find session name for status message
    const session = availableProjects.find(s => s.id === sessionId);
    const sessionName = session ? session.id : sessionId;

    uploadInProgress = true;
    showUploadStatus('uploading', `Uploading to ${sessionName}...`);

    // Capture activeWs reference for use in callback
    const uploadWs = activeWs;
    const reader = new FileReader();

    reader.onload = () => {
      try {
        // Extract base64 from data URL (format: "data:mime/type;base64,XXXXX")
        const dataUrl = reader.result;
        const base64 = dataUrl.split(',')[1];

        if (uploadWs && uploadWs.readyState === WebSocket.OPEN) {
          uploadWs.send(JSON.stringify({
            type: 'upload_file',
            sessionId: sessionId,
            filename: file.name,
            data: base64,
            size: file.size
          }));
        } else {
          uploadInProgress = false;
          showUploadStatus('error', 'Connection lost during upload');
        }
      } catch (err) {
        uploadInProgress = false;
        showUploadStatus('error', 'Failed to encode file');
        console.error('[Upload] Encoding error:', err);
      }
    };

    reader.onerror = () => {
      uploadInProgress = false;
      showUploadStatus('error', 'Failed to read file');
      console.error('[Upload] Read error:', reader.error);
    };

    reader.readAsDataURL(file);
  }

  // Create a new session
  function createNewSession() {
    if (!newSessionName) return;

    const projectName = newSessionName.value.trim();

    // Validate project name
    if (!projectName) {
      showUploadStatus('error', 'Enter a project name');
      newSessionName.focus();
      return;
    }

    // Basic sanitization check (server will do full validation)
    if (!/^[a-zA-Z0-9_-]+$/.test(projectName)) {
      showUploadStatus('error', 'Use only letters, numbers, - and _');
      newSessionName.focus();
      return;
    }

    if (projectName.length > 50) {
      showUploadStatus('error', 'Name too long (max 50 chars)');
      newSessionName.focus();
      return;
    }

    if (!ws || ws.readyState !== WebSocket.OPEN) {
      showUploadStatus('error', 'Not connected to server');
      return;
    }

    if (createSessionPending) {
      showUploadStatus('error', 'Session creation in progress');
      return;
    }

    createSessionPending = true;
    createSessionBtn.disabled = true;
    showUploadStatus('uploading', `Creating ${projectName}...`);

    ws.send(JSON.stringify({
      type: 'create_session',
      projectName
    }));
  }

  // Open folder panel
  function openFolderPanel() {
    if (folderPanel) {
      folderPanel.classList.add('visible');
      folderBtn.classList.add('active');
      requestFolders();
    }
  }

  // Close folder panel
  function closeFolderPanel() {
    if (folderPanel) {
      folderPanel.classList.remove('visible');
      folderBtn.classList.remove('active');
    }
  }

  // Request folder list from server
  function requestFolders() {
    if (ws && ws.readyState === WebSocket.OPEN) {
      folderList.innerHTML = '<p class="folder-loading">Loading folders...</p>';
      ws.send(JSON.stringify({ type: 'list_folders' }));
    }
  }

  // Render folder list
  function renderFolderList() {
    if (!folderList) return;

    if (availableFolders.length === 0) {
      folderList.innerHTML = `
        <div class="folder-empty">
          <p>No folders found</p>
          <p class="hint">Create folders in Documents\\Code</p>
        </div>
      `;
      return;
    }

    folderList.innerHTML = availableFolders.map(folder => {
      const statusText = folder.hasSession ? 'Session active' : 'Click to start';
      const hasSessionClass = folder.hasSession ? 'has-session' : '';

      return `
        <div class="folder-item ${hasSessionClass}" data-folder="${escapeHtml(folder.name)}">
          <div class="folder-icon">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/>
            </svg>
          </div>
          <div class="folder-info">
            <div class="folder-name">${escapeHtml(folder.name)}</div>
            <div class="folder-status">${statusText}</div>
          </div>
          <div class="folder-action">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <path d="M8 5v14l11-7z"/>
            </svg>
          </div>
        </div>
      `;
    }).join('');

    // Event handlers managed via delegation in setupFolderEventDelegation()
  }

  // Event delegation for folder list - single listener, no memory leaks
  function setupFolderEventDelegation() {
    if (!folderList) return;

    folderList.addEventListener('click', (e) => {
      const item = e.target.closest('.folder-item');
      if (!item) return;

      const folderName = item.dataset.folder;
      if (folderName) {
        startFolderSession(folderName);
      }
    });
  }

  // Event delegation for split container - prevents listener stacking on panel add/remove
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

  // Start a session in a folder
  function startFolderSession(folderName) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      showUploadStatus('error', 'Not connected to server');
      return;
    }

    if (folderSessionPending) {
      showUploadStatus('error', 'Session start in progress');
      return;
    }

    folderSessionPending = true;
    const skipPermissions = skipPermissionsToggle ? skipPermissionsToggle.checked : false;

    showUploadStatus('uploading', `Starting ${folderName}...`);

    ws.send(JSON.stringify({
      type: 'start_folder_session',
      folderName,
      skipPermissions
    }));
  }

  // Ambient music controls
  function initMusic() {
    if (!ambientAudio || !musicBtn) return;

    // Set initial volume
    ambientAudio.volume = 0.25;

    // Update button state from saved preference
    updateMusicButton();

    // Handle tab visibility changes - pause when hidden, resume when visible
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        // Tab is hidden - pause music if playing
        if (musicPlaying) {
          musicPausedByVisibility = true;
          ambientAudio.pause();
          musicPlaying = false;
          updateMusicButton();
          console.log('[Music] Paused (tab hidden)');
        }
      } else {
        // Tab is visible again - resume if we paused it
        if (musicPausedByVisibility && musicEnabled) {
          musicPausedByVisibility = false;
          playMusic();
          console.log('[Music] Resumed (tab visible)');
        }
      }
    });

    // Only auto-play if tab is visible
    if (musicEnabled && !document.hidden) {
      // Try to play - will fail silently if no user interaction yet
      playMusic();
    }
  }

  function updateMusicButton() {
    if (!musicBtn) return;

    if (musicEnabled && musicPlaying) {
      musicBtn.classList.add('playing');
      musicBtn.classList.remove('muted');
    } else if (musicEnabled && !musicPlaying) {
      musicBtn.classList.remove('playing', 'muted');
    } else {
      musicBtn.classList.add('muted');
      musicBtn.classList.remove('playing');
    }
  }

  function toggleMusic() {
    musicEnabled = !musicEnabled;
    localStorage.setItem('cnm-music', musicEnabled ? 'on' : 'off');

    if (musicEnabled) {
      playMusic();
    } else {
      pauseMusic();
    }
  }

  function playMusic() {
    if (!ambientAudio || !musicEnabled) return;

    // Don't play if tab is hidden
    if (document.hidden) {
      console.log('[Music] Tab hidden, will play when visible');
      return;
    }

    ambientAudio.play()
      .then(() => {
        musicPlaying = true;
        musicPausedByVisibility = false;
        updateMusicButton();
      })
      .catch(err => {
        // Autoplay blocked - will play on next user interaction
        console.log('[Music] Autoplay blocked, waiting for interaction');
        musicPlaying = false;
        updateMusicButton();
      });
  }

  function pauseMusic() {
    if (!ambientAudio) return;

    ambientAudio.pause();
    musicPlaying = false;
    updateMusicButton();
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

  // Show iOS keyboard - improved for Safari reliability
  function showKeyboard() {
    // Clear any previous value to ensure clean state
    hiddenInput.value = '';

    // Use setTimeout to ensure focus happens after current event loop
    // This helps iOS Safari properly show the keyboard
    setTimeout(() => {
      hiddenInput.focus();
      document.body.classList.add('keyboard-visible');

      // Scroll terminal into view if needed
      if (focusTerm) {
        focusTerm.scrollToBottom();
      }
    }, 10);
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
    // Refresh button with spin animation
    refreshBtn.addEventListener('click', () => {
      refreshBtn.classList.add('spinning');
      requestSessions();
      // Remove class after animation completes
      setTimeout(() => refreshBtn.classList.remove('spinning'), 800);
    });

    // Folder button
    if (folderBtn) {
      folderBtn.addEventListener('click', () => {
        if (folderPanel.classList.contains('visible')) {
          closeFolderPanel();
        } else {
          openFolderPanel();
        }
      });
    }

    // Folder panel close button
    if (folderPanelClose) {
      folderPanelClose.addEventListener('click', closeFolderPanel);
    }

    // Close folder panel when clicking outside
    if (folderPanel) {
      folderPanel.addEventListener('click', (e) => {
        if (e.target === folderPanel) {
          closeFolderPanel();
        }
      });
    }

    // Music toggle button
    if (musicBtn) {
      musicBtn.addEventListener('click', () => {
        toggleMusic();
      });
    }

    // Back button (focus view)
    backBtn.addEventListener('click', () => {
      switchView('dashboard');
    });

    // Back to machines button (dashboard view)
    if (backToMachinesBtn) {
      backToMachinesBtn.addEventListener('click', () => {
        switchView('machines');
        // Re-request machines list to refresh
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'list_machines' }));
        }
      });
    }

    // Back button (split view)
    if (splitBackBtn) {
      splitBackBtn.addEventListener('click', () => {
        switchView('dashboard');
      });
    }

    // Expand button
    expandBtn.addEventListener('click', toggleFullscreen);

    // Upload button and file input
    if (uploadBtn && fileInput) {
      uploadBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        // Set pending session to current focused session
        pendingUploadSessionId = focusedSessionId;
        fileInput.click();
      });

      fileInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file && pendingUploadSessionId) {
          uploadFile(file, pendingUploadSessionId);
        }
        // Reset input and pending session
        fileInput.value = '';
        pendingUploadSessionId = null;
      });
    }

    // Control buttons (in header)
    controlBtns.forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const key = btn.dataset.key;
        sendControl(key);
        // Re-focus keyboard after control key to maintain input flow
        if (document.body.classList.contains('keyboard-visible')) {
          showKeyboard();
        }
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

    // Create new session
    if (createSessionBtn && newSessionName) {
      createSessionBtn.addEventListener('click', () => {
        createNewSession();
      });

      newSessionName.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          createNewSession();
        }
      });
    }

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

    // Prevent iOS bounce scrolling - only on non-scrollable areas
    // IMPORTANT: Be very selective to avoid blocking legitimate interactions
    document.body.addEventListener('touchmove', (e) => {
      // Allow all scrolling in these containers
      if (e.target.closest('#dashboard-view')) return;
      if (e.target.closest('.split-panel-terminal')) return;
      if (e.target.closest('#focus-terminal')) return;
      if (e.target.closest('.folder-list')) return;
      if (e.target.closest('.panel-content')) return;
      // Only prevent on the app container itself (background areas)
      if (e.target.id === 'app' || e.target === document.body) {
        e.preventDefault();
      }
    }, { passive: false });

    // Setup event delegation for session cards (prevents memory leaks)
    setupCardEventDelegation();

    // Setup event delegation for folder list (prevents memory leaks)
    setupFolderEventDelegation();

    // Setup event delegation for split container (prevents memory leaks)
    setupSplitEventDelegation();
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
        pullRefresh.style.height = `${Math.min(pullDistance * 0.6, 56)}px`;
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
    initMusic();
    setupMobileInput();
    setupEventListeners();
    setupPullToRefresh();
    setupMachineCardDelegation();

    // Connect immediately - iOS self-signed cert stability handled by session cookie
    connect();

    // Periodic refresh based on current view
    setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        if (currentView === 'machines') {
          // Refresh machine list when on machine selector
          ws.send(JSON.stringify({ type: 'list_machines' }));
        } else if (selectedMachine) {
          // Refresh projects when viewing a specific machine
          if (selectedMachine.isLocal) {
            requestProjects();
          } else if (agentWs && agentWs.readyState === WebSocket.OPEN) {
            agentWs.send(JSON.stringify({ type: 'list_projects' }));
          }
        }
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
