# Spellbook

Project planning CLI that integrates with Claude Code for AI-assisted development. Track bugs, improvements, and features with markdown-based documentation, then implement them through Claude Code skills.

## Requirements

- Node.js >= 20
- Git
- Claude Code (for skill integration)

## Install

```bash
npm install -g @mrwzrd/spellbook
```

`node-pty` is an optional dependency for embedded web terminals. If it fails to install (missing build tools), everything else works fine — you just won't have inline terminals in the web board.

## Quick Start

```bash
cd your-project

# Basic init — registers project and creates .spellbook.yaml
spellbook init

# Full init — also creates docs structure, templates, and Claude skills
spellbook init --full

# Log work items
spellbook log bug "Login modal doesn't close on mobile"
spellbook log improvement "Refactor auth middleware" --priority high
spellbook idea "Add dark mode support"

# Check status
spellbook status

# Open the kanban board
spellbook board
```

## What `spellbook init --full` Creates

Running `spellbook init --full` sets up everything in your project:

### Docs Structure

```
docs/
├── bugs/active/          # Active bug specs
├── bugs/resolved/        # Resolved bugs
├── improvements/active/  # Active improvement specs
├── improvements/completed/
├── features/             # Feature specs
└── knowledge/
    ├── architecture/     # Architecture docs
    ├── decisions/        # ADRs
    ├── guides/           # How-to guides
    ├── api/              # API docs
    ├── research/         # Research notes
    ├── templates/        # Bug, improvement, feature, ADR, guide templates
    └── ROADMAP.md        # Auto-generated roadmap
```

### Claude Code Skills

Two skills are generated in `.claude/skills/` within your project:

**`/log`** — Thin wrapper around the `spellbook log` CLI. Use it in Claude Code to quickly capture bugs, improvements, or feature ideas without leaving the conversation.

**`/implement`** — Full implementation workflow manager. Given a reference like `/implement bug-44`, it:
1. Reads the logged item's markdown spec
2. Marks it as in-progress via `spellbook update`
3. Enters plan mode for implementation design
4. Implements the changes after approval
5. Runs quality checks
6. Finalizes via `spellbook finalize`

### Worktree Manager (Optional, Global)

For parallel AI agent workflows, there's a separate worktree manager skill at `~/.claude/skills/worktree-manager/`. It manages git worktrees so multiple Claude Code agents can work on different items simultaneously. Configure it at `~/.claude/skills/worktree-manager/config.json`:

```json
{
  "terminal": "ghostty",
  "aiTool": "claude",
  "portPool": { "start": 8100, "end": 8199 },
  "worktreeBase": "~/tmp/worktrees",
  "defaultCopyFiles": [".mcp.json", ".env.local"],
  "defaultCopyDirs": [".agents"]
}
```

Supports both Ghostty and iTerm2 terminals, and both Claude Code and Codex as AI tools.

## CLI Commands

| Command | Description |
|---------|-------------|
| `spellbook init [--full]` | Initialize project (with optional full setup) |
| `spellbook log <type> <title>` | Log a bug, improvement, or feature |
| `spellbook idea <description>` | Quick capture to inbox |
| `spellbook inbox` | List inbox items |
| `spellbook spec <inbox-id>` | Convert inbox item to spec |
| `spellbook ready <ref>` | Mark spec as ready for implementation |
| `spellbook start <ref>` | Mark item as in-progress |
| `spellbook update <ref> --status <s>` | Update item status |
| `spellbook finalize <ref>` | Mark item as resolved/completed |
| `spellbook pr <ref>` | Mark item as having an open PR |
| `spellbook status` | Show project status summary |
| `spellbook roadmap` | Regenerate ROADMAP.md |
| `spellbook board [-p port]` | Open kanban board web UI |
| `spellbook doc <path>` | Read a doc file |
| `spellbook generate` | Generate project docs |
| `spellbook sync` | Sync docs with database |
| `spellbook activity` | Show recent activity |
| `spellbook projects` | List registered projects |
| `spellbook worktree` | Manage git worktrees |
| `spellbook migrate` | Migrate docs to central storage |
| `spellbook rebuild` | Rebuild database from docs |

## Web Board

`spellbook board` starts a local Express server (default port 3333) with:

- Kanban board for bugs, improvements, features, and inbox items
- Knowledge base browser for project documentation
- Git status and sync tools
- Worktree management UI
- Embedded web terminals (requires `node-pty`)
- iTerm2 / Ghostty integration for launching AI agents

All frontend assets are bundled locally — no CDN dependencies, works fully offline.

## Storage

- **Database**: `~/.spellbook/db.sqlite` — central SQLite database for all projects
- **Item files**: `~/.spellbook/projects/<project-id>/` — markdown files for bugs, improvements, features
- **Config**: `.spellbook.yaml` in each project root
- **Worktree registry**: `~/.claude/worktree-registry.json` — tracks active worktrees

## Development

```bash
git clone https://github.com/mrwzrd/spellbook.git
cd spellbook
npm install
npm run build    # Compiles CSS + TypeScript + copies public assets
npm link         # Makes `spellbook` command available globally
```

The build pipeline:
1. `build:css` — Tailwind CLI compiles CSS from `src/web/public/tailwind-input.css`
2. `tsc` — TypeScript compilation
3. `copy-public` — Copies `src/web/public/` to `dist/web/public/`

### Project Structure

```
src/
├── index.ts                  # CLI entry point
├── commands/                 # CLI command handlers
├── db/                       # SQLite database layer
├── utils/                    # Shared utilities
└── web/
    ├── server.ts             # Express server orchestrator
    ├── types.ts              # Shared TypeScript interfaces
    ├── terminal-manager.ts   # Web terminal management (optional node-pty)
    ├── helpers/              # Extracted helper functions
    │   ├── path.ts           # Doc path resolution
    │   ├── template.ts       # Plan template generation
    │   ├── worktree.ts       # Worktree management functions
    │   └── applescript.ts    # AppleScript helpers
    ├── routes/               # Express route modules
    │   ├── projects.ts       # Project listing and switching
    │   ├── worktrees.ts      # Worktree create/delete
    │   ├── git.ts            # Git operations
    │   ├── knowledge.ts      # Knowledge base CRUD
    │   ├── files.ts          # File tree and reading
    │   ├── status.ts         # Dashboard, workflow state, roadmap
    │   ├── items.ts          # Bug/improvement/feature CRUD
    │   ├── inbox.ts          # Inbox and item creation
    │   ├── terminals.ts      # Embedded web terminals
    │   ├── terminal-integration.ts  # iTerm2/Ghostty integration
    │   ├── config.ts         # MCP/env/security config
    │   └── uploads.ts        # File uploads
    └── public/               # Frontend assets
        ├── index.html
        ├── app.js
        └── vendor/           # Bundled dependencies (Tailwind, marked, xterm)
```

## License

MIT
