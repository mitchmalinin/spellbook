# Spellbook

Project planning CLI + web board for AI-assisted development. Track bugs, improvements, and features with markdown specs, then implement them through Claude Code skills.

## Build & Run

```bash
npm run build          # CSS + TypeScript + copy public assets
npm run dev            # TypeScript watch mode (no CSS rebuild)
spellbook board        # Start web board on localhost:3333
spellbook status       # Show project status in terminal
```

Build is required after any `.ts` file change. The `dist/` folder is what runs — source changes in `src/` don't take effect until build.

## Architecture Overview

```
User → CLI (src/commands/) → Database (SQLite) → Web Board (src/web/)
                ↓                    ↓
         Markdown Files      Claude Code Skills
     (~/.spellbook/projects/)   (.claude/skills/)
```

**Three systems work together:**
1. **CLI** (`src/commands/`) — All item operations: log, spec, update, finalize
2. **Database** (`~/.spellbook/spellbook.db`) — SQLite, source of truth for status/metadata
3. **Web Board** (`src/web/`) — Express server with vanilla JS frontend, reads from database

## Storage Model

All item data lives in **centralized storage**, not in the project repo:

```
~/.spellbook/
├── spellbook.db                          # SQLite database (all projects)
└── projects/{projectId}/
    ├── bugs/{number}-{slug}.md           # Bug specs
    ├── improvements/{number}-{slug}.md   # Improvement specs
    ├── features/{number}-{slug}/README.md # Feature specs
    └── knowledge/{name}.md               # Knowledge docs
```

Each project has a `.spellbook.yaml` in its root that links to the centralized storage via `project.id`.

Database stores doc paths as relative: `docs/bugs/74-fix-modal.md` (prefixed with `docs/` for legacy reasons, resolved by `helpers/path.ts`).

## Item Lifecycle

```
idea → inbox → spec_draft → spec_ready → active → in_progress → pr_open → resolved/completed
 │                                                    ↑
 └──── spellbook log (skips inbox, creates active directly) ────┘
```

| Command | What it does | Status transition |
|---------|-------------|-------------------|
| `spellbook idea "text"` | Quick capture to inbox | — |
| `spellbook spec idea-{id}` | Convert inbox to spec | → `spec_draft` |
| `spellbook ready {ref}` | Mark spec complete | → `spec_ready` |
| `spellbook start {ref}` | Begin implementation | → `active` |
| `spellbook update {ref} --status in_progress` | Track progress | → `in_progress` |
| `spellbook pr {ref} --url {url}` | PR opened | → `pr_open` |
| `spellbook finalize {ref}` | Done | → `resolved` / `completed` |
| `spellbook log bug "title"` | Direct create (skip inbox) | → `active` |

**Reference format:** `{type}-{number}` — e.g., `bug-44`, `improvement-31`, `feature-7`

**Final statuses by type:**
- Bugs: `resolved`
- Improvements: `completed`
- Features: `complete`

## Project Structure

```
src/
├── index.ts                    # CLI entry — registers all commands
├── commands/                   # CLI command handlers (one file per command)
├── db/index.ts                 # SQLite schema, queries, and CRUD functions
├── utils/
│   ├── project.ts              # Project detection (.spellbook.yaml lookup)
│   ├── file-creator.ts         # Creates/updates markdown spec files
│   ├── git-sync.ts             # Auto-commit specs to git (debounced)
│   ├── config.ts               # MCP config, env loading, security checks
│   └── format.ts               # CLI output formatting helpers
└── web/
    ├── server.ts               # Express orchestrator (~110 lines)
    ├── types.ts                # Shared interfaces (RouteContext, BoardConfig)
    ├── terminal-manager.ts     # Web terminal management (optional node-pty)
    ├── helpers/
    │   ├── path.ts             # Doc path resolution (central storage ↔ relative)
    │   ├── template.ts         # Plan template generation
    │   ├── worktree.ts         # Worktree functions and interfaces
    │   └── applescript.ts      # AppleScript escaping, work item extraction
    ├── routes/                 # 12 Express route modules
    │   ├── projects.ts         # Project list/switch
    │   ├── worktrees.ts        # Worktree create/delete (largest module)
    │   ├── git.ts              # Git operations (sync, diff, pull, branch)
    │   ├── knowledge.ts        # Knowledge base CRUD
    │   ├── files.ts            # File tree and reading
    │   ├── status.ts           # Dashboard, workflow state, roadmap, activity
    │   ├── items.ts            # Bug/improvement/feature doc/plan CRUD
    │   ├── inbox.ts            # Inbox CRUD, item creation, conversion
    │   ├── terminals.ts        # Embedded web terminals (conditional on node-pty)
    │   ├── terminal-integration.ts  # iTerm2/Ghostty launch (uses AppleScript)
    │   ├── config.ts           # MCP/env/security config endpoints
    │   └── uploads.ts          # File upload with multer
    └── public/
        ├── index.html          # Single-page app shell
        ├── app.js              # All frontend logic (vanilla JS)
        └── vendor/             # Bundled deps (Tailwind CSS, marked, xterm)
```

## Key Conventions

