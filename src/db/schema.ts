export const SCHEMA = `
-- Enable WAL mode for concurrent access
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;

-- ═══════════════════════════════════════════════════════════════
-- PROJECTS: Registry of all projects
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,              -- 'shillz', 'other-project'
    name TEXT NOT NULL,               -- 'Shillz'
    path TEXT NOT NULL,               -- '/Users/.../shillz'
    description TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ═══════════════════════════════════════════════════════════════
-- FEATURES: Roadmap items per project
-- Lifecycle: spec_draft → spec_ready → active → in_progress → complete
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS features (
    id INTEGER PRIMARY KEY,
    project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
    number INTEGER,                   -- Feature number within project
    name TEXT NOT NULL,
    status TEXT DEFAULT 'spec_draft', -- 'spec_draft', 'spec_ready', 'active', 'in_progress', 'complete'
    doc_path TEXT,                    -- './specs/features/01-name/' or './active/features/01-name/'
    tasks INTEGER DEFAULT 0,
    source_inbox_id INTEGER,          -- Which inbox item it came from (nullable)
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(project_id, number)
);

-- ═══════════════════════════════════════════════════════════════
-- IMPROVEMENTS: Tech debt, refactors per project
-- Lifecycle: spec_draft → spec_ready → active → in_progress → pr_open → completed
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS improvements (
    id INTEGER PRIMARY KEY,
    project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
    number INTEGER,
    slug TEXT,
    title TEXT NOT NULL,
    priority TEXT DEFAULT 'medium',
    linked_feature INTEGER,           -- Feature number (not ID, no FK constraint)
    status TEXT DEFAULT 'spec_draft', -- 'spec_draft', 'spec_ready', 'active', 'in_progress', 'pr_open', 'completed'
    owner TEXT,                       -- Who is working on this
    blocked_by TEXT,                  -- Comma-separated refs (bug-44,improvement-31)
    source_inbox_id INTEGER,          -- Which inbox item it came from (nullable)
    doc_path TEXT,
    pr_number INTEGER,                -- PR number if PR is open
    pr_url TEXT,                      -- Full PR URL
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(project_id, number)
);

-- ═══════════════════════════════════════════════════════════════
-- BUGS: Bug tracking per project
-- Lifecycle: spec_draft → spec_ready → active → in_progress → pr_open → resolved
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS bugs (
    id INTEGER PRIMARY KEY,
    project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
    number INTEGER,
    slug TEXT,
    title TEXT NOT NULL,
    priority TEXT DEFAULT 'medium',
    status TEXT DEFAULT 'spec_draft', -- 'spec_draft', 'spec_ready', 'active', 'in_progress', 'pr_open', 'resolved'
    owner TEXT,                       -- Who is working on this
    blocked_by TEXT,                  -- Comma-separated refs (bug-44,improvement-31)
    source_inbox_id INTEGER,          -- Which inbox item it came from (nullable)
    doc_path TEXT,
    pr_number INTEGER,                -- PR number if PR is open
    pr_url TEXT,                      -- Full PR URL
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(project_id, number)
);

-- ═══════════════════════════════════════════════════════════════
-- INBOX: Quick capture of ideas before creating specs
-- These are one-liner ideas, not detailed specifications
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS inbox (
    id INTEGER PRIMARY KEY,
    project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
    description TEXT NOT NULL,
    type TEXT DEFAULT 'feature',      -- 'bug', 'improvement', 'feature'
    priority TEXT DEFAULT 'medium',   -- Initial priority estimate
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ═══════════════════════════════════════════════════════════════
-- SKILLS: Available skills per project
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS skills (
    id INTEGER PRIMARY KEY,
    project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,               -- 'log-bug', 'implement', 'commit-and-push'
    path TEXT,                        -- '.claude/skills/log/SKILL.md'
    description TEXT,
    UNIQUE(project_id, name)
);

-- ═══════════════════════════════════════════════════════════════
-- WORKTREES: Active worktrees across all projects
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS worktrees (
    id INTEGER PRIMARY KEY,
    project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
    path TEXT NOT NULL,               -- '/Users/.../worktrees/shillz/fix-x'
    branch TEXT,                      -- 'fix/pwa-notifications'
    working_on TEXT,                  -- 'bug-69' or 'improvement-31'
    status TEXT DEFAULT 'active',     -- 'active', 'merged', 'abandoned'
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ═══════════════════════════════════════════════════════════════
-- ACTIONABLES: Generated task files
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS actionables (
    id INTEGER PRIMARY KEY,
    project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
    source_type TEXT,                 -- 'bug', 'improvement', 'feature'
    source_id INTEGER,                -- Reference to the source item
    file_path TEXT,                   -- './actionables/bug-44.md'
    skill_to_use TEXT,                -- 'implement'
    generated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ═══════════════════════════════════════════════════════════════
-- KNOWLEDGE: Project documentation
-- Doc types: architecture, decision, guide, api, research, prd, cron, analytics, design
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS knowledge (
    id INTEGER PRIMARY KEY,
    project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
    slug TEXT NOT NULL,               -- 'auth-flow', 'payment-architecture'
    title TEXT NOT NULL,
    doc_type TEXT NOT NULL,           -- 'architecture', 'decision', 'guide', 'api', 'research',
                                      -- 'prd', 'cron', 'analytics', 'design'
    doc_path TEXT,                    -- 'docs/knowledge/guides/auth-flow.md'
    tags TEXT,                        -- Comma-separated: 'auth,security,api'
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(project_id, slug)
);

-- ═══════════════════════════════════════════════════════════════
-- ACTIVITY: Changelog/history for all items
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS activity (
    id INTEGER PRIMARY KEY,
    project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
    item_type TEXT NOT NULL,          -- 'bug', 'improvement', 'feature', 'doc'
    item_ref TEXT NOT NULL,           -- 'bug-74', 'doc-auth-flow'
    action TEXT NOT NULL,             -- 'created', 'started', 'changed', 'completed'
    message TEXT,                     -- "Fixed modal scroll issue"
    author TEXT DEFAULT 'Claude',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_features_project ON features(project_id);
CREATE INDEX IF NOT EXISTS idx_improvements_project ON improvements(project_id);
CREATE INDEX IF NOT EXISTS idx_bugs_project ON bugs(project_id);
CREATE INDEX IF NOT EXISTS idx_worktrees_project ON worktrees(project_id);
CREATE INDEX IF NOT EXISTS idx_activity_item ON activity(project_id, item_type, item_ref);
CREATE INDEX IF NOT EXISTS idx_knowledge_project ON knowledge(project_id);
CREATE INDEX IF NOT EXISTS idx_inbox_project ON inbox(project_id);
`;
