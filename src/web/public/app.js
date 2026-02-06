// Spellbook - Mission Control for Development
// Multi-Session Planning Architecture

const API_BASE = '/api';

// ==================== TYPE LOOKUP MAPS ====================

/** Maps item type to its plural API endpoint name */
const TYPE_TO_ENDPOINT = { bug: 'bugs', improvement: 'improvements', feature: 'features' };

/** Maps item type to its "done" status value */
const TYPE_TO_DONE_STATUS = { bug: 'resolved', improvement: 'completed', feature: 'complete' };

/** Maps item type to its branch prefix */
const TYPE_TO_BRANCH_PREFIX = { bug: 'fix', improvement: 'improvement', feature: 'feature' };

// ==================== PERFORMANCE CONFIGURATION ====================

const PERF_CONFIG = {
  // Polling intervals (ms)
  KANBAN_POLL_INTERVAL: 10000,        // Was 5000, reduced frequency
  GIT_SYNC_POLL_INTERVAL: 30000,      // Git sync polling
  DOC_REFRESH_INTERVAL: 5000,         // Was 3000, reduced frequency

  // Terminal resize debounce
  RESIZE_DEBOUNCE_MS: 100,            // Debounce resize events

  // Fit terminal retry config
  FIT_RETRY_DELAYS: [100, 300, 600],  // Reduced from 4 attempts to 3

  // Debug mode - set to false for production
  DEBUG_MODE: false,
};

// Debug logger that respects config
function debugLog(...args) {
  if (PERF_CONFIG.DEBUG_MODE) {
    console.log(...args);
  }
}

// Track active timeouts for cleanup
const activeTimeouts = new Set();

function safeSetTimeout(callback, delay) {
  const id = setTimeout(() => {
    activeTimeouts.delete(id);
    callback();
  }, delay);
  activeTimeouts.add(id);
  return id;
}

function safeClearTimeout(id) {
  if (id) {
    clearTimeout(id);
    activeTimeouts.delete(id);
  }
}

// Track visibility state for pausing polling when tab is hidden
let isPageVisible = true;
document.addEventListener('visibilitychange', () => {
  isPageVisible = document.visibilityState === 'visible';
  if (isPageVisible) {
    // Resume polling when page becomes visible
    fetchData().then(() => renderKanban());
  }
});

// ==================== SESSION CLEANUP ====================

/**
 * Properly cleanup a terminal session to prevent memory leaks
 * Disconnects ResizeObserver, removes window event listeners, closes WebSocket, disposes terminal
 */
function cleanupSession(session) {
  if (!session) return;

  // Clear any pending resize timeouts
  if (session.resizeTimeout) {
    clearTimeout(session.resizeTimeout);
    session.resizeTimeout = null;
  }
  if (session.windowResizeTimeout) {
    clearTimeout(session.windowResizeTimeout);
    session.windowResizeTimeout = null;
  }

  // Disconnect ResizeObserver if exists
  if (session.resizeObserver) {
    try {
      session.resizeObserver.disconnect();
    } catch (e) {
      // Ignore errors during cleanup
    }
    session.resizeObserver = null;
  }

  // Remove window resize listener if exists
  if (session.handleWindowResize) {
    window.removeEventListener('resize', session.handleWindowResize);
    session.handleWindowResize = null;
  }

  // Close WebSocket
  if (session.ws) {
    try {
      session.ws.close();
    } catch (e) {
      // Ignore errors during cleanup
    }
    session.ws = null;
  }

  // Dispose terminal
  if (session.term) {
    try {
      session.term.dispose();
    } catch (e) {
      // Ignore errors during cleanup
    }
    session.term = null;
  }

  // Clear fitAddon reference
  session.fitAddon = null;
}

// Helper: Send command to terminal with separate Enter key (required for PTY)
function sendTerminalCommand(ws, text, callback) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  // Send the text
  ws.send(JSON.stringify({ type: 'input', data: text }));
  // Send Enter as separate message after small delay
  setTimeout(() => {
    ws.send(JSON.stringify({ type: 'input', data: '\r' }));
    if (callback) setTimeout(callback, 100);
  }, 50);
}

// Helper: Check if terminal is scrolled to bottom (within threshold)
function isTerminalAtBottom(term, threshold = 50) {
  const buffer = term.buffer.active;
  const viewportY = buffer.viewportY;
  const baseY = buffer.baseY;
  return baseY - viewportY <= threshold;
}

// Helper: Smart scroll - only scroll to bottom if user was already at bottom
function smartScrollToBottom(term) {
  if (isTerminalAtBottom(term)) {
    term.scrollToBottom();
  }
}

// Helper: Setup drag-and-drop and paste image functionality for terminal containers
function setupTerminalDropZone(container, session) {
  if (!container || !session) {
    debugLog('[DropZone] Missing container or session', { container, session });
    return;
  }

  debugLog('[DropZone] Setting up drop zone for', container.id || container.className);

  // Allowed file types for drag and drop
  const allowedImageTypes = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml'];
  const allowedFileExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.pdf', '.txt', '.md', '.json', '.js', '.ts', '.py', '.sh'];

  function isAllowedFile(file) {
    if (allowedImageTypes.includes(file.type)) return true;
    const ext = '.' + file.name.split('.').pop().toLowerCase();
    return allowedFileExtensions.includes(ext);
  }

  function isImageFile(file) {
    return allowedImageTypes.includes(file.type) || file.type.startsWith('image/');
  }

  async function uploadFile(file) {
    debugLog('[DropZone] Uploading file:', file.name, file.type, file.size);
    const formData = new FormData();
    formData.append('file', file);

    try {
      const response = await fetch(`${API_BASE}/upload`, {
        method: 'POST',
        body: formData,
      });

      debugLog('[DropZone] Upload response status:', response.status);

      if (!response.ok) {
        const error = await response.json();
        console.error('[DropZone] Upload failed:', error);
        return null;
      }

      const data = await response.json();
      debugLog('[DropZone] Upload success:', data);
      return data.path;
    } catch (err) {
      console.error('[DropZone] Upload error:', err);
      return null;
    }
  }

  function injectIntoTerminal(filePath, isImage) {
    debugLog('[DropZone] Injecting into terminal:', filePath, 'isImage:', isImage);
    debugLog('[DropZone] Session state:', {
      hasWs: !!session.ws,
      wsState: session.ws?.readyState,
      hasTerm: !!session.term,
    });

    // Method 1: Use WebSocket if connected
    if (session.ws?.readyState === WebSocket.OPEN) {
      const message = isImage
        ? `Please analyze this image: ${filePath}`
        : `I've uploaded a file: ${filePath}`;
      debugLog('[DropZone] Sending via WebSocket:', message);
      sendTerminalCommand(session.ws, message);
      return;
    }

    // Method 2: Use term.write if terminal exists
    if (session.term) {
      const message = isImage
        ? `Please analyze this image: ${filePath}`
        : `I've uploaded a file: ${filePath}`;
      debugLog('[DropZone] Writing via term.write:', message);
      session.term.write(message + '\r');
      return;
    }

    console.error('[DropZone] No way to inject into terminal - no WebSocket or term available');
  }

  // Get the actual xterm screen element for better event targeting
  const getDropTarget = () => {
    const xtermScreen = container.querySelector('.xterm-screen');
    return xtermScreen || container;
  };

  // Prevent default for all drag events to enable drop
  const preventDefaults = (e) => {
    e.preventDefault();
    e.stopPropagation();
  };

  // Add event listeners to both container and xterm-screen (when available)
  const addDropListeners = (target) => {
    // Drag enter/over handler
    target.addEventListener('dragenter', (e) => {
      preventDefaults(e);
      container.classList.add('drag-over');
      debugLog('[DropZone] Drag enter on', target.className);
    }, { capture: true });

    target.addEventListener('dragover', (e) => {
      preventDefaults(e);
      container.classList.add('drag-over');
    }, { capture: true });

    // Drag leave handler
    target.addEventListener('dragleave', (e) => {
      preventDefaults(e);
      // Only remove highlight if leaving the container entirely
      if (!container.contains(e.relatedTarget)) {
        container.classList.remove('drag-over');
      }
    }, { capture: true });

    // Drop handler
    target.addEventListener('drop', async (e) => {
      preventDefaults(e);
      container.classList.remove('drag-over');
      debugLog('[DropZone] Drop event received!', e.dataTransfer.files);

      const files = Array.from(e.dataTransfer.files);
      debugLog('[DropZone] Files dropped:', files.length, files.map(f => f.name));

      const validFiles = files.filter(isAllowedFile);
      debugLog('[DropZone] Valid files:', validFiles.length);

      if (validFiles.length === 0) {
        debugLog('[DropZone] No valid files to upload');
        // Show feedback in terminal
        if (session.term) {
          session.term.write('\r\n[Spellbook] No valid files dropped. Supported: images, pdf, txt, md, json, js, ts, py, sh\r\n');
        }
        return;
      }

      for (const file of validFiles) {
        // Show upload progress
        if (session.term) {
          session.term.write(`\r\n[Spellbook] Uploading ${file.name}...\r\n`);
        }

        const filePath = await uploadFile(file);
        if (filePath) {
          injectIntoTerminal(filePath, isImageFile(file));
        } else {
          if (session.term) {
            session.term.write(`\r\n[Spellbook] Failed to upload ${file.name}\r\n`);
          }
        }
      }
    }, { capture: true });
  };

  // Add listeners to container immediately
  addDropListeners(container);

  // Also try to add to xterm-screen after a delay (xterm might not be rendered yet)
  setTimeout(() => {
    const xtermScreen = container.querySelector('.xterm-screen');
    if (xtermScreen) {
      debugLog('[DropZone] Found .xterm-screen, adding listeners');
      addDropListeners(xtermScreen);
    }
  }, 500);

  // Paste handler for images from clipboard (attach to document to catch all pastes when terminal focused)
  const handlePaste = async (e) => {
    // Only handle if terminal is focused or mouse is over container
    if (!container.contains(document.activeElement) && !container.matches(':hover')) {
      return;
    }

    const items = Array.from(e.clipboardData?.items || []);
    const imageItems = items.filter(item => item.type.startsWith('image/'));

    if (imageItems.length === 0) return;

    e.preventDefault();
    debugLog('[DropZone] Paste event with images:', imageItems.length);

    for (const item of imageItems) {
      const blob = item.getAsFile();
      if (!blob) continue;

      // Create a proper file with a name
      const extension = blob.type.split('/')[1] || 'png';
      const fileName = `clipboard-${Date.now()}.${extension}`;
      const file = new File([blob], fileName, { type: blob.type });

      // Show progress
      if (session.term) {
        session.term.write(`\r\n[Spellbook] Uploading pasted image...\r\n`);
      }

      const filePath = await uploadFile(file);
      if (filePath) {
        injectIntoTerminal(filePath, true);
      }
    }
  };

  // Attach paste handler to document (will filter based on focus)
  document.addEventListener('paste', handlePaste);

  debugLog('[DropZone] Terminal drop zone initialized for', container.id || 'terminal');
}

// ==================== STATE ====================

const state = {
  project: null,
  bugs: [],
  improvements: [],
  features: [],
  worktrees: [],
  inbox: [],
  kanbanFilter: 'all',
  kanbanPriorityFilter: 'all',
  kanbanSort: 'newest',
  kanbanSearch: '',
  inboxFilter: 'all',
  selectedInboxItem: null,
  currentView: 'kanban', // 'dashboard' | 'kanban' | 'inbox' | 'investigate' | 'terminals' | 'knowledge'
  knowledgeBase: [],
  dashboardLoaded: false,
  kbCategory: 'all',
  selectedKBDoc: null,
};

// Investigation sessions
const investigations = {
  sessions: {}, // { 'inv-1': { id, type, question, terminalId, term, ws, fitAddon, status } }
  activeSession: null,
  nextId: 1,
};

// Session management
const sessions = {
  quickChat: {
    terminalId: null,
    term: null,
    fitAddon: null,
    ws: null,
    tmuxSession: null,
  },
  worktreeTerminal: {
    terminalId: null,
    term: null,
    fitAddon: null,
    ws: null,
    tmuxSession: null,
  },
  // { 'improvement-32': { terminalId, term, ws, fitAddon, itemType, itemNumber, docPath, planContent, planExists, tmuxSession, ... } }
  planning: {},
  activePlanningSession: null, // Currently visible planning session key
};

// Session persistence storage key
const SESSION_STORAGE_KEY = 'spellbook-sessions';

// Document refresh interval
let docRefreshInterval = null;

// Kanban polling interval
let kanbanInterval = null;

// ==================== SESSION PERSISTENCE ====================

/**
 * Save session info to localStorage for reconnection after refresh
 */
function saveSessionsToStorage() {
  const persistedSessions = {};

  // Save planning sessions that have tmux
  for (const [key, session] of Object.entries(sessions.planning)) {
    if (session.tmuxSession) {
      persistedSessions[key] = {
        tmuxSession: session.tmuxSession,
        itemType: session.itemType,
        itemNumber: session.itemNumber,
        docPath: session.docPath,
        workingDir: session.workingDir,
      };
    }
  }

  // Save quickchat if it has tmux
  if (sessions.quickChat?.tmuxSession) {
    persistedSessions['quickChat'] = {
      tmuxSession: sessions.quickChat.tmuxSession,
    };
  }

  localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(persistedSessions));
  debugLog('[Spellbook] Saved sessions to storage:', Object.keys(persistedSessions));
}

/**
 * Load saved session info from localStorage
 */
function loadSessionsFromStorage() {
  try {
    const stored = localStorage.getItem(SESSION_STORAGE_KEY);
    if (!stored) return {};
    return JSON.parse(stored);
  } catch (err) {
    console.error('[Spellbook] Failed to load sessions from storage:', err);
    return {};
  }
}

/**
 * Clear saved sessions from localStorage
 */
function clearSessionsFromStorage() {
  localStorage.removeItem(SESSION_STORAGE_KEY);
}

/**
 * Check for persisted tmux sessions and offer to reconnect
 */
async function checkPersistedSessions() {
  try {
    const res = await fetch(`${API_BASE}/terminals/persisted`);
    const data = await res.json();

    if (!data.available || !data.sessions || data.sessions.length === 0) {
      debugLog('[Spellbook] No persisted tmux sessions found');
      return;
    }

    debugLog('[Spellbook] Found persisted tmux sessions:', data.sessions);

    // Load our saved session mapping
    const savedSessions = loadSessionsFromStorage();
    const matchedSessions = [];

    // Match persisted tmux sessions with our saved session keys
    for (const tmuxSession of data.sessions) {
      // Check if we have a saved session that matches this tmux session
      for (const [key, savedInfo] of Object.entries(savedSessions)) {
        if (savedInfo.tmuxSession === tmuxSession.name) {
          matchedSessions.push({
            key,
            tmuxSession: tmuxSession.name,
            ...savedInfo,
            created: tmuxSession.created,
          });
        }
      }
    }

    if (matchedSessions.length === 0) {
      debugLog('[Spellbook] No matching sessions to reconnect');
      return;
    }

    // Show reconnection prompt
    showReconnectPrompt(matchedSessions);

  } catch (err) {
    console.error('[Spellbook] Failed to check persisted sessions:', err);
  }
}

/**
 * Show a prompt to reconnect to persisted sessions
 */
function showReconnectPrompt(matchedSessions) {
  const container = document.createElement('div');
  container.id = 'reconnect-prompt';
  container.className = 'fixed top-4 right-4 z-50 bg-spellbook-card border border-spellbook-accent rounded-lg shadow-lg p-4 max-w-md';

  const planningMatches = matchedSessions.filter(s => s.key !== 'quickChat');
  const hasQuickChat = matchedSessions.some(s => s.key === 'quickChat');

  container.innerHTML = `
    <div class="flex items-start justify-between mb-3">
      <div class="flex items-center gap-2">
        <span class="text-spellbook-accent text-lg">&#9889;</span>
        <h3 class="font-semibold text-spellbook-text">Reconnect Sessions</h3>
      </div>
      <button onclick="dismissReconnectPrompt()" class="text-spellbook-muted hover:text-spellbook-text">&times;</button>
    </div>
    <p class="text-sm text-spellbook-muted mb-3">
      Found ${matchedSessions.length} session${matchedSessions.length !== 1 ? 's' : ''} from your previous visit:
    </p>
    <div class="space-y-2 mb-4">
      ${hasQuickChat ? `
        <div class="flex items-center justify-between p-2 bg-spellbook-bg rounded">
          <span class="text-sm text-spellbook-text">Quick Chat</span>
          <button onclick="reconnectSession('quickChat')" class="px-2 py-1 text-xs bg-spellbook-accent/20 text-spellbook-accent rounded hover:bg-spellbook-accent/30">
            Reconnect
          </button>
        </div>
      ` : ''}
      ${planningMatches.map(s => `
        <div class="flex items-center justify-between p-2 bg-spellbook-bg rounded">
          <span class="text-sm text-spellbook-text">${s.key}</span>
          <button onclick="reconnectSession('${s.key}')" class="px-2 py-1 text-xs bg-spellbook-accent/20 text-spellbook-accent rounded hover:bg-spellbook-accent/30">
            Reconnect
          </button>
        </div>
      `).join('')}
    </div>
    <div class="flex gap-2">
      <button onclick="reconnectAllSessions()" class="flex-1 px-3 py-2 bg-spellbook-accent text-spellbook-bg text-sm rounded hover:bg-spellbook-accent/80">
        Reconnect All
      </button>
      <button onclick="dismissReconnectPrompt(true)" class="px-3 py-2 bg-spellbook-card border border-spellbook-border text-spellbook-muted text-sm rounded hover:border-red-400 hover:text-red-400">
        Dismiss
      </button>
    </div>
  `;

  document.body.appendChild(container);

  // Store matched sessions for reconnection
  window._pendingReconnectSessions = matchedSessions;
}

/**
 * Dismiss the reconnect prompt
 */
function dismissReconnectPrompt(clearStorage = false) {
  const prompt = document.getElementById('reconnect-prompt');
  if (prompt) {
    prompt.remove();
  }
  if (clearStorage) {
    clearSessionsFromStorage();
  }
  delete window._pendingReconnectSessions;
}

/**
 * Reconnect to a specific session
 */
async function reconnectSession(sessionKey) {
  const savedSessions = loadSessionsFromStorage();
  const savedInfo = savedSessions[sessionKey];

  if (!savedInfo) {
    console.error('[Spellbook] No saved info for session:', sessionKey);
    return;
  }

  try {
    const res = await fetch(`${API_BASE}/terminals/reconnect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionName: savedInfo.tmuxSession,
        cwd: savedInfo.workingDir || state.project?.path,
      }),
    });

    if (!res.ok) {
      const err = await res.json();
      console.error('[Spellbook] Failed to reconnect:', err);
      updateActivity(`Failed to reconnect ${sessionKey}: ${err.error}`);
      return;
    }

    const data = await res.json();
    debugLog('[Spellbook] Reconnected session:', data);

    if (sessionKey === 'quickChat') {
      sessions.quickChat.terminalId = data.terminalId;
      sessions.quickChat.tmuxSession = data.tmuxSession;
      await connectTerminal('quickChat', document.getElementById('quick-chat-terminal'));
      updateActivity('Quick Chat reconnected');
    } else {
      // Reconnect planning session
      sessions.planning[sessionKey] = {
        terminalId: data.terminalId,
        term: null,
        ws: null,
        fitAddon: null,
        itemType: savedInfo.itemType,
        itemNumber: savedInfo.itemNumber,
        docPath: savedInfo.docPath,
        planContent: null,
        planExists: false,
        status: 'active',
        workingDir: savedInfo.workingDir,
        tmuxSession: data.tmuxSession,
      };

      updateActivity(`Reconnected to ${sessionKey}`);
      refreshItermSessionsForPills();
    }

    // Update storage
    saveSessionsToStorage();

    // Remove this session from pending list
    if (window._pendingReconnectSessions) {
      window._pendingReconnectSessions = window._pendingReconnectSessions.filter(s => s.key !== sessionKey);
      if (window._pendingReconnectSessions.length === 0) {
        dismissReconnectPrompt();
      } else {
        // Refresh prompt
        dismissReconnectPrompt();
        showReconnectPrompt(window._pendingReconnectSessions);
      }
    }

  } catch (err) {
    console.error('[Spellbook] Failed to reconnect session:', err);
    updateActivity(`Failed to reconnect ${sessionKey}`);
  }
}

/**
 * Reconnect all pending sessions
 */
async function reconnectAllSessions() {
  const pendingSessions = window._pendingReconnectSessions || [];
  dismissReconnectPrompt();

  for (const session of pendingSessions) {
    await reconnectSession(session.key);
  }
}

/**
 * Save session before page unload
 */
function setupUnloadHandler() {
  window.addEventListener('beforeunload', () => {
    // Save session state
    saveSessionsToStorage();

    // Clean up all active timeouts
    activeTimeouts.forEach(id => clearTimeout(id));
    activeTimeouts.clear();

    // Clean up polling intervals
    if (gitSyncInterval) clearInterval(gitSyncInterval);
    if (docRefreshInterval) clearInterval(docRefreshInterval);
    if (kanbanInterval) clearInterval(kanbanInterval);

    // Clean up all sessions
    if (sessions.quickChat) {
      cleanupSession(sessions.quickChat);
    }
    Object.values(sessions.planning).forEach(session => {
      cleanupSession(session);
    });
    Object.values(investigations.sessions).forEach(session => {
      cleanupSession(session);
    });
  });
}

// Current planning doc tab
let currentPlanningTab = 'document';

// ==================== INITIALIZATION ====================

document.addEventListener('DOMContentLoaded', async () => {
  // Initialize view state first - ensure kanban view is properly displayed
  switchMainView('kanban');

  await loadProjects();
  await fetchData();
  await loadWorktrees();
  await loadBranch();
  await loadKnowledgeBase();
  await loadRecentActivity();
  startGitSyncPolling();
  renderKanban();
  initDragAndDrop();
  updateStats();
  startItermSessionsRefresh();

  // Initialize planning view close button - single handler only
  const closePlanningBtn = document.getElementById('close-planning-btn');
  if (closePlanningBtn) {
    closePlanningBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      debugLog('[Spellbook] Close button clicked');
      closePlanningView();
    });
  }

  // Set up session persistence
  setupUnloadHandler();

  // Removed: tmux session reconnection - now using external iTerm
  // await checkPersistedSessions();

  // Start Quick Chat terminal
  if (!sessions.quickChat?.terminalId) {
    await initQuickChatTerminal();
  }

  // Extra fit() calls after initialization to handle layout timing
  // The browser needs time to compute dimensions after DOM is rendered
  setTimeout(handleResize, 100);
  setTimeout(handleResize, 500);
  setTimeout(handleResize, 1000);

  // Resize handler with debouncing
  let resizeTimeout = null;
  window.addEventListener('resize', () => {
    if (resizeTimeout) clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(handleResize, PERF_CONFIG.RESIZE_DEBOUNCE_MS);
  });

  // Start polling for kanban updates (pauses when tab is hidden)
  kanbanInterval = setInterval(async () => {
    if (!isPageVisible) return; // Skip polling when tab is hidden
    await fetchData();
    await loadRecentActivity();
    renderKanban();
    updateStats();
  }, PERF_CONFIG.KANBAN_POLL_INTERVAL);
});

function handleResize() {
  // Resize Quick Chat terminal
  if (sessions.quickChat?.fitAddon) {
    sessions.quickChat.fitAddon.fit();
  }
  // Resize Worktree terminal
  if (sessions.worktreeTerminal?.fitAddon) {
    sessions.worktreeTerminal.fitAddon.fit();
  }
  // Resize active planning terminal
  if (sessions.activePlanningSession) {
    const session = sessions.planning[sessions.activePlanningSession];
    if (session?.fitAddon) {
      session.fitAddon.fit();
    }
  }
}

// ==================== PROJECT LOADING ====================

async function loadProjects() {
  try {
    const res = await fetch(`${API_BASE}/projects`);
    const data = await res.json();

    const selector = document.getElementById('project-selector');
    selector.innerHTML = data.projects.map(p =>
      `<option value="${p.id}" ${p.id === data.current ? 'selected' : ''}>${p.name}</option>`
    ).join('');

    state.project = data.projects.find(p => p.id === data.current);

    selector.addEventListener('change', async (e) => {
      await fetch(`${API_BASE}/projects/switch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: e.target.value }),
      });
      window.location.reload();
    });
  } catch (err) {
    console.error('Failed to load projects:', err);
  }
}

async function fetchData() {
  try {
    const res = await fetch(`${API_BASE}/status`);
    const data = await res.json();
    state.bugs = data.bugs || [];
    state.improvements = data.improvements || [];
    state.features = data.features || [];
    state.inbox = data.inbox || [];
    updateInboxBadge();
  } catch (err) {
    console.error('Failed to fetch data:', err);
  }
}

// Refresh kanban board - fetches fresh data and re-renders
async function refreshKanban() {
  const refreshBtn = document.querySelector('[onclick="refreshKanban()"]');
  if (refreshBtn) {
    refreshBtn.textContent = '↻ Refreshing...';
    refreshBtn.disabled = true;
  }

  try {
    await fetchData();
    renderKanban();
    updateStats();
    updateActivity('Kanban board refreshed');
  } catch (err) {
    console.error('Failed to refresh kanban:', err);
  } finally {
    if (refreshBtn) {
      refreshBtn.textContent = '↻ Refresh';
      refreshBtn.disabled = false;
    }
  }
}

