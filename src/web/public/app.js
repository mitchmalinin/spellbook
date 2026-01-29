// Spellbook - Mission Control for Development
// Multi-Session Planning Architecture

const API_BASE = '/api';

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
  kanbanSort: 'priority',
  inboxFilter: 'all',
  selectedInboxItem: null,
  currentView: 'kanban', // 'dashboard' | 'kanban' | 'inbox' | 'investigate' | 'terminals'
  knowledgeBase: [],
  dashboardLoaded: false,
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
  },
  // { 'improvement-32': { terminalId, term, ws, fitAddon, itemType, itemNumber, docPath, planContent, planExists, ... } }
  planning: {},
  activePlanningSession: null, // Currently visible planning session key
};

// Document refresh interval
let docRefreshInterval = null;

// Current planning doc tab
let currentPlanningTab = 'document';

// ==================== INITIALIZATION ====================

document.addEventListener('DOMContentLoaded', async () => {
  await loadProjects();
  await fetchData();
  await loadWorktrees();
  await loadBranch();
  await loadKnowledgeBase();
  await loadRecentActivity();
  renderKanban();
  initDragAndDrop();
  updateStats();
  renderSessionPills();

  // Initialize action button with default handler
  const implBtn = document.getElementById('start-impl-btn');
  if (implBtn) {
    implBtn.onclick = startImplementation;
  }

  // Initialize planning view close button with explicit event listener
  // Use document-level delegation to ensure it works even with dynamic content
  document.addEventListener('click', (e) => {
    const target = e.target;
    // Check for close button by ID or by content
    if (target.id === 'close-planning-btn' ||
        (target.tagName === 'BUTTON' && target.textContent?.includes('Close') &&
         target.closest('#planning-view'))) {
      console.log('[Spellbook] Close button clicked via delegation');
      e.preventDefault();
      e.stopPropagation();
      closePlanningView();
    }
  }, true); // Use capture phase to get event first

  // Also add direct listener as backup
  const closePlanningBtn = document.getElementById('close-planning-btn');
  if (closePlanningBtn) {
    closePlanningBtn.onclick = (e) => {
      console.log('[Spellbook] Close button clicked directly');
      closePlanningView();
    };
  }

  // Start Quick Chat terminal
  await initQuickChatTerminal();

  // Resize handler
  window.addEventListener('resize', handleResize);

  // Start polling for kanban updates
  setInterval(async () => {
    await fetchData();
    await loadRecentActivity();
    renderKanban();
    updateStats();
  }, 5000);
});