### TypeScript / ESM
- Project uses ESM (`"type": "module"` in package.json)
- All imports must use `.js` extensions: `import { foo } from './bar.js'`
- Top-level `await` is safe (Node 20+, `"module": "NodeNext"`)
- `node-pty` is in `optionalDependencies` — imported dynamically in `terminal-manager.ts`

### Web Server
- **Route registration order matters.** Parameterized routes (`:id`) must come after specific routes. Example: `/api/terminals/persisted` must register before `/api/terminals/:id`.
- **Mutable project state.** Routes must call `ctx.getCurrentProject()` on every request — never cache the result. The current project changes when users call `/api/projects/switch`.
- All route modules receive a `RouteContext` and export `registerXxxRoutes(ctx)`.
- Terminal routes (`terminals.ts`) are conditional on `node-pty` availability — wrapped in `if (ctx.terminalAvailable)` with 503 fallback.
- Terminal integration routes (`terminal-integration.ts`) always load — they use AppleScript, not `node-pty`.

### Frontend
- Single vanilla JS file (`app.js`), no framework, no build step
- Uses globals from vendor scripts: `marked.parse()`, `Terminal`, `FitAddon`
- All vendor assets are local in `public/vendor/` — no CDN dependencies

### Database
- SQLite with WAL mode at `~/.spellbook/spellbook.db`
- `better-sqlite3` (synchronous API)
- Item numbers auto-increment per project: `getNextBugNumber(projectId)`
- `doc_path` in database is relative, prefixed with `docs/` (e.g., `docs/bugs/74-slug.md`)
- Actual file is at `~/.spellbook/projects/{projectId}/bugs/74-slug.md`

### Doc Files
- Flat structure — no `active/` or `resolved/` subdirectories
- Status tracked in markdown header (`**Status:** emoji text`), not folder location
- Files stay in place when status changes (no moving between folders)
- `file-creator.ts` handles creation; `updateFileStatus()` handles in-place status updates

## Database Tables

| Table | Key Columns | Purpose |
|-------|------------|---------|
| `projects` | `id`, `name`, `path` | Registered projects |
| `bugs` | `project_id`, `number`, `slug`, `status`, `doc_path`, `pr_url` | Bug tracking |
| `improvements` | Same as bugs + `linked_feature` | Tech debt / refactors |
| `features` | `project_id`, `number`, `name`, `status`, `tasks` | Roadmap items |
| `inbox` | `project_id`, `description`, `type`, `priority` | Quick-captured ideas |
| `activity` | `project_id`, `item_ref`, `action`, `message` | Change history |
| `worktrees` | `project_id`, `path`, `branch`, `working_on`, `status` | Git worktrees |
| `knowledge` | `project_id`, `slug`, `doc_type`, `doc_path` | Documentation |
| `skills` | `project_id`, `name`, `path` | Available skills |

## Claude Code Skills

`spellbook init --full` generates two skills in the project's `.claude/skills/`:

**`/log`** — Captures bugs/improvements/features via `spellbook log` CLI. Does NOT implement anything.

**`/implement`** — Full workflow: reads spec, marks in-progress, enters plan mode, implements, runs quality checks, finalizes. Always requires plan mode before coding.

**Worktree manager** (optional, global at `~/.claude/skills/worktree-manager/`) — Manages parallel git worktrees for multiple agents. Config at `config.json` supports Ghostty/iTerm2 and Claude/Codex.

## Common Tasks

**Add a new API endpoint:**
1. Create or edit the appropriate file in `src/web/routes/`
2. If new route file, register it in `src/web/server.ts`
3. `npm run build`
4. Watch for route ordering conflicts with parameterized routes

**Add a new CLI command:**
1. Create `src/commands/{name}.ts` exporting a Commander `Command`
2. Import and `program.addCommand()` in `src/index.ts`
3. `npm run build`

**Add a new database table or column:**
1. Edit `src/db/index.ts` — schema is in the `CREATE TABLE` statements at top
2. Add query functions in the same file
3. `npm run build`

**Modify the frontend:**
1. Edit `src/web/public/app.js` (vanilla JS) and/or `src/web/public/index.html`
2. `npm run build` (copies public/ to dist/)
3. If adding Tailwind classes, the CSS rebuild (`build:css`) handles it automatically

## Gotchas

- **Ghostty terminal launch:** Use `/bin/zsh -c 'cmd; exec /bin/zsh -l -i'` — NOT `zsh -lic 'cmd'` which breaks cursor/terminal input (the `-i` + `-c` flags conflict).
- **AppleScript strings:** Always use `escapeAppleScript()` from `helpers/applescript.ts` for any interpolated values.
- **`dist/` is what runs:** After `npm run build`, the server runs from `dist/`. Editing `src/` without rebuilding has no effect.
- **Route conflicts:** The old `/api/terminal/open` endpoint was renamed to `/api/terminal/get-command` to avoid conflicts with the terminal integration route at the same path. Check for duplicates before adding routes.
- **`doc_path` prefix:** Database stores `docs/bugs/74-slug.md` but files live at `~/.spellbook/projects/{id}/bugs/74-slug.md`. The `helpers/path.ts` `resolvePath()` function handles this translation.