function updateInboxBadge() {
  const badge = document.getElementById('inbox-badge');
  if (badge) {
    badge.textContent = state.inbox.length;
    badge.style.display = state.inbox.length > 0 ? 'inline' : 'none';
  }
}

async function loadBranch() {
  try {
    const res = await fetch(`${API_BASE}/git/branch`);
    const data = await res.json();
    document.getElementById('branch-display').textContent = `branch: ${data.branch}`;
  } catch (err) {
    console.error('Failed to load branch:', err);
  }
}

// ==================== GIT SYNC STATUS ====================

let gitSyncInterval = null;

// Toast notification system for better error display
function showToast(message, type = 'info', duration = 5000) {
  const container = document.getElementById('toast-container');
  if (!container) {
    debugLog(`[Toast ${type}]`, message);
    return;
  }

  const toast = document.createElement('div');
  const colors = {
    error: 'bg-red-500/90 border-red-400',
    warning: 'bg-yellow-500/90 border-yellow-400 text-black',
    success: 'bg-green-500/90 border-green-400',
    info: 'bg-blue-500/90 border-blue-400',
  };

  toast.className = `${colors[type] || colors.info} border rounded-lg px-4 py-3 shadow-lg text-sm font-medium animate-slide-in flex items-start gap-2 max-w-full`;

  const icons = {
    error: '⚠️',
    warning: '⚡',
    success: '✓',
    info: 'ℹ️',
  };

  toast.innerHTML = `
    <span class="shrink-0">${icons[type] || icons.info}</span>
    <span class="flex-1">${message}</span>
    <button onclick="this.parentElement.remove()" class="shrink-0 opacity-70 hover:opacity-100 ml-2">×</button>
  `;

  container.appendChild(toast);

  if (duration > 0) {
    setTimeout(() => {
      toast.classList.add('animate-slide-out');
      setTimeout(() => toast.remove(), 300);
    }, duration);
  }
}

// Load uncommitted changes status
async function loadUncommittedStatus() {
  const indicator = document.getElementById('uncommitted-indicator');
  const dot = document.getElementById('uncommitted-dot');
  const text = document.getElementById('uncommitted-text');
  const filesList = document.getElementById('uncommitted-files');

  if (!indicator || !dot || !text) return;

  try {
    const res = await fetch(`${API_BASE}/git/uncommitted`);
    const data = await res.json();

    if (data.error || !data.hasUncommitted) {
      indicator.classList.add('hidden');
      return;
    }

    indicator.classList.remove('hidden');

    const { count, files, modifiedCount, stagedCount, untrackedCount } = data;

    // Set text
    const parts = [];
    if (stagedCount > 0) parts.push(`${stagedCount} staged`);
    if (modifiedCount > 0) parts.push(`${modifiedCount} modified`);
    if (untrackedCount > 0) parts.push(`${untrackedCount} untracked`);
    text.textContent = parts.length > 0 ? parts.join(', ') : `${count} uncommitted`;

    // Set color based on severity
    if (count > 10) {
      dot.className = 'w-2 h-2 rounded-full bg-red-500';
      text.className = 'text-red-400';
      indicator.className = indicator.className.replace('border-spellbook-border', 'border-red-500/50');
    } else if (count > 5) {
      dot.className = 'w-2 h-2 rounded-full bg-yellow-500';
      text.className = 'text-yellow-400';
      indicator.className = indicator.className.replace('border-spellbook-border', 'border-yellow-500/50');
    } else {
      dot.className = 'w-2 h-2 rounded-full bg-yellow-500';
      text.className = 'text-yellow-400';
      indicator.className = indicator.className.replace(/border-(red|yellow)-500\/50/g, 'border-spellbook-border');
    }

    // Populate tooltip with file list
    if (filesList) {
      filesList.innerHTML = files.slice(0, 20).map(f => {
        const statusColors = {
          added: 'text-green-400',
          deleted: 'text-red-400',
          modified: 'text-yellow-400',
          renamed: 'text-blue-400',
          untracked: 'text-gray-400',
          conflict: 'text-red-500',
        };
        const statusIcons = {
          added: '+',
          deleted: '-',
          modified: '~',
          renamed: 'R',
          untracked: '?',
          conflict: '!',
        };
        return `<div class="truncate ${statusColors[f.status] || 'text-spellbook-text'}">${statusIcons[f.status] || '~'} ${f.path}</div>`;
      }).join('');

      if (files.length > 20) {
        filesList.innerHTML += `<div class="text-spellbook-muted mt-1">...and ${files.length - 20} more</div>`;
      }
    }
  } catch (err) {
    console.error('Failed to load uncommitted status:', err);
    indicator.classList.add('hidden');
  }
}

// Load comparison between develop and main
async function loadMainComparison() {
  const indicator = document.getElementById('main-comparison-indicator');
  const dot = document.getElementById('main-comparison-dot');
  const text = document.getElementById('main-comparison-text');
  const tooltip = document.getElementById('main-comparison-tooltip');
  const pullMainBtn = document.getElementById('pull-main-btn');

  if (!indicator || !dot || !text) return;

  try {
    const res = await fetch(`${API_BASE}/git/main-comparison`);
    const data = await res.json();

    if (data.error) {
      dot.className = 'w-2 h-2 rounded-full bg-gray-500';
      text.textContent = 'error';
      text.className = 'text-gray-400';
      return;
    }

    const { developAheadOfMain, developBehindMain, synced, currentBranch } = data;

    if (synced) {
      dot.className = 'w-2 h-2 rounded-full bg-green-500';
      text.textContent = 'synced';
      text.className = 'text-green-400';
      if (tooltip) tooltip.textContent = 'develop is in sync with origin/main';
      if (pullMainBtn) pullMainBtn.classList.add('hidden');
    } else if (developBehindMain > 0 && developAheadOfMain === 0) {
      // Only behind - need to pull main
      let severity = 'blue';
      if (developBehindMain > 10) severity = 'red';
      else if (developBehindMain > 3) severity = 'yellow';
      dot.className = `w-2 h-2 rounded-full bg-${severity}-500`;
      text.textContent = `↓${developBehindMain} behind`;
      text.className = `text-${severity}-400`;
      if (tooltip) tooltip.textContent = `develop is ${developBehindMain} commits behind origin/main. Pull main to sync.`;
      if (pullMainBtn) pullMainBtn.classList.remove('hidden');
    } else if (developAheadOfMain > 0 && developBehindMain === 0) {
      // Only ahead - develop has commits not in main (normal state before PR merge)
      dot.className = 'w-2 h-2 rounded-full bg-blue-500';
      text.textContent = `↑${developAheadOfMain} ahead`;
      text.className = 'text-blue-400';
      if (tooltip) tooltip.textContent = `develop is ${developAheadOfMain} commits ahead of origin/main. Create a PR to merge into main.`;
      if (pullMainBtn) pullMainBtn.classList.add('hidden');
    } else {
      // Both ahead and behind - diverged
      const severity = developBehindMain > 5 ? 'red' : 'yellow';
      dot.className = `w-2 h-2 rounded-full bg-${severity}-500`;
      text.textContent = `↓${developBehindMain} ↑${developAheadOfMain}`;
      text.className = `text-${severity}-400`;
      if (tooltip) tooltip.textContent = `develop has diverged from origin/main: ${developAheadOfMain} ahead, ${developBehindMain} behind. Pull main first, then resolve any conflicts.`;
      if (pullMainBtn) pullMainBtn.classList.remove('hidden');
    }

    // Update Pull Main button styling based on urgency
    if (pullMainBtn && !pullMainBtn.classList.contains('hidden')) {
      if (developBehindMain > 10) {
        pullMainBtn.className = 'flex items-center gap-1 px-2 py-1 bg-red-500/20 text-red-400 border border-red-500/30 rounded text-xs hover:bg-red-500/30 transition-colors animate-pulse';
      } else if (developBehindMain > 3) {
        pullMainBtn.className = 'flex items-center gap-1 px-2 py-1 bg-yellow-500/20 text-yellow-400 border border-yellow-500/30 rounded text-xs hover:bg-yellow-500/30 transition-colors';
      } else {
        pullMainBtn.className = 'flex items-center gap-1 px-2 py-1 bg-purple-500/20 text-purple-400 border border-purple-500/30 rounded text-xs hover:bg-purple-500/30 transition-colors';
      }
    }
  } catch (err) {
    console.error('Failed to load main comparison:', err);
    dot.className = 'w-2 h-2 rounded-full bg-gray-500';
    text.textContent = 'error';
    text.className = 'text-gray-400';
  }
}

async function loadGitSyncStatus() {
  const indicator = document.getElementById('git-sync-indicator');
  const dot = document.getElementById('git-sync-dot');
  const status = document.getElementById('git-sync-status');
  const btn = document.getElementById('git-sync-btn');
  const time = document.getElementById('git-sync-time');

  if (!dot || !status || !indicator) return;

  try {
    indicator.classList.remove('hidden');
    const res = await fetch(`${API_BASE}/git/sync-status?branch=develop`);
    const data = await res.json();

    if (data.error) {
      dot.className = 'w-2 h-2 rounded-full bg-gray-500';
      dot.title = 'Error checking sync status';
      status.textContent = 'error';
      status.className = 'text-gray-400';
      btn.classList.add('hidden');
      return;
    }

    const { ahead, behind, synced, lastFetch } = data;

    if (synced) {
      dot.className = 'w-2 h-2 rounded-full bg-green-500';
      dot.title = 'Up to date with origin/develop';
      status.textContent = 'synced';
      status.className = 'text-green-400';
      btn.classList.add('hidden');
    } else if (behind > 0 && ahead === 0) {
      const severity = behind > 5 ? 'red' : 'yellow';
      dot.className = `w-2 h-2 rounded-full bg-${severity}-500`;
      dot.title = `${behind} commits behind origin/develop`;
      status.textContent = `↓${behind}`;
      status.className = `text-${severity}-400`;
      btn.classList.remove('hidden');
      btn.textContent = 'Pull';
    } else if (ahead > 0 && behind === 0) {
      dot.className = 'w-2 h-2 rounded-full bg-blue-500';
      dot.title = `${ahead} commits ahead of origin/develop`;
      status.textContent = `↑${ahead}`;
      status.className = 'text-blue-400';
      btn.classList.add('hidden');
    } else {
      dot.className = 'w-2 h-2 rounded-full bg-purple-500';
      dot.title = `${ahead} ahead, ${behind} behind origin/develop`;
      status.textContent = `↓${behind} ↑${ahead}`;
      status.className = 'text-purple-400';
      btn.classList.remove('hidden');
      btn.textContent = 'Sync';
    }

    if (lastFetch && time) {
      const fetchTime = new Date(lastFetch);
      time.textContent = fetchTime.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
      time.title = `Last checked: ${fetchTime.toLocaleString()}`;
    }
  } catch (err) {
    console.error('Failed to load git sync status:', err);
    indicator.classList.add('hidden');
  }
}

async function pullFromOrigin() {
  const btn = document.getElementById('git-sync-btn');
  const status = document.getElementById('git-sync-status');
  const dot = document.getElementById('git-sync-dot');

  if (!btn || !status) return;

  const originalText = btn.textContent;
  btn.textContent = 'Pulling...';
  btn.disabled = true;

  try {
    const res = await fetch(`${API_BASE}/git/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ branch: 'develop' }),
    });

    const data = await res.json();

    if (data.success) {
      dot.className = 'w-2 h-2 rounded-full bg-green-500';
      status.textContent = 'synced';
      status.className = 'text-green-400';
      btn.classList.add('hidden');
      showToast('Pulled from origin/develop successfully', 'success');
      updateActivity(`Pulled from origin: ${data.message}`);

      await loadBranch();
      await loadUncommittedStatus();
      await loadMainComparison();
      await fetchData();
    } else {
      dot.className = 'w-2 h-2 rounded-full bg-red-500';
      status.textContent = 'failed';
      status.className = 'text-red-400';
      btn.textContent = 'Retry';
      showToast(`Pull failed: ${data.hint || data.error}`, 'error');
      updateActivity(`Pull failed: ${data.hint || data.error}`);
    }
  } catch (err) {
    console.error('Failed to pull:', err);
    status.textContent = 'error';
    status.className = 'text-red-400';
    btn.textContent = 'Retry';
    showToast('Pull failed: Network error', 'error');
    updateActivity('Pull failed: Network error');
  } finally {
    btn.disabled = false;
  }
}

function startGitSyncPolling() {
  // Load all git status info
  loadGitSyncStatus();
  loadUncommittedStatus();
  loadMainComparison();

  if (gitSyncInterval) clearInterval(gitSyncInterval);
  gitSyncInterval = setInterval(() => {
    if (!isPageVisible) return; // Skip polling when tab is hidden
    loadGitSyncStatus();
    loadUncommittedStatus();
    loadMainComparison();
  }, PERF_CONFIG.GIT_SYNC_POLL_INTERVAL);
}

async function pullMainIntoDevelop() {
  const btn = document.getElementById('pull-main-btn');
  const textSpan = document.getElementById('pull-main-text');

  if (!btn || !textSpan) return;

  // First check for uncommitted changes client-side to show better error
  try {
    const uncommittedRes = await fetch(`${API_BASE}/git/uncommitted`);
    const uncommittedData = await uncommittedRes.json();
    if (uncommittedData.hasUncommitted) {
      showToast(`Cannot pull main: ${uncommittedData.count} uncommitted changes. Commit or stash first.`, 'warning', 8000);
      updateActivity('Pull main blocked: uncommitted changes');
      return;
    }
  } catch {
    // Continue anyway, server will also check
  }

  const originalText = textSpan.textContent;
  textSpan.textContent = 'Pulling...';
  btn.disabled = true;
  btn.classList.add('opacity-50', 'cursor-not-allowed');

  try {
    const res = await fetch(`${API_BASE}/git/pull-main`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });

    const data = await res.json();

    if (data.success) {
      textSpan.textContent = 'Done!';
      btn.classList.remove('opacity-50', 'cursor-not-allowed');
      btn.classList.add('bg-green-500/20', 'text-green-400', 'border-green-500/30');
      btn.classList.remove('bg-purple-500/20', 'text-purple-400', 'border-purple-500/30', 'bg-yellow-500/20', 'text-yellow-400', 'border-yellow-500/30', 'bg-red-500/20', 'text-red-400', 'border-red-500/30');
      showToast('Pulled origin/main into develop successfully', 'success');
      updateActivity(`Pulled main into develop: ${data.message}`);

      await loadGitSyncStatus();
      await loadUncommittedStatus();
      await loadMainComparison();
      await loadBranch();
      await fetchData();

      setTimeout(() => {
        textSpan.textContent = originalText;
        btn.classList.remove('bg-green-500/20', 'text-green-400', 'border-green-500/30');
        btn.classList.add('bg-purple-500/20', 'text-purple-400', 'border-purple-500/30');
        // Re-check main comparison to potentially hide button
        loadMainComparison();
      }, 3000);
    } else {
      textSpan.textContent = 'Failed';
      btn.classList.remove('opacity-50', 'cursor-not-allowed');
      btn.classList.add('bg-red-500/20', 'text-red-400', 'border-red-500/30');
      btn.classList.remove('bg-purple-500/20', 'text-purple-400', 'border-purple-500/30', 'bg-yellow-500/20', 'text-yellow-400', 'border-yellow-500/30');

      // Show detailed error in toast
      const errorMsg = data.hint || data.error || 'Unknown error';
      showToast(`Pull main failed: ${errorMsg}`, 'error', 10000);
      updateActivity(`Pull main failed: ${errorMsg}`);

      setTimeout(() => {
        textSpan.textContent = originalText;
        btn.classList.remove('bg-red-500/20', 'text-red-400', 'border-red-500/30');
        btn.classList.add('bg-purple-500/20', 'text-purple-400', 'border-purple-500/30');
        loadMainComparison(); // Re-style button based on current state
      }, 5000);
    }
  } catch (err) {
    console.error('Failed to pull main:', err);
    textSpan.textContent = 'Error';
    btn.classList.remove('opacity-50', 'cursor-not-allowed');
    btn.classList.add('bg-red-500/20', 'text-red-400', 'border-red-500/30');
    btn.classList.remove('bg-purple-500/20', 'text-purple-400', 'border-purple-500/30', 'bg-yellow-500/20', 'text-yellow-400', 'border-yellow-500/30');
    showToast('Pull main failed: Network error', 'error');
    updateActivity('Pull main failed: Network error');

    setTimeout(() => {
      textSpan.textContent = originalText;
      btn.classList.remove('bg-red-500/20', 'text-red-400', 'border-red-500/30');
      btn.classList.add('bg-purple-500/20', 'text-purple-400', 'border-purple-500/30');
      loadMainComparison(); // Re-style button based on current state
    }, 5000);
  } finally {
    btn.disabled = false;
  }
}

async function loadWorktrees() {
  try {
    const res = await fetch(`${API_BASE}/worktrees`);
    const data = await res.json();
    state.worktrees = data.worktrees || [];
    renderWorktrees();
  } catch (err) {
    console.error('Failed to load worktrees:', err);
  }
}

// ==================== RECENT ACTIVITY ====================

async function loadRecentActivity() {
  try {
    const res = await fetch(`${API_BASE}/activity`);
    const activities = await res.json();
    renderRecentActivity(activities.slice(0, 15)); // Show last 15
  } catch (err) {
    console.error('Failed to load activity:', err);
  }
}

function renderRecentActivity(activities) {
  const container = document.getElementById('recent-activity-list');
  if (!container) return;

  if (!activities || activities.length === 0) {
    container.innerHTML = '<div class="text-xs text-spellbook-muted p-2">No recent activity</div>';
    return;
  }

  const countEl = document.getElementById('activity-count');
  if (countEl) countEl.textContent = `${activities.length}`;

  container.innerHTML = activities.map(a => {
    const actionColors = {
      created: 'text-green-400',
      started: 'text-yellow-400',
      changed: 'text-blue-400',
      completed: 'text-purple-400',
      resolved: 'text-purple-400',
    };
    const actionColor = actionColors[a.action] || 'text-gray-400';

    const typeColors = {
      bug: 'text-red-400',
      improvement: 'text-blue-400',
      feature: 'text-purple-400',
      inbox: 'text-yellow-400',
    };
    const typeClass = typeColors[a.item_type] || 'text-spellbook-muted';

    // Format time as HH:MM
    const date = new Date(a.created_at);
    const timeStr = date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });

    // Format date if not today
    const now = new Date();
    const isToday = date.toDateString() === now.toDateString();
    const dateStr = isToday ? '' : date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' ';

    // Get title (from enriched data) - truncate if too long
    const title = a.item_title ? (a.item_title.length > 40 ? a.item_title.slice(0, 40) + '...' : a.item_title) : '';

    return `
      <div class="px-3 py-2 hover:bg-spellbook-card/50 border-b border-spellbook-border/50 last:border-0 cursor-pointer transition-colors"
           onclick="openActivityItem('${a.item_ref || ''}', '${a.item_type || ''}')"
           title="Click to open ${a.item_ref}">
        <div class="flex items-center justify-between mb-1">
          <div class="flex items-center gap-2">
            <span class="${typeClass} text-xs font-semibold hover:underline">${a.item_ref}</span>
            <span class="${actionColor} text-xs">${a.action}</span>
          </div>
          <span class="text-xs text-spellbook-muted">${dateStr}${timeStr}</span>
        </div>
        ${title ? `<div class="text-xs text-spellbook-text truncate">${escapeHtml(title)}</div>` : ''}
      </div>
    `;
  }).join('');
}

function openActivityItem(itemRef, itemType) {
  if (!itemRef) return;

  const match = itemRef.match(/(bug|improvement|feature)-(\d+)/i);
  if (match) {
    const type = match[1].toLowerCase();
    const number = parseInt(match[2], 10);
    openPlanningView(type, number);
  } else if (itemType && itemRef) {
    const numberMatch = itemRef.match(/(\d+)/);
    if (numberMatch) {
      openPlanningView(itemType.toLowerCase(), parseInt(numberMatch[1], 10));
    }
  }
}

// ==================== INBOX ====================

function setInboxFilter(filter) {
  state.inboxFilter = filter;
  // Update filter buttons
  document.querySelectorAll('.inbox-filter').forEach(btn => {
    const isActive = btn.dataset.filter === filter;
    btn.className = isActive
      ? 'inbox-filter active px-3 py-1 text-xs rounded bg-yellow-500/20 text-yellow-400'
      : 'inbox-filter px-3 py-1 text-xs rounded bg-spellbook-card border border-spellbook-border text-spellbook-muted hover:border-spellbook-accent';
  });
  renderInbox();
}

function renderInbox() {
  const container = document.getElementById('inbox-items-list');
  if (!container) return;

  let items = state.inbox || [];
  if (state.inboxFilter !== 'all') {
    items = items.filter(i => i.type === state.inboxFilter);
  }

  document.getElementById('inbox-count').textContent = `${items.length} idea${items.length !== 1 ? 's' : ''}`;

  if (items.length === 0) {
    container.innerHTML = '<div class="text-center text-spellbook-muted py-8">No ideas in inbox</div>';
    return;
  }

  container.innerHTML = items.map(item => {
    const typeColors = {
      bug: 'bg-red-500/20 text-red-400',
      improvement: 'bg-blue-500/20 text-blue-400',
      feature: 'bg-purple-500/20 text-purple-400',
    };
    const typeClass = typeColors[item.type] || 'bg-gray-500/20 text-gray-400';

    const priorityColors = {
      high: 'text-red-400',
      medium: 'text-yellow-400',
      low: 'text-green-400',
    };
    const priorityClass = priorityColors[item.priority] || 'text-spellbook-muted';

    const date = new Date(item.created_at);
    const dateStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

    const isSelected = state.selectedInboxItem?.id === item.id;

    return `
      <div class="inbox-item p-3 bg-spellbook-card border ${isSelected ? 'border-yellow-400' : 'border-spellbook-border'} rounded-lg cursor-pointer hover:border-yellow-400/50 transition-colors"
           onclick="selectInboxItem(${item.id})">
        <div class="flex items-center justify-between mb-2">
          <span class="${typeClass} text-xs px-2 py-0.5 rounded">${item.type}</span>
          <span class="text-xs text-spellbook-muted">${dateStr}</span>
        </div>
        <div class="text-sm text-spellbook-text mb-2">${escapeHtml(item.description.slice(0, 100))}${item.description.length > 100 ? '...' : ''}</div>
        <div class="flex items-center justify-between">
          <span class="${priorityClass} text-xs">${item.priority} priority</span>
          <span class="text-xs text-spellbook-muted">idea-${item.id}</span>
        </div>
      </div>
    `;
  }).join('');
}

function selectInboxItem(id) {
  const item = state.inbox.find(i => i.id === id);
  state.selectedInboxItem = item;
  renderInbox(); // Re-render to show selection
  renderInboxDetail(item);
}

function renderInboxDetail(item) {
  const panel = document.getElementById('inbox-detail-panel');
  if (!panel) return;

  if (!item) {
    panel.innerHTML = `
      <div class="text-center text-spellbook-muted py-8">
        <div class="text-4xl mb-4">💡</div>
        <div>Select an idea to view details</div>
      </div>
    `;
    return;
  }

  const typeColors = {
    bug: 'bg-red-500/20 text-red-400',
    improvement: 'bg-blue-500/20 text-blue-400',
    feature: 'bg-purple-500/20 text-purple-400',
  };
  const typeClass = typeColors[item.type] || 'bg-gray-500/20 text-gray-400';

  const date = new Date(item.created_at);
  const dateStr = date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

  panel.innerHTML = `
    <div class="space-y-4">
      <div>
        <div class="flex items-center gap-2 mb-2">
          <span class="${typeClass} text-xs px-2 py-0.5 rounded">${item.type}</span>
          <span class="text-xs text-spellbook-muted">idea-${item.id}</span>
        </div>
        <div class="text-sm text-spellbook-text">${escapeHtml(item.description)}</div>
      </div>

      <div class="text-xs text-spellbook-muted">
        <div>Priority: <span class="text-spellbook-text">${item.priority}</span></div>
        <div>Created: <span class="text-spellbook-text">${dateStr}</span></div>
      </div>

      <div class="border-t border-spellbook-border pt-4">
        <div class="text-xs text-spellbook-muted mb-3">Convert to:</div>
        <div class="space-y-2">
          <button onclick="convertInboxItem(${item.id}, 'bug')" class="w-full px-3 py-2 bg-red-500/20 text-red-400 rounded text-sm hover:bg-red-500/30 flex items-center gap-2">
            🐛 Create as Bug
          </button>
          <button onclick="convertInboxItem(${item.id}, 'improvement')" class="w-full px-3 py-2 bg-blue-500/20 text-blue-400 rounded text-sm hover:bg-blue-500/30 flex items-center gap-2">
            ⚡ Create as Improvement
          </button>
          <button onclick="planAsFeature(${item.id})" class="w-full px-3 py-2 bg-purple-500/20 text-purple-400 rounded text-sm hover:bg-purple-500/30 flex items-center gap-2">
            🚀 Plan as Feature
          </button>
        </div>
      </div>

      <div class="border-t border-spellbook-border pt-4">
        <button onclick="deleteInboxItem(${item.id})" class="w-full px-3 py-2 bg-spellbook-card border border-spellbook-border text-spellbook-muted rounded text-sm hover:border-red-400 hover:text-red-400">
          🗑️ Delete Idea
        </button>
      </div>
    </div>
  `;
}

async function convertInboxItem(id, targetType) {
  console.log('convertInboxItem called:', { id, targetType, inbox: state.inbox });
  const item = state.inbox.find(i => i.id === id);
  if (!item) {
    console.error('Inbox item not found:', id);
    alert('Could not find inbox item. Try refreshing the page.');
    return;
  }
  console.log('Converting item:', item);

  // First, update the item type if different
  if (item.type !== targetType) {
    // We need to update the type before converting
    item.type = targetType;
  }

  try {
    const res = await fetch(`${API_BASE}/inbox/${id}/convert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: item.description.slice(0, 100),
        priority: item.priority,
        targetType: targetType,
      }),
    });

    if (!res.ok) {
      const err = await res.json();
      alert('Failed to convert: ' + (err.error || 'Unknown error'));
      return;
    }

    const result = await res.json();
    alert(`Created ${result.type}-${result.item.number}: ${result.item.title}`);

    // Refresh data
    await fetchData();
    state.selectedInboxItem = null;
    renderInbox();
    renderInboxDetail(null);

    // Sync roadmap
    try {
      await fetch(`${API_BASE}/roadmap`, { method: 'POST' });
    } catch (e) {
      console.warn('Failed to sync roadmap:', e);
    }
  } catch (err) {
    console.error('Failed to convert inbox item:', err);
    alert('Failed to convert item');
  }
}