function handleResize() {
  // Resize Quick Chat terminal
  if (sessions.quickChat?.fitAddon) {
    sessions.quickChat.fitAddon.fit();
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
      <div class="px-3 py-2 hover:bg-spellbook-card/50 border-b border-spellbook-border/50 last:border-0">
        <div class="flex items-center justify-between mb-1">
          <div class="flex items-center gap-2">
            <span class="${typeClass} text-xs font-semibold">${a.item_ref}</span>
            <span class="${actionColor} text-xs">${a.action}</span>
          </div>
          <span class="text-xs text-spellbook-muted">${dateStr}${timeStr}</span>
        </div>
        ${title ? `<div class="text-xs text-spellbook-text truncate">${escapeHtml(title)}</div>` : ''}
      </div>
    `;
  }).join('');
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
      }),
    });

    if (!res.ok) throw new Error('Failed to create quick chat terminal');

    const data = await res.json();
    sessions.quickChat.terminalId = data.terminalId;

    await connectTerminal('quickChat', document.getElementById('quick-chat-terminal'));
    updateActivity('Quick Chat ready - use for rapid logging');
  } catch (err) {
    console.error('Failed to init quick chat:', err);
    updateActivity('Failed to start Quick Chat terminal');
  }
}

// ==================== TERMINAL CONNECTION ====================

async function connectTerminal(sessionKey, container) {
  let session;
  if (sessionKey === 'quickChat') {
    session = sessions.quickChat;
  } else {
    session = sessions.planning[sessionKey];
  }

  if (!session?.terminalId) return;

  const term = new Terminal({
    cursorBlink: true,
    cursorStyle: 'block',
    fontSize: 13,
    fontFamily: "'Space Mono', 'Menlo', 'Monaco', monospace",
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

  session.term = term;
  session.fitAddon = fitAddon;

  setTimeout(() => fitAddon.fit(), 100);

  // Connect WebSocket
  const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${wsProtocol}//${window.location.host}/ws/terminal?id=${session.terminalId}`);

  ws.onopen = () => {
    session.ws = ws;
    ws.send(JSON.stringify({
      type: 'resize',
      cols: term.cols,
      rows: term.rows,
    }));
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === 'output') {
        term.write(msg.data);
        term.scrollToBottom(); // Auto-scroll to bottom on new output
      }
    } catch {
      term.write(event.data);
      term.scrollToBottom(); // Auto-scroll to bottom on new output
    }
  };

  ws.onclose = () => {
    term.write('\r\n\x1b[33m[Terminal disconnected]\x1b[0m\r\n');
    term.scrollToBottom();
    if (sessionKey === 'quickChat') {
      document.getElementById('terminal-status')?.classList.add('text-red-400');
      document.getElementById('terminal-status')?.classList.remove('text-green-400');
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

  // Update buttons
  const activeClass = 'px-3 py-1 text-sm bg-spellbook-accent/20 text-spellbook-accent rounded';
  const inactiveClass = 'px-3 py-1 text-sm bg-spellbook-card border border-spellbook-border rounded hover:border-spellbook-accent';

  document.getElementById('view-dashboard-btn').className = view === 'dashboard' ? activeClass : inactiveClass;
  document.getElementById('view-kanban-btn').className = view === 'kanban' ? activeClass : inactiveClass;
  document.getElementById('view-inbox-btn').className = view === 'inbox' ? activeClass : inactiveClass;
  document.getElementById('view-investigate-btn').className = view === 'investigate' ? activeClass : inactiveClass;
  document.getElementById('view-terminals-btn').className = view === 'terminals' ? activeClass : inactiveClass;

  // Show/hide views
  document.getElementById('dashboard-view').classList.toggle('hidden', view !== 'dashboard');
  document.getElementById('dashboard-view').classList.toggle('flex', view === 'dashboard');
  document.getElementById('kanban-view').classList.toggle('hidden', view !== 'kanban');
  document.getElementById('kanban-view').classList.toggle('flex', view === 'kanban');
  document.getElementById('inbox-view').classList.toggle('hidden', view !== 'inbox');
  document.getElementById('inbox-view').classList.toggle('flex', view === 'inbox');
  document.getElementById('investigate-view').classList.toggle('hidden', view !== 'investigate');
  document.getElementById('investigate-view').classList.toggle('flex', view === 'investigate');
  document.getElementById('terminal-manager-view').classList.toggle('hidden', view !== 'terminals');
  document.getElementById('terminal-manager-view').classList.toggle('flex', view === 'terminals');

  // Resize terminals
  setTimeout(handleResize, 100);

  if (view === 'terminals') {
    renderSessionsGrid();
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
      }
    }
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

  session.term = term;
  session.fitAddon = fitAddon;

  setTimeout(() => fitAddon.fit(), 100);

  // Connect WebSocket
  const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${wsProtocol}//${window.location.host}/ws/terminal?id=${session.terminalId}`);

  ws.onopen = () => {
    session.ws = ws;
    ws.send(JSON.stringify({
      type: 'resize',
      cols: term.cols,
      rows: term.rows,
    }));
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === 'output') {
        term.write(msg.data);
        term.scrollToBottom(); // Auto-scroll to bottom on new output
      }
    } catch {
      term.write(event.data);
      term.scrollToBottom(); // Auto-scroll to bottom on new output
    }
  };

  ws.onclose = () => {
    term.write('\r\n\x1b[33m[Investigation ended]\x1b[0m\r\n');
    term.scrollToBottom();
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
    const typeIcon = session.type === 'bug' ? '🐛' : session.type === 'research' ? '🔍' : '❓';

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

  if (session.ws) session.ws.close();
  if (session.term) session.term.dispose();

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
  if (item.status === 'in_progress') {
    finalizeBtn.classList.remove('hidden');
  } else {
    finalizeBtn.classList.add('hidden');
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

function openPlanningFromModal() {
  console.log('openPlanningFromModal called, currentDetailItem:', currentDetailItem);
  if (!currentDetailItem) {
    alert('No item selected. Please click on an item first.');
    return;
  }

  const { type, number, item } = currentDetailItem;

  // Check if item already has a worktree - if so, go straight to planning view
  const existingWorktree = findItemWorktree(type, number);
  if (existingWorktree) {
    console.log('Item has existing worktree, opening planning view directly');
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
  const branchPrefix = type === 'bug' ? 'fix' : type === 'feature' ? 'feature' : 'improvement';
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
    // Create worktree first, then open planning view
    const branchName = document.getElementById('worktree-branch-name').value;
    await createWorktreeAndOpenPlanning(type, number, branchName);
  } else {
    // Open planning view directly (work on develop)
    openPlanningView(type, number);
  }
}

async function createWorktreeAndOpenPlanning(type, number, branchName) {
  const ref = `${type}-${number}`;

  updateActivity(`Creating worktree for ${ref}...`);

  try {
    // Call the Spellbook CLI to create worktree
    const res = await fetch(`${API_BASE}/worktree/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        itemRef: ref,
        branchName: branchName,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Failed to create worktree: ${errText}`);
    }

    const worktreeData = await res.json();
    console.log('Worktree created:', worktreeData);

    // Refresh worktrees list
    await loadWorktrees();

    updateActivity(`Worktree created for ${ref}`);

    // Now open planning view - it will detect the new worktree
    openPlanningView(type, number);

  } catch (err) {
    console.error('Failed to create worktree:', err);

    // Fallback: Try using spellbook CLI command through a temporary terminal
    // For now, just show error and open planning view in main directory
    alert(`Could not create worktree automatically: ${err.message}\n\nOpening in main project directory instead. You can create a worktree manually using: spellbook worktree create ${ref}`);
    openPlanningView(type, number);
  }
}

async function quickFinalize() {
  console.log('quickFinalize called', currentDetailItem);
  if (!currentDetailItem) {
    alert('No item selected');
    return;
  }

  const { type, number } = currentDetailItem;
  const newStatus = type === 'bug' ? 'resolved' : type === 'improvement' ? 'completed' : 'complete';

  try {
    const endpoint = type === 'bug' ? 'bugs' : type === 'improvement' ? 'improvements' : 'features';

    console.log(`Updating ${endpoint}/${number} to status: ${newStatus}`);

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

// ==================== PLANNING VIEW ====================

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

  // Check for linked worktree and fetch branch from appropriate path
  const linkedWorktree = findItemWorktree(type, number);
  const branchPath = linkedWorktree?.path || state.project?.path;

  try {
    const branchRes = await fetch(`${API_BASE}/git/branch?path=${encodeURIComponent(branchPath)}`);
    const branchData = await branchRes.json();
    const terminalBranchEl = document.getElementById('terminal-branch');
    if (terminalBranchEl) {
      const branchLabel = linkedWorktree
        ? `🌲 ${branchData.branch}`
        : `branch: ${branchData.branch}`;
      terminalBranchEl.textContent = branchLabel;
    }
  } catch (err) {
    console.error('Failed to fetch branch:', err);
    const terminalBranchEl = document.getElementById('terminal-branch');
    if (terminalBranchEl) {
      terminalBranchEl.textContent = 'branch: unknown';
    }
  }

  // Update status badge
  const statusBadge = document.getElementById('planning-status-badge');
  const statusColors = {
    active: 'bg-gray-500/20 text-gray-400',
    planning: 'bg-blue-500/20 text-blue-400',
    in_progress: 'bg-yellow-500/20 text-yellow-400',
    resolved: 'bg-green-500/20 text-green-400',
    completed: 'bg-green-500/20 text-green-400',
  };
  statusBadge.className = `px-2 py-1 text-xs rounded ${statusColors[item.status] || statusColors.active}`;
  statusBadge.textContent = item.status.replace('_', ' ');

  // Load plan file first (needed for terminal context)
  const planData = await loadPlanFile(type, number);

  // Create or resume session
  if (!sessions.planning[sessionKey]) {
    await createPlanningSession(sessionKey, type, number, item, planData);
  } else {
    // Update plan data and item status in session
    sessions.planning[sessionKey].planContent = planData.content;
    sessions.planning[sessionKey].planExists = planData.exists;
    sessions.planning[sessionKey].itemStatus = item.status; // Update item status
    // Reconnect existing terminal
    await connectTerminal(sessionKey, document.getElementById('planning-terminal'));
  }

  sessions.activePlanningSession = sessionKey;

  // Load document
  await loadPlanningDocument(sessionKey, type, number);

  // Update plan indicator
  updatePlanIndicator(planData.exists);

  // Update action button based on item status
  updateActionButton(item.status);

  // Update worktree indicator
  updateWorktreeIndicator(type, number);

  // Show planning view
  document.getElementById('planning-view').classList.remove('hidden');

  // Start document refresh
  startDocumentRefresh(sessionKey, type, number);

  // Fit terminal
  setTimeout(() => {
    const session = sessions.planning[sessionKey];
    if (session?.fitAddon) {
      session.fitAddon.fit();
    }
  }, 100);

  renderSessionPills();
  updateActivity(`Planning ${sessionKey}`);
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
function updatePlanIndicator(exists) {
  const indicator = document.getElementById('plan-status-indicator');
  if (indicator) {
    if (exists) {
      indicator.innerHTML = '<span class="text-green-400">✓ Plan exists</span>';
    } else {
      indicator.innerHTML = '<span class="text-yellow-400">⚠ No plan yet</span>';
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
    const worktreeInfo = linkedWorktree
      ? `\nWorktree: ${linkedWorktree.path} (branch: ${linkedWorktree.branch})`
      : '';

    // Build initial prompt based on whether plan exists
    let initialPrompt;
    if (planData.exists && planData.content) {
      // Extract "How to Continue" section if present
      const howToContinue = extractHowToContinue(planData.content);
      initialPrompt = howToContinue
        ? `Working on ${sessionKey}. ${howToContinue}\n\nMain doc: ${centralPath}\nPlan file: ${planPath}${worktreeInfo}`
        : `Working on ${sessionKey}. Plan file exists at ${planPath} - read it first. Main doc at ${centralPath}${worktreeInfo}`;
    } else {
      // No plan - prompt to create one with file locations
      initialPrompt = `You're working on ${sessionKey}: "${item.title || item.name}".\n\nMain document: ${centralPath}${worktreeInfo}\n\nNo implementation plan exists yet. Please:\n1. Read the main document at ${centralPath}\n2. Enter plan mode to create a comprehensive implementation plan\n3. When done, I'll save your plan to ${planPath}`;
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
    };

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
              // Wait a bit, then send context prompt
              setTimeout(() => {
                if (session?.ws?.readyState === WebSocket.OPEN) {
                  sendCommand(initialPrompt);
                }
              }, 1000);
            }
          } catch (e) {
            // Ignore parse errors
          }
        };
        session.ws.addEventListener('message', checkRename);

        // Send rename command (text + Enter separately)
        sendCommand(`/rename ${sessionKey}`);

        // Fallback: if rename confirmation not received in 10 seconds, send anyway
        setTimeout(() => {
          if (!renameConfirmed) {
            session.ws.removeEventListener('message', checkRename);
            if (session?.ws?.readyState === WebSocket.OPEN) {
              sendCommand(initialPrompt);
            }
          }
        }, 10000);
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

  // Refresh every 3 seconds
  docRefreshInterval = setInterval(async () => {
    if (sessions.activePlanningSession === sessionKey) {
      await loadPlanningDocument(sessionKey, type, number);
    }
  }, 3000);
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
          <div class="flex justify-between items-center mb-4">
            <span class="text-yellow-400 text-sm">⚠ No plan yet - create one below</span>
            <button onclick="createPlanFromTemplate()" class="px-3 py-1 bg-spellbook-accent/20 text-spellbook-accent rounded text-sm hover:bg-spellbook-accent/30">
              Create Plan
            </button>
          </div>
          <div class="plan-template text-spellbook-muted">
            <p class="mb-2">Click "Create Plan" to start with this template:</p>
            <pre class="bg-spellbook-card p-4 rounded text-xs overflow-auto max-h-96">${escapeHtml(session.planTemplate)}</pre>
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
    const res = await fetch(`${API_BASE}/git/diff`);
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

    contentEl.innerHTML = `
      <div class="files-changed-tree">
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
    const res = await fetch(`${API_BASE}/git/diff/file?file=${encodeURIComponent(filePath)}`);
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

function minimizePlanningView() {
  // Hide planning view but keep session running
  document.getElementById('planning-view').classList.add('hidden');
  stopDocumentRefresh();

  // Update session status
  const session = sessions.planning[sessions.activePlanningSession];
  if (session) {
    session.status = 'minimized';
  }

  sessions.activePlanningSession = null;
  renderSessionPills();
  updateActivity('Session minimized - click session pill to resume');
}

async function closePlanningView() {
  console.log('[Spellbook] closePlanningView called');
  const sessionKey = sessions.activePlanningSession;
  console.log('[Spellbook] sessionKey:', sessionKey);

  if (!sessionKey) {
    console.log('[Spellbook] No active session, just hiding view');
    document.getElementById('planning-view').classList.add('hidden');
    return;
  }

  // Use a custom modal instead of browser confirm() to avoid potential blocking issues
  // For now, always confirm (user can use Minimize if they want to keep session)
  const confirmed = window.confirm(`Close planning session for ${sessionKey}? The terminal will be terminated.`);
  console.log('[Spellbook] User confirmed:', confirmed);
  if (!confirmed) {
    return;
  }

  // Close terminal
  const session = sessions.planning[sessionKey];
  if (session?.terminalId) {
    try {
      console.log(`[Spellbook] Sending DELETE request for terminal ${session.terminalId}`);
      const res = await fetch(`${API_BASE}/terminals/${session.terminalId}`, { method: 'DELETE' });
      const result = await res.json();
      console.log('[Spellbook] Terminal close result:', result);
    } catch (err) {
      console.error('Failed to close terminal:', err);
    }
  } else {
    console.log('[Spellbook] No terminal ID to close');
  }

  // Clean up
  if (session?.ws) session.ws.close();
  if (session?.term) session.term.dispose();

  delete sessions.planning[sessionKey];
  sessions.activePlanningSession = null;

  // Hide view
  document.getElementById('planning-view').classList.add('hidden');
  stopDocumentRefresh();
  renderSessionPills();
  updateActivity('Session closed');
}

function resumePlanningSession(sessionKey) {
  const session = sessions.planning[sessionKey];
  if (!session) return;

  openPlanningView(session.itemType, session.itemNumber);
}

// ==================== FINALIZE & START IMPLEMENTATION ====================

// Store plan content globally to avoid escaping issues in template literals
let pendingPlanContent = null;

async function finalizePlanning() {
  console.log('[Spellbook] finalizePlanning clicked');

  const session = sessions.planning[sessions.activePlanningSession];
  if (!session) {
    alert('No active planning session');
    return;
  }

  updateActivity('Fetching Claude\'s plan...');

  try {
    // Fetch Claude's current plan from ~/.claude/plans/
    console.log('[Spellbook] Fetching from /api/claude-plan');
    const res = await fetch(`${API_BASE}/claude-plan`);
    const planData = await res.json();
    console.log('[Spellbook] Plan data:', planData.exists, planData.filename);

    if (!planData.exists || !planData.content) {
      alert('No plan found. Make sure Claude has created a plan in plan mode (look for the plan file path at the bottom of the terminal).');
      return;
    }

    // Store content globally
    pendingPlanContent = planData.content;

    // Show confirmation modal with the plan content
    showFinalizePlanModal(planData);

  } catch (err) {
    console.error('[Spellbook] Failed to fetch plan:', err);
    alert('Failed to fetch plan: ' + err.message);
  }
}

function showFinalizePlanModal(planData) {
  console.log('[Spellbook] Showing finalize modal');

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
  console.log('[Spellbook] confirmFinalizePlan clicked');

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

    // Update button states
    document.getElementById('finalize-btn').classList.add('opacity-50');
    document.getElementById('start-impl-btn').classList.add('bg-green-500/20', 'text-green-400');
    document.getElementById('start-impl-btn').classList.remove('bg-spellbook-accent', 'text-black');
    document.getElementById('start-impl-btn').innerHTML = '● Implementing...';

    updateActivity(`Invoked /implement ${ref}`);

  } catch (err) {
    console.error('Failed to start implementation:', err);
    alert('Failed to start implementation: ' + err.message);
  }
}

// Update action button based on item status
function updateActionButton(itemStatus) {
  const btn = document.getElementById('start-impl-btn');
  const finalizeBtn = document.getElementById('finalize-btn');

  // Reset button classes and show main button
  btn.classList.remove('bg-spellbook-accent', 'text-black', 'bg-green-500/20', 'text-green-400', 'bg-blue-500', 'text-white', 'opacity-50', 'hidden');

  // Hide all workflow buttons
  ['create-pr-btn', 'code-rabbit-btn', 'finalize-item-btn'].forEach(id => {
    document.getElementById(id)?.classList.add('hidden');
  });

  switch (itemStatus) {
    case 'active':
    case 'planning':
    case 'not_started':
      // Planning phase - show "Start Implementation"
      btn.className = 'px-4 py-2 bg-spellbook-accent text-black rounded font-semibold hover:bg-spellbook-accent/80';
      btn.innerHTML = 'Start Implementation →';
      btn.onclick = startImplementation;
      btn.disabled = false;
      finalizeBtn.classList.remove('hidden');
      updateWorkflowProgress('plan');
      break;

    case 'in_progress':
      // Implementation done - show "Commit & Push"
      btn.className = 'px-4 py-2 bg-blue-500 text-white rounded font-semibold hover:bg-blue-600';
      btn.innerHTML = 'Commit & Push →';
      btn.onclick = startCommitWorkflow;
      btn.disabled = false;
      finalizeBtn.classList.add('hidden');
      updateWorkflowProgress('impl');
      break;

    case 'resolved':
    case 'completed':
    case 'complete':
      // Item is done - show disabled state
      btn.className = 'px-4 py-2 bg-green-500/20 text-green-400 rounded font-semibold opacity-50 cursor-not-allowed';
      btn.innerHTML = '✓ Completed';
      btn.onclick = null;
      btn.disabled = true;
      finalizeBtn.classList.add('hidden');
      updateWorkflowProgress('review'); // All steps completed
      break;

    default:
      // Fallback to implementation
      btn.className = 'px-4 py-2 bg-spellbook-accent text-black rounded font-semibold hover:bg-spellbook-accent/80';
      btn.innerHTML = 'Start Implementation →';
      btn.onclick = startImplementation;
      btn.disabled = false;
      finalizeBtn.classList.remove('hidden');
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

    // Update button to show in progress
    const btn = document.getElementById('start-impl-btn');
    btn.className = 'px-4 py-2 bg-blue-500/20 text-blue-400 rounded font-semibold';
    btn.innerHTML = '● Committing...';
    btn.disabled = true;

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

// Show/hide workflow buttons
function showWorkflowButton(buttonId) {
  // Hide main impl button
  document.getElementById('start-impl-btn').classList.add('hidden');
  document.getElementById('finalize-btn').classList.add('hidden');

  // Hide all workflow buttons first
  ['create-pr-btn', 'code-rabbit-btn', 'finalize-item-btn'].forEach(id => {
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

function renderSessionPills() {
  const container = document.getElementById('session-pills');
  const sessionKeys = Object.keys(sessions.planning);

  if (sessionKeys.length === 0) {
    container.innerHTML = '<span class="text-xs text-spellbook-muted">No active sessions</span>';
    return;
  }

  container.innerHTML = sessionKeys.map(key => {
    const session = sessions.planning[key];
    const isActive = sessions.activePlanningSession === key;
    const statusDot = session.status === 'minimized' ? '○' : '●';
    const statusColor = isActive ? 'text-green-400' : session.status === 'minimized' ? 'text-yellow-400' : 'text-blue-400';

    return `
      <button onclick="resumePlanningSession('${key}')"
              class="px-2 py-0.5 text-xs rounded flex items-center gap-1 ${isActive ? 'bg-spellbook-accent/20 text-spellbook-accent' : 'bg-spellbook-card hover:bg-spellbook-border'}">
        <span class="${statusColor}">${statusDot}</span>
        ${key}
      </button>
    `;
  }).join('');
}

// ==================== TERMINAL MANAGER VIEW ====================

function renderSessionsGrid() {
  const container = document.getElementById('sessions-grid');
  const sessionKeys = Object.keys(sessions.planning);

  if (sessionKeys.length === 0) {
    container.innerHTML = `
      <div class="text-center text-spellbook-muted py-8 col-span-3">
        No active sessions. Click an item on the Kanban board to start planning.
      </div>
    `;
    return;
  }

  container.innerHTML = sessionKeys.map(key => {
    const session = sessions.planning[key];
    const isActive = sessions.activePlanningSession === key;
    const statusText = isActive ? 'Active' : session.status === 'minimized' ? 'Minimized' : 'Idle';
    const statusColor = isActive ? 'text-green-400' : session.status === 'minimized' ? 'text-yellow-400' : 'text-spellbook-muted';

    return `
      <div class="bg-spellbook-card border border-spellbook-border rounded-lg p-3 ${isActive ? 'border-spellbook-accent' : ''}">
        <div class="flex items-center justify-between mb-2">
          <span class="font-semibold text-spellbook-accent">${key}</span>
          <span class="text-xs ${statusColor}">● ${statusText}</span>
        </div>
        <div class="text-xs text-spellbook-muted mb-3">
          Last activity: ${session.lastActivity ? new Date(session.lastActivity).toLocaleTimeString() : 'Unknown'}
        </div>
        <div class="flex gap-2">
          <button onclick="resumePlanningSession('${key}')"
                  class="flex-1 px-2 py-1 text-xs bg-spellbook-accent/20 text-spellbook-accent rounded hover:bg-spellbook-accent/30">
            Open
          </button>
          <button onclick="closeSessionFromGrid('${key}')"
                  class="px-2 py-1 text-xs bg-red-500/20 text-red-400 rounded hover:bg-red-500/30">
            ✕
          </button>
        </div>
      </div>
    `;
  }).join('');
}

async function closeSessionFromGrid(sessionKey) {
  if (!confirm(`Close session ${sessionKey}?`)) return;

  const session = sessions.planning[sessionKey];
  if (session?.terminalId) {
    try {
      await fetch(`${API_BASE}/terminals/${session.terminalId}`, { method: 'DELETE' });
    } catch (err) {
      console.error('Failed to close terminal:', err);
    }
  }

  if (session?.ws) session.ws.close();
  if (session?.term) session.term.dispose();

  delete sessions.planning[sessionKey];

  if (sessions.activePlanningSession === sessionKey) {
    sessions.activePlanningSession = null;
    document.getElementById('planning-view').classList.add('hidden');
  }

  renderSessionsGrid();
  renderSessionPills();
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

  // Categorize by status
  let backlog = items.filter(i =>
    ['active', 'backlog', 'logged', 'not_started'].includes(i.status)
  );
  let planning = items.filter(i =>
    ['planning', 'planned', 'spec_draft', 'spec_ready'].includes(i.status)
  );
  let inProgress = items.filter(i =>
    ['in_progress', 'in-progress', 'implementing'].includes(i.status)
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
  return '<div class="text-spellbook-muted text-xs text-center py-4">No items</div>';
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
    done: type === 'bug' ? 'resolved' : type === 'improvement' ? 'completed' : 'complete',
  };

  const newStatus = statusMap[targetColumn];
  if (!newStatus) return;

  try {
    const endpoint = type === 'bug' ? 'bugs' : type === 'improvement' ? 'improvements' : 'features';
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
    state.knowledgeBase = data.files || [];
    renderKnowledgeBase();
  } catch (err) {
    console.error('Failed to load knowledge base:', err);
    state.knowledgeBase = [];
  }
}

function renderKnowledgeBase() {
  const container = document.getElementById('kb-list');
  if (!state.knowledgeBase || state.knowledgeBase.length === 0) {
    container.innerHTML = '<div class="p-3 text-xs text-spellbook-muted">No documents found</div>';
    return;
  }

  container.innerHTML = state.knowledgeBase.map(file => `
    <div class="flex items-center gap-3 py-2 px-3 hover:bg-spellbook-bg cursor-pointer border-b border-spellbook-border last:border-0"
         onclick="viewKnowledgeDoc('${escapeHtml(file.path)}', '${escapeHtml(file.name)}')">
      <span class="text-lg">📄</span>
      <div class="flex-1 min-w-0">
        <div class="text-sm text-spellbook-text">${escapeHtml(file.name)}</div>
        <div class="text-xs text-spellbook-muted truncate">${escapeHtml(file.category || 'general')}</div>
      </div>
    </div>
  `).join('');
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
  document.getElementById('knowledge-base').classList.add('hidden');
  document.getElementById('kb-toggle').textContent = '▼';

  try {
    const res = await fetch(`${API_BASE}/knowledge/doc?path=${encodeURIComponent(path)}`);
    const data = await res.json();

    if (data.content) {
      showDocViewer(name, path, data.content);
    }
  } catch (err) {
    console.error('Failed to load document:', err);
    alert('Failed to load document');
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
  document.getElementById('activity-feed').textContent = message;
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
window.openPlanningFromModal = openPlanningFromModal;
window.hideItemDetailModal = hideItemDetailModal;
window.showWorkModeModal = showWorkModeModal;
window.hideWorkModeModal = hideWorkModeModal;
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
window.setDetailTab = setDetailTab;
window.openDocInEditor = openDocInEditor;
window.quickFinalize = quickFinalize;
window.setPlanningDocTab = setPlanningDocTab;
window.finalizePlanning = finalizePlanning;
window.startImplementation = startImplementation;
window.exitClaudeTerminal = exitClaudeTerminal;
window.hideDocViewer = hideDocViewer;
window.viewKnowledgeDoc = viewKnowledgeDoc;
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