function planAsFeature(id) {
  const item = state.inbox.find(i => i.id === id);
  if (!item) {
    console.error('Inbox item not found:', id);
    alert('Could not find inbox item');
    return;
  }

  // Switch to kanban view where the terminal is
  switchMainView('kanban');

  // Type the /plan command into the quick chat terminal
  setTimeout(() => {
    if (sessions.quickChat?.ws && sessions.quickChat.ws.readyState === WebSocket.OPEN) {
      const description = item.description.slice(0, 150).replace(/"/g, '\\"');
      const command = `/plan "${description}"`;

      // Send the command to terminal
      sendTerminalCommand(sessions.quickChat.ws, command, () => {
        console.log('Sent /plan command to terminal');
      });

      // Focus the terminal
      if (sessions.quickChat.term) {
        sessions.quickChat.term.focus();
      }
    } else {
      // Fallback if terminal not ready
      alert(`To plan this feature, run in terminal:\n\n/plan "${item.description.slice(0, 100)}"`);
    }
  }, 300);
}

async function deleteInboxItem(id) {
  if (!confirm('Delete this idea? This cannot be undone.')) return;

  try {
    await fetch(`${API_BASE}/inbox/${id}`, { method: 'DELETE' });
    await fetchData();
    state.selectedInboxItem = null;
    renderInbox();
    renderInboxDetail(null);
  } catch (err) {
    console.error('Failed to delete inbox item:', err);
    alert('Failed to delete item');
  }
}

function quickAddIdea() {
  // Show a modal for adding ideas
  const modal = document.getElementById('quick-log-modal');
  const title = document.getElementById('quick-log-title');
  const input = document.getElementById('quick-log-input');
  const desc = document.getElementById('quick-log-description');
  const priority = document.getElementById('quick-log-priority');

  if (modal && title) {
    title.textContent = 'Add Idea to Inbox';
    input.placeholder = 'Brief description of your idea...';
    input.value = '';
    desc.value = '';
    priority.value = 'medium';
    modal.classList.remove('hidden');

    // Change submit handler
    window.currentQuickLogType = 'idea';
    input.focus();
  }
}

// ==================== QUICK CHAT TERMINAL ====================

async function initQuickChatTerminal() {
  try {
    const res = await fetch(`${API_BASE}/terminals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cwd: state.project?.path,
        name: 'QuickChat',
        command: 'claude',
        args: ['--dangerously-skip-permissions'],
        useTmux: true,
        tmuxSessionName: 'QuickChat',
      }),
    });

    if (!res.ok) throw new Error('Failed to create quick chat terminal');

    const data = await res.json();
    sessions.quickChat.terminalId = data.terminalId;
    sessions.quickChat.tmuxSession = data.tmuxSession;

    await connectTerminal('quickChat', document.getElementById('quick-chat-terminal'));

    // Save session for persistence
    saveSessionsToStorage();

    updateActivity('Quick Chat connected');
  } catch (err) {
    console.error('Failed to init quick chat:', err);
    updateActivity('Failed to start Quick Chat terminal');
  }
}

// ==================== WORKTREE TERMINAL ====================

async function initWorktreeTerminal() {
  try {
    const statusEl = document.getElementById('worktree-terminal-status');
    if (statusEl) {
      statusEl.textContent = 'Connecting...';
      statusEl.classList.remove('text-green-400', 'text-red-400');
      statusEl.classList.add('text-yellow-400');
    }

    const res = await fetch(`${API_BASE}/terminals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cwd: state.project?.path,
        name: 'WorktreeManager',
        command: 'claude',
        args: ['--dangerously-skip-permissions'],
        useTmux: true,
        tmuxSessionName: 'WorktreeManager',
      }),
    });

    if (!res.ok) throw new Error('Failed to create worktree terminal');

    const data = await res.json();
    sessions.worktreeTerminal.terminalId = data.terminalId;
    sessions.worktreeTerminal.tmuxSession = data.tmuxSession;

    await connectTerminal('worktreeTerminal', document.getElementById('worktree-terminal'));

    if (statusEl) {
      statusEl.textContent = 'Connected';
      statusEl.classList.remove('text-yellow-400', 'text-red-400');
      statusEl.classList.add('text-green-400');
    }

    saveSessionsToStorage();
    updateActivity('Worktree terminal connected');
  } catch (err) {
    console.error('Failed to init worktree terminal:', err);
    const statusEl = document.getElementById('worktree-terminal-status');
    if (statusEl) {
      statusEl.textContent = 'Failed to connect';
      statusEl.classList.remove('text-yellow-400', 'text-green-400');
      statusEl.classList.add('text-red-400');
    }
    updateActivity('Failed to start worktree terminal');
  }
}

// ==================== TERMINAL CONNECTION ====================

async function connectTerminal(sessionKey, container) {
  let session;
  if (sessionKey === 'quickChat') {
    session = sessions.quickChat;
  } else if (sessionKey === 'worktreeTerminal') {
    session = sessions.worktreeTerminal;
  } else {
    session = sessions.planning[sessionKey];
  }

  if (!session?.terminalId) return;

  const term = new Terminal({
    cursorBlink: true,
    cursorStyle: 'block',
    fontSize: 13,
    fontFamily: "'Space Mono', 'Menlo', 'Monaco', monospace",
    scrollback: 10000,
    allowProposedApi: true,
    theme: {
      background: '#0a0a0f',
      foreground: '#e0e0e0',
      cursor: '#00ff88',
      selection: 'rgba(0, 255, 136, 0.3)',
      black: '#0a0a0f',
      red: '#ef4444',
      green: '#00ff88',
      yellow: '#eab308',
      blue: '#3b82f6',
      magenta: '#a855f7',
      cyan: '#22d3ee',
      white: '#e0e0e0',
    },
  });

  const fitAddon = new FitAddon.FitAddon();
  const webLinksAddon = new WebLinksAddon.WebLinksAddon();

  term.loadAddon(fitAddon);
  term.loadAddon(webLinksAddon);

  container.innerHTML = '';
  term.open(container);

  // Handle Cmd+C / Ctrl+C to copy selected text
  term.attachCustomKeyEventHandler((e) => {
    // Allow Cmd+C (Mac) or Ctrl+C (Windows/Linux) to copy when there's a selection
    if ((e.metaKey || e.ctrlKey) && e.key === 'c' && term.hasSelection()) {
      const selection = term.getSelection();
      if (selection) {
        navigator.clipboard.writeText(selection).catch(err => {
          console.error('[Terminal] Failed to copy:', err);
        });
        return false; // Prevent default terminal handling
      }
    }
    // Allow Cmd+V (Mac) or Ctrl+V (Windows/Linux) to paste
    if ((e.metaKey || e.ctrlKey) && e.key === 'v') {
      return false; // Let browser handle paste
    }
    return true; // Let terminal handle other keys
  });

  // Local scroll handling - use passive listener to allow selection events
  term.element.addEventListener('wheel', (e) => {
    const lines = e.deltaY > 0 ? 3 : -3;
    term.scrollLines(lines);
  }, { passive: true });

  // Focus terminal on mouse enter for better scroll handling
  container.addEventListener('mouseenter', () => {
    term.focus();
  });

  session.term = term;
  session.fitAddon = fitAddon;

  // Setup drag-and-drop and paste image functionality
  setupTerminalDropZone(container, session);

  // Helper to fit terminal and send resize to PTY
  const doFit = () => {
    try {
      fitAddon.fit();
      // After fitting, send resize to PTY if WebSocket is connected
      if (session.ws && session.ws.readyState === WebSocket.OPEN) {
        session.ws.send(JSON.stringify({
          type: 'resize',
          cols: term.cols,
          rows: term.rows,
        }));
      }
    } catch (e) {
      console.error('[Terminal] fit() error:', e);
    }
  };

  // Connect WebSocket first
  const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${wsProtocol}//${window.location.host}/ws/terminal?id=${session.terminalId}`);

  ws.onopen = () => {
    session.ws = ws;
    console.log(`[Terminal] WebSocket connected for session: ${sessionKey}`);

    // Update status to Connected based on session type
    if (sessionKey === 'worktreeTerminal') {
      const statusEl = document.getElementById('worktree-terminal-status');
      if (statusEl) {
        statusEl.textContent = 'Connected';
        statusEl.classList.remove('text-red-400', 'text-yellow-400');
        statusEl.classList.add('text-green-400');
      }
    } else if (sessionKey !== 'quickChat') {
      const statusEl = document.getElementById('terminal-status');
      if (statusEl) {
        statusEl.textContent = '● Connected';
        statusEl.classList.remove('text-red-400', 'text-yellow-400');
        statusEl.classList.add('text-green-400');
      }
    }

    // Now that WebSocket is open, do the initial fit and send resize
    // Multiple attempts to ensure layout is computed
    setTimeout(() => {
      doFit();
      // Extra resize sends to ensure PTY gets correct dimensions
      setTimeout(doFit, 100);
      setTimeout(doFit, 300);
      setTimeout(doFit, 600);
    }, 50);
  };

  // Use ResizeObserver to handle container resize
  if (window.ResizeObserver) {
    const resizeObserver = new ResizeObserver(() => {
      if (session.resizeTimeout) clearTimeout(session.resizeTimeout);
      session.resizeTimeout = setTimeout(doFit, 50);
    });
    resizeObserver.observe(container);
    session.resizeObserver = resizeObserver;
  }

  // Also handle window resize
  const handleWindowResize = () => {
    if (session.windowResizeTimeout) clearTimeout(session.windowResizeTimeout);
    session.windowResizeTimeout = setTimeout(doFit, 100);
  };
  window.addEventListener('resize', handleWindowResize);
  session.handleWindowResize = handleWindowResize;

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === 'output') {
        term.write(msg.data);
        smartScrollToBottom(term);
      }
    } catch {
      term.write(event.data);
      smartScrollToBottom(term);
    }
  };

  ws.onclose = () => {
    console.log(`[Terminal] WebSocket closed for session: ${sessionKey}`);
    term.write('\r\n\x1b[33m[Terminal disconnected]\x1b[0m\r\n');
    term.scrollToBottom(); // Always scroll on disconnect message

    // Don't update status if we're intentionally closing (flag set by closePlanningView)
    if (window._intentionalClose) {
      console.log(`[Terminal] Intentional close, skipping status update`);
      return;
    }

    // Update status to Disconnected for unexpected disconnections
    if (sessionKey === 'worktreeTerminal') {
      const statusEl = document.getElementById('worktree-terminal-status');
      if (statusEl) {
        statusEl.textContent = 'Disconnected';
        statusEl.classList.remove('text-green-400', 'text-yellow-400');
        statusEl.classList.add('text-red-400');
      }
    } else {
      const statusEl = document.getElementById('terminal-status');
      if (statusEl) {
        statusEl.textContent = '● Disconnected';
        statusEl.classList.remove('text-green-400', 'text-yellow-400');
        statusEl.classList.add('text-red-400');
      }
    }
  };

  ws.onerror = (err) => {
    console.error('WebSocket error:', err);
  };

  term.onData((data) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'input', data }));
    }
  });

  term.onResize(({ cols, rows }) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'resize', cols, rows }));
    }
  });
}

// ==================== VIEW SWITCHING ====================

function switchMainView(view) {
  state.currentView = view;

  // Update sidebar navigation buttons
  const navButtons = ['dashboard', 'kanban', 'inbox', 'investigate', 'terminals', 'knowledge', 'worktrees'];
  navButtons.forEach(navView => {
    const btn = document.getElementById(`nav-${navView}`);
    if (btn) {
      if (view === navView) {
        btn.classList.add('active', 'bg-spellbook-accent/20');
        btn.classList.remove('hover:bg-spellbook-accent/20');
        const svg = btn.querySelector('svg');
        if (svg) {
          svg.classList.remove('text-spellbook-muted');
          svg.classList.add('text-spellbook-accent');
        }
      } else {
        btn.classList.remove('active', 'bg-spellbook-accent/20');
        btn.classList.add('hover:bg-spellbook-accent/20');
        const svg = btn.querySelector('svg');
        if (svg) {
          svg.classList.add('text-spellbook-muted');
          svg.classList.remove('text-spellbook-accent');
        }
      }
    }
  });

  // Show/hide views - use hidden class only, CSS handles display type
  const viewIds = [
    'dashboard-view',
    'kanban-view',
    'inbox-view',
    'investigate-view',
    'terminal-manager-view',
    'knowledge-view',
    'worktrees-view'
  ];

  viewIds.forEach(viewId => {
    const el = document.getElementById(viewId);
    if (el) {
      const viewName = viewId.replace('-view', '').replace('terminal-manager', 'terminals');
      const shouldShow = (view === viewName) ||
                         (view === 'terminals' && viewId === 'terminal-manager-view') ||
                         (view === 'kanban' && viewId === 'kanban-view');

      // Remove any inline display style - let CSS handle it via hidden class
      el.style.removeProperty('display');

      if (shouldShow) {
        el.classList.remove('hidden');
      } else {
        el.classList.add('hidden');
      }
    }
  });

  // Resize terminals with multiple attempts for layout timing
  setTimeout(handleResize, 50);
  setTimeout(handleResize, 200);
  setTimeout(handleResize, 500);

  if (view === 'kanban') {
    // Extra resize attempts for quick chat terminal when returning to kanban
    if (sessions.quickChat?.fitAddon) {
      setTimeout(() => {
        try { sessions.quickChat.fitAddon.fit(); } catch (e) { /* ignore */ }
      }, 100);
      setTimeout(() => {
        try { sessions.quickChat.fitAddon.fit(); } catch (e) { /* ignore */ }
      }, 300);
    }
  }

  if (view === 'terminals') {
    renderSessionsGrid();
    // Preview refresh is started by renderSessionsGrid
  } else {
    // Stop preview refresh when leaving terminal manager view
    stopPreviewRefresh();
  }

  if (view === 'dashboard') {
    loadDashboard();
  }

  if (view === 'inbox') {
    renderInbox();
  }

  if (view === 'investigate') {
    renderInvestigationSessions();
    // Resize active investigation terminal if exists
    if (investigations.activeSession) {
      const session = investigations.sessions[investigations.activeSession];
      if (session?.fitAddon) {
        setTimeout(() => session.fitAddon.fit(), 100);
        setTimeout(() => session.fitAddon.fit(), 300);
      }
    }
  }

  if (view === 'knowledge') {
    loadKnowledgeBase();  // Load first, render happens inside after data arrives
  }

  if (view === 'worktrees') {
    loadWorktreesView();
  } else {
    // Stop worktrees refresh when leaving worktrees view
    stopWorktreesRefresh();
  }
}

// ==================== DASHBOARD VIEW ====================

async function loadDashboard() {
  // Load project info and roadmap in parallel
  await Promise.all([
    loadProjectInfo(),
    loadRoadmap(),
  ]);

  state.dashboardLoaded = true;
  document.getElementById('dashboard-updated').textContent = `Updated: ${new Date().toLocaleTimeString()}`;
}

async function refreshDashboard() {
  updateActivity('Regenerating roadmap...');

  // Regenerate roadmap first
  try {
    await fetch(`${API_BASE}/roadmap`, { method: 'POST' });
  } catch (err) {
    console.error('Failed to regenerate roadmap:', err);
  }

  updateActivity('Refreshing dashboard...');
  await loadDashboard();
  updateActivity('Dashboard refreshed (roadmap synced)');
}

async function loadProjectInfo() {
  try {
    const res = await fetch(`${API_BASE}/project-info`);
    const data = await res.json();

    // Update project name and git info
    document.getElementById('dashboard-project-name').textContent = data.project.name || 'Project Dashboard';
    document.getElementById('dashboard-git-info').innerHTML = `
      <span class="text-purple-400">${data.git.branch}</span>
      <span class="text-spellbook-muted mx-2">•</span>
      <span class="text-spellbook-muted">${data.git.remote.replace('git@github.com:', '').replace('.git', '')}</span>
    `;

    // Update stats
    document.getElementById('stat-features').textContent = `${data.stats.featuresComplete}/${data.stats.featuresTotal}`;
    document.getElementById('stat-bugs').textContent = data.stats.activeBugs;
    document.getElementById('stat-improvements').textContent = data.stats.activeImprovements;
    document.getElementById('stat-inbox').textContent = data.stats.inboxItems;

    // Update tech stack
    const techStackEl = document.getElementById('tech-stack-list');
    if (data.techStack.dependencies && data.techStack.dependencies.length > 0) {
      techStackEl.innerHTML = `
        <div class="text-sm text-spellbook-accent mb-2">${data.techStack.name || 'Project'} ${data.techStack.version ? `v${data.techStack.version}` : ''}</div>
        <div class="flex flex-wrap gap-1">
          ${data.techStack.dependencies.map(dep => `
            <span class="px-2 py-0.5 bg-spellbook-bg rounded text-xs text-spellbook-muted">${dep}</span>
          `).join('')}
        </div>
      `;
    } else {
      techStackEl.innerHTML = '<div class="text-sm text-spellbook-muted">No package.json found</div>';
    }

    // Update project path
    document.getElementById('project-path').textContent = data.project.path;

  } catch (err) {
    console.error('Failed to load project info:', err);
  }
}

async function loadRoadmap() {
  const contentEl = document.getElementById('roadmap-content');
  const modifiedEl = document.getElementById('roadmap-modified');

  try {
    const res = await fetch(`${API_BASE}/roadmap`);
    const data = await res.json();

    if (data.exists && data.content) {
      contentEl.innerHTML = marked.parse(data.content);
      modifiedEl.textContent = `Last modified: ${new Date(data.modifiedAt).toLocaleString()}`;
    } else {
      contentEl.innerHTML = `
        <div class="text-center py-8">
          <div class="text-spellbook-muted mb-4">${data.message || 'ROADMAP.md not found'}</div>
          <p class="text-sm text-spellbook-muted">Run <code class="bg-spellbook-card px-2 py-1 rounded">spellbook generate</code> to create the roadmap.</p>
        </div>
      `;
      modifiedEl.textContent = '';
    }
  } catch (err) {
    console.error('Failed to load roadmap:', err);
    contentEl.innerHTML = `
      <div class="text-center py-8 text-red-400">
        Failed to load roadmap: ${err.message}
      </div>
    `;
  }
}

// ==================== INVESTIGATE VIEW ====================

async function startNewInvestigation(type) {
  const sessionId = `inv-${investigations.nextId++}`;
  const typeLabel = type === 'bug' ? 'Bug Hunt' : 'Codebase Research';

  try {
    // Create terminal for investigation
    const res = await fetch(`${API_BASE}/terminals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cwd: state.project?.path,
        name: sessionId,
        command: 'claude',
        args: ['--dangerously-skip-permissions'],
      }),
    });

    if (!res.ok) throw new Error('Failed to create terminal');

    const data = await res.json();

    investigations.sessions[sessionId] = {
      id: sessionId,
      type,
      typeLabel,
      question: null,
      terminalId: data.terminalId,
      term: null,
      ws: null,
      fitAddon: null,
      status: 'active',
      createdAt: new Date(),
    };

    // Connect terminal
    await connectInvestigationTerminal(sessionId);

    // Set as active
    investigations.activeSession = sessionId;

    // Update UI
    renderInvestigationSessions();
    updateInvestigationUI(sessionId);

    // Send initial prompt after terminal is ready
    setTimeout(() => {
      const session = investigations.sessions[sessionId];
      if (session?.ws?.readyState === WebSocket.OPEN) {
        // Helper to send command with separate Enter
        const sendCmd = (text, cb) => {
          session.ws.send(JSON.stringify({ type: 'input', data: text }));
          setTimeout(() => {
            session.ws.send(JSON.stringify({ type: 'input', data: '\r' }));
            if (cb) setTimeout(cb, 100);
          }, 50);
        };

        // Step 1: Rename session, then send investigation prompt
        sendCmd(`/rename ${sessionId}`, () => {
          setTimeout(() => {
            const prompt = type === 'bug'
              ? '/investigate I need to find and diagnose a potential bug. Help me investigate.'
              : '/investigate I want to understand how something works in this codebase. Help me research.';
            sendCmd(prompt);
          }, 3000);
        });
      }
    }, 2000);

    updateActivity(`Started ${typeLabel.toLowerCase()} investigation`);

  } catch (err) {
    console.error('Failed to start investigation:', err);
    alert('Failed to start investigation: ' + err.message);
  }
}

async function askQuickQuestion() {
  const input = document.getElementById('quick-question-input');
  const question = input.value.trim();

  if (!question) {
    alert('Please enter a question');
    return;
  }

  const sessionId = `inv-${investigations.nextId++}`;

  try {
    // Create terminal
    const res = await fetch(`${API_BASE}/terminals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cwd: state.project?.path,
        name: sessionId,
        command: 'claude',
        args: ['--dangerously-skip-permissions'],
      }),
    });

    if (!res.ok) throw new Error('Failed to create terminal');

    const data = await res.json();

    investigations.sessions[sessionId] = {
      id: sessionId,
      type: 'question',
      typeLabel: 'Quick Question',
      question: question.slice(0, 50) + (question.length > 50 ? '...' : ''),
      terminalId: data.terminalId,
      term: null,
      ws: null,
      fitAddon: null,
      status: 'active',
      createdAt: new Date(),
    };

    // Connect terminal
    await connectInvestigationTerminal(sessionId);

    // Set as active
    investigations.activeSession = sessionId;

    // Update UI
    renderInvestigationSessions();
    updateInvestigationUI(sessionId);

    // Clear input
    input.value = '';

    // Send question after terminal is ready
    setTimeout(() => {
      const session = investigations.sessions[sessionId];
      if (session?.ws?.readyState === WebSocket.OPEN) {
        // Helper to send command with separate Enter
        const sendCmd = (text, cb) => {
          session.ws.send(JSON.stringify({ type: 'input', data: text }));
          setTimeout(() => {
            session.ws.send(JSON.stringify({ type: 'input', data: '\r' }));
            if (cb) setTimeout(cb, 100);
          }, 50);
        };

        // Step 1: Rename session, then send question
        sendCmd(`/rename ${sessionId}`, () => {
          setTimeout(() => {
            sendCmd(`/investigate ${question}`);
          }, 3000);
        });
      }
    }, 2000);

    updateActivity('Started quick question investigation');

  } catch (err) {
    console.error('Failed to ask question:', err);
    alert('Failed to start investigation: ' + err.message);
  }
}

async function connectInvestigationTerminal(sessionId) {
  const session = investigations.sessions[sessionId];
  if (!session?.terminalId) return;

  const container = document.getElementById('investigation-terminal');

  const term = new Terminal({
    cursorBlink: true,
    cursorStyle: 'block',
    fontSize: 13,
    fontFamily: "'Space Mono', 'Menlo', 'Monaco', monospace",
    scrollback: 10000,
    allowProposedApi: true,
    theme: {
      background: '#0a0a0f',
      foreground: '#e0e0e0',
      cursor: '#00ff88',
      selection: 'rgba(0, 255, 136, 0.3)',
      black: '#0a0a0f',
      red: '#ef4444',
      green: '#00ff88',
      yellow: '#eab308',
      blue: '#3b82f6',
      magenta: '#a855f7',
      cyan: '#22d3ee',
      white: '#e0e0e0',
    },
  });

  const fitAddon = new FitAddon.FitAddon();
  const webLinksAddon = new WebLinksAddon.WebLinksAddon();

  term.loadAddon(fitAddon);
  term.loadAddon(webLinksAddon);

  container.innerHTML = '';
  term.open(container);

  // Handle Cmd+C / Ctrl+C to copy selected text
  term.attachCustomKeyEventHandler((e) => {
    // Allow Cmd+C (Mac) or Ctrl+C (Windows/Linux) to copy when there's a selection
    if ((e.metaKey || e.ctrlKey) && e.key === 'c' && term.hasSelection()) {
      const selection = term.getSelection();
      if (selection) {
        navigator.clipboard.writeText(selection).catch(err => {
          console.error('[Investigation Terminal] Failed to copy:', err);
        });
        return false; // Prevent default terminal handling
      }
    }
    // Allow Cmd+V (Mac) or Ctrl+V (Windows/Linux) to paste
    if ((e.metaKey || e.ctrlKey) && e.key === 'v') {
      return false; // Let browser handle paste
    }
    return true; // Let terminal handle other keys
  });

  // Local scroll handling - use passive listener to allow selection events
  term.element.addEventListener('wheel', (e) => {
    const lines = e.deltaY > 0 ? 3 : -3;
    term.scrollLines(lines);
  }, { passive: true });

  // Focus terminal on mouse enter for better scroll handling
  container.addEventListener('mouseenter', () => {
    term.focus();
  });

  session.term = term;
  session.fitAddon = fitAddon;

  // Setup drag-and-drop and paste image functionality
  setupTerminalDropZone(container, session);

  // Helper to fit terminal and send resize to PTY
  const doFit = () => {
    try {
      fitAddon.fit();
      // After fitting, send resize to PTY if WebSocket is connected
      if (session.ws && session.ws.readyState === WebSocket.OPEN) {
        session.ws.send(JSON.stringify({
          type: 'resize',
          cols: term.cols,
          rows: term.rows,
        }));
      }
    } catch (e) {
      console.error('[Investigation Terminal] fit() error:', e);
    }
  };

  // Connect WebSocket first
  const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${wsProtocol}//${window.location.host}/ws/terminal?id=${session.terminalId}`);

  ws.onopen = () => {
    session.ws = ws;
    // Do initial fit and send resize after WebSocket is open
    setTimeout(() => {
      doFit();
      setTimeout(doFit, 100);
      setTimeout(doFit, 300);
      setTimeout(doFit, 600);
    }, 50);
  };

  // ResizeObserver for container resize
  if (window.ResizeObserver) {
    const resizeObserver = new ResizeObserver(() => {
      if (session.resizeTimeout) clearTimeout(session.resizeTimeout);
      session.resizeTimeout = setTimeout(doFit, 50);
    });
    resizeObserver.observe(container);
    session.resizeObserver = resizeObserver;
  }

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === 'output') {
        term.write(msg.data);
        smartScrollToBottom(term);
      }
    } catch {
      term.write(event.data);
      smartScrollToBottom(term);
    }
  };

  ws.onclose = () => {
    term.write('\r\n\x1b[33m[Investigation ended]\x1b[0m\r\n');
    term.scrollToBottom(); // Always scroll on disconnect message
    session.status = 'closed';
    renderInvestigationSessions();
  };

  ws.onerror = (err) => {
    console.error('WebSocket error:', err);
  };

  term.onData((data) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'input', data }));
    }
  });

  term.onResize(({ cols, rows }) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'resize', cols, rows }));
    }
  });
}

function renderInvestigationSessions() {
  const container = document.getElementById('investigation-sessions');
  const sessionIds = Object.keys(investigations.sessions);

  if (sessionIds.length === 0) {
    container.innerHTML = `
      <div class="text-center text-spellbook-muted py-8 text-sm">
        No active investigations. Start one above.
      </div>
    `;
    return;
  }

  container.innerHTML = sessionIds.map(id => {
    const session = investigations.sessions[id];
    const isActive = investigations.activeSession === id;
    const statusColor = session.status === 'active' ? 'text-green-400' : 'text-spellbook-muted';
    const typeIcon = { bug: '🐛', research: '🔍' }[session.type] || '❓';

    return `
      <div class="bg-spellbook-card border ${isActive ? 'border-spellbook-accent' : 'border-spellbook-border'} rounded-lg p-3 cursor-pointer hover:border-spellbook-accent transition-colors"
           onclick="switchInvestigation('${id}')">
        <div class="flex items-center justify-between mb-2">
          <span class="text-sm font-semibold">${typeIcon} ${session.typeLabel}</span>
          <span class="text-xs ${statusColor}">● ${session.status}</span>
        </div>
        ${session.question ? `<div class="text-xs text-spellbook-muted truncate">${escapeHtml(session.question)}</div>` : ''}
        <div class="text-xs text-spellbook-muted mt-1">
          ${new Date(session.createdAt).toLocaleTimeString()}
        </div>
      </div>
    `;
  }).join('');
}

function switchInvestigation(sessionId) {
  const session = investigations.sessions[sessionId];
  if (!session) return;

  investigations.activeSession = sessionId;

  // Reconnect terminal if needed
  if (session.term && session.status === 'active') {
    const container = document.getElementById('investigation-terminal');
    container.innerHTML = '';
    session.term.open(container);
    setTimeout(() => session.fitAddon?.fit(), 100);
  } else if (session.status === 'closed') {
    const container = document.getElementById('investigation-terminal');
    container.innerHTML = `
      <div class="flex items-center justify-center h-full text-spellbook-muted">
        <div class="text-center">
          <div class="text-4xl mb-4">✓</div>
          <div class="text-lg mb-2">Investigation Complete</div>
          <div class="text-sm">This session has been closed.</div>
        </div>
      </div>
    `;
  }

  updateInvestigationUI(sessionId);
  renderInvestigationSessions();
}

function updateInvestigationUI(sessionId) {
  const session = investigations.sessions[sessionId];
  if (!session) return;

  document.getElementById('investigation-title').textContent = `${session.typeLabel}: ${session.id}`;
  document.getElementById('investigation-status').textContent = session.status === 'active' ? '● Active' : '○ Closed';
  document.getElementById('investigation-status').className = session.status === 'active' ? 'text-xs text-green-400' : 'text-xs text-spellbook-muted';
  document.getElementById('close-investigation-btn').classList.toggle('hidden', session.status !== 'active');
}

async function closeInvestigation() {
  const sessionId = investigations.activeSession;
  if (!sessionId) return;

  const session = investigations.sessions[sessionId];
  if (!session) return;

  if (!confirm(`Close investigation ${sessionId}?`)) return;

  try {
    if (session.terminalId) {
      await fetch(`${API_BASE}/terminals/${session.terminalId}`, { method: 'DELETE' });
    }
  } catch (err) {
    console.error('Failed to close terminal:', err);
  }

  // Clean up resources properly
  cleanupSession(session);
  session.status = 'closed';

  // Clear terminal view
  const container = document.getElementById('investigation-terminal');
  container.innerHTML = `
    <div class="flex items-center justify-center h-full text-spellbook-muted">
      <div class="text-center">
        <div class="text-4xl mb-4">✓</div>
        <div class="text-lg mb-2">Investigation Closed</div>
        <div class="text-sm">Start a new investigation or select another session.</div>
      </div>
    </div>
  `;

  renderInvestigationSessions();
  updateInvestigationUI(sessionId);
  updateActivity(`Closed investigation ${sessionId}`);
}

// ==================== ITEM DETAIL MODAL ====================

// Store current item being viewed in modal
let currentDetailItem = null;
let currentDetailTab = 'document';
let currentDocContent = '';

async function openItemDetail(type, number) {
  // Find the item
  let item;
  if (type === 'bug') item = state.bugs.find(b => b.number === number);
  else if (type === 'improvement') item = state.improvements.find(i => i.number === number);
  else if (type === 'feature') item = state.features.find(f => f.number === number);

  if (!item) {
    alert('Item not found');
    return;
  }

  currentDetailItem = { type, number, item };
  currentDetailTab = 'document';

  // Update modal content
  document.getElementById('detail-ref').textContent = `${type}-${number}`;
  document.getElementById('detail-title').textContent = item.title || item.name || 'Untitled';

  // Status badge
  const statusBadge = document.getElementById('detail-status-badge');
  const statusColors = {
    active: 'bg-gray-500/20 text-gray-400',
    planning: 'bg-blue-500/20 text-blue-400',
    in_progress: 'bg-yellow-500/20 text-yellow-400',
    resolved: 'bg-green-500/20 text-green-400',
    completed: 'bg-green-500/20 text-green-400',
    complete: 'bg-green-500/20 text-green-400',
  };
  statusBadge.className = `px-2 py-1 text-xs rounded ${statusColors[item.status] || statusColors.active}`;
  statusBadge.textContent = (item.status || 'active').replace('_', ' ');

  // Priority badge
  const priorityBadge = document.getElementById('detail-priority-badge');
  const priorityColors = {
    high: 'bg-red-500/20 text-red-400',
    medium: 'bg-yellow-500/20 text-yellow-400',
    low: 'bg-green-500/20 text-green-400',
  };
  if (item.priority && type !== 'feature') {
    priorityBadge.className = `px-2 py-1 text-xs rounded ${priorityColors[item.priority] || priorityColors.medium}`;
    priorityBadge.textContent = item.priority;
    priorityBadge.classList.remove('hidden');
  } else {
    priorityBadge.classList.add('hidden');
  }

  // Dates
  if (item.created_at) {
    document.getElementById('detail-created').textContent = new Date(item.created_at).toLocaleDateString();
  } else {
    document.getElementById('detail-created').textContent = '-';
  }
  if (item.updated_at) {
    document.getElementById('detail-updated').textContent = new Date(item.updated_at).toLocaleDateString();
  } else {
    document.getElementById('detail-updated').textContent = '-';
  }

  // Linked feature
  if (item.linked_feature) {
    document.getElementById('detail-feature-row').classList.remove('hidden');
    document.getElementById('detail-feature').textContent = `Feature ${item.linked_feature}`;
  } else {
    document.getElementById('detail-feature-row').classList.add('hidden');
  }

  // Owner
  if (item.owner) {
    document.getElementById('detail-owner-row').classList.remove('hidden');
    document.getElementById('detail-owner').textContent = item.owner;
  } else {
    document.getElementById('detail-owner-row').classList.add('hidden');
  }

  // Doc path
  if (item.doc_path) {
    document.getElementById('detail-docpath').textContent = item.doc_path;
  } else {
    document.getElementById('detail-docpath').textContent = '-';
  }

  // Show finalize button for in_progress items
  const finalizeBtn = document.getElementById('detail-finalize-btn');
  if (finalizeBtn) {
    if (item.status === 'in_progress') {
      finalizeBtn.classList.remove('hidden');
    } else {
      finalizeBtn.classList.add('hidden');
    }
  }

  // Reset tabs UI
  document.querySelectorAll('.detail-tab').forEach(tab => {
    tab.classList.remove('active');
    if (tab.dataset.tab === 'document') tab.classList.add('active');
  });
  document.getElementById('detail-document-tab').classList.remove('hidden');
  document.getElementById('detail-changelog-tab').classList.add('hidden');
  document.getElementById('detail-files-tab').classList.add('hidden');

  // Load document content
  document.getElementById('detail-doc-content').innerHTML = '<div class="text-spellbook-muted">Loading...</div>';
  document.getElementById('detail-changelog-content').innerHTML = '<div class="text-spellbook-muted">Loading...</div>';
  document.getElementById('detail-files-content').innerHTML = '<div class="text-spellbook-muted">Loading...</div>';

  try {
    const res = await fetch(`${API_BASE}/item/${type}/${number}/doc`);
    const data = await res.json();
    if (data.content) {
      currentDocContent = data.content;
      document.getElementById('detail-doc-content').innerHTML = marked.parse(data.content);

      // Extract changelog section
      const changelogMatch = data.content.match(/##\s*Changelog[\s\S]*?(?=\n##\s|$)/i);
      if (changelogMatch) {
        document.getElementById('detail-changelog-content').innerHTML = marked.parse(changelogMatch[0]);
      } else {
        document.getElementById('detail-changelog-content').innerHTML = '<div class="text-spellbook-muted">No changelog found in document</div>';
      }

      // Extract files changed section
      const filesMatch = data.content.match(/##\s*Files\s*Changed[\s\S]*?(?=\n##\s|$)/i);
      if (filesMatch) {
        document.getElementById('detail-files-content').innerHTML = marked.parse(filesMatch[0]);
      } else {
        document.getElementById('detail-files-content').innerHTML = '<div class="text-spellbook-muted">No "Files Changed" section found</div>';
      }
    } else {
      document.getElementById('detail-doc-content').innerHTML = '<div class="text-spellbook-muted">No document found</div>';
      document.getElementById('detail-changelog-content').innerHTML = '<div class="text-spellbook-muted">No document found</div>';
      document.getElementById('detail-files-content').innerHTML = '<div class="text-spellbook-muted">No document found</div>';
    }
  } catch (err) {
    document.getElementById('detail-doc-content').innerHTML = '<div class="text-red-400">Failed to load document</div>';
    document.getElementById('detail-changelog-content').innerHTML = '<div class="text-red-400">Failed to load document</div>';
    document.getElementById('detail-files-content').innerHTML = '<div class="text-red-400">Failed to load document</div>';
  }

  // Show modal
  document.getElementById('item-detail-modal').classList.remove('hidden');

  // Check if there's an existing tmux session for this item
  const sessionKey = `${type}-${number}`;
  const workOnBtn = document.querySelector('#item-detail-modal button[onclick="openPlanningFromModal()"]');

  if (workOnBtn) {
    // Check localStorage for saved session
    const savedSessions = loadSessionsFromStorage();
    const hasSavedSession = savedSessions[sessionKey]?.tmuxSession;

    // Also check persisted tmux sessions
    try {
      const persistedRes = await fetch(`${API_BASE}/terminals/persisted`);
      const persistedData = await persistedRes.json();
      const hasTmuxSession = persistedData.available &&
        persistedData.sessions.some(s => s.name === sessionKey);

      if (hasSavedSession || hasTmuxSession) {
        workOnBtn.innerHTML = '▶ Resume Session';
        workOnBtn.dataset.hasSession = 'true';
      } else {
        workOnBtn.innerHTML = '🔧 Work on This';
        workOnBtn.dataset.hasSession = 'false';
      }
    } catch (err) {
      // Default to work on this if check fails
      workOnBtn.innerHTML = '🔧 Work on This';
      workOnBtn.dataset.hasSession = 'false';
    }
  }
}

function setDetailTab(tab) {
  currentDetailTab = tab;

  // Update tab buttons
  document.querySelectorAll('.detail-tab').forEach(btn => {
    btn.classList.remove('active');
    if (btn.dataset.tab === tab) btn.classList.add('active');
  });

  // Show/hide tab content
  document.getElementById('detail-document-tab').classList.toggle('hidden', tab !== 'document');
  document.getElementById('detail-changelog-tab').classList.toggle('hidden', tab !== 'changelog');
  document.getElementById('detail-files-tab').classList.toggle('hidden', tab !== 'files');
}

function hideItemDetailModal() {
  document.getElementById('item-detail-modal').classList.add('hidden');
  currentDetailItem = null;
}

async function openPlanningFromModal() {
  console.log('openPlanningFromModal called, currentDetailItem:', currentDetailItem);
  if (!currentDetailItem) {
    alert('No item selected. Please click on an item first.');
    return;
  }

  const { type, number, item } = currentDetailItem;
  const sessionKey = `${type}-${number}`;

  // Check if item already has a worktree - if so, go straight to planning view
  const existingWorktree = findItemWorktree(type, number);
  if (existingWorktree) {
    console.log('Item has existing worktree, opening planning view directly');
    hideItemDetailModal();
    openPlanningView(type, number);
    return;
  }

  // Check if there's an existing tmux session for this item (from localStorage or persisted)
  const workOnBtn = document.querySelector('#item-detail-modal button[onclick="openPlanningFromModal()"]');
  const hasSession = workOnBtn?.dataset.hasSession === 'true';

  // Also check localStorage directly
  const savedSessions = loadSessionsFromStorage();
  const hasSavedSession = savedSessions[sessionKey]?.tmuxSession;

  if (hasSession || hasSavedSession) {
    console.log(`Found existing session for ${sessionKey}, resuming directly`);
    hideItemDetailModal();
    openPlanningView(type, number);
    return;
  }

  // Show work mode selection modal
  showWorkModeModal(type, number, item);
}

function showWorkModeModal(type, number, item) {
  const modal = document.getElementById('work-mode-modal');
  const itemRef = document.getElementById('work-mode-item-ref');
  const branchInput = document.getElementById('worktree-branch-name');
  const pathPreview = document.getElementById('worktree-path-preview');
  const worktreeOptions = document.getElementById('worktree-options');

  // Store item info for submission
  modal.dataset.itemType = type;
  modal.dataset.itemNumber = number;
  modal.dataset.itemSlug = item.slug || item.title?.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30) || 'item';

  // Set item reference display
  const ref = `${type}-${number}`;
  itemRef.textContent = ref;

  // Generate default branch name
  const branchPrefix = TYPE_TO_BRANCH_PREFIX[type] || 'improvement';
  const slug = modal.dataset.itemSlug;
  const defaultBranch = `${branchPrefix}/${number}-${slug}`;
  branchInput.value = defaultBranch;

  // Update path preview
  const projectName = state.project?.name || state.project?.id || 'project';
  pathPreview.textContent = `~/.worktrees/${projectName}/${defaultBranch.replace('/', '-')}`;

  // Reset to develop mode
  const developRadio = modal.querySelector('input[value="develop"]');
  if (developRadio) {
    developRadio.checked = true;
  }
  worktreeOptions.classList.add('hidden');

  // Add radio change listeners
  const radios = modal.querySelectorAll('input[name="work-mode"]');
  radios.forEach(radio => {
    radio.onchange = () => {
      if (radio.value === 'worktree' && radio.checked) {
        worktreeOptions.classList.remove('hidden');
      } else {
        worktreeOptions.classList.add('hidden');
      }
    };
  });

  // Update path preview when branch name changes
  branchInput.oninput = () => {
    const branch = branchInput.value || defaultBranch;
    pathPreview.textContent = `~/.worktrees/${projectName}/${branch.replace('/', '-')}`;
  };

  // Show modal
  modal.classList.remove('hidden');
}

function hideWorkModeModal() {
  document.getElementById('work-mode-modal').classList.add('hidden');
}

// ==================== WORKTREE PROGRESS MODAL ====================

let worktreeProgressState = {
  type: null,
  number: null,
  branchName: null,
  installDeps: true,
  aborted: false,
};

function showWorktreeProgressModal(type, number, branchName) {
  const modal = document.getElementById('worktree-progress-modal');
  const ref = `${type}-${number}`;

  // Store state for retry
  worktreeProgressState = {
    type,
    number,
    branchName,
    installDeps: document.getElementById('worktree-install-deps')?.checked ?? true,
    aborted: false,
  };

  // Set item reference
  document.getElementById('progress-item-ref').textContent = ref;

  // Reset all steps to pending
  const steps = ['create', 'checkout', 'setup', 'deps', 'ready'];
  steps.forEach(step => {
    updateProgressStep(step, 'pending', 'Waiting...');
  });

  // Hide result/error sections
  document.getElementById('progress-result').classList.add('hidden');
  document.getElementById('progress-error').classList.add('hidden');

  // Show cancel button, hide continue/retry buttons
  document.getElementById('progress-cancel-btn').classList.remove('hidden');
  document.getElementById('progress-continue-btn').classList.add('hidden');
  document.getElementById('progress-retry-btn').classList.add('hidden');

  // Show modal
  modal.classList.remove('hidden');
}

function hideWorktreeProgressModal() {
  document.getElementById('worktree-progress-modal').classList.add('hidden');
  worktreeProgressState.aborted = true;
}

function updateProgressStep(stepName, status, message) {
  const stepEl = document.querySelector(`.progress-step[data-step="${stepName}"]`);
  if (!stepEl) return;

  const pendingEl = stepEl.querySelector('.step-pending');
  const activeEl = stepEl.querySelector('.step-active');
  const doneEl = stepEl.querySelector('.step-done');
  const errorEl = stepEl.querySelector('.step-error');
  const statusEl = stepEl.querySelector('.step-status');

  // Hide all icons first
  pendingEl?.classList.add('hidden');
  activeEl?.classList.add('hidden');
  doneEl?.classList.add('hidden');
  errorEl?.classList.add('hidden');

  // Show appropriate icon
  switch (status) {
    case 'pending':
      pendingEl?.classList.remove('hidden');
      break;
    case 'active':
      activeEl?.classList.remove('hidden');
      break;
    case 'done':
      doneEl?.classList.remove('hidden');
      break;
    case 'error':
      errorEl?.classList.remove('hidden');
      break;
    case 'skipped':
      pendingEl?.classList.remove('hidden');
      break;
  }

  // Update status message
  if (statusEl && message) {
    statusEl.textContent = message;
    if (status === 'done') {
      statusEl.classList.add('text-green-400');
      statusEl.classList.remove('text-red-400', 'text-spellbook-muted');
    } else if (status === 'error') {
      statusEl.classList.add('text-red-400');
      statusEl.classList.remove('text-green-400', 'text-spellbook-muted');
    } else {
      statusEl.classList.add('text-spellbook-muted');
      statusEl.classList.remove('text-green-400', 'text-red-400');
    }
  }
}

function showProgressSuccess(worktreeData) {
  const resultEl = document.getElementById('progress-result');
  const contentEl = document.getElementById('progress-result-content');

  const parts = [
    `<div class="text-green-400 font-medium mb-2">✓ Worktree created successfully!</div>`,
    `<div class="text-sm space-y-1">`,
    `<div><span class="text-spellbook-muted">Branch:</span> <span class="font-mono">${worktreeData.branch}</span></div>`,
    `<div><span class="text-spellbook-muted">Path:</span> <span class="font-mono text-xs">${worktreeData.path}</span></div>`,
  ];

  if (worktreeData.ports?.length > 0) {
    parts.push(`<div><span class="text-spellbook-muted">Ports:</span> ${worktreeData.ports.join(', ')}</div>`);
  }

  parts.push('</div>');

  contentEl.innerHTML = parts.join('');
  resultEl.classList.remove('hidden');
  resultEl.classList.add('bg-green-500/10', 'border', 'border-green-500/30');

  // Show continue button, hide cancel
  document.getElementById('progress-cancel-btn').classList.add('hidden');
  document.getElementById('progress-continue-btn').classList.remove('hidden');
}

function showProgressError(errorMessage) {
  const errorEl = document.getElementById('progress-error');
  document.getElementById('progress-error-message').textContent = errorMessage;
  errorEl.classList.remove('hidden');

  // Show retry button, keep cancel
  document.getElementById('progress-retry-btn').classList.remove('hidden');
}

function cancelWorktreeProgress() {
  worktreeProgressState.aborted = true;
  hideWorktreeProgressModal();
}

function continueFromProgress() {
  const { type, number } = worktreeProgressState;
  hideWorktreeProgressModal();
  if (type && number) {
    openPlanningView(type, number);
  }
}

async function retryWorktreeCreation() {
  const { type, number, branchName, installDeps } = worktreeProgressState;

  // Reset steps
  const steps = ['create', 'checkout', 'setup', 'deps', 'ready'];
  steps.forEach(step => {
    updateProgressStep(step, 'pending', 'Waiting...');
  });

  // Hide error/result
  document.getElementById('progress-result').classList.add('hidden');
  document.getElementById('progress-error').classList.add('hidden');
  document.getElementById('progress-retry-btn').classList.add('hidden');

  worktreeProgressState.aborted = false;

  // Retry creation
  await createWorktreeAndOpenPlanning(type, number, branchName, { installDeps, showProgress: false });
}

async function submitWorkMode() {
  const modal = document.getElementById('work-mode-modal');
  const type = modal.dataset.itemType;
  const number = parseInt(modal.dataset.itemNumber, 10);
  const selectedMode = modal.querySelector('input[name="work-mode"]:checked')?.value;

  if (!type || !number) {
    alert('No item selected');
    return;
  }

  hideWorkModeModal();
  hideItemDetailModal();

  if (selectedMode === 'worktree') {
    // Get worktree options
    const branchName = document.getElementById('worktree-branch-name').value;
    const installDeps = document.getElementById('worktree-install-deps')?.checked ?? true;
    const aiTool = modal.querySelector('input[name="ai-tool"]:checked')?.value || 'claude';

    // Show progress modal
    showWorktreeProgressModal(type, number, branchName);

    // Create worktree with full setup (opens in built-in web terminal, not external)
    await createWorktreeAndOpenPlanning(type, number, branchName, { installDeps, aiTool });
  } else {
    // Open planning view directly (work on develop)
    openPlanningView(type, number);
  }
}

async function createWorktreeAndOpenPlanning(type, number, branchName, options = {}) {
  const { installDeps = true, aiTool = 'claude' } = options;
  // Never launch external terminal - we'll open in the built-in web terminal via openPlanningView
  const launchTerminal = false;
  const ref = `${type}-${number}`;

  // Get task description from the item
  let item;
  if (type === 'bug') item = state.bugs.find(b => b.number === number);
  else if (type === 'improvement') item = state.improvements.find(i => i.number === number);
  else if (type === 'feature') item = state.features.find(f => f.number === number);

  const task = item?.title || item?.name || '';

  updateActivity(`Creating worktree for ${ref}...`);

  // Update progress: start creating
  updateProgressStep('create', 'active', 'Creating worktree directory...');

  try {
    // Simulate progress steps while API call runs
    const progressTimer = setTimeout(() => {
      if (!worktreeProgressState.aborted) {
        updateProgressStep('create', 'done', 'Directory created');
        updateProgressStep('checkout', 'active', `Checking out ${branchName}...`);
      }
    }, 500);

    const progressTimer2 = setTimeout(() => {
      if (!worktreeProgressState.aborted) {
        updateProgressStep('checkout', 'done', 'Branch checked out');
        updateProgressStep('setup', 'active', 'Copying .env files, symlinking docs...');
      }
    }, 1500);

    const progressTimer3 = setTimeout(() => {
      if (!worktreeProgressState.aborted && installDeps) {
        updateProgressStep('setup', 'done', 'Environment configured');
        updateProgressStep('deps', 'active', 'Running npm install...');
      }
    }, 2500);

    // Call the enhanced worktree create API
    const res = await fetch(`${API_BASE}/worktree/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        itemRef: ref,
        branchName: branchName,
        task: task,
        installDeps: installDeps,
        launchTerminal: launchTerminal,
        aiTool: aiTool,
      }),
    });

    // Clear progress timers
    clearTimeout(progressTimer);
    clearTimeout(progressTimer2);
    clearTimeout(progressTimer3);

    if (worktreeProgressState.aborted) {
      return;
    }

    if (!res.ok) {
      const errData = await res.json().catch(() => ({ error: 'Unknown error' }));
      throw new Error(errData.error || errData.message || 'Failed to create worktree');
    }

    const worktreeData = await res.json();
    console.log('Worktree created:', worktreeData);

    // Update progress steps based on actual results
    updateProgressStep('create', 'done', `Created at ${worktreeData.path.split('/').slice(-2).join('/')}`);
    updateProgressStep('checkout', 'done', `Branch: ${worktreeData.branch}`);

    if (worktreeData.setup?.knowledgeSymlinked || worktreeData.setup?.envCopied) {
      updateProgressStep('setup', 'done', 'Environment configured');
    } else {
      updateProgressStep('setup', 'done', 'Basic setup complete');
    }

    if (installDeps) {
      if (worktreeData.dependencies?.installed) {
        updateProgressStep('deps', 'done', 'Dependencies installed');
      } else if (worktreeData.dependencies?.error) {
        updateProgressStep('deps', 'error', 'Failed - install manually');
      } else {
        updateProgressStep('deps', 'done', 'Dependencies ready');
      }
    } else {
      updateProgressStep('deps', 'skipped', 'Skipped (manual install)');
    }

    updateProgressStep('ready', 'done', 'Ready to work!');

    // Build status message for activity feed
    const statusParts = [`Worktree created at ${worktreeData.path}`];

    if (worktreeData.ports?.length > 0) {
      statusParts.push(`Ports: ${worktreeData.ports.join(', ')}`);
    }

    if (worktreeData.setup?.knowledgeSymlinked) {
      statusParts.push('docs/knowledge symlinked');
    }

    if (worktreeData.dependencies?.installed) {
      statusParts.push('Dependencies installed');
    } else if (worktreeData.dependencies?.error) {
      statusParts.push('Deps failed - install manually');
    }

    updateActivity(statusParts.join(' | '));

    // Refresh worktrees list
    await loadWorktrees();

    // Update item status to in_progress
    try {
      const endpoint = TYPE_TO_ENDPOINT[type] || 'features';
      await fetch(`${API_BASE}/${endpoint}/${number}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'in_progress' }),
      });
      await fetchData();
      renderKanban();
    } catch (statusErr) {
      console.warn('Could not update item status:', statusErr);
    }

    // Show success in progress modal
    showProgressSuccess(worktreeData);

    console.log(`Worktree created for ${ref}\nBranch: ${worktreeData.branch}\nPath: ${worktreeData.path}`);

  } catch (err) {
    console.error('Failed to create worktree:', err);

    // Update progress to show error
    updateProgressStep('create', 'error', 'Failed');
    showProgressError(err.message);

    updateActivity(`Failed to create worktree: ${err.message}`);
  }
}

async function quickFinalize() {
  console.log('quickFinalize called', currentDetailItem);
  if (!currentDetailItem) {
    alert('No item selected');
    return;
  }

  const { type, number } = currentDetailItem;
  const newStatus = TYPE_TO_DONE_STATUS[type] || 'complete';

  try {
    const endpoint = TYPE_TO_ENDPOINT[type] || 'features';

    debugLog(`Updating ${endpoint}/${number} to status: ${newStatus}`);

    const res = await fetch(`${API_BASE}/${endpoint}/${number}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: newStatus }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`API error: ${res.status} - ${errText}`);
    }

    console.log('Status updated, regenerating roadmap...');

    // Regenerate roadmap
    const roadmapRes = await fetch(`${API_BASE}/roadmap`, { method: 'POST' });
    if (!roadmapRes.ok) {
      console.warn('Roadmap regeneration failed');
    }

    updateActivity(`Finalized ${type}-${number}`);
    hideItemDetailModal();
    await fetchData();
    renderKanban();

    // Show success message
    alert(`${type}-${number} marked as ${newStatus}!`);
  } catch (err) {
    console.error('Failed to finalize:', err);
    alert(`Failed to finalize item: ${err.message}`);
  }
}

function openDocInEditor() {
  if (!currentDetailItem) return;
  const { type, number, item } = currentDetailItem;

  // Try to open the doc path if available
  if (item.doc_path) {
    updateActivity(`Open ${item.doc_path} in your editor`);
    alert(`Document path: ${item.doc_path}\n\nOpen this file in your editor.`);
  } else {
    alert('No document path available');
  }
}

// ==================== PLANNING VIEW (Simplified - No Browser Terminal) ====================

async function openPlanningView(type, number) {
  const sessionKey = `${type}-${number}`;

  // Find the item
  let item;
  if (type === 'bug') item = state.bugs.find(b => b.number === number);
  else if (type === 'improvement') item = state.improvements.find(i => i.number === number);
  else if (type === 'feature') item = state.features.find(f => f.number === number);

  if (!item) {
    alert('Item not found');
    return;
  }

  // Update header
  document.getElementById('planning-item-ref').textContent = sessionKey;
  document.getElementById('planning-item-title').textContent = item.title || item.name || 'Untitled';
  document.getElementById('planning-working-ref').textContent = sessionKey;

  // Update status badge
  const statusBadge = document.getElementById('planning-status-badge');
  const statusColors = {
    active: 'bg-gray-500/20 text-gray-400',
    spec_draft: 'bg-gray-500/20 text-gray-400',
    spec_ready: 'bg-blue-500/20 text-blue-400',
    in_progress: 'bg-yellow-500/20 text-yellow-400',
    pr_open: 'bg-purple-500/20 text-purple-400',
    resolved: 'bg-green-500/20 text-green-400',
    completed: 'bg-green-500/20 text-green-400',
  };
  statusBadge.className = `px-2 py-1 text-xs rounded ${statusColors[item.status] || statusColors.active}`;
  statusBadge.textContent = (item.status || 'active').replace('_', ' ');

  // Store active session info (for "Open in iTerm" button)
  sessions.activePlanningSession = sessionKey;
  if (!sessions.planning[sessionKey]) {
    sessions.planning[sessionKey] = {
      itemType: type,
      itemNumber: number,
      status: 'viewing',
    };
  }

  // Check for linked worktree
  const linkedWorktree = findItemWorktree(type, number);
  sessions.planning[sessionKey].worktreePath = linkedWorktree?.path || state.project?.path;

  // Load plan file
  const planData = await loadPlanFile(type, number);

  // Update plan indicator
  updatePlanIndicator(planData.exists);

  // Load document
  await loadPlanningDocument(sessionKey, type, number);

  // Update worktree indicator
  updateWorktreeIndicator(type, number);

  // Update action button based on item status
  updateActionButton(item.status);

  // Show planning view
  document.getElementById('planning-view').classList.remove('hidden');

  // Start document refresh
  startDocumentRefresh(sessionKey, type, number);

  // Update workflow phase badge
  const itemStatus = item?.status || 'active';
  let initialPhase;
  switch (itemStatus) {
    case 'in_progress': initialPhase = 'implementing'; break;
    case 'pr_open': initialPhase = 'review'; break;
    case 'resolved':
    case 'completed': initialPhase = 'complete'; break;
    default: initialPhase = 'planning';
  }
  updateWorkflowPhaseBadge(initialPhase);

  updateActivity(`Viewing ${sessionKey}`);
}


// Load plan file for an item
async function loadPlanFile(type, number) {
  try {
    const res = await fetch(`${API_BASE}/item/${type}/${number}/plan`);
    return await res.json();
  } catch (err) {
    console.error('Failed to load plan:', err);
    return { exists: false, content: null };
  }
}

// Save plan file
async function savePlanFile(type, number, content) {
  try {
    const res = await fetch(`${API_BASE}/item/${type}/${number}/plan`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    if (!res.ok) throw new Error('Failed to save plan');
    return await res.json();
  } catch (err) {
    console.error('Failed to save plan:', err);
    throw err;
  }
}

// Update the plan indicator in UI
// Note: Plans are created in Claude Code's plan mode, not saved to files
// So we just show status based on what the scribe has documented
function updatePlanIndicator(exists) {
  const indicator = document.getElementById('plan-status-indicator');
  if (indicator) {
    if (exists) {
      indicator.innerHTML = '<span class="text-green-400">✓ Plan documented</span>';
    } else {
      // Don't show warning - plans are in Claude context, not files
      indicator.innerHTML = '';
    }
  }
}

async function createPlanningSession(sessionKey, type, number, item, planData) {
  try {
    // Get the central storage path for this item
    const centralPath = `~/.spellbook/projects/${state.project?.id}/${type}s/${item.doc_path?.split('/').pop() || `${number}-${item.slug}.md`}`;
    const planPath = centralPath.replace('.md', '.plan.md');

    // Check if there's a worktree linked to this item
    const linkedWorktree = findItemWorktree(type, number);
    const workingDir = linkedWorktree?.path || state.project?.path;

    // FIRST: Check if a tmux session already exists for this item
    // This handles the case where item is in_progress and Claude is already running
    const persistedRes = await fetch(`${API_BASE}/terminals/persisted`);
    const persistedData = await persistedRes.json();
    const existingSession = persistedData.available &&
      persistedData.sessions.find(s => s.name === sessionKey);

    if (existingSession) {
      debugLog(`[Planning] Found existing tmux session for ${sessionKey}, reconnecting...`);

      // Reconnect to existing session instead of creating new
      const reconnectRes = await fetch(`${API_BASE}/terminals/reconnect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionName: sessionKey,
          cwd: workingDir,
        }),
      });

      if (reconnectRes.ok) {
        const reconnectData = await reconnectRes.json();

        sessions.planning[sessionKey] = {
          terminalId: reconnectData.terminalId,
          term: null,
          ws: null,
          fitAddon: null,
          itemType: type,
          itemNumber: number,
          docPath: item.doc_path,
          planContent: planData.content,
          planExists: planData.exists,
          planTemplate: planData.template,
          status: 'active',
          itemStatus: item.status,
          lastActivity: new Date(),
          worktree: linkedWorktree,
          workingDir: workingDir,
          tmuxSession: sessionKey,
          reconnected: true, // Flag to indicate this was a reconnection
        };

        saveSessionsToStorage();
        await connectTerminal(sessionKey, document.getElementById('planning-terminal'));

        // Don't send /rename or initial prompt - session is already running
        updateActivity(`Reconnected to existing session: ${sessionKey}`);
        return;
      }
      // If reconnect failed, fall through to create new session
      debugLog(`[Planning] Reconnect failed, creating new session for ${sessionKey}`);
    }
    const worktreeInfo = linkedWorktree
      ? `\nWorktree: ${linkedWorktree.path} (branch: ${linkedWorktree.branch})`
      : '';

    // Build initial prompt based on ITEM STATUS (not just plan existence)
    let initialPrompt;
    const itemStatus = item.status || 'active';

    if (itemStatus === 'in_progress') {
      // Item is in_progress (plan approved) - trigger /implement
      initialPrompt = `/implement ${sessionKey}`;
    } else if (itemStatus === 'pr_open') {
      // PR is open - give context about review
      initialPrompt = `Working on ${sessionKey}. PR is open and awaiting review/merge.\n\nMain doc: ${centralPath}${worktreeInfo}`;
    } else if (planData.exists && planData.content) {
      // Has plan but not in_progress - give context
      const howToContinue = extractHowToContinue(planData.content);
      initialPrompt = howToContinue
        ? `Working on ${sessionKey}. ${howToContinue}\n\nMain doc: ${centralPath}\nPlan file: ${planPath}${worktreeInfo}`
        : `Working on ${sessionKey}. Plan file exists at ${planPath} - read it first. Main doc at ${centralPath}${worktreeInfo}`;
    } else {
      // No plan and status is active/spec_draft/spec_ready - trigger /plan skill
      initialPrompt = `/plan ${sessionKey}`;
    }

    // Use worktree path if linked, otherwise main project path
    const res = await fetch(`${API_BASE}/terminals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cwd: workingDir,
        name: sessionKey,
        command: 'claude',
        args: ['--dangerously-skip-permissions'],
        useTmux: true,
        tmuxSessionName: sessionKey,
      }),
    });

    if (!res.ok) throw new Error('Failed to create terminal');

    const data = await res.json();

    sessions.planning[sessionKey] = {
      terminalId: data.terminalId,
      term: null,
      ws: null,
      fitAddon: null,
      itemType: type,
      itemNumber: number,
      docPath: item.doc_path,
      planContent: planData.content,
      planExists: planData.exists,
      planTemplate: planData.template,
      status: 'active',
      itemStatus: item.status, // Store the actual item status
      lastActivity: new Date(),
      worktree: linkedWorktree, // Store linked worktree info
      workingDir: workingDir, // Store the actual working directory
      tmuxSession: data.tmuxSession, // Store tmux session name
    };

    // Save session for persistence
    saveSessionsToStorage();

    await connectTerminal(sessionKey, document.getElementById('planning-terminal'));

    // After terminal is ready, rename session then inject the initial context prompt
    setTimeout(() => {
      const session = sessions.planning[sessionKey];
      if (session?.ws?.readyState === WebSocket.OPEN) {
        // Helper to send text + Enter as separate messages (simulates real typing)
        const sendCommand = (text, callback) => {
          // Send the text first
          session.ws.send(JSON.stringify({ type: 'input', data: text }));
          // Then send Enter as a separate message after a small delay
          setTimeout(() => {
            session.ws.send(JSON.stringify({ type: 'input', data: '\r' }));
            if (callback) setTimeout(callback, 100);
          }, 50);
        };

        // Set up listener for rename confirmation
        let renameConfirmed = false;
        const checkRename = (event) => {
          try {
            const msg = JSON.parse(event.data);
            if (msg.type === 'output' && msg.data && msg.data.includes('Session renamed to:')) {
              renameConfirmed = true;
              session.ws.removeEventListener('message', checkRename);
              // Wait longer for Claude to be ready after rename, then send prompt
              setTimeout(() => {
                if (session?.ws?.readyState === WebSocket.OPEN) {
                  console.log(`[Spellbook] Rename confirmed, sending initial prompt: ${initialPrompt.substring(0, 50)}...`);
                  sendCommand(initialPrompt);
                }
              }, 2000); // Increased from 1000ms to 2000ms
            }
          } catch (e) {
            // Ignore parse errors
          }
        };
        session.ws.addEventListener('message', checkRename);

        // Send rename command (text + Enter separately)
        console.log(`[Spellbook] Sending rename command: /rename ${sessionKey}`);
        sendCommand(`/rename ${sessionKey}`);

        // Fallback: if rename confirmation not received in 15 seconds, send anyway
        setTimeout(() => {
          if (!renameConfirmed) {
            console.log(`[Spellbook] Rename confirmation timeout, sending prompt anyway`);
            session.ws.removeEventListener('message', checkRename);
            if (session?.ws?.readyState === WebSocket.OPEN) {
              sendCommand(initialPrompt);
            }
          }
        }, 15000); // Increased from 10000ms to 15000ms
      }
    }, 2000); // Wait for Claude to initialize

  } catch (err) {
    console.error('Failed to create planning session:', err);
    throw err;
  }
}

// Extract the "How to Continue" section from a plan
function extractHowToContinue(planContent) {
  const lines = planContent.split('\n');
  let inSection = false;
  let result = [];

  for (const line of lines) {
    if (line.match(/^##?\s*How to Continue/i)) {
      inSection = true;
      continue;
    }
    if (inSection) {
      if (line.match(/^##?\s+/)) break; // Next section
      if (line.trim()) result.push(line.trim());
    }
  }

  return result.length > 0 ? result.join(' ') : null;
}

async function loadPlanningDocument(sessionKey, type, number) {
  try {
    const res = await fetch(`${API_BASE}/item/${type}/${number}/doc`);
    const data = await res.json();

    // Store for changelog extraction
    const session = sessions.planning[sessionKey];
    if (session && data.content) {
      session.docContent = data.content;
    }

    // Only update content if we're on the document tab
    if (currentPlanningTab === 'document') {
      const contentEl = document.getElementById('planning-document-content');
      if (data.content) {
        contentEl.innerHTML = marked.parse(data.content);
      } else {
        contentEl.innerHTML = '<p class="text-spellbook-muted">No documentation available</p>';
      }
    }

    document.getElementById('doc-last-modified').textContent = `Updated: ${new Date().toLocaleTimeString()}`;
  } catch (err) {
    console.error('Failed to load document:', err);
  }
}

function startDocumentRefresh(sessionKey, type, number) {
  // Clear any existing interval
  if (docRefreshInterval) {
    clearInterval(docRefreshInterval);
  }

  // Refresh at configured interval (pauses when tab is hidden)
  docRefreshInterval = setInterval(async () => {
    if (!isPageVisible) return; // Skip refresh when tab is hidden
    if (sessions.activePlanningSession === sessionKey) {
      await loadPlanningDocument(sessionKey, type, number);
    }
  }, PERF_CONFIG.DOC_REFRESH_INTERVAL);
}

function stopDocumentRefresh() {
  if (docRefreshInterval) {
    clearInterval(docRefreshInterval);
    docRefreshInterval = null;
  }
}

function setPlanningDocTab(tab) {
  // Track current tab
  currentPlanningTab = tab;

  document.querySelectorAll('.planning-doc-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });

  const session = sessions.planning[sessions.activePlanningSession];
  const contentEl = document.getElementById('planning-document-content');

  if (tab === 'files') {
    // Load and show git diff in tree structure
    loadFilesChangedTree(contentEl);
    return;
  } else if (tab === 'changelog' && session?.docContent) {
    // Extract changelog section
    const changelogMatch = session.docContent.match(/## Changelog[\s\S]*$/);
    if (changelogMatch) {
      contentEl.innerHTML = marked.parse(changelogMatch[0]);
    } else {
      contentEl.innerHTML = '<p class="text-spellbook-muted">No changelog found</p>';
    }
  } else if (tab === 'plan') {
    // Show plan content or template
    if (session?.planContent) {
      contentEl.innerHTML = `
        <div class="plan-editor">
          <div class="flex justify-between items-center mb-4">
            <span class="text-green-400 text-sm">✓ Plan file exists</span>
            <button onclick="editPlan()" class="px-3 py-1 bg-spellbook-card border border-spellbook-border rounded text-sm hover:border-spellbook-accent">
              Edit Plan
            </button>
          </div>
          <div class="plan-content">${marked.parse(session.planContent)}</div>
        </div>
      `;
    } else if (session?.planTemplate) {
      contentEl.innerHTML = `
        <div class="plan-editor">
          <div class="mb-4">
            <p class="text-spellbook-muted text-sm mb-2">
              📋 The plan will be saved here automatically when Claude starts implementing.
            </p>
            <p class="text-spellbook-muted text-xs">
              Claude creates the plan in plan mode → You approve → Claude saves it here and implements.
            </p>
          </div>
        </div>
      `;
    } else {
      contentEl.innerHTML = '<p class="text-spellbook-muted">No plan data available</p>';
    }
  } else if (tab === 'document') {
    contentEl.innerHTML = marked.parse(session?.docContent || 'No content');
  }
}

// Create plan from template
async function createPlanFromTemplate() {
  const session = sessions.planning[sessions.activePlanningSession];
  if (!session?.planTemplate) return;

  try {
    await savePlanFile(session.itemType, session.itemNumber, session.planTemplate);
    session.planContent = session.planTemplate;
    session.planExists = true;

    // Refresh the view
    setPlanningDocTab('plan');
    updatePlanIndicator(true);

    updateActivity('Plan created from template');
  } catch (err) {
    alert('Failed to create plan: ' + err.message);
  }
}

// Edit plan in a modal
function editPlan() {
  const session = sessions.planning[sessions.activePlanningSession];
  if (!session) return;

  const content = session.planContent || session.planTemplate || '';

  const modal = document.createElement('div');
  modal.id = 'plan-edit-modal';
  modal.className = 'fixed inset-0 bg-black/80 flex items-center justify-center z-[60]';
  modal.innerHTML = `
    <div class="bg-spellbook-card border border-spellbook-border rounded-lg w-3/4 max-w-4xl h-3/4 flex flex-col">
      <div class="p-4 border-b border-spellbook-border flex justify-between items-center">
        <h3 class="font-semibold">Edit Plan: ${sessions.activePlanningSession}</h3>
        <div class="flex gap-2">
          <button onclick="cancelPlanEdit()" class="px-4 py-2 border border-spellbook-border rounded hover:bg-spellbook-card">
            Cancel
          </button>
          <button onclick="savePlanEdit()" class="px-4 py-2 bg-spellbook-accent text-black rounded hover:bg-spellbook-accent/80">
            Save Plan
          </button>
        </div>
      </div>
      <textarea id="plan-edit-textarea" class="flex-1 bg-spellbook-bg p-4 font-mono text-sm resize-none focus:outline-none"
        placeholder="Enter your implementation plan...">${escapeHtml(content)}</textarea>
    </div>
  `;

  document.body.appendChild(modal);
  document.getElementById('plan-edit-textarea').focus();
}

function cancelPlanEdit() {
  const modal = document.getElementById('plan-edit-modal');
  if (modal) modal.remove();
}

async function savePlanEdit() {
  const textarea = document.getElementById('plan-edit-textarea');
  const content = textarea.value;
  const session = sessions.planning[sessions.activePlanningSession];

  if (!session) return;

  try {
    await savePlanFile(session.itemType, session.itemNumber, content);
    session.planContent = content;
    session.planExists = true;

    cancelPlanEdit();
    setPlanningDocTab('plan');
    updatePlanIndicator(true);

    updateActivity('Plan saved');
  } catch (err) {
    alert('Failed to save plan: ' + err.message);
  }
}

// Escape HTML for safe display
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Build file tree structure from flat file list
function buildFileTree(files) {
  const tree = {};

  files.forEach(file => {
    const parts = file.path.split('/');
    let current = tree;

    parts.forEach((part, i) => {
      if (i === parts.length - 1) {
        // Leaf node (file)
        current[part] = { ...file, isFile: true, name: part };
      } else {
        // Directory node
        if (!current[part]) {
          current[part] = { isDir: true, name: part, children: {} };
        }
        current = current[part].children;
      }
    });
  });

  return tree;
}

// Render file tree recursively
function renderFileTree(tree, depth = 0) {
  const entries = Object.entries(tree).sort(([, a], [, b]) => {
    // Directories first, then files
    if (a.isDir && !b.isDir) return -1;
    if (!a.isDir && b.isDir) return 1;
    return a.name.localeCompare(b.name);
  });

  return entries.map(([name, node]) => {
    const indent = depth * 16;

    if (node.isDir) {
      const dirId = `dir-${name}-${depth}`.replace(/[^a-z0-9-]/gi, '_');
      return `
        <div class="file-tree-dir">
          <div class="flex items-center gap-2 py-1 px-2 hover:bg-spellbook-card rounded cursor-pointer"
               style="padding-left: ${indent + 8}px"
               onclick="toggleTreeDir('${dirId}')">
            <span id="${dirId}-icon" class="text-spellbook-muted text-xs">▼</span>
            <span class="text-blue-400">📁</span>
            <span class="text-sm">${escapeHtml(name)}</span>
          </div>
          <div id="${dirId}" class="tree-dir-contents">
            ${renderFileTree(node.children, depth + 1)}
          </div>
        </div>
      `;
    } else {
      return renderTreeFileItem(node, indent);
    }
  }).join('');
}

// Render single file in tree
function renderTreeFileItem(file, indent) {
  const statusIcons = {
    'M': '📝', 'A': '✨', 'D': '🗑️', 'R': '📋', '?': '🆕', '??': '🆕'
  };
  const statusColors = {
    'M': 'text-yellow-400', 'A': 'text-green-400', 'D': 'text-red-400',
    'R': 'text-blue-400', '?': 'text-purple-400', '??': 'text-purple-400'
  };

  const icon = statusIcons[file.status] || '📄';
  const color = statusColors[file.status] || 'text-white';
  const total = (file.additions || 0) + (file.deletions || 0);
  const addWidth = total > 0 ? Math.round((file.additions / total) * 60) : 0;
  const delWidth = total > 0 ? Math.round((file.deletions / total) * 60) : 0;

  return `
    <div class="file-tree-item flex items-center gap-2 py-1 px-2 hover:bg-spellbook-card rounded cursor-pointer group"
         style="padding-left: ${indent + 8}px"
         onclick="showFileDiff('${escapeHtml(file.path)}')">
      <span class="text-sm">${icon}</span>
      <span class="text-sm ${color} flex-1 truncate font-mono">${escapeHtml(file.name)}</span>
      <div class="flex items-center gap-2 text-xs opacity-70 group-hover:opacity-100">
        ${file.additions > 0 ? `<span class="text-green-400">+${file.additions}</span>` : ''}
        ${file.deletions > 0 ? `<span class="text-red-400">-${file.deletions}</span>` : ''}
        <div class="flex h-1.5 w-[60px] bg-spellbook-bg rounded overflow-hidden">
          <div class="bg-green-500" style="width: ${addWidth}px"></div>
          <div class="bg-red-500" style="width: ${delWidth}px"></div>
        </div>
      </div>
    </div>
  `;
}

// Toggle directory expand/collapse
function toggleTreeDir(dirId) {
  const contents = document.getElementById(dirId);
  const icon = document.getElementById(`${dirId}-icon`);
  if (contents.classList.contains('hidden')) {
    contents.classList.remove('hidden');
    icon.textContent = '▼';
  } else {
    contents.classList.add('hidden');
    icon.textContent = '▶';
  }
}

// Load and display changed files as tree (GitHub-style)
async function loadFilesChangedTree(contentEl) {
  contentEl.innerHTML = '<div class="text-center py-8 text-spellbook-muted">Loading changed files...</div>';

  try {
    // Get worktree path from active planning session (if linked to a worktree)
    const session = sessions.planning[sessions.activePlanningSession];
    const targetPath = session?.worktree?.path || session?.workingDir || '';
    const pathParam = targetPath ? `?path=${encodeURIComponent(targetPath)}` : '';
    const res = await fetch(`${API_BASE}/git/diff${pathParam}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    if (!data.files || data.files.length === 0) {
      contentEl.innerHTML = `
        <div class="text-center py-8">
          <div class="text-4xl mb-4">✓</div>
          <div class="text-lg text-spellbook-muted">No uncommitted changes</div>
          <p class="text-sm text-spellbook-muted mt-2">All changes have been committed or there are no modifications.</p>
        </div>
      `;
      document.getElementById('files-count').textContent = '';
      return;
    }

    // Update files count badge
    document.getElementById('files-count').textContent = `(${data.files.length})`;

    // Build and render tree
    const tree = buildFileTree(data.files);

    // Build path indicator showing which directory we're viewing
    const isWorktree = session?.worktree?.path;
    const displayPath = isWorktree
      ? session.worktree.path.replace(/^\/Users\/[^/]+/, '~')
      : (session?.workingDir || state.project?.path || 'project').replace(/^\/Users\/[^/]+/, '~');
    const pathIndicator = isWorktree
      ? `<div class="text-xs text-spellbook-muted mb-2 flex items-center gap-1"><span class="text-green-400">worktree:</span> ${escapeHtml(displayPath)}</div>`
      : `<div class="text-xs text-spellbook-muted mb-2">${escapeHtml(displayPath)}</div>`;

    contentEl.innerHTML = `
      <div class="files-changed-tree">
        ${pathIndicator}
        <div class="flex items-center justify-between mb-4 pb-3 border-b border-spellbook-border">
          <div class="text-sm">
            <span class="font-semibold">${data.summary?.filesChanged || data.files.length}</span> files changed
            <span class="text-green-400 ml-3">+${data.summary?.additions || 0}</span>
            <span class="text-red-400 ml-2">-${data.summary?.deletions || 0}</span>
          </div>
          <div class="flex gap-2">
            <button onclick="collapseAllDirs()" class="px-2 py-1 text-xs bg-spellbook-card border border-spellbook-border rounded hover:border-spellbook-accent">
              Collapse All
            </button>
            <button onclick="refreshFilesChangedTree()" class="px-2 py-1 text-xs bg-spellbook-card border border-spellbook-border rounded hover:border-spellbook-accent">
              ↻ Refresh
            </button>
          </div>
        </div>
        <div class="file-tree overflow-auto max-h-[calc(100vh-300px)]">
          ${renderFileTree(tree)}
        </div>
      </div>
    `;

    // Store files for diff viewing
    state.changedFiles = data.files;
  } catch (err) {
    console.error('Failed to load files:', err);
    contentEl.innerHTML = `
      <div class="text-center py-8 text-red-400">
        <p>Failed to load changed files</p>
        <p class="text-sm mt-2">${err.message}</p>
        <button onclick="refreshFilesChangedTree()" class="mt-4 px-3 py-1 bg-spellbook-card border border-spellbook-border rounded hover:border-spellbook-accent text-spellbook-muted">
          Try Again
        </button>
      </div>
    `;
  }
}

// Collapse all directories
function collapseAllDirs() {
  document.querySelectorAll('.tree-dir-contents').forEach(el => {
    el.classList.add('hidden');
  });
  document.querySelectorAll('[id$="-icon"]').forEach(el => {
    if (el.textContent === '▼') el.textContent = '▶';
  });
}

// Refresh files tree
function refreshFilesChangedTree() {
  const contentEl = document.getElementById('planning-document-content');
  loadFilesChangedTree(contentEl);
}


async function showFileDiff(filePath) {
  const contentEl = document.getElementById('planning-document-content');
  contentEl.innerHTML = '<div class="text-center py-8 text-spellbook-muted">Loading diff...</div>';

  try {
    // Get worktree path from active planning session (if linked to a worktree)
    const session = sessions.planning[sessions.activePlanningSession];
    const targetPath = session?.worktree?.path || session?.workingDir || '';
    const pathParam = targetPath ? `&path=${encodeURIComponent(targetPath)}` : '';
    const res = await fetch(`${API_BASE}/git/diff/file?file=${encodeURIComponent(filePath)}${pathParam}`);
    const data = await res.json();

    if (!data.diff) {
      contentEl.innerHTML = `
        <div class="mb-4">
          <button onclick="setPlanningDocTab('files')" class="text-sm text-spellbook-accent hover:underline">← Back to files</button>
        </div>
        <div class="text-center py-8 text-spellbook-muted">
          No diff available (file may be new or binary)
        </div>
      `;
      return;
    }

    // Parse and render diff
    contentEl.innerHTML = `
      <div class="mb-4 flex items-center justify-between">
        <button onclick="setPlanningDocTab('files')" class="text-sm text-spellbook-accent hover:underline">← Back to files</button>
        <span class="text-sm font-mono text-spellbook-muted">${escapeHtml(filePath)}</span>
      </div>
      <div class="diff-view bg-spellbook-bg rounded-lg overflow-hidden">
        <pre class="p-4 text-xs font-mono overflow-auto max-h-[60vh]">${renderDiff(data.diff)}</pre>
      </div>
    `;
  } catch (err) {
    console.error('Failed to load file diff:', err);
    contentEl.innerHTML = `
      <div class="mb-4">
        <button onclick="setPlanningDocTab('files')" class="text-sm text-spellbook-accent hover:underline">← Back to files</button>
      </div>
      <div class="text-center py-8 text-red-400">
        Failed to load diff: ${err.message}
      </div>
    `;
  }
}

function renderDiff(diff) {
  const lines = diff.split('\n');
  return lines.map(line => {
    if (line.startsWith('+') && !line.startsWith('+++')) {
      return `<span class="text-green-400">${escapeHtml(line)}</span>`;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      return `<span class="text-red-400">${escapeHtml(line)}</span>`;
    } else if (line.startsWith('@@')) {
      return `<span class="text-blue-400">${escapeHtml(line)}</span>`;
    } else if (line.startsWith('diff ') || line.startsWith('index ')) {
      return `<span class="text-spellbook-muted">${escapeHtml(line)}</span>`;
    }
    return escapeHtml(line);
  }).join('\n');
}

// ==================== TERMINAL INTEGRATION ====================

/**
 * Open or focus terminal tab for current planning session
 * Uses the user's configured terminal (Ghostty/iTerm)
 */
async function openInTerminal() {
  const sessionKey = sessions.activePlanningSession;
  if (!sessionKey) {
    showToast('error', 'No active session');
    return;
  }

  const session = sessions.planning[sessionKey];
  const worktreePath = session?.worktreePath || state.projectPath;

  try {
    const res = await fetch(`${API_BASE}/terminal/open`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionName: sessionKey,
        workingDir: worktreePath,
        command: 'claude --dangerously-skip-permissions',
      }),
    });

    const result = await res.json();

    if (result.success) {
      if (result.focused) {
        showToast('success', `Focused existing terminal: ${sessionKey}`);
      } else {
        showToast('success', `Opened new terminal: ${sessionKey}`);
      }
    } else {
      showToast('error', result.error || 'Failed to open terminal');
    }
  } catch (err) {
    console.error('Failed to open terminal:', err);
    showToast('error', `Failed to open terminal: ${err.message}`);
  }
}

// Backwards compatibility alias
const openInIterm = openInTerminal;

function minimizePlanningView() {
  const sessionKey = sessions.activePlanningSession;

  // Hide planning view but keep session running
  document.getElementById('planning-view').classList.add('hidden');
  stopDocumentRefresh();

  // Update session status and clean up terminal display resources (not the session itself)
  const session = sessions.planning[sessionKey];
  if (session) {
    session.status = 'minimized';
    session.minimizedAt = Date.now();

    // Note: We don't dispose the terminal or close WebSocket here
    // The session stays connected in the background
    // We do clean up resize observers since the container will be hidden
    if (session.resizeObserver) {
      session.resizeObserver.disconnect();
      session.resizeObserver = null;
    }
    if (session.handleWindowResize) {
      window.removeEventListener('resize', session.handleWindowResize);
      session.handleWindowResize = null;
    }
  }

  sessions.activePlanningSession = null;

  // Save session state to localStorage for persistence across page refreshes
  saveSessionsToStorage();

  // Note: Session pills now reflect iTerm sessions, not browser state
  updateActivity(`Session ${sessionKey} minimized`);
}

// Flag to prevent multiple concurrent close attempts
let _closingPlanningView = false;

async function closePlanningView() {
  // Prevent multiple concurrent close attempts
  if (_closingPlanningView) {
    console.log('[Spellbook] closePlanningView already in progress, ignoring');
    return;
  }
  _closingPlanningView = true;

  console.log('[Spellbook] closePlanningView called');
  const sessionKey = sessions.activePlanningSession;

  if (!sessionKey) {
    console.log('[Spellbook] No active session, just hiding view');
    document.getElementById('planning-view').classList.add('hidden');
    _closingPlanningView = false;
    return;
  }

  // Remove from sessions
  delete sessions.planning[sessionKey];
  sessions.activePlanningSession = null;

  // Update session storage
  saveSessionsToStorage();

  // Hide view and stop polling
  document.getElementById('planning-view').classList.add('hidden');
  stopDocumentRefresh();
  stopWorkflowStatePolling();
  clearWorkflowState();

  updateActivity(`Session ${sessionKey} closed`);
  showToast('success', `Session ${sessionKey} closed`);
  console.log('[Spellbook] closePlanningView completed');

  // Reset closing flag
  _closingPlanningView = false;
}

async function resumePlanningSession(sessionKey) {
  const session = sessions.planning[sessionKey];
  if (!session) return;

  // Update session status before opening
  session.status = 'active';

  // Open the view (will show documentation)
  await openPlanningView(session.itemType, session.itemNumber);
}

// ==================== TRIGGER SKILLS ====================

/**
 * Trigger /implement skill - copies command to clipboard and opens iTerm
 * User runs the command in their iTerm session
 */
async function triggerImplementSkill() {
  debugLog('[Spellbook] triggerImplementSkill clicked');

  const sessionKey = sessions.activePlanningSession;
  const session = sessions.planning[sessionKey];

  if (!session) {
    showToast('error', 'No active planning session');
    return;
  }

  const implementCmd = `/implement ${sessionKey}`;

  // Copy command to clipboard
  try {
    await navigator.clipboard.writeText(implementCmd);
    showToast('success', `Copied to clipboard: ${implementCmd}`);
  } catch (err) {
    console.error('Failed to copy:', err);
  }

  // Open iTerm to the session
  await openInIterm();

  updateActivity(`Ready to implement ${sessionKey} - command copied to clipboard`);
}

// Legacy finalize planning - kept for backwards compatibility
// Store plan content globally to avoid escaping issues in template literals
let pendingPlanContent = null;

async function finalizePlanning() {
  // Redirect to the new implementation trigger
  triggerImplementSkill();
}

function showFinalizePlanModal(planData) {
  debugLog('[Spellbook] Showing finalize modal');

  // Remove any existing modal
  const existing = document.getElementById('finalize-plan-modal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'finalize-plan-modal';
  modal.className = 'fixed inset-0 bg-black/80 flex items-center justify-center z-[60]';

  // Build modal HTML without embedding the content in attributes
  modal.innerHTML = `
    <div class="bg-spellbook-card border border-spellbook-border rounded-lg w-3/4 max-w-4xl h-3/4 flex flex-col">
      <div class="p-4 border-b border-spellbook-border flex justify-between items-center">
        <div>
          <h3 class="font-semibold">Finalize Plan for ${sessions.activePlanningSession}</h3>
          <p class="text-xs text-spellbook-muted mt-1">From: ${planData.filename} (${new Date(planData.modifiedAt).toLocaleString()})</p>
        </div>
        <div class="flex gap-2">
          <button onclick="cancelFinalizePlan()" class="px-4 py-2 border border-spellbook-border rounded hover:bg-spellbook-card">
            Cancel
          </button>
          <button onclick="confirmFinalizePlan()" class="px-4 py-2 bg-spellbook-accent text-black rounded hover:bg-spellbook-accent/80">
            Save Plan & Update Status
          </button>
        </div>
      </div>
      <div id="finalize-plan-preview" class="flex-1 overflow-auto p-4">
        <div class="prose prose-invert max-w-none">Loading...</div>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  // Render markdown content after modal is in DOM
  const previewEl = document.getElementById('finalize-plan-preview');
  previewEl.innerHTML = `<div class="prose prose-invert max-w-none">${marked.parse(planData.content)}</div>`;
}

function cancelFinalizePlan() {
  const modal = document.getElementById('finalize-plan-modal');
  if (modal) modal.remove();
}

async function confirmFinalizePlan() {
  debugLog('[Spellbook] confirmFinalizePlan clicked');

  const session = sessions.planning[sessions.activePlanningSession];
  if (!session) return;

  // Use the globally stored content
  const content = pendingPlanContent;
  if (!content) {
    alert('No plan content to save');
    return;
  }

  try {
    // Save the plan to our storage
    await savePlanFile(session.itemType, session.itemNumber, content);
    session.planContent = content;
    session.planExists = true;

    // Update item status to "planning" (spec_ready)
    await updateItemStatus(session.itemType, session.itemNumber, 'spec_ready');

    cancelFinalizePlan();
    setPlanningDocTab('plan');
    updatePlanIndicator(true);

    // Refresh kanban to show updated status
    await fetchData();
    renderKanban();

    updateActivity(`Plan saved for ${sessions.activePlanningSession}`);

  } catch (err) {
    console.error('Failed to save plan:', err);
    alert('Failed to save plan: ' + err.message);
  }
}

async function startImplementation() {
  const session = sessions.planning[sessions.activePlanningSession];
  if (!session) {
    alert('No active planning session');
    return;
  }

  // Check if plan exists
  if (!session.planExists && !session.planContent) {
    const proceed = confirm('No plan has been saved yet. Do you want to start implementation anyway?');
    if (!proceed) return;
  }

  try {
    // Update item status to "in_progress" via API
    await updateItemStatus(session.itemType, session.itemNumber, 'in_progress');

    // Build the reference (e.g., "improvement-32", "bug-44")
    const ref = `${session.itemType}-${session.itemNumber}`;

    // Send /implement skill invocation to Claude terminal
    // This triggers the full skill workflow with changelog updates
    if (session.ws?.readyState === WebSocket.OPEN) {
      sendTerminalCommand(session.ws, `/implement ${ref}`);
    }

    // Refresh kanban to show updated status
    await fetchData();
    renderKanban();

    // Hide the manual implement fallback button since we triggered it
    document.getElementById('manual-implement-btn')?.classList.add('hidden');

    updateActivity(`Invoked /implement ${ref}`);

  } catch (err) {
    console.error('Failed to start implementation:', err);
    alert('Failed to start implementation: ' + err.message);
  }
}

// Update workflow buttons based on item status
// The flow is now automatic - Claude auto-runs /implement after plan approval
// These buttons are for later workflow stages or manual fallback
function updateActionButton(itemStatus) {
  // Hide all workflow buttons first
  ['create-pr-btn', 'code-rabbit-btn', 'finalize-item-btn', 'manual-implement-btn'].forEach(id => {
    document.getElementById(id)?.classList.add('hidden');
  });

  switch (itemStatus) {
    case 'active':
    case 'planning':
    case 'not_started':
      // Planning phase - show subtle fallback button in case Claude doesn't auto-implement
      // This will be shown after a delay if needed
      document.getElementById('manual-implement-btn')?.classList.remove('hidden');
      updateWorkflowProgress('plan');
      break;

    case 'in_progress':
      // Implementation in progress - no buttons needed, Claude is working
      // Later: could show Commit & Push button when implementation is done
      updateWorkflowProgress('impl');
      break;

    case 'resolved':
    case 'completed':
    case 'complete':
      // Item is done
      updateWorkflowProgress('review');
      break;

    default:
      // Fallback - show manual implement button
      document.getElementById('manual-implement-btn')?.classList.remove('hidden');
      updateWorkflowProgress('plan');
  }
}

// Start commit workflow (for items already in progress)
async function startCommitWorkflow() {
  const session = sessions.planning[sessions.activePlanningSession];
  if (!session) {
    alert('No active planning session');
    return;
  }

  try {
    const ref = `${session.itemType}-${session.itemNumber}`;

    // Send /commit-and-push skill to Claude terminal
    if (session.ws?.readyState === WebSocket.OPEN) {
      sendTerminalCommand(session.ws, '/commit-and-push');
    }

    updateActivity(`Started commit workflow for ${ref}`);

    // Update workflow progress
    updateWorkflowProgress('commit');

    // After commit, show PR button
    setTimeout(() => {
      showWorkflowButton('create-pr-btn');
    }, 1000);

  } catch (err) {
    console.error('Failed to start commit workflow:', err);
    alert('Failed to start commit workflow: ' + err.message);
  }
}

// Update workflow progress indicator
function updateWorkflowProgress(currentStep) {
  const steps = ['plan', 'impl', 'commit', 'pr', 'review'];
  const stepIndex = steps.indexOf(currentStep);

  steps.forEach((step, idx) => {
    const el = document.getElementById(`wf-step-${step}`);
    if (!el) return;

    el.classList.remove('active', 'completed', 'pending');

    if (idx < stepIndex) {
      el.classList.add('completed');
    } else if (idx === stepIndex) {
      el.classList.add('active');
    } else {
      el.classList.add('pending');
    }
  });
}

// ==================== WORKFLOW STATE MANAGEMENT ====================
// Tracks planning → implementing flow via external state file
// This enables auto-triggering /implement after plan approval (even with context clear)

let workflowStateInterval = null;
let lastWorkflowStatus = null;

async function fetchWorkflowState() {
  try {
    const res = await fetch(`${API_BASE}/workflow-state`);
    return await res.json();
  } catch (err) {
    console.error('Failed to fetch workflow state:', err);
    return { ref: null, status: null };
  }
}

function updateWorkflowPhaseBadge(status) {
  const badge = document.getElementById('workflow-phase-badge');
  if (!badge) return;

  // Update badge based on status
  const statusConfig = {
    planning: { text: 'planning', class: 'bg-blue-500/20 text-blue-400' },
    implementing: { text: 'implementing', class: 'bg-yellow-500/20 text-yellow-400' },
    committing: { text: 'committing', class: 'bg-purple-500/20 text-purple-400' },
    reviewing: { text: 'reviewing', class: 'bg-orange-500/20 text-orange-400' },
    complete: { text: 'complete', class: 'bg-green-500/20 text-green-400' },
  };

  const config = statusConfig[status] || statusConfig.planning;
  badge.textContent = config.text;
  badge.className = `px-2 py-0.5 text-xs rounded ${config.class}`;
}

function startWorkflowStatePolling() {
  // Clear any existing interval
  if (workflowStateInterval) {
    clearInterval(workflowStateInterval);
  }

  // Poll every 2 seconds
  workflowStateInterval = setInterval(async () => {
    const state = await fetchWorkflowState();

    // Detect status change
    if (state.status && state.status !== lastWorkflowStatus) {
      console.log(`[Spellbook] Workflow status changed: ${lastWorkflowStatus} → ${state.status}`);
      lastWorkflowStatus = state.status;
      updateWorkflowPhaseBadge(state.status);

      // If status changed to "implementing", update the workflow progress
      if (state.status === 'implementing') {
        updateWorkflowProgress('impl');
        showToast('info', 'Implementation started - Claude is now implementing the plan');
      }
    }
  }, 2000);
}

function stopWorkflowStatePolling() {
  if (workflowStateInterval) {
    clearInterval(workflowStateInterval);
    workflowStateInterval = null;
  }
}

async function clearWorkflowState() {
  try {
    await fetch(`${API_BASE}/workflow-state`, { method: 'DELETE' });
    lastWorkflowStatus = null;
    console.log('[Spellbook] Workflow state cleared');
  } catch (err) {
    console.error('Failed to clear workflow state:', err);
  }
}

// Show/hide workflow buttons
function showWorkflowButton(buttonId) {
  // Hide all workflow buttons first
  ['create-pr-btn', 'code-rabbit-btn', 'finalize-item-btn', 'manual-implement-btn'].forEach(id => {
    document.getElementById(id)?.classList.add('hidden');
  });

  // Show requested button
  document.getElementById(buttonId)?.classList.remove('hidden');
}

// Create Pull Request
async function createPullRequest() {
  const session = sessions.planning[sessions.activePlanningSession];
  if (!session) {
    alert('No active planning session');
    return;
  }

  try {
    const ref = `${session.itemType}-${session.itemNumber}`;

    // Send PR creation command to Claude terminal
    if (session.ws?.readyState === WebSocket.OPEN) {
      sendTerminalCommand(session.ws, 'gh pr create --fill');
    }

    // Update button
    const btn = document.getElementById('create-pr-btn');
    btn.className = 'px-4 py-2 bg-purple-500/20 text-purple-400 rounded font-semibold';
    btn.innerHTML = '● Creating PR...';
    btn.disabled = true;

    updateWorkflowProgress('pr');
    updateActivity(`Creating PR for ${ref}`);

    // After PR, show CodeRabbit button
    setTimeout(() => {
      showWorkflowButton('code-rabbit-btn');
    }, 2000);

  } catch (err) {
    console.error('Failed to create PR:', err);
    alert('Failed to create PR: ' + err.message);
  }
}

// Start CodeRabbit review
async function startCodeRabbitReview() {
  const session = sessions.planning[sessions.activePlanningSession];
  if (!session) {
    alert('No active planning session');
    return;
  }

  try {
    const ref = `${session.itemType}-${session.itemNumber}`;

    // Send /code-rabbit skill to Claude terminal
    if (session.ws?.readyState === WebSocket.OPEN) {
      sendTerminalCommand(session.ws, '/code-rabbit');
    }

    // Update button
    const btn = document.getElementById('code-rabbit-btn');
    btn.className = 'px-4 py-2 bg-orange-500/20 text-orange-400 rounded font-semibold';
    btn.innerHTML = '● Reviewing...';
    btn.disabled = true;

    updateWorkflowProgress('review');
    updateActivity(`Started CodeRabbit review for ${ref}`);

    // After review, show finalize button
    setTimeout(() => {
      showWorkflowButton('finalize-item-btn');
    }, 3000);

  } catch (err) {
    console.error('Failed to start CodeRabbit review:', err);
    alert('Failed to start CodeRabbit review: ' + err.message);
  }
}

// Finalize and mark item complete
async function finalizeItem() {
  const session = sessions.planning[sessions.activePlanningSession];
  if (!session) {
    alert('No active planning session');
    return;
  }

  try {
    const ref = `${session.itemType}-${session.itemNumber}`;
    const finalStatus = session.itemType === 'bug' ? 'resolved' : 'completed';

    // Update item status
    await updateItemStatus(session.itemType, session.itemNumber, finalStatus);

    // Update session's item status
    session.itemStatus = finalStatus;

    // Update button
    const btn = document.getElementById('finalize-item-btn');
    btn.className = 'px-4 py-2 bg-green-500/20 text-green-400 rounded font-semibold';
    btn.innerHTML = '✓ Completed!';
    btn.disabled = true;

    // Refresh kanban
    await fetchData();
    renderKanban();

    updateActivity(`Finalized ${ref} as ${finalStatus}`);

    // Close planning view after a moment
    setTimeout(() => {
      closePlanningView();
    }, 2000);

  } catch (err) {
    console.error('Failed to finalize item:', err);
    alert('Failed to finalize item: ' + err.message);
  }
}

async function updateItemStatus(type, number, status) {
  const res = await fetch(`${API_BASE}/item/${type}/${number}/status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  });

  if (!res.ok) {
    throw new Error('Failed to update status');
  }

  return await res.json();
}

// Exit Claude terminal (sends /exit command)
function exitClaudeTerminal() {
  const session = sessions.planning[sessions.activePlanningSession];
  if (!session?.ws || session.ws.readyState !== WebSocket.OPEN) {
    alert('Terminal not connected');
    return;
  }

  // Send /exit command to exit Claude and return to bash
  sendTerminalCommand(session.ws, '/exit');
  updateActivity('Exited Claude - terminal now in bash mode');
}

// ==================== SESSION PILLS (Status Bar) ====================

// Interval reference for periodic iTerm session refresh
let itermSessionsRefreshInterval = null;
const ITERM_SESSIONS_REFRESH_MS = 5000; // Refresh every 5 seconds

function renderSessionPills() {
  const container = document.getElementById('session-pills');

  // Filter to only show sessions with Claude running
  const claudeSessions = itermSessions.filter(s => s.hasClaude !== false);

  if (claudeSessions.length === 0) {
    container.innerHTML = '<span class="text-xs text-spellbook-muted">No active Claude sessions</span>';
    return;
  }

  container.innerHTML = claudeSessions.map(session => {
    const sessionName = session.name || session;
    const tty = session.tty || '';
    const matchedItem = session.matchedItem;
    const displayName = matchedItem || sessionName;
    const statusColor = session.hasClaude ? 'text-green-400' : 'text-gray-400';
    const isFocused = session.isFocused === true;
    const focusedClasses = isFocused ? 'ring-1 ring-yellow-400 bg-yellow-400/10' : 'bg-spellbook-card';

    return `
      <button onclick="handleSessionPillClick('${escapeHtml(sessionName)}', '${escapeHtml(tty)}', '${escapeHtml(matchedItem || '')}')"
              class="px-2 py-0.5 text-xs rounded flex items-center gap-1 ${focusedClasses} hover:bg-spellbook-border group"
              title="${isFocused ? '⚡ Currently focused - ' : ''}Click to focus iTerm, Shift+Click for docs">
        <span class="${statusColor}">●</span>
        ${escapeHtml(displayName)}
        ${isFocused ? '<span class="text-yellow-400 text-[10px]">⚡</span>' : ''}
      </button>
    `;
  }).join('');
}

/**
 * Handle click on session pill - focus iTerm or open docs
 */
function handleSessionPillClick(sessionName, tty, matchedItem) {
  if (event.shiftKey && matchedItem) {
    viewSessionDocs(matchedItem);
  } else {
    focusItermSession(sessionName, tty);
  }
}

/**
 * Start periodic refresh of iTerm sessions for pills
 */
function startItermSessionsRefresh() {
  if (itermSessionsRefreshInterval) return; // Already running

  // Initial fetch
  refreshItermSessionsForPills();

  // Set up periodic refresh
  itermSessionsRefreshInterval = setInterval(() => {
    if (isPageVisible) {
      refreshItermSessionsForPills();
    }
  }, ITERM_SESSIONS_REFRESH_MS);
}

/**
 * Refresh iTerm sessions and update pills
 */
async function refreshItermSessionsForPills() {
  try {
    const res = await fetch(`${API_BASE}/terminal/sessions`);
    const data = await res.json();
    itermSessions = data.sessions || [];
  } catch (err) {
    console.warn('[Spellbook] Failed to fetch iTerm sessions for pills:', err);
  }
  renderSessionPills();
}

// ==================== TERMINAL MANAGER VIEW ====================

// Preview refresh interval reference
let previewRefreshInterval = null;
const PREVIEW_REFRESH_MS = 2500; // Refresh previews every 2.5 seconds
const PREVIEW_MAX_LINES = 10; // Show last 10 lines in preview

/**
 * Fetch terminal preview for a session
 */
async function fetchTerminalPreview(terminalId) {
  if (!terminalId) return null;

  try {
    const res = await fetch(`${API_BASE}/terminals/${terminalId}/preview?lines=${PREVIEW_MAX_LINES}`);
    if (!res.ok) return null;

    const data = await res.json();
    return data.lines || [];
  } catch (err) {
    console.warn(`[Spellbook] Failed to fetch preview for terminal ${terminalId}:`, err);
    return null;
  }
}

/**
 * Escape HTML to prevent XSS in preview content
 */
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Strip ANSI escape codes from text
 */
function stripAnsi(text) {
  // Remove all ANSI escape sequences
  // This regex matches: ESC[ followed by parameters and a final byte
  // Also matches OSC sequences (ESC]) and other escape sequences
  return text
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')  // CSI sequences like [?25h, [0m, [32m
    .replace(/\x1b\][^\x07]*\x07/g, '')      // OSC sequences (title changes)
    .replace(/\x1b[PX^_][^\x1b]*\x1b\\/g, '') // DCS, SOS, PM, APC sequences
    .replace(/\x1b[\x40-\x5f]/g, '')          // Fe sequences
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, ''); // Other control chars
}

/**
 * Truncate long lines for preview display
 */
function truncateLine(line, maxLength = 100) {
  // Strip ANSI codes first
  const clean = stripAnsi(line);
  if (clean.length <= maxLength) return clean;
  return clean.substring(0, maxLength - 3) + '...';
}

/**
 * Update preview content for a single session card
 */
async function updateSessionPreview(sessionKey) {
  const session = sessions.planning[sessionKey];
  if (!session?.terminalId) return;

  const previewEl = document.getElementById(`preview-${sessionKey}`);
  if (!previewEl) return;

  const lines = await fetchTerminalPreview(session.terminalId);

  if (lines && lines.length > 0) {
    // Don't use escapeHtml since .textContent already handles escaping
    const formattedLines = lines
      .map(line => truncateLine(line, 80))
      .join('\n');
    previewEl.textContent = formattedLines;
    previewEl.classList.remove('text-spellbook-muted');
    previewEl.classList.add('text-spellbook-text');
  } else {
    previewEl.textContent = 'No output yet...';
    previewEl.classList.add('text-spellbook-muted');
    previewEl.classList.remove('text-spellbook-text');
  }
}

/**
 * Update all session previews
 */
async function updateAllSessionPreviews() {
  const sessionKeys = Object.keys(sessions.planning);
  if (sessionKeys.length === 0) return;

  // Update previews in parallel
  await Promise.all(sessionKeys.map(key => updateSessionPreview(key)));
}

/**
 * Start periodic preview refresh
 */
function startPreviewRefresh() {
  if (previewRefreshInterval) return; // Already running

  // Initial fetch
  updateAllSessionPreviews();

  // Set up periodic refresh
  previewRefreshInterval = setInterval(() => {
    // Only refresh if terminal manager view is visible
    const terminalView = document.getElementById('terminal-manager-view');
    if (terminalView && !terminalView.classList.contains('hidden')) {
      updateAllSessionPreviews();
    }
  }, PREVIEW_REFRESH_MS);
}

/**
 * Stop periodic preview refresh
 */
function stopPreviewRefresh() {
  if (previewRefreshInterval) {
    clearInterval(previewRefreshInterval);
    previewRefreshInterval = null;
  }
}

// Store detected iTerm sessions
let itermSessions = [];

/**
 * Fetch and render terminal sessions (works with Ghostty and iTerm)
 */
async function refreshItermSessions() {
  const container = document.getElementById('sessions-grid');

  try {
    const res = await fetch(`${API_BASE}/terminal/sessions`);
    const data = await res.json();
    itermSessions = data.sessions || [];
  } catch (err) {
    console.error('Failed to fetch terminal sessions:', err);
    itermSessions = [];
  }

  renderItermSessionsGrid();
  renderSessionPills();
}

function renderItermSessionsGrid() {
  const container = document.getElementById('sessions-grid');

  if (itermSessions.length === 0) {
    container.innerHTML = `
      <div class="text-center text-spellbook-muted py-8 col-span-4">
        No active terminal sessions detected. Click "Work on this" on an item to start.
      </div>
    `;
    return;
  }

  container.innerHTML = itermSessions.map(session => {
    // Session is now an object: { name, tty, hasClaude, matchedItem, isFocused }
    const sessionName = session.name || session; // Handle both old string format and new object format
    const tty = session.tty || '';
    const hasClaude = session.hasClaude !== false;
    const matchedItem = session.matchedItem;
    const isFocused = session.isFocused === true;

    // Try to find the item in state
    let item = null;
    if (matchedItem) {
      const match = matchedItem.match(/(bug|improvement|feature)-(\d+)/i);
      if (match) {
        const type = match[1].toLowerCase();
        const number = parseInt(match[2]);
        if (type === 'bug') item = state.bugs?.find(b => b.number === number);
        else if (type === 'improvement') item = state.improvements?.find(i => i.number === number);
        else if (type === 'feature') item = state.features?.find(f => f.number === number);
      }
    }

    const title = item?.title || item?.name || sessionName;
    const priority = item?.priority || 'medium';
    const statusIndicator = hasClaude ? '● Claude running' : '○ No Claude';
    const statusColor = hasClaude ? 'text-green-400' : 'text-gray-400';
    const itemRef = matchedItem || 'unlinked';
    const focusedBorder = isFocused ? 'border-yellow-400 ring-2 ring-yellow-400/30' : 'border-spellbook-border';
    const focusedBadge = isFocused ? '<span class="px-1.5 py-0.5 text-[10px] bg-yellow-400/20 text-yellow-400 rounded font-medium">ACTIVE</span>' : '';

    return `
      <div class="bg-spellbook-card border ${focusedBorder} rounded-lg p-3 hover:border-spellbook-accent transition-colors">
        <div class="flex items-center justify-between mb-2">
          <div class="flex items-center gap-2">
            <span class="font-semibold text-spellbook-accent">${escapeHtml(sessionName)}</span>
            ${focusedBadge}
          </div>
          <span class="text-xs ${statusColor}">${statusIndicator}</span>
        </div>
        <div class="text-xs text-spellbook-muted mb-1">
          ${matchedItem ? `<span class="text-spellbook-accent">${escapeHtml(matchedItem)}</span>` : '<span class="text-gray-500">No linked item</span>'}
        </div>
        <div class="text-xs text-spellbook-muted mb-3 truncate" title="${escapeHtml(title)}">
          ${escapeHtml(title.substring(0, 50))}${title.length > 50 ? '...' : ''}
        </div>
        <div class="flex gap-2">
          <button onclick="focusItermSession('${escapeHtml(sessionName)}', '${escapeHtml(tty)}')"
                  class="flex-1 px-2 py-1 text-xs bg-spellbook-accent/20 text-spellbook-accent rounded hover:bg-spellbook-accent/30">
            Focus
          </button>
          ${matchedItem ? `
          <button onclick="viewSessionDocs('${escapeHtml(matchedItem)}')"
                  class="px-2 py-1 text-xs bg-blue-500/20 text-blue-400 rounded hover:bg-blue-500/30">
            Docs
          </button>
          ` : ''}
        </div>
      </div>
    `;
  }).join('');
}

/**
 * Focus a terminal session by name or TTY
 * Uses the user's configured terminal (Ghostty/iTerm)
 */
async function focusTerminalSession(sessionName, tty = '') {
  try {
    // Use focus endpoint which brings terminal to front without opening new window
    const res = await fetch(`${API_BASE}/terminal/focus`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionName, tty }),
    });
    const result = await res.json();
    if (result.success) {
      showToast('success', `Focused terminal: ${sessionName}`);
    } else {
      showToast('error', result.error || 'Failed to focus terminal');
    }
  } catch (err) {
    showToast('error', `Error: ${err.message}`);
  }
}

// Backwards compatibility alias
const focusItermSession = focusTerminalSession;

/**
 * View documentation for a session (accepts matched item reference like "bug-79")
 */
function viewSessionDocs(itemRef) {
  const match = itemRef.match(/(bug|improvement|feature)-(\d+)/i);
  if (match) {
    const type = match[1].toLowerCase();
    const number = parseInt(match[2]);
    openPlanningView(type, number);
  } else {
    showToast('error', 'Could not determine item from reference: ' + itemRef);
  }
}

// Keep old function for backwards compatibility but make it call the new one
function renderSessionsGrid() {
  refreshItermSessions();
}

async function closeSessionFromGrid(sessionKey) {
  if (!confirm(`Close session ${sessionKey}?`)) return;

  debugLog(`[Spellbook] closeSessionFromGrid called for ${sessionKey}`);

  const session = sessions.planning[sessionKey];
  if (session?.terminalId) {
    try {
      debugLog(`[Spellbook] Sending DELETE request for terminal ${session.terminalId}`);
      const res = await fetch(`${API_BASE}/terminals/${session.terminalId}`, { method: 'DELETE' });
      const result = await res.json();
      debugLog('[Spellbook] Terminal close result:', result);
    } catch (err) {
      console.error('Failed to close terminal:', err);
    }
  } else {
    debugLog('[Spellbook] No terminal ID to close');
  }

  // Clean up resources properly
  cleanupSession(session);

  delete sessions.planning[sessionKey];

  // Update session storage
  saveSessionsToStorage();

  if (sessions.activePlanningSession === sessionKey) {
    sessions.activePlanningSession = null;
    document.getElementById('planning-view').classList.add('hidden');
  }

  renderSessionsGrid();
  debugLog(`[Spellbook] Session ${sessionKey} closed`);
  // Note: Session pills will be refreshed by the periodic iTerm session poll
}

function closeAllIdleSessions() {
  const idleSessions = Object.keys(sessions.planning).filter(key => {
    const session = sessions.planning[key];
    return session.status === 'minimized' || key !== sessions.activePlanningSession;
  });

  if (idleSessions.length === 0) {
    alert('No idle sessions to close');
    return;
  }

  if (!confirm(`Close ${idleSessions.length} idle session(s)?`)) return;

  idleSessions.forEach(key => closeSessionFromGrid(key));
}

// ==================== QUICK LOG ====================

let quickLogType = null;

function quickLog(type) {
  quickLogType = type;
  document.getElementById('quick-log-title').textContent = `Log ${type.charAt(0).toUpperCase() + type.slice(1)}`;
  document.getElementById('quick-log-input').value = '';
  document.getElementById('quick-log-priority').value = 'medium';
  document.getElementById('quick-log-description').value = '';
  document.getElementById('quick-log-modal').classList.remove('hidden');
  document.getElementById('quick-log-input').focus();
}

function hideQuickLogModal() {
  document.getElementById('quick-log-modal').classList.add('hidden');
  quickLogType = null;
}

async function submitQuickLog() {
  const title = document.getElementById('quick-log-input').value.trim();
  const priority = document.getElementById('quick-log-priority').value;
  const description = document.getElementById('quick-log-description').value.trim();

  // Handle 'idea' type from quickAddIdea()
  const logType = window.currentQuickLogType || quickLogType;
  window.currentQuickLogType = null;

  if (!title) {
    alert('Title is required');
    return;
  }

  try {
    let endpoint, body;

    if (logType === 'idea') {
      endpoint = 'inbox';
      body = { description: title + (description ? '\n\n' + description : ''), type: 'feature', priority };
    } else if (logType === 'feature') {
      endpoint = 'inbox';
      body = { description: title, type: 'feature', priority };
    } else if (logType === 'bug') {
      endpoint = 'bugs';
      body = { title, priority, description };
    } else if (logType === 'improvement') {
      endpoint = 'improvements';
      body = { title, priority, description };
    } else {
      endpoint = 'inbox';
      body = { description: title, type: 'feature', priority };
    }

    const res = await fetch(`${API_BASE}/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) throw new Error('Failed to create item');

    const data = await res.json();
    updateActivity(`Created ${logType} #${data.number || data.id}`);
    hideQuickLogModal();
    await fetchData();
    renderKanban();

    // If we added an idea, show the inbox
    if (logType === 'idea') {
      switchMainView('inbox');
    }
  } catch (err) {
    console.error('Failed to create item:', err);
    alert('Failed to create item: ' + err.message);
  }
}

// ==================== KANBAN BOARD ====================

function setKanbanFilter(filter) {
  state.kanbanFilter = filter;
  document.querySelectorAll('.kanban-filter').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.filter === filter);
  });
  renderKanban();
}

function setKanbanPriorityFilter(priority) {
  state.kanbanPriorityFilter = priority;
  renderKanban();
}

function setKanbanSort(sortBy) {
  state.kanbanSort = sortBy;
  renderKanban();
}

function handleKanbanSearch(query) {
  state.kanbanSearch = query.toLowerCase().trim();
  renderKanban();
}

function clearKanbanSearch() {
  state.kanbanSearch = '';
  document.getElementById('kanban-search').value = '';
  renderKanban();
}

function sortKanbanItems(items) {
  const priorityOrder = { high: 0, critical: 0, medium: 1, low: 2 };

  return [...items].sort((a, b) => {
    switch (state.kanbanSort) {
      case 'priority':
        const aPriority = priorityOrder[a.priority] ?? 1;
        const bPriority = priorityOrder[b.priority] ?? 1;
        if (aPriority !== bPriority) return aPriority - bPriority;
        return b.number - a.number; // Secondary sort by number (newest first)

      case 'newest':
        // Sort by created_at if available, otherwise by number descending
        if (a.created_at && b.created_at) {
          return new Date(b.created_at) - new Date(a.created_at);
        }
        return b.number - a.number;

      case 'oldest':
        if (a.created_at && b.created_at) {
          return new Date(a.created_at) - new Date(b.created_at);
        }
        return a.number - b.number;

      case 'number':
        return a.number - b.number;

      default:
        return 0;
    }
  });
}

function renderKanban() {
  const filter = state.kanbanFilter;
  const priorityFilter = state.kanbanPriorityFilter;

  let items = [];

  if (filter === 'all' || filter === 'bug') {
    items = items.concat(state.bugs.map(b => ({ ...b, type: 'bug', ref: `bug-${b.number}` })));
  }
  if (filter === 'all' || filter === 'improvement') {
    items = items.concat(state.improvements.map(i => ({ ...i, type: 'improvement', ref: `imp-${i.number}` })));
  }
  if (filter === 'all' || filter === 'feature') {
    items = items.concat(state.features.map(f => ({
      ...f,
      type: 'feature',
      ref: `feature-${f.number}`,
      title: f.name,
    })));
  }

  // Apply priority filter
  if (priorityFilter !== 'all') {
    items = items.filter(i => {
      // Features don't have priority, show them when filtering
      if (i.type === 'feature') return true;
      return i.priority === priorityFilter;
    });
  }

  // Apply search filter
  if (state.kanbanSearch) {
    items = items.filter(i => {
      const title = (i.title || i.name || '').toLowerCase();
      const ref = i.ref?.toLowerCase() || '';
      const slug = i.slug?.toLowerCase() || '';
      return title.includes(state.kanbanSearch) ||
             ref.includes(state.kanbanSearch) ||
             slug.includes(state.kanbanSearch);
    });
  }

  // Categorize by status
  let backlog = items.filter(i =>
    ['active', 'backlog', 'logged', 'not_started'].includes(i.status)
  );
  let planning = items.filter(i =>
    ['planning', 'planned', 'spec_draft', 'spec_ready'].includes(i.status)
  );
  let inProgress = items.filter(i =>
    ['in_progress', 'in-progress', 'implementing', 'pr_open', 'review'].includes(i.status)
  );
  let done = items.filter(i =>
    ['resolved', 'completed', 'done', 'complete', 'merged'].includes(i.status)
  );

  // Sort each column
  backlog = sortKanbanItems(backlog);
  planning = sortKanbanItems(planning);
  inProgress = sortKanbanItems(inProgress);
  done = sortKanbanItems(done);

  // Render columns
  document.getElementById('backlog-items').innerHTML = backlog.map(i => renderKanbanCard(i, 'backlog')).join('') || emptyColumn();
  document.getElementById('planning-items').innerHTML = planning.map(i => renderKanbanCard(i, 'planning')).join('') || emptyColumn();
  document.getElementById('progress-items').innerHTML = inProgress.map(i => renderKanbanCard(i, 'progress')).join('') || emptyColumn();
  document.getElementById('done-items').innerHTML = done.slice(0, 20).map(i => renderKanbanCard(i, 'done')).join('') || emptyColumn();

  // Update counts
  document.getElementById('backlog-count').textContent = backlog.length;
  document.getElementById('planning-count').textContent = planning.length;
  document.getElementById('progress-count').textContent = inProgress.length;
  document.getElementById('done-count').textContent = done.length;
  document.getElementById('kanban-count').textContent = `${items.length} items`;
}

function emptyColumn() {
  const message = state.kanbanSearch ? 'No matching items' : 'No items';
  return `<div class="text-spellbook-muted text-xs text-center py-4">${message}</div>`;
}

function renderKanbanCard(item, column) {
  const typeClass = item.type;
  const priorityClass = item.priority || 'medium';
  const sessionKey = `${item.type}-${item.number}`;
  const hasSession = !!sessions.planning[sessionKey];

  // Format date
  let dateStr = '';
  if (item.created_at) {
    const date = new Date(item.created_at);
    const now = new Date();
    const diffDays = Math.floor((now - date) / (1000 * 60 * 60 * 24));

    if (diffDays === 0) {
      dateStr = 'Today';
    } else if (diffDays === 1) {
      dateStr = 'Yesterday';
    } else if (diffDays < 7) {
      dateStr = `${diffDays}d ago`;
    } else if (diffDays < 30) {
      dateStr = `${Math.floor(diffDays / 7)}w ago`;
    } else {
      dateStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    }
  }

  return `
    <div class="kanban-card ${hasSession ? 'has-session' : ''}"
         draggable="true"
         data-type="${item.type}"
         data-number="${item.number}"
         ondragstart="handleDragStart(event)"
         ondragend="handleDragEnd(event)"
         onclick="openItemDetail('${item.type}', ${item.number})">
      <div class="flex items-center gap-2 mb-1">
        <span class="card-ref ${typeClass}">${item.ref}</span>
        ${hasSession ? '<span class="text-xs text-green-400">●</span>' : ''}
        ${item.type !== 'feature' ? `<span class="card-priority ${priorityClass}">${item.priority || 'medium'}</span>` : ''}
      </div>
      <div class="text-sm line-clamp-2">${escapeHtml(item.title || item.name || 'Untitled')}</div>
      ${dateStr ? `<div class="text-xs text-spellbook-muted mt-2">${dateStr}</div>` : ''}
    </div>
  `;
}

// ==================== DRAG AND DROP ====================

let draggedItem = null;

function handleDragStart(event) {
  draggedItem = {
    type: event.target.dataset.type,
    number: parseInt(event.target.dataset.number),
  };
  event.target.classList.add('dragging');
  event.dataTransfer.effectAllowed = 'move';
}

function handleDragEnd(event) {
  event.target.classList.remove('dragging');
  draggedItem = null;
  document.querySelectorAll('.kanban-items').forEach(col => col.classList.remove('drag-over'));
}

function handleDragOver(event) {
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  event.currentTarget.classList.add('drag-over');
}

function handleDragLeave(event) {
  event.currentTarget.classList.remove('drag-over');
}

async function handleDrop(event, targetColumn) {
  event.preventDefault();
  event.currentTarget.classList.remove('drag-over');

  if (!draggedItem) return;

  const { type, number } = draggedItem;

  const statusMap = {
    backlog: 'active',
    planning: 'planning',
    progress: 'in_progress',
    done: TYPE_TO_DONE_STATUS[type] || 'complete',
  };

  const newStatus = statusMap[targetColumn];
  if (!newStatus) return;

  try {
    const endpoint = TYPE_TO_ENDPOINT[type] || 'features';
    await fetch(`${API_BASE}/${endpoint}/${number}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: newStatus }),
    });

    // Auto-sync roadmap when status changes
    await fetch(`${API_BASE}/roadmap`, { method: 'POST' });

    updateActivity(`Moved ${type}-${number} to ${targetColumn} (roadmap synced)`);
    await fetchData();
    renderKanban();
  } catch (err) {
    console.error('Failed to update status:', err);
  }
}

function initDragAndDrop() {
  const columns = {
    'backlog-items': 'backlog',
    'planning-items': 'planning',
    'progress-items': 'progress',
    'done-items': 'done',
  };

  Object.entries(columns).forEach(([id, status]) => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('dragover', handleDragOver);
      el.addEventListener('dragleave', handleDragLeave);
      el.addEventListener('drop', (e) => handleDrop(e, status));
    }
  });
}

// ==================== WORKTREES ====================

function renderWorktrees() {
  const container = document.getElementById('worktree-list');

  if (state.worktrees.length === 0) {
    container.innerHTML = '<div class="text-xs text-spellbook-muted">No worktrees</div>';
    return;
  }

  container.innerHTML = state.worktrees.map(w => {
    const isMain = w.path === state.project?.path;
    const shortPath = w.path.split('/').slice(-2).join('/');

    return `
      <div class="flex items-center justify-between py-1 text-xs">
        <div class="flex items-center gap-2">
          ${isMain ? '<span class="text-spellbook-accent">●</span>' : '<span class="text-spellbook-muted">○</span>'}
          <span class="text-spellbook-accent">${w.branch}</span>
        </div>
        <span class="text-spellbook-muted truncate ml-2">${shortPath}</span>
      </div>
    `;
  }).join('');
}

function toggleWorktrees() {
  const dropdown = document.getElementById('worktree-dropdown');
  const toggle = document.getElementById('worktree-toggle');

  dropdown.classList.toggle('hidden');
  toggle.textContent = dropdown.classList.contains('hidden') ? '▼' : '▲';
}

// ==================== WORKTREES VIEW AUTO-REFRESH ====================

let worktreesRefreshInterval = null;
const WORKTREES_REFRESH_MS = 3000; // Refresh every 3 seconds

/**
 * Start periodic worktrees refresh (for when cleanup skill is running)
 */
function startWorktreesRefresh() {
  if (worktreesRefreshInterval) return; // Already running

  worktreesRefreshInterval = setInterval(async () => {
    // Only refresh if worktrees view is visible
    const worktreesView = document.getElementById('worktrees-view');
    if (worktreesView && !worktreesView.classList.contains('hidden')) {
      await loadWorktrees();
      renderWorktreesView();
    }
  }, WORKTREES_REFRESH_MS);
}

/**
 * Stop periodic worktrees refresh
 */
function stopWorktreesRefresh() {
  if (worktreesRefreshInterval) {
    clearInterval(worktreesRefreshInterval);
    worktreesRefreshInterval = null;
  }
}

// Load worktrees view (full page view)
async function loadWorktreesView() {
  await loadWorktrees();
  renderWorktreesView();

  // Initialize worktree terminal if not already running
  if (!sessions.worktreeTerminal?.terminalId) {
    await initWorktreeTerminal();
  } else {
    // Terminal already exists, just ensure fitAddon resizes correctly
    setTimeout(() => {
      if (sessions.worktreeTerminal?.fitAddon) {
        sessions.worktreeTerminal.fitAddon.fit();
      }
    }, 100);
  }

  // Start auto-refresh for worktrees (so cleanup skill results are visible)
  startWorktreesRefresh();
}

// Refresh worktrees view
async function refreshWorktreesView() {
  await loadWorktrees();
  renderWorktreesView();
  updateActivity('Refreshed worktrees');
}

// Render full worktrees view
function renderWorktreesView() {
  const container = document.getElementById('worktrees-list');
  const projectPath = document.getElementById('worktrees-project-path');
  const countEl = document.getElementById('worktrees-count');

  // Update project path
  if (projectPath && state.project?.path) {
    projectPath.textContent = state.project.path;
  }

  // Update stats
  const totalWorktrees = state.worktrees.length;
  const activeWorktrees = state.worktrees.filter(w => w.status === 'active').length;
  const assignedWorktrees = state.worktrees.filter(w => w.working_on).length;
  const mainRepo = state.worktrees.filter(w => w.path === state.project?.path).length;

  const statTotal = document.getElementById('wt-stat-total');
  const statActive = document.getElementById('wt-stat-active');
  const statAssigned = document.getElementById('wt-stat-assigned');
  const statMain = document.getElementById('wt-stat-main');

  if (statTotal) statTotal.textContent = totalWorktrees;
  if (statActive) statActive.textContent = activeWorktrees;
  if (statAssigned) statAssigned.textContent = assignedWorktrees;
  if (statMain) statMain.textContent = mainRepo;

  // Update count
  if (countEl) countEl.textContent = `${totalWorktrees} worktree${totalWorktrees !== 1 ? 's' : ''}`;

  if (!container) return;

  if (state.worktrees.length === 0) {
    container.innerHTML = `
      <div class="text-center text-spellbook-muted py-12">
        <div class="text-4xl mb-4">🌲</div>
        <div class="text-lg mb-2">No Worktrees</div>
        <div class="text-sm">Worktrees allow parallel development on different branches.</div>
        <div class="text-sm mt-2">Create one from the planning view or use the worktree-manager skill.</div>
      </div>
    `;
    return;
  }

  container.innerHTML = state.worktrees.map(w => {
    const isMain = w.path === state.project?.path;
    const shortPath = w.path.split('/').slice(-3).join('/');
    const statusColor = w.status === 'active' ? 'text-green-400' :
                       w.status === 'merged' ? 'text-purple-400' :
                       w.status === 'abandoned' ? 'text-red-400' : 'text-spellbook-muted';

    return `
      <div class="bg-spellbook-card border border-spellbook-border rounded-lg p-4 hover:border-spellbook-accent/50 transition-colors">
        <div class="flex items-start justify-between">
          <div class="flex-1">
            <!-- Branch and status -->
            <div class="flex items-center gap-3 mb-2">
              ${isMain ? '<span class="text-spellbook-accent text-lg">●</span>' : '<span class="text-spellbook-muted text-lg">○</span>'}
              <span class="font-semibold text-spellbook-accent">${w.branch || 'unknown'}</span>
              <span class="text-xs px-2 py-0.5 rounded ${statusColor} bg-spellbook-bg">${w.status || 'active'}</span>
              ${isMain ? '<span class="text-xs px-2 py-0.5 rounded bg-purple-500/20 text-purple-400">MAIN</span>' : ''}
            </div>

            <!-- Working on -->
            ${w.working_on ? `
              <div class="flex items-center gap-2 mb-2 ml-7">
                <span class="text-xs text-spellbook-muted">Working on:</span>
                <span class="text-xs text-blue-400 font-mono">${w.working_on}</span>
              </div>
            ` : ''}

            <!-- Path -->
            <div class="flex items-center gap-2 ml-7">
              <span class="text-xs text-spellbook-muted">Path:</span>
              <span class="text-xs font-mono text-spellbook-muted/70 truncate" title="${w.path}">${shortPath}</span>
            </div>

            <!-- Ports -->
            ${w.ports && w.ports.length > 0 ? `
              <div class="flex items-center gap-2 ml-7 mt-2">
                <span class="text-xs text-spellbook-muted">Ports:</span>
                <div class="flex flex-wrap gap-1">
                  ${w.ports.map(p => `
                    <a href="http://localhost:${p}" target="_blank"
                       class="text-xs font-mono px-2 py-0.5 rounded bg-green-500/20 text-green-400 hover:bg-green-500/30 transition-colors">
                      :${p}
                    </a>
                  `).join('')}
                </div>
              </div>
            ` : ''}
          </div>

          <!-- Actions -->
          <div class="flex items-center gap-2">
            ${!isMain ? `
              <button onclick="closeWorktree('${w.path.replace(/'/g, "\\'")}')"
                      class="px-3 py-1.5 text-xs bg-red-500/20 text-red-400 rounded hover:bg-red-500/30 transition-colors"
                      title="Close and remove this worktree">
                Close
              </button>
            ` : ''}
            <button onclick="openWorktreeInTerminal('${w.path.replace(/'/g, "\\'")}')"
                    class="px-3 py-1.5 text-xs bg-spellbook-accent/20 text-spellbook-accent rounded hover:bg-spellbook-accent/30 transition-colors"
                    title="Open terminal in this worktree">
              Terminal
            </button>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

// Close a worktree via terminal - populates skill command
async function closeWorktree(path) {
  const session = sessions.worktreeTerminal;
  if (!session?.ws || session.ws.readyState !== WebSocket.OPEN) {
    showToast('error', 'Worktree terminal not connected. Please wait for it to initialize.');
    return;
  }

  // Send the worktree-manager skill command to the terminal (don't auto-execute, let user confirm)
  const skillCmd = `/worktree-manager cleanup ${path}`;

  session.ws.send(JSON.stringify({ type: 'input', data: skillCmd }));

  showToast('info', 'Command populated in terminal - press Enter to execute');
  updateActivity(`Prepared worktree cleanup: ${path.split('/').slice(-2).join('/')}`);
}

// Open terminal in worktree directory (uses external terminal based on config - Ghostty/iTerm)
// Does NOT pass a hardcoded command - lets the server use the configured AI tool
async function openWorktreeInTerminal(path) {
  try {
    // Use the generic terminal endpoint which respects the user's terminal config
    const sessionName = path.split('/').slice(-2).join('/');
    const res = await fetch(`${API_BASE}/terminal/open`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionName: sessionName,
        workingDir: path,
      }),
    });

    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error || 'Failed to open terminal');
    }

    const data = await res.json();
    showToast('success', data.message || `Opened terminal: ${sessionName}`);
    updateActivity(`Opened terminal at: ${sessionName}`);
  } catch (err) {
    console.error('Failed to open terminal:', err);
    showToast('error', `Failed to open terminal: ${err.message}`);
  }
}

// Find worktree associated with an item
function findItemWorktree(itemType, itemNumber) {
  const ref = `${itemType}-${itemNumber}`;
  // First check working_on field (direct assignment from Spellbook DB)
  const byAssignment = state.worktrees.find(w => w.working_on === ref);
  if (byAssignment) return byAssignment;

  // Fallback: Check worktrees for matching branch name patterns
  return state.worktrees.find(w => {
    const branch = (w.branch || '').toLowerCase();
    const pathPart = (w.path || '').toLowerCase();
    // Match patterns like: fix/bug-44, feature/improvement-32, bug-44, etc.
    return branch.includes(ref) ||
           branch.includes(`${itemType}/${itemNumber}`) ||
           pathPart.includes(ref) ||
           pathPart.endsWith(`/${ref}`);
  });
}

// Update worktree indicator in planning view
function updateWorktreeIndicator(itemType, itemNumber) {
  const indicator = document.getElementById('worktree-indicator');
  const infoEl = document.getElementById('worktree-info');
  const iconEl = document.getElementById('worktree-icon');
  const actionBtn = document.getElementById('worktree-action-btn');

  if (!indicator) return;

  const worktree = findItemWorktree(itemType, itemNumber);
  const session = sessions.planning[sessions.activePlanningSession];

  if (worktree) {
    // Worktree exists for this item
    const shortBranch = worktree.branch.split('/').pop();
    const shortPath = worktree.path.split('/').slice(-2).join('/');

    iconEl.textContent = '🌲';
    iconEl.classList.remove('text-spellbook-muted');
    iconEl.classList.add('text-green-400');

    infoEl.innerHTML = `<span class="text-green-400">${shortBranch}</span> <span class="text-spellbook-muted text-[10px]">(${shortPath})</span>`;

    actionBtn.textContent = 'Open';
    actionBtn.className = 'px-2 py-0.5 bg-green-500/20 text-green-400 rounded hover:bg-green-500/30 text-xs';
    actionBtn.onclick = () => openWorktree(worktree.path);

    // Store worktree in session
    if (session) {
      session.worktree = worktree;
    }
  } else {
    // No worktree - show create option
    iconEl.textContent = '🌲';
    iconEl.classList.add('text-spellbook-muted');
    iconEl.classList.remove('text-green-400');

    infoEl.textContent = 'No worktree';
    infoEl.className = 'text-spellbook-muted';

    actionBtn.textContent = 'Create';
    actionBtn.className = 'px-2 py-0.5 bg-spellbook-accent/20 text-spellbook-accent rounded hover:bg-spellbook-accent/30 text-xs';
    actionBtn.onclick = () => createItemWorktree(itemType, itemNumber);

    if (session) {
      session.worktree = null;
    }
  }
}

// Handle worktree action button click
function handleWorktreeAction() {
  const session = sessions.planning[sessions.activePlanningSession];
  if (!session) return;

  if (session.worktree) {
    openWorktree(session.worktree.path);
  } else {
    createItemWorktree(session.itemType, session.itemNumber);
  }
}

// Open an existing worktree
function openWorktree(path) {
  const session = sessions.planning[sessions.activePlanningSession];
  if (!session?.ws || session.ws.readyState !== WebSocket.OPEN) {
    alert('Terminal not connected');
    return;
  }

  // Send cd command to the terminal
  sendTerminalCommand(session.ws, `cd "${path}"`);
  updateActivity(`Changed to worktree: ${path}`);
}

// Create a new worktree for an item
async function createItemWorktree(itemType, itemNumber) {
  const session = sessions.planning[sessions.activePlanningSession];
  if (!session?.ws || session.ws.readyState !== WebSocket.OPEN) {
    alert('Terminal not connected');
    return;
  }

  const ref = `${itemType}-${itemNumber}`;

  // Use the worktree-manager skill to create the worktree
  sendTerminalCommand(session.ws, `/worktree-manager create ${ref}`);

  updateActivity(`Creating worktree for ${ref}...`);

  // Refresh worktrees after a delay
  setTimeout(async () => {
    await loadWorktrees();
    updateWorktreeIndicator(itemType, itemNumber);
  }, 5000);
}

// ==================== KNOWLEDGE BASE ====================

async function loadKnowledgeBase() {
  try {
    const res = await fetch(`${API_BASE}/knowledge`);
    const data = await res.json();
    state.knowledgeBase = data.tree || [];  // API returns 'tree' not 'files'
    state.knowledgeStats = data.stats || { totalDocs: 0, totalCategories: 0 };
    state.knowledgeRoot = data.root || '';
    // Only render if we're currently on the knowledge view
    if (state.currentView === 'knowledge') {
      renderKnowledgeBase();
    }
  } catch (err) {
    console.error('Failed to load knowledge base:', err);
    state.knowledgeBase = [];
  }
}

function renderKnowledgeBase() {
  const container = document.getElementById('kb-file-tree');
  if (!container) {
    debugLog('[KnowledgeBase] Container kb-file-tree not found, skipping render');
    return;
  }

  // Update stats
  if (state.knowledgeStats) {
    const totalEl = document.getElementById('kb-stat-total');
    const catEl = document.getElementById('kb-stat-categories');
    if (totalEl) totalEl.textContent = state.knowledgeStats.totalDocs || 0;
    if (catEl) catEl.textContent = state.knowledgeStats.totalCategories || 0;
  }

  // Update root path
  if (state.knowledgeRoot) {
    const rootEl = document.getElementById('kb-root-path');
    if (rootEl) rootEl.textContent = state.knowledgeRoot;
  }

  if (!state.knowledgeBase || state.knowledgeBase.length === 0) {
    container.innerHTML = '<div class="text-center text-spellbook-muted py-8 text-sm">No documents found</div>';
    return;
  }

  container.innerHTML = renderKBTree(state.knowledgeBase, 0);
}

function renderKBTree(items, depth) {
  if (!items || items.length === 0) return '';

  return items.map(item => {
    const indent = depth * 12;

    if (item.type === 'folder') {
      const folderId = `kb-folder-${item.path.replace(/[^a-zA-Z0-9]/g, '-')}`;
      return `
        <div class="kb-folder">
          <div class="flex items-center gap-2 py-1.5 px-2 hover:bg-spellbook-bg cursor-pointer rounded text-sm"
               style="padding-left: ${indent + 8}px"
               onclick="toggleKBFolder('${folderId}')">
            <span id="${folderId}-icon" class="text-xs text-spellbook-muted transition-transform">▼</span>
            <span class="text-blue-400">📁</span>
            <span class="text-spellbook-text">${escapeHtml(item.name)}</span>
          </div>
          <div id="${folderId}" class="kb-folder-contents">
            ${renderKBTree(item.children || [], depth + 1)}
          </div>
        </div>
      `;
    } else {
      return `
        <div class="flex items-center gap-2 py-1.5 px-2 hover:bg-spellbook-accent/10 cursor-pointer rounded text-sm"
             style="padding-left: ${indent + 8}px"
             onclick="viewKnowledgeDoc('${escapeHtml(item.path)}', '${escapeHtml(item.name)}')">
          <span class="text-spellbook-muted">📄</span>
          <span class="text-spellbook-text truncate">${escapeHtml(item.name.replace('.md', ''))}</span>
        </div>
      `;
    }
  }).join('');
}

function toggleKBFolder(folderId) {
  const contents = document.getElementById(folderId);
  const icon = document.getElementById(`${folderId}-icon`);
  if (contents && icon) {
    const isHidden = contents.classList.toggle('hidden');
    icon.textContent = isHidden ? '▶' : '▼';
    icon.style.transform = isHidden ? '' : '';
  }
}

function toggleKnowledgeBase() {
  const kb = document.getElementById('knowledge-base');
  const toggle = document.getElementById('kb-toggle');

  kb.classList.toggle('hidden');
  toggle.textContent = kb.classList.contains('hidden') ? '▼' : '▲';

  if (!kb.classList.contains('hidden')) {
    setTimeout(() => {
      document.addEventListener('click', closeKBOnClickOutside);
    }, 10);
  }
}

function closeKBOnClickOutside(e) {
  const kb = document.getElementById('knowledge-base');
  const kbButton = kb?.parentElement?.querySelector('button');
  if (kb && !kb.contains(e.target) && !kbButton?.contains(e.target)) {
    kb.classList.add('hidden');
    document.getElementById('kb-toggle').textContent = '▼';
    document.removeEventListener('click', closeKBOnClickOutside);
  }
}

async function viewKnowledgeDoc(path, name) {
  // Update title and path in the right panel
  const titleEl = document.getElementById('kb-doc-title');
  const pathEl = document.getElementById('kb-doc-path');
  const actionsEl = document.getElementById('kb-doc-actions');
  const viewEl = document.getElementById('kb-doc-view');

  if (titleEl) titleEl.textContent = name.replace('.md', '');
  if (pathEl) {
    pathEl.textContent = path;
    pathEl.classList.remove('hidden');
  }
  if (actionsEl) actionsEl.classList.remove('hidden');
  if (viewEl) viewEl.innerHTML = '<div class="text-center text-spellbook-muted py-8">Loading...</div>';

  // Store current doc info for editing
  state.currentKBDoc = { path, name };

  try {
    const res = await fetch(`${API_BASE}/knowledge/doc?path=${encodeURIComponent(path)}`);
    const data = await res.json();

    if (data.content && viewEl) {
      // Render markdown to HTML
      viewEl.innerHTML = renderMarkdown(data.content);
      state.currentKBDoc.content = data.content;
    }
  } catch (err) {
    console.error('Failed to load document:', err);
    if (viewEl) viewEl.innerHTML = '<div class="text-center text-red-400 py-8">Failed to load document</div>';
  }
}

function renderMarkdown(content) {
  // Simple markdown rendering - convert headers, code blocks, lists, etc.
  let html = escapeHtml(content);

  // Code blocks (must be first)
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre class="bg-spellbook-bg p-4 rounded overflow-x-auto text-sm"><code>$2</code></pre>');

  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code class="bg-spellbook-bg px-1 rounded text-sm">$1</code>');

  // Headers with IDs for anchor links
  html = html.replace(/^### (.+)$/gm, (match, title) => {
    const id = slugify(title);
    return `<h3 id="${id}" class="text-lg font-bold text-spellbook-accent mt-6 mb-2">${title}</h3>`;
  });
  html = html.replace(/^## (.+)$/gm, (match, title) => {
    const id = slugify(title);
    return `<h2 id="${id}" class="text-xl font-bold text-spellbook-accent mt-8 mb-3">${title}</h2>`;
  });
  html = html.replace(/^# (.+)$/gm, (match, title) => {
    const id = slugify(title);
    return `<h1 id="${id}" class="text-2xl font-bold text-spellbook-accent mt-8 mb-4">${title}</h1>`;
  });

  // Bold and italic
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');

  // Links - handle anchor links specially for scrolling
  html = html.replace(/\[([^\]]+)\]\(#([^)]+)\)/g, '<a href="#$2" class="text-spellbook-accent hover:underline" onclick="scrollToAnchor(\'$2\'); return false;">$1</a>');
  html = html.replace(/\[([^\]]+)\]\(([^#][^)]*)\)/g, '<a href="$2" class="text-spellbook-accent hover:underline" target="_blank">$1</a>');

  // Lists
  html = html.replace(/^- (.+)$/gm, '<li class="ml-4">$1</li>');
  html = html.replace(/^(\d+)\. (.+)$/gm, '<li class="ml-4">$2</li>');

  // Paragraphs (double newlines)
  html = html.replace(/\n\n/g, '</p><p class="mb-4">');
  html = '<p class="mb-4">' + html + '</p>';

  // Clean up empty paragraphs
  html = html.replace(/<p class="mb-4"><\/p>/g, '');

  return html;
}

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function scrollToAnchor(anchorId) {
  const viewEl = document.getElementById('kb-doc-view');
  const targetEl = document.getElementById(anchorId);
  if (viewEl && targetEl) {
    targetEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function showDocViewer(name, path, content) {
  let modal = document.getElementById('doc-viewer-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'doc-viewer-modal';
    modal.className = 'modal-overlay hidden';
    modal.innerHTML = `
      <div class="modal-content max-w-4xl max-h-[80vh] flex flex-col">
        <div class="modal-header">
          <div>
            <h3 id="doc-viewer-title" class="font-bold text-lg"></h3>
            <div id="doc-viewer-path" class="text-xs text-spellbook-muted"></div>
          </div>
          <button onclick="hideDocViewer()" class="text-spellbook-muted hover:text-white text-2xl">&times;</button>
        </div>
        <div id="doc-viewer-content" class="modal-body flex-1 overflow-auto prose prose-invert max-w-none"></div>
      </div>
    `;
    document.body.appendChild(modal);
  }

  document.getElementById('doc-viewer-title').textContent = name;
  document.getElementById('doc-viewer-path').textContent = path;
  document.getElementById('doc-viewer-content').innerHTML = marked.parse(content);
  modal.classList.remove('hidden');
}

function hideDocViewer() {
  const modal = document.getElementById('doc-viewer-modal');
  if (modal) modal.classList.add('hidden');
}

// ==================== UTILITY ====================

function updateActivity(message) {
  const feed = document.getElementById('activity-feed');
  if (feed) {
    feed.textContent = message;
  } else {
    debugLog('[Activity]', message);
  }
}

function updateStats() {
  const activeBugs = state.bugs.filter(b => ['active', 'planning', 'in_progress'].includes(b.status)).length;
  const activeImp = state.improvements.filter(i => ['active', 'planning', 'in_progress'].includes(i.status)).length;
  document.getElementById('stats-summary').textContent = `${activeBugs} bugs · ${activeImp} improvements`;
}

// ==================== GLOBAL EXPORTS ====================
// Expose functions to window for onclick handlers in HTML
window.closePlanningView = closePlanningView;
window.minimizePlanningView = minimizePlanningView;
window.openPlanningView = openPlanningView;
window.openActivityItem = openActivityItem;
window.openPlanningFromModal = openPlanningFromModal;
window.hideItemDetailModal = hideItemDetailModal;
window.showWorkModeModal = showWorkModeModal;
window.hideWorkModeModal = hideWorkModeModal;
window.showWorktreeProgressModal = showWorktreeProgressModal;
window.hideWorktreeProgressModal = hideWorktreeProgressModal;
window.cancelWorktreeProgress = cancelWorktreeProgress;
window.continueFromProgress = continueFromProgress;
window.retryWorktreeCreation = retryWorktreeCreation;
window.submitWorkMode = submitWorkMode;
window.handleWorktreeAction = handleWorktreeAction;
window.quickLog = quickLog;
window.hideQuickLogModal = hideQuickLogModal;
window.submitQuickLog = submitQuickLog;
window.quickAddIdea = quickAddIdea;
window.setKanbanFilter = setKanbanFilter;
window.setKanbanPriorityFilter = setKanbanPriorityFilter;
window.setKanbanSort = setKanbanSort;
window.switchMainView = switchMainView;
window.toggleKnowledgeBase = toggleKnowledgeBase;
window.toggleWorktrees = toggleWorktrees;
window.refreshWorktreesView = refreshWorktreesView;
window.closeWorktree = closeWorktree;
window.openWorktreeInTerminal = openWorktreeInTerminal;
window.initWorktreeTerminal = initWorktreeTerminal;
window.setDetailTab = setDetailTab;
window.openDocInEditor = openDocInEditor;
window.quickFinalize = quickFinalize;
window.setPlanningDocTab = setPlanningDocTab;
window.finalizePlanning = finalizePlanning;
window.triggerImplementSkill = triggerImplementSkill;
window.startImplementation = startImplementation;
window.exitClaudeTerminal = exitClaudeTerminal;
window.hideDocViewer = hideDocViewer;
window.viewKnowledgeDoc = viewKnowledgeDoc;
window.scrollToAnchor = scrollToAnchor;
window.setInboxFilter = setInboxFilter;
window.refreshDashboard = refreshDashboard;
window.startNewInvestigation = startNewInvestigation;
window.askQuickQuestion = askQuickQuestion;
window.closeInvestigation = closeInvestigation;
window.closeSessionFromGrid = closeSessionFromGrid;
window.closeAllIdleSessions = closeAllIdleSessions;
window.setTMDocTab = setTMDocTab;
window.createPullRequest = createPullRequest;
window.startCodeRabbitReview = startCodeRabbitReview;
window.finalizeItem = finalizeItem;
window.reconnectSession = reconnectSession;
window.reconnectAllSessions = reconnectAllSessions;
window.dismissReconnectPrompt = dismissReconnectPrompt;
