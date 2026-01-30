import express, { Request, Response, NextFunction } from 'express';
import { createServer as createHttpServer, Server } from 'http';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, existsSync, readdirSync, writeFileSync, mkdirSync, statSync, unlinkSync, copyFileSync, symlinkSync, lstatSync, rmSync } from 'fs';
import { execSync } from 'child_process';
import { homedir } from 'os';
import multer from 'multer';
import { terminalManager, CreateTerminalOptions } from './terminal-manager.js';
import { debouncedSync } from '../utils/git-sync.js';
import { createBugFile, createImprovementFile, generateSlug, updateFileStatus } from '../utils/file-creator.js';
import {
  loadProjectEnv,
  loadMCPConfig,
  getMCPServers,
  checkGitignoreSecurity,
} from '../utils/config.js';
import {
  getBugsByProject,
  getImprovementsByProject,
  getFeaturesByProject,
  getInbox,
  updateBug,
  updateImprovement,
  updateFeature,
  addToInbox,
  removeFromInbox,
  getInboxItem,
  getRecentActivity,
  getAllProjects,
  getProject,
  createBug,
  getNextBugNumber,
  createImprovement,
  getNextImprovementNumber,
  getWorktreesByProject,
  updateWorktree,
  PROJECTS_DIR,
  Bug,
  Improvement,
  Feature,
  InboxItem,
  Project,
} from '../db/index.js';

// Resolve paths - first check central storage, then project path
function resolvePath(docPath: string, projectId: string, projectPath: string): string {
  // If it starts with ~/.spellbook/, expand the path
  if (docPath.startsWith('~/.spellbook/')) {
    return docPath.replace('~', homedir());
  }

  // Remove 'docs/' prefix if present (legacy paths)
  let normalizedPath = docPath.replace(/^docs\//, '');

  // Try central storage first
  const centralPath = join(PROJECTS_DIR, projectId, normalizedPath);
  if (existsSync(centralPath)) {
    return centralPath;
  }

  // Try with zero-padded number (e.g., "bugs/1-foo.md" -> "bugs/01-foo.md")
  const paddedPath = normalizedPath.replace(
    /^(bugs|improvements)\/(\d+)-/,
    (_match, folder, num) => `${folder}/${num.padStart(2, '0')}-`
  );
  const paddedCentralPath = join(PROJECTS_DIR, projectId, paddedPath);
  if (existsSync(paddedCentralPath)) {
    return paddedCentralPath;
  }

  // Try project path (original behavior)
  const projectFilePath = join(projectPath, docPath);
  if (existsSync(projectFilePath)) {
    return projectFilePath;
  }

  // Return central path (even if it doesn't exist, for error reporting)
  return centralPath;
}

// Generate a plan template for a new item
function generatePlanTemplate(type: string, number: number, slug: string): string {
  const today = new Date().toISOString().split('T')[0];
  const title = slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

  return `---
status: planning
created: ${today}
last_session: ${today}
phase: 0
---

# Implementation Plan: ${type === 'bug' ? 'Bug' : type === 'improvement' ? 'Improvement' : 'Feature'} #${number}

## Overview
${title}

## Phases

### Phase 1: Analysis & Setup
- [ ] Review the issue/improvement description
- [ ] Identify affected files and code paths
- [ ] Determine testing strategy

### Phase 2: Implementation
- [ ] [Add specific implementation tasks]

### Phase 3: Testing & Validation
- [ ] Write/update unit tests
- [ ] Manual testing
- [ ] Code review prep

## Session Log

### ${today} - Planning Session
- Created initial plan
- [Add notes as you work]

## Session Handoff

**Last completed:** Initial planning
**Next step:** Begin Phase 1 analysis
**Blocked:** None
**Warnings:** None

## How to Continue
Read this plan file. We're in the planning phase. Start by reviewing the main document and identifying the specific implementation approach.
`;
}

// Global worktree registry path
const WORKTREE_REGISTRY_PATH = join(homedir(), '.claude', 'worktree-registry.json');
const WORKTREE_CONFIG_PATH = join(homedir(), '.claude', 'skills', 'worktree-manager', 'config.json');

interface WorktreeRegistryEntry {
  id: string;
  project: string;
  repoPath: string;
  branch: string;
  branchSlug: string;
  worktreePath: string;
  ports: number[];
  createdAt: string;
  validatedAt: string | null;
  agentLaunchedAt: string | null;
  task: string | null;
  prNumber: number | null;
  status: 'active' | 'orphaned' | 'merged';
}

interface WorktreeRegistry {
  worktrees: WorktreeRegistryEntry[];
  portPool: {
    start: number;
    end: number;
    allocated: number[];
  };
}

interface WorktreeConfig {
  terminal: string;
  shell: string;
  claudeCommand: string;
  portPool: { start: number; end: number };
  portsPerWorktree: number;
  worktreeBase: string;
  defaultCopyFiles: string[];
  defaultCopyDirs: string[];
}

// Load worktree manager config
function loadWorktreeConfig(): WorktreeConfig {
  const defaultConfig: WorktreeConfig = {
    terminal: 'iterm2',
    shell: 'zsh',
    claudeCommand: 'claude --dangerously-skip-permissions',
    portPool: { start: 8100, end: 8199 },
    portsPerWorktree: 2,
    worktreeBase: '~/tmp/worktrees',
    defaultCopyFiles: ['.mcp.json', '.env.local', '.env.development.local', '.spellbook.yaml'],
    defaultCopyDirs: ['.agents'],
  };

  if (!existsSync(WORKTREE_CONFIG_PATH)) {
    return defaultConfig;
  }

  try {
    const content = readFileSync(WORKTREE_CONFIG_PATH, 'utf-8');
    const config = JSON.parse(content);
    return { ...defaultConfig, ...config };
  } catch {
    return defaultConfig;
  }
}

// Load or initialize the global worktree registry
function loadWorktreeRegistry(): WorktreeRegistry {
  const defaultRegistry: WorktreeRegistry = {
    worktrees: [],
    portPool: {
      start: 8100,
      end: 8199,
      allocated: [],
    },
  };

  if (!existsSync(WORKTREE_REGISTRY_PATH)) {
    // Create the registry file
    const registryDir = dirname(WORKTREE_REGISTRY_PATH);
    if (!existsSync(registryDir)) {
      mkdirSync(registryDir, { recursive: true });
    }
    writeFileSync(WORKTREE_REGISTRY_PATH, JSON.stringify(defaultRegistry, null, 2));
    return defaultRegistry;
  }

  try {
    const content = readFileSync(WORKTREE_REGISTRY_PATH, 'utf-8');
    return JSON.parse(content);
  } catch {
    return defaultRegistry;
  }
}

// Save the global worktree registry
function saveWorktreeRegistry(registry: WorktreeRegistry): void {
  const registryDir = dirname(WORKTREE_REGISTRY_PATH);
  if (!existsSync(registryDir)) {
    mkdirSync(registryDir, { recursive: true });
  }
  writeFileSync(WORKTREE_REGISTRY_PATH, JSON.stringify(registry, null, 2));
}

// Allocate ports from the global pool
function allocatePorts(count: number): number[] {
  const registry = loadWorktreeRegistry();
  const { start, end, allocated } = registry.portPool;
  const ports: number[] = [];

  for (let port = start; port <= end && ports.length < count; port++) {
    if (!allocated.includes(port)) {
      // Check if port is actually in use by the system
      try {
        execSync(`lsof -i :${port}`, { stdio: 'pipe' });
        // Port is in use by system, skip it
        continue;
      } catch {
        // Port is free, use it
        ports.push(port);
      }
    }
  }

  if (ports.length < count) {
    throw new Error(`Could not allocate ${count} ports. Only ${ports.length} available.`);
  }

  // Update registry with allocated ports
  registry.portPool.allocated = [...registry.portPool.allocated, ...ports].sort((a, b) => a - b);
  saveWorktreeRegistry(registry);

  return ports;
}

// Register a worktree in the global registry
function registerWorktreeInGlobalRegistry(entry: WorktreeRegistryEntry): void {
  const registry = loadWorktreeRegistry();

  // Remove any existing entry for the same path
  registry.worktrees = registry.worktrees.filter(w => w.worktreePath !== entry.worktreePath);

  // Add new entry
  registry.worktrees.push(entry);
  saveWorktreeRegistry(registry);
}

// Copy directory recursively
function copyDirRecursive(src: string, dest: string): void {
  if (!existsSync(src)) return;

  mkdirSync(dest, { recursive: true });

  const entries = readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      copyFileSync(srcPath, destPath);
    }
  }
}

// Setup worktree with config files and symlinks
function setupWorktree(projectPath: string, worktreePath: string, projectId: string, config: WorktreeConfig): void {
  // Copy files
  for (const file of config.defaultCopyFiles) {
    const srcPath = join(projectPath, file);
    const destPath = join(worktreePath, file);
    if (existsSync(srcPath)) {
      try {
        copyFileSync(srcPath, destPath);
        console.log(`[Worktree] Copied ${file} to worktree`);
      } catch (err) {
        console.warn(`[Worktree] Failed to copy ${file}:`, err);
      }
    }
  }

  // Copy directories
  for (const dir of config.defaultCopyDirs) {
    const srcPath = join(projectPath, dir);
    const destPath = join(worktreePath, dir);
    if (existsSync(srcPath)) {
      try {
        copyDirRecursive(srcPath, destPath);
        console.log(`[Worktree] Copied ${dir}/ to worktree`);
      } catch (err) {
        console.warn(`[Worktree] Failed to copy ${dir}/:`, err);
      }
    }
  }

  // Create symlink for docs/knowledge to central Spellbook storage
  const centralKnowledgePath = join(PROJECTS_DIR, projectId, 'knowledge');
  const worktreeDocsPath = join(worktreePath, 'docs');
  const worktreeKnowledgePath = join(worktreeDocsPath, 'knowledge');

  if (existsSync(centralKnowledgePath)) {
    try {
      // Ensure docs directory exists
      if (!existsSync(worktreeDocsPath)) {
        mkdirSync(worktreeDocsPath, { recursive: true });
      }

      // Remove existing knowledge directory/symlink if present
      if (existsSync(worktreeKnowledgePath)) {
        try {
          const stat = lstatSync(worktreeKnowledgePath);
          if (stat.isSymbolicLink() || stat.isDirectory()) {
            rmSync(worktreeKnowledgePath, { recursive: true, force: true });
          }
        } catch {
          // Ignore removal errors
        }
      }

      // Create symlink
      symlinkSync(centralKnowledgePath, worktreeKnowledgePath);
      console.log(`[Worktree] Created symlink: docs/knowledge -> ${centralKnowledgePath}`);
    } catch (err) {
      console.warn(`[Worktree] Failed to create knowledge symlink:`, err);
    }
  }
}

// Detect package manager and return install command
function detectInstallCommand(worktreePath: string): string | null {
  if (existsSync(join(worktreePath, 'bun.lockb'))) return 'bun install';
  if (existsSync(join(worktreePath, 'pnpm-lock.yaml'))) return 'pnpm install';
  if (existsSync(join(worktreePath, 'yarn.lock'))) return 'yarn install';
  if (existsSync(join(worktreePath, 'package-lock.json'))) return 'npm install';
  if (existsSync(join(worktreePath, 'uv.lock'))) return 'uv sync';
  if (existsSync(join(worktreePath, 'pyproject.toml'))) return 'uv sync';
  if (existsSync(join(worktreePath, 'requirements.txt'))) return 'pip install -r requirements.txt';
  if (existsSync(join(worktreePath, 'go.mod'))) return 'go mod download';
  if (existsSync(join(worktreePath, 'Cargo.toml'))) return 'cargo build';
  return null;
}

// Generate a unique ID for worktree entries
function generateWorktreeId(): string {
  return `wt-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// File upload configuration
const uploadDir = join(homedir(), '.spellbook', 'uploads');
if (!existsSync(uploadDir)) {
  mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: uploadDir,
  filename: (_req, file, cb) => {
    const timestamp = Date.now();
    const safeName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
    cb(null, `${timestamp}-${safeName}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB limit
});

export interface BoardConfig {
  port: number;
  project: Project;
}

export interface StatusResponse {
  bugs: Bug[];
  improvements: Improvement[];
  features: Feature[];
  inbox: InboxItem[];
  project: {
    id: string;
    name: string;
    path: string;
  };
}

export interface DashboardStats {
  bugs: { total: number; active: number; inProgress: number; resolved: number };
  improvements: { total: number; active: number; inProgress: number; completed: number };
  features: { total: number; complete: number; inProgress: number; notStarted: number };
  inbox: { total: number; bugs: number; improvements: number; features: number };
}

export function createServer(config: BoardConfig) {
  const app = express();

  // Mutable current project - can be switched via API
  let currentProject: Project = config.project;

  app.use(express.json());

  // Serve static files from public directory
  const publicDir = join(__dirname, 'public');
  app.use(express.static(publicDir));

  // API: List all registered projects
  app.get('/api/projects', (_req: Request, res: Response) => {
    const projects = getAllProjects();
    res.json({
      projects,
      current: currentProject.id,
    });
  });

  // API: Switch to a different project
  app.post('/api/projects/switch', (req: Request, res: Response) => {
    const { projectId } = req.body;

    if (!projectId) {
      res.status(400).json({ error: 'projectId is required' });
      return;
    }

    const project = getProject(projectId);
    if (!project) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }

    currentProject = project;
    res.json({ success: true, project: currentProject });
  });

  // API: Get worktrees for current project
  app.get('/api/worktrees', (_req: Request, res: Response) => {
    try {
      // Run git worktree list from the project directory
      const output = execSync('git worktree list --porcelain', {
        cwd: currentProject.path,
        encoding: 'utf-8',
      });

      // Parse porcelain output
      const worktrees: Array<{
        path: string;
        branch: string;
        commit: string;
        bare: boolean;
      }> = [];

      let current: { path?: string; branch?: string; commit?: string; bare?: boolean } = {};

      for (const line of output.split('\n')) {
        if (line.startsWith('worktree ')) {
          if (current.path) {
            worktrees.push(current as any);
          }
          current = { path: line.slice(9), bare: false };
        } else if (line.startsWith('HEAD ')) {
          current.commit = line.slice(5);
        } else if (line.startsWith('branch ')) {
          current.branch = line.slice(7).replace('refs/heads/', '');
        } else if (line === 'bare') {
          current.bare = true;
        } else if (line === '' && current.path) {
          worktrees.push(current as any);
          current = {};
        }
      }

      // Merge with database worktrees to get working_on assignments
      const dbWorktrees = getWorktreesByProject(currentProject.id);
      const dbWorktreeMap = new Map(dbWorktrees.map(w => [w.path, w]));

      // Load global registry for port info
      const registryPath = join(homedir(), '.claude', 'worktree-registry.json');
      let registryWorktrees: Array<{ worktreePath: string; ports: number[]; task?: string }> = [];
      if (existsSync(registryPath)) {
        try {
          const registry = JSON.parse(readFileSync(registryPath, 'utf-8'));
          registryWorktrees = registry.worktrees || [];
        } catch {
          // Ignore parse errors
        }
      }
      const registryMap = new Map(registryWorktrees.map(w => [w.worktreePath, w]));

      // Enrich git worktrees with database and registry info
      const enrichedWorktrees = worktrees.map(gitWt => {
        const dbWt = dbWorktreeMap.get(gitWt.path);
        const regWt = registryMap.get(gitWt.path);
        return {
          ...gitWt,
          working_on: dbWt?.working_on || regWt?.task || null,
          status: dbWt?.status || 'active',
          ports: regWt?.ports || [],
        };
      });

      res.json({ worktrees: enrichedWorktrees, projectPath: currentProject.path });
    } catch (err) {
      console.error('Failed to list worktrees:', err);
      res.json({ worktrees: [], error: 'Failed to list worktrees' });
    }
  });

  // API: Create a worktree for an item (full workflow)
  app.post('/api/worktree/create', async (req: Request, res: Response) => {
    const { itemRef, branchName, task, installDeps = true, launchTerminal = true } = req.body;

    if (!itemRef) {
      res.status(400).json({ error: 'itemRef is required (e.g., bug-44, improvement-31)' });
      return;
    }

    try {
      // Parse the item reference
      const match = itemRef.match(/^(bug|improvement|feature)-(\d+)$/);
      if (!match) {
        res.status(400).json({ error: 'Invalid itemRef format. Use: bug-44, improvement-31, or feature-5' });
        return;
      }

      const [, type, numStr] = match;
      const number = parseInt(numStr, 10);

      // Load worktree config
      const wtConfig = loadWorktreeConfig();

      // Determine worktree path
      const worktreeBase = join(homedir(), 'tmp', 'worktrees', currentProject.id);
      const worktreePath = join(worktreeBase, `${type}-${number}`);

      // Determine branch name (use provided or generate default)
      const finalBranchName = branchName || `${type === 'bug' ? 'fix' : type}/${number}`;
      const branchSlug = finalBranchName.replace(/\//g, '-');

      // Check if worktree already exists
      if (existsSync(worktreePath)) {
        res.status(409).json({
          error: 'Worktree already exists',
          path: worktreePath,
          message: 'A worktree already exists at this path. Use the existing worktree or delete it first.',
        });
        return;
      }

      // Create worktree directory parent if needed
      const parentDir = dirname(worktreePath);
      if (!existsSync(parentDir)) {
        mkdirSync(parentDir, { recursive: true });
      }

      // Step 1: Allocate ports from global pool
      let allocatedPorts: number[] = [];
      try {
        allocatedPorts = allocatePorts(wtConfig.portsPerWorktree);
        console.log(`[Worktree] Allocated ports: ${allocatedPorts.join(', ')}`);
      } catch (portErr) {
        console.warn('[Worktree] Could not allocate ports:', portErr);
        // Continue without ports - not critical
      }

      // Step 2: Create the git worktree (always from develop branch)
      try {
        // Fetch latest develop first
        try {
          execSync('git fetch origin develop', { cwd: currentProject.path, stdio: 'pipe' });
        } catch (fetchErr) {
          console.warn('[Worktree] Could not fetch origin/develop:', fetchErr);
        }

        // Create new branch from develop
        execSync(`git worktree add -b "${finalBranchName}" "${worktreePath}" origin/develop`, {
          cwd: currentProject.path,
          stdio: 'pipe',
        });
      } catch (gitErr) {
        // Try without creating new branch (branch might already exist)
        try {
          execSync(`git worktree add "${worktreePath}" "${finalBranchName}"`, {
            cwd: currentProject.path,
            stdio: 'pipe',
          });
        } catch (gitErr2) {
          // Release allocated ports on failure
          if (allocatedPorts.length > 0) {
            const registry = loadWorktreeRegistry();
            registry.portPool.allocated = registry.portPool.allocated.filter(p => !allocatedPorts.includes(p));
            saveWorktreeRegistry(registry);
          }

          const errorMsg = gitErr2 instanceof Error ? gitErr2.message : String(gitErr2);
          res.status(500).json({
            error: 'Failed to create git worktree',
            details: errorMsg,
          });
          return;
        }
      }

      console.log(`[Worktree] Created git worktree at ${worktreePath}`);

      // Step 3: Copy config files and create symlinks
      setupWorktree(currentProject.path, worktreePath, currentProject.id, wtConfig);

      // Step 4: Install dependencies (if requested)
      let installError = '';
      if (installDeps) {
        const installCmd = detectInstallCommand(worktreePath);
        if (installCmd) {
          console.log(`[Worktree] Running: ${installCmd}`);
          try {
            execSync(installCmd, {
              cwd: worktreePath,
              encoding: 'utf-8',
              timeout: 300000, // 5 minute timeout
              stdio: 'pipe',
            });
            console.log(`[Worktree] Dependencies installed successfully`);
          } catch (installErr) {
            installError = installErr instanceof Error ? installErr.message : String(installErr);
            console.warn(`[Worktree] Dependency installation failed:`, installError);
            // Continue - deps can be installed manually
          }
        }
      }

      // Step 5: Register in Spellbook database
      const { createWorktree: dbCreateWorktree } = await import('../db/index.js');
      dbCreateWorktree({
        project_id: currentProject.id,
        path: worktreePath,
        branch: finalBranchName,
        working_on: itemRef,
        status: 'active',
      });

      // Step 6: Register in global worktree registry
      const registryEntry: WorktreeRegistryEntry = {
        id: generateWorktreeId(),
        project: currentProject.id,
        repoPath: currentProject.path,
        branch: finalBranchName,
        branchSlug,
        worktreePath,
        ports: allocatedPorts,
        createdAt: new Date().toISOString(),
        validatedAt: null,
        agentLaunchedAt: null,
        task: task || null,
        prNumber: null,
        status: 'active',
      };
      registerWorktreeInGlobalRegistry(registryEntry);

      console.log(`[Worktree] Registered in global registry: ${itemRef}`);

      // Step 7: Launch terminal with Claude agent (if requested)
      let terminalLaunched = false;
      let terminalInfo = null;

      if (launchTerminal) {
        const launchScript = join(homedir(), '.claude', 'skills', 'worktree-manager', 'scripts', 'launch-agent.sh');

        if (existsSync(launchScript)) {
          try {
            execSync(`"${launchScript}" "${worktreePath}" "${task || ''}"`, {
              cwd: worktreePath,
              stdio: 'pipe',
              timeout: 10000,
            });
            terminalLaunched = true;
            console.log(`[Worktree] Launched agent via launch-agent.sh`);

            // Update registry with launch time
            const registry = loadWorktreeRegistry();
            const entry = registry.worktrees.find(w => w.worktreePath === worktreePath);
            if (entry) {
              entry.agentLaunchedAt = new Date().toISOString();
              saveWorktreeRegistry(registry);
            }
          } catch (launchErr) {
            console.warn(`[Worktree] Failed to launch via script:`, launchErr);
            // Try manual terminal launch fallback
            try {
              const terminal = wtConfig.terminal || 'iterm2';
              const claudeCmd = wtConfig.claudeCommand || 'claude --dangerously-skip-permissions';

              if (terminal === 'iterm2') {
                execSync(`osascript -e 'tell application "iTerm2" to activate' -e 'tell application "iTerm2" to create window with default profile' -e 'tell application "iTerm2" to tell current session of current window to write text "cd \\"${worktreePath}\\" && ${claudeCmd}"'`, {
                  stdio: 'pipe',
                });
                terminalLaunched = true;
              } else if (terminal === 'ghostty') {
                execSync(`open -na "Ghostty.app" --args -e bash -c "cd '${worktreePath}' && ${claudeCmd}; exec bash"`, {
                  stdio: 'pipe',
                });
                terminalLaunched = true;
              }
            } catch (fallbackErr) {
              console.warn(`[Worktree] Terminal launch fallback failed:`, fallbackErr);
            }
          }
        } else {
          // No launch script, try direct terminal launch
          try {
            const terminal = wtConfig.terminal || 'iterm2';
            const claudeCmd = wtConfig.claudeCommand || 'claude --dangerously-skip-permissions';

            if (terminal === 'iterm2') {
              execSync(`osascript -e 'tell application "iTerm2" to activate' -e 'tell application "iTerm2" to create window with default profile' -e 'tell application "iTerm2" to tell current session of current window to write text "cd \\"${worktreePath}\\" && ${claudeCmd}"'`, {
                stdio: 'pipe',
              });
              terminalLaunched = true;
            } else if (terminal === 'ghostty') {
              execSync(`open -na "Ghostty.app" --args -e bash -c "cd '${worktreePath}' && ${claudeCmd}; exec bash"`, {
                stdio: 'pipe',
              });
              terminalLaunched = true;
            }
          } catch (termErr) {
            console.warn(`[Worktree] Could not launch terminal:`, termErr);
          }
        }

        terminalInfo = {
          launched: terminalLaunched,
          terminal: wtConfig.terminal,
          command: wtConfig.claudeCommand,
        };
      }

      console.log(`[Server] Created worktree for ${itemRef} at ${worktreePath}`);

      res.status(201).json({
        success: true,
        path: worktreePath,
        branch: finalBranchName,
        branchSlug,
        workingOn: itemRef,
        ports: allocatedPorts,
        setup: {
          configFilesCopied: wtConfig.defaultCopyFiles,
          directoriesCopied: wtConfig.defaultCopyDirs,
          knowledgeSymlinked: existsSync(join(worktreePath, 'docs', 'knowledge')),
        },
        dependencies: {
          installed: installDeps && !installError,
          error: installError || null,
        },
        terminal: terminalInfo,
        registryEntry,
      });
    } catch (err) {
      console.error('Failed to create worktree:', err);
      res.status(500).json({
        error: 'Failed to create worktree',
        details: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // API: Close/remove a worktree
  app.delete('/api/worktrees/:path(*)', async (req: Request, res: Response) => {
    const worktreePath = '/' + req.params.path;

    if (!worktreePath || worktreePath === '/') {
      res.status(400).json({ error: 'Worktree path is required' });
      return;
    }

    try {
      // Verify this is a valid worktree for the current project
      const dbWorktrees = getWorktreesByProject(currentProject.id);
      const worktree = dbWorktrees.find(w => w.path === worktreePath);

      // Also verify it's not the main repository
      if (worktreePath === currentProject.path) {
        res.status(400).json({ error: 'Cannot remove the main repository' });
        return;
      }

      // Step 0: Kill associated iTerm sessions
      // Find the working_on item (e.g., "bug-79") and close matching iTerm tabs
      if (worktree?.working_on) {
        try {
          const itemRef = worktree.working_on;
          const closeItermScript = `
            tell application "iTerm2"
              repeat with w in windows
                repeat with t in tabs of w
                  try
                    set sess to current session of t
                    set sessName to name of sess
                    if sessName contains "${itemRef}" or sessName contains "${itemRef.replace('-', ' ')}" then
                      close t
                    end if
                  end try
                end repeat
              end repeat
            end tell
          `;
          execSync(`osascript -e '${closeItermScript.replace(/'/g, "'\"'\"'")}'`, {
            timeout: 5000,
            stdio: 'pipe',
          });
          console.log(`[Server] Closed iTerm session for: ${itemRef}`);
        } catch (itermErr) {
          console.warn('[Server] Could not close iTerm session:', itermErr);
        }
      }

      // Step 1: Kill any processes on ports associated with this worktree
      // Try to find and kill processes in the worktree directory
      try {
        // Find node processes running from this directory
        const psOutput = execSync('ps aux', { encoding: 'utf-8' });
        const lines = psOutput.split('\n').filter(line => line.includes(worktreePath));
        for (const line of lines) {
          const parts = line.trim().split(/\s+/);
          if (parts.length > 1) {
            const pid = parts[1];
            try {
              execSync(`kill -9 ${pid}`, { stdio: 'pipe' });
              console.log(`[Server] Killed process ${pid} for worktree ${worktreePath}`);
            } catch {
              // Process might already be dead
            }
          }
        }
      } catch {
        // Ignore ps/kill errors
      }

      // Step 2: Remove the git worktree
      try {
        execSync(`git worktree remove "${worktreePath}" --force`, {
          cwd: currentProject.path,
          stdio: 'pipe',
        });
        console.log(`[Server] Removed git worktree: ${worktreePath}`);
      } catch (gitErr) {
        // If git worktree remove fails, try manual removal
        console.warn('[Server] git worktree remove failed, trying manual cleanup:', gitErr);
        try {
          // Remove the directory
          if (existsSync(worktreePath)) {
            execSync(`rm -rf "${worktreePath}"`, { stdio: 'pipe' });
          }
          // Prune the worktree list
          execSync('git worktree prune', {
            cwd: currentProject.path,
            stdio: 'pipe',
          });
        } catch (manualErr) {
          console.error('[Server] Manual cleanup failed:', manualErr);
        }
      }

      // Step 3: Update database status to 'abandoned'
      if (worktree) {
        try {
          updateWorktree(worktreePath, { status: 'abandoned' });
          console.log(`[Server] Updated worktree status to abandoned: ${worktreePath}`);
        } catch (dbErr) {
          console.warn('[Server] Failed to update worktree in database:', dbErr);
        }
      }

      // Step 4: Clean up global worktree registry if it exists
      const registryPath = join(homedir(), '.claude', 'worktree-registry.json');
      if (existsSync(registryPath)) {
        try {
          const registry = JSON.parse(readFileSync(registryPath, 'utf-8'));
          if (registry.worktrees && Array.isArray(registry.worktrees)) {
            // Find and remove the worktree entry
            const entryIndex = registry.worktrees.findIndex((w: any) => w.worktreePath === worktreePath);
            if (entryIndex !== -1) {
              const entry = registry.worktrees[entryIndex];
              // Release ports
              if (entry.ports && registry.portPool?.allocated) {
                registry.portPool.allocated = registry.portPool.allocated.filter(
                  (p: number) => !entry.ports.includes(p)
                );
              }
              // Remove entry
              registry.worktrees.splice(entryIndex, 1);
              writeFileSync(registryPath, JSON.stringify(registry, null, 2));
              console.log(`[Server] Removed from global registry: ${worktreePath}`);
            }
          }
        } catch (regErr) {
          console.warn('[Server] Failed to update global registry:', regErr);
        }
      }

      res.json({
        success: true,
        path: worktreePath,
        message: 'Worktree closed and cleaned up',
      });
    } catch (err) {
      console.error('Failed to close worktree:', err);
      res.status(500).json({
        error: 'Failed to close worktree',
        details: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // API: Get git sync status (ahead/behind origin)
  app.get('/api/git/sync-status', (req: Request, res: Response) => {
    const targetPath = (req.query.path as string) || currentProject.path;
    const branch = (req.query.branch as string) || 'develop';

    try {
      // First, fetch from origin to get latest refs
      try {
        execSync(`git fetch origin ${branch}`, {
          cwd: targetPath,
          encoding: 'utf-8',
          timeout: 30000,
          stdio: 'pipe',
        });
      } catch (fetchErr) {
        // Fetch might fail if offline or remote unavailable - continue with stale data
        console.warn('[Server] git fetch failed, using cached refs:', fetchErr instanceof Error ? fetchErr.message : fetchErr);
      }

      // Get ahead/behind counts
      const revListOutput = execSync(`git rev-list --left-right --count origin/${branch}...${branch}`, {
        cwd: targetPath,
        encoding: 'utf-8',
      }).trim();

      const [behind, ahead] = revListOutput.split('\t').map(n => parseInt(n, 10) || 0);

      // Get current branch to confirm
      const currentBranch = execSync('git rev-parse --abbrev-ref HEAD', {
        cwd: targetPath,
        encoding: 'utf-8',
      }).trim();

      res.json({
        branch: currentBranch,
        trackedBranch: branch,
        ahead,
        behind,
        lastFetch: new Date().toISOString(),
        synced: ahead === 0 && behind === 0,
      });
    } catch (err) {
      console.error('Failed to get git sync status:', err);
      res.json({
        branch: 'unknown',
        trackedBranch: branch,
        ahead: 0,
        behind: 0,
        lastFetch: null,
        synced: false,
        error: err instanceof Error ? err.message : 'Failed to get sync status',
      });
    }
  });

  // API: Get uncommitted changes (modified, staged, untracked files)
  app.get('/api/git/uncommitted', (req: Request, res: Response) => {
    const targetPath = (req.query.path as string) || currentProject.path;

    try {
      const statusOutput = execSync('git status --porcelain', {
        cwd: targetPath,
        encoding: 'utf-8',
      });

      const files: Array<{ path: string; status: string; statusCode: string }> = [];

      if (statusOutput.trim()) {
        const lines = statusOutput.trim().split('\n');
        for (const line of lines) {
          if (!line.trim()) continue;
          const statusCode = line.substring(0, 2);
          const filePath = line.substring(3);

          let status = 'modified';
          if (statusCode.includes('A')) status = 'added';
          else if (statusCode.includes('D')) status = 'deleted';
          else if (statusCode.includes('R')) status = 'renamed';
          else if (statusCode.includes('?')) status = 'untracked';
          else if (statusCode.includes('U')) status = 'conflict';

          files.push({ path: filePath, status, statusCode: statusCode.trim() });
        }
      }

      const hasUncommitted = files.length > 0;
      const modifiedCount = files.filter(f => f.status === 'modified').length;
      const stagedCount = files.filter(f => f.statusCode[0] !== ' ' && f.statusCode[0] !== '?').length;
      const untrackedCount = files.filter(f => f.status === 'untracked').length;

      res.json({
        hasUncommitted,
        count: files.length,
        modifiedCount,
        stagedCount,
        untrackedCount,
        files,
      });
    } catch (err) {
      console.error('Failed to get uncommitted changes:', err);
      res.json({
        hasUncommitted: false,
        count: 0,
        modifiedCount: 0,
        stagedCount: 0,
        untrackedCount: 0,
        files: [],
        error: err instanceof Error ? err.message : 'Failed to get uncommitted changes',
      });
    }
  });

  // API: Get comparison between develop and main
  app.get('/api/git/main-comparison', (req: Request, res: Response) => {
    const targetPath = (req.query.path as string) || currentProject.path;

    try {
      // First fetch both branches to get latest refs
      try {
        execSync('git fetch origin main develop', {
          cwd: targetPath,
          encoding: 'utf-8',
          timeout: 30000,
          stdio: 'pipe',
        });
      } catch (fetchErr) {
        console.warn('[Server] git fetch for main/develop failed, using cached refs');
      }

      // Get current branch
      const currentBranch = execSync('git rev-parse --abbrev-ref HEAD', {
        cwd: targetPath,
        encoding: 'utf-8',
      }).trim();

      // Get commits that develop has that main doesn't (develop ahead of main)
      let developAheadOfMain = 0;
      try {
        const aheadOutput = execSync('git rev-list --count origin/main..HEAD', {
          cwd: targetPath,
          encoding: 'utf-8',
        }).trim();
        developAheadOfMain = parseInt(aheadOutput, 10) || 0;
      } catch {
        developAheadOfMain = 0;
      }

      // Get commits that main has that develop doesn't (develop behind main)
      let developBehindMain = 0;
      try {
        const behindOutput = execSync('git rev-list --count HEAD..origin/main', {
          cwd: targetPath,
          encoding: 'utf-8',
        }).trim();
        developBehindMain = parseInt(behindOutput, 10) || 0;
      } catch {
        developBehindMain = 0;
      }

      // Determine sync status
      const synced = developAheadOfMain === 0 && developBehindMain === 0;
      const needsPull = developBehindMain > 0;
      const needsPush = developAheadOfMain > 0 && developBehindMain === 0;

      res.json({
        currentBranch,
        developAheadOfMain,
        developBehindMain,
        synced,
        needsPull,
        needsPush,
        lastCheck: new Date().toISOString(),
      });
    } catch (err) {
      console.error('Failed to get main comparison:', err);
      res.json({
        currentBranch: 'unknown',
        developAheadOfMain: 0,
        developBehindMain: 0,
        synced: false,
        needsPull: false,
        needsPush: false,
        error: err instanceof Error ? err.message : 'Failed to compare with main',
      });
    }
  });

  // API: Pull from origin
  app.post('/api/git/pull', (req: Request, res: Response) => {
    const targetPath = (req.query.path as string) || currentProject.path;
    const branch = (req.body.branch as string) || 'develop';

    try {
      // Run git pull
      const output = execSync(`git pull origin ${branch}`, {
        cwd: targetPath,
        encoding: 'utf-8',
        timeout: 60000,
      });

      // Get new sync status after pull
      const revListOutput = execSync(`git rev-list --left-right --count origin/${branch}...${branch}`, {
        cwd: targetPath,
        encoding: 'utf-8',
      }).trim();

      const [behind, ahead] = revListOutput.split('\t').map(n => parseInt(n, 10) || 0);

      res.json({
        success: true,
        message: output.trim() || 'Already up to date',
        ahead,
        behind,
        synced: ahead === 0 && behind === 0,
      });
    } catch (err) {
      console.error('Failed to pull:', err);
      const errorMessage = err instanceof Error ? err.message : 'Failed to pull';

      // Check for common issues
      let hint = '';
      if (errorMessage.includes('uncommitted changes')) {
        hint = 'You have uncommitted changes. Commit or stash them first.';
      } else if (errorMessage.includes('CONFLICT')) {
        hint = 'Merge conflict detected. Resolve conflicts manually.';
      }

      res.status(500).json({
        success: false,
        error: errorMessage,
        hint,
      });
    }
  });

  // API: Pull main into develop (fetch origin/main and merge)
  app.post('/api/git/pull-main', (req: Request, res: Response) => {
    const targetPath = (req.query.path as string) || currentProject.path;

    try {
      // Check current branch
      const currentBranch = execSync('git rev-parse --abbrev-ref HEAD', {
        cwd: targetPath,
        encoding: 'utf-8',
      }).trim();

      if (currentBranch !== 'develop') {
        res.status(400).json({
          success: false,
          error: `Not on develop branch (currently on ${currentBranch})`,
          hint: 'Switch to develop branch before pulling main.',
        });
        return;
      }

      // Check for uncommitted changes
      const statusOutput = execSync('git status --porcelain', {
        cwd: targetPath,
        encoding: 'utf-8',
      }).trim();

      if (statusOutput) {
        res.status(400).json({
          success: false,
          error: 'Uncommitted changes detected',
          hint: 'Commit or stash your changes before pulling main.',
        });
        return;
      }

      // Fetch origin/main
      try {
        execSync('git fetch origin main', {
          cwd: targetPath,
          encoding: 'utf-8',
          timeout: 30000,
          stdio: 'pipe',
        });
      } catch (fetchErr) {
        console.error('Failed to fetch origin/main:', fetchErr);
        res.status(500).json({
          success: false,
          error: 'Failed to fetch origin/main',
          hint: 'Check your network connection or if the main branch exists on origin.',
        });
        return;
      }

      // Merge origin/main into develop
      let mergeOutput: string;
      try {
        mergeOutput = execSync('git merge origin/main --no-edit', {
          cwd: targetPath,
          encoding: 'utf-8',
          timeout: 60000,
        });
      } catch (mergeErr) {
        // Check if it's a merge conflict
        const mergeStatus = execSync('git status --porcelain', {
          cwd: targetPath,
          encoding: 'utf-8',
        }).trim();

        if (mergeStatus.includes('UU') || mergeStatus.includes('AA') || mergeStatus.includes('DD')) {
          // Abort the merge to leave repo in clean state
          try {
            execSync('git merge --abort', { cwd: targetPath, encoding: 'utf-8' });
          } catch {
            // Ignore abort errors
          }
          res.status(500).json({
            success: false,
            error: 'Merge conflict detected',
            hint: 'Resolve conflicts manually: git merge origin/main',
          });
          return;
        }

        throw mergeErr;
      }

      res.json({
        success: true,
        message: mergeOutput.trim() || 'Already up to date',
      });
    } catch (err) {
      console.error('Failed to pull main into develop:', err);
      const errorMessage = err instanceof Error ? err.message : 'Failed to pull main';

      res.status(500).json({
        success: false,
        error: errorMessage,
        hint: 'Check the server logs for more details.',
      });
    }
  });

  // API: Get current git branch for a path
  app.get('/api/git/branch', (req: Request, res: Response) => {
    const targetPath = (req.query.path as string) || currentProject.path;

    try {
      const branch = execSync('git rev-parse --abbrev-ref HEAD', {
        cwd: targetPath,
        encoding: 'utf-8',
      }).trim();

      res.json({ branch, path: targetPath });
    } catch (err) {
      console.error('Failed to get git branch:', err);
      res.json({ branch: 'unknown', path: targetPath, error: 'Not a git repository or git error' });
    }
  });

  // API: Get git diff (changed files)
  app.get('/api/git/diff', (req: Request, res: Response) => {
    const targetPath = (req.query.path as string) || currentProject.path;
    const base = (req.query.base as string) || 'HEAD';

    try {
      // Get list of changed files with stats
      const diffStat = execSync(`git diff --stat ${base}`, {
        cwd: targetPath,
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024, // 10MB buffer
      });

      // Get list of changed files (staged + unstaged)
      const statusOutput = execSync('git status --porcelain', {
        cwd: targetPath,
        encoding: 'utf-8',
      });

      // Parse status output into file list
      const files: Array<{
        path: string;
        status: string;
        additions: number;
        deletions: number;
      }> = [];

      const statusLines = statusOutput.trim().split('\n').filter(Boolean);
      for (const line of statusLines) {
        const status = line.substring(0, 2).trim();
        const filePath = line.substring(3);

        // Get diff stats for this file
        let additions = 0;
        let deletions = 0;
        try {
          const fileStats = execSync(`git diff --numstat -- "${filePath}"`, {
            cwd: targetPath,
            encoding: 'utf-8',
          }).trim();
          if (fileStats) {
            const [add, del] = fileStats.split('\t');
            additions = parseInt(add) || 0;
            deletions = parseInt(del) || 0;
          }
        } catch {
          // New file or binary
        }

        files.push({
          path: filePath,
          status: status || 'M',
          additions,
          deletions,
        });
      }

      // Get total stats
      const totalAdditions = files.reduce((sum, f) => sum + f.additions, 0);
      const totalDeletions = files.reduce((sum, f) => sum + f.deletions, 0);

      res.json({
        files,
        summary: {
          filesChanged: files.length,
          additions: totalAdditions,
          deletions: totalDeletions,
        },
        diffStat,
      });
    } catch (err) {
      console.error('Failed to get git diff:', err);
      res.json({ files: [], summary: { filesChanged: 0, additions: 0, deletions: 0 }, error: 'Failed to get git diff' });
    }
  });

  // API: Get diff content for a specific file
  app.get('/api/git/diff/file', (req: Request, res: Response) => {
    const targetPath = (req.query.path as string) || currentProject.path;
    const filePath = req.query.file as string;

    if (!filePath) {
      res.status(400).json({ error: 'file parameter is required' });
      return;
    }

    try {
      const diff = execSync(`git diff -- "${filePath}"`, {
        cwd: targetPath,
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024,
      });

      res.json({ file: filePath, diff });
    } catch (err) {
      console.error('Failed to get file diff:', err);
      res.status(500).json({ error: 'Failed to get file diff' });
    }
  });

  // API: Get knowledge base as tree structure from ~/.spellbook/projects/{project_id}/knowledge/
  app.get('/api/knowledge', (_req: Request, res: Response) => {
    // Knowledge base is stored in central Spellbook storage
    const knowledgePath = join(PROJECTS_DIR, currentProject.id, 'knowledge');

    interface TreeNode {
      type: 'folder' | 'file';
      name: string;
      path: string;
      children?: TreeNode[];
      lastModified?: string;
    }

    function buildTree(dirPath: string, relativePath: string = ''): TreeNode[] {
      if (!existsSync(dirPath)) return [];

      const entries = readdirSync(dirPath, { withFileTypes: true });
      const nodes: TreeNode[] = [];

      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;

        const fullPath = join(dirPath, entry.name);
        const relPath = relativePath ? `${relativePath}/${entry.name}` : entry.name;

        if (entry.isDirectory()) {
          const children = buildTree(fullPath, relPath);
          nodes.push({
            type: 'folder',
            name: entry.name,
            path: relPath,
            children,
          });
        } else if (entry.isFile() && entry.name.endsWith('.md')) {
          const stat = statSync(fullPath);
          nodes.push({
            type: 'file',
            name: entry.name.replace('.md', ''),
            path: relPath,
            lastModified: stat.mtime.toISOString(),
          });
        }
      }

      // Sort: folders first, then alphabetically
      return nodes.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    }

    try {
      // Create knowledge directory if it doesn't exist with default structure
      if (!existsSync(knowledgePath)) {
        mkdirSync(knowledgePath, { recursive: true });
        // Create default subdirectories
        const defaultDirs = ['architecture', 'decisions', 'guides', 'api', 'research'];
        for (const dir of defaultDirs) {
          mkdirSync(join(knowledgePath, dir), { recursive: true });
        }
      }

      const tree = buildTree(knowledgePath);

      // Count total files
      function countFiles(nodes: TreeNode[]): number {
        let count = 0;
        for (const node of nodes) {
          if (node.type === 'file') count++;
          if (node.children) count += countFiles(node.children);
        }
        return count;
      }

      // Count folders (categories)
      function countFolders(nodes: TreeNode[]): number {
        let count = 0;
        for (const node of nodes) {
          if (node.type === 'folder') {
            count++;
            if (node.children) count += countFolders(node.children);
          }
        }
        return count;
      }

      res.json({
        tree,
        root: `~/.spellbook/projects/${currentProject.id}/knowledge`,
        stats: {
          totalDocs: countFiles(tree),
          totalCategories: countFolders(tree),
        },
      });
    } catch (err) {
      console.error('Failed to read knowledge base:', err);
      res.json({ tree: [], root: '', stats: { totalDocs: 0, totalCategories: 0 }, error: 'Failed to read knowledge base' });
    }
  });

  // API: Get knowledge document content
  app.get('/api/knowledge/content', (req: Request, res: Response) => {
    const docPath = req.query.path as string;
    if (!docPath) {
      res.status(400).json({ error: 'path is required' });
      return;
    }

    // Security: ensure path is within knowledge directory
    const knowledgePath = join(PROJECTS_DIR, currentProject.id, 'knowledge');
    const fullPath = join(knowledgePath, docPath);

    if (!fullPath.startsWith(knowledgePath)) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    // Add .md extension if not present
    const finalPath = fullPath.endsWith('.md') ? fullPath : `${fullPath}.md`;

    if (!existsSync(finalPath)) {
      res.status(404).json({ error: 'Document not found', path: docPath });
      return;
    }

    try {
      const content = readFileSync(finalPath, 'utf-8');
      const stat = statSync(finalPath);
      res.json({
        content,
        path: docPath,
        lastModified: stat.mtime.toISOString(),
      });
    } catch (err) {
      console.error('Failed to read document:', err);
      res.status(500).json({ error: 'Failed to read document' });
    }
  });

  // API: Update knowledge document content
  app.put('/api/knowledge/content', (req: Request, res: Response) => {
    const { path: docPath, content } = req.body;

    if (!docPath) {
      res.status(400).json({ error: 'path is required' });
      return;
    }

    if (content === undefined) {
      res.status(400).json({ error: 'content is required' });
      return;
    }

    // Security: ensure path is within knowledge directory
    const knowledgePath = join(PROJECTS_DIR, currentProject.id, 'knowledge');
    const fullPath = join(knowledgePath, docPath);

    if (!fullPath.startsWith(knowledgePath)) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    // Add .md extension if not present
    const finalPath = fullPath.endsWith('.md') ? fullPath : `${fullPath}.md`;

    try {
      // Ensure parent directory exists
      const parentDir = dirname(finalPath);
      if (!existsSync(parentDir)) {
        mkdirSync(parentDir, { recursive: true });
      }

      writeFileSync(finalPath, content, 'utf-8');

      // Auto-commit to git
      debouncedSync(currentProject.id, `Updated knowledge doc: ${docPath}`);

      res.json({ success: true, path: docPath });
    } catch (err) {
      console.error('Failed to save document:', err);
      res.status(500).json({ error: 'Failed to save document' });
    }
  });

  // API: Get specific knowledge doc content from Spellbook knowledge folder
  app.get('/api/knowledge/doc', (req: Request, res: Response) => {
    const docPath = req.query.path as string;
    if (!docPath) {
      res.status(400).json({ error: 'Path is required' });
      return;
    }

    // Read from Spellbook knowledge folder (matches the tree source)
    const knowledgePath = join(PROJECTS_DIR, currentProject.id, 'knowledge');
    const fullPath = join(knowledgePath, docPath);
    try {
      if (existsSync(fullPath)) {
        const content = readFileSync(fullPath, 'utf-8');
        res.json({ content, path: docPath });
      } else {
        res.status(404).json({ error: 'Document not found', path: fullPath });
      }
    } catch (err) {
      console.error('Failed to read document:', err);
      res.status(500).json({ error: 'Failed to read document' });
    }
  });

  // API: Get file tree structure for current project
  app.get('/api/files', (_req: Request, res: Response) => {
    interface FileNode {
      name: string;
      type: 'file' | 'folder';
      path: string;
      children?: FileNode[];
    }

    function buildTree(dirPath: string, relativePath: string = ''): FileNode[] {
      if (!existsSync(dirPath)) return [];

      const entries = readdirSync(dirPath, { withFileTypes: true });
      const nodes: FileNode[] = [];

      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue; // Skip hidden files

        const fullPath = join(dirPath, entry.name);
        const relPath = relativePath ? `${relativePath}/${entry.name}` : entry.name;

        if (entry.isDirectory()) {
          nodes.push({
            name: entry.name,
            type: 'folder',
            path: relPath,
            children: buildTree(fullPath, relPath),
          });
        } else {
          nodes.push({
            name: entry.name,
            type: 'file',
            path: relPath,
          });
        }
      }

      // Sort: folders first, then alphabetically
      return nodes.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    }

    const projectDocsPath = join(PROJECTS_DIR, currentProject.id);
    const tree = buildTree(projectDocsPath);

    res.json({
      root: `~/.spellbook/projects/${currentProject.id}`,
      tree,
    });
  });

  // API: Read any file from project docs
  app.get('/api/files/read', (req: Request, res: Response) => {
    const filePath = req.query.path as string;

    if (!filePath) {
      res.status(400).json({ error: 'path is required' });
      return;
    }

    // Security: ensure path is within project docs
    const fullPath = join(PROJECTS_DIR, currentProject.id, filePath);
    const projectDocsPath = join(PROJECTS_DIR, currentProject.id);

    if (!fullPath.startsWith(projectDocsPath)) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    if (!existsSync(fullPath)) {
      res.status(404).json({ error: 'File not found' });
      return;
    }

    try {
      const content = readFileSync(fullPath, 'utf-8');
      res.json({ content, path: filePath });
    } catch (err) {
      res.status(500).json({ error: 'Failed to read file' });
    }
  });

  // API: Open terminal at a path (returns command, client executes)
  app.post('/api/terminal/open', (req: Request, res: Response) => {
    const { path: targetPath } = req.body;

    if (!targetPath) {
      res.status(400).json({ error: 'path is required' });
      return;
    }

    // Return the command - client can use it with a protocol handler or display instructions
    // For macOS with Ghostty
    const command = `open -a Ghostty --args --working-directory="${targetPath}"`;

    res.json({
      command,
      path: targetPath,
      instructions: `Run this command to open terminal: ${command}`,
    });
  });

  // API: Get all items for the kanban board
  app.get('/api/status', (_req: Request, res: Response) => {
    const bugs = getBugsByProject(currentProject.id);
    const improvements = getImprovementsByProject(currentProject.id);
    const features = getFeaturesByProject(currentProject.id);
    const inbox = getInbox(currentProject.id);

    const response: StatusResponse = {
      bugs,
      improvements,
      features,
      inbox,
      project: {
        id: currentProject.id,
        name: currentProject.name,
        path: currentProject.path,
      },
    };

    res.json(response);
  });

  // API: Get workflow state (for tracking planning → implementing flow)
  app.get('/api/workflow-state', (_req: Request, res: Response) => {
    const stateFile = join(currentProject.path, '.claude', 'state', 'workflow.json');

    try {
      if (existsSync(stateFile)) {
        const state = JSON.parse(readFileSync(stateFile, 'utf-8'));
        res.json(state);
      } else {
        res.json({ ref: null, status: null });
      }
    } catch (err) {
      console.error('Failed to read workflow state:', err);
      res.json({ ref: null, status: null });
    }
  });

  // API: Set workflow state (called when user starts "Work on this")
  app.post('/api/workflow-state', (req: Request, res: Response) => {
    const { ref, status, itemType, itemNumber } = req.body;
    const stateDir = join(currentProject.path, '.claude', 'state');
    const stateFile = join(stateDir, 'workflow.json');

    try {
      // Ensure directory exists
      if (!existsSync(stateDir)) {
        mkdirSync(stateDir, { recursive: true });
      }

      const state = {
        ref,
        status,
        itemType,
        itemNumber,
        startedAt: new Date().toISOString(),
        projectPath: currentProject.path,
      };

      writeFileSync(stateFile, JSON.stringify(state, null, 2));
      console.log(`[Server] Workflow state set: ${ref} → ${status}`);
      res.json({ success: true, state });
    } catch (err) {
      console.error('Failed to write workflow state:', err);
      res.status(500).json({ error: 'Failed to write workflow state' });
    }
  });

  // API: Clear workflow state (called when work is complete)
  app.delete('/api/workflow-state', (_req: Request, res: Response) => {
    const stateFile = join(currentProject.path, '.claude', 'state', 'workflow.json');

    try {
      if (existsSync(stateFile)) {
        unlinkSync(stateFile);
      }
      res.json({ success: true });
    } catch (err) {
      console.error('Failed to clear workflow state:', err);
      res.status(500).json({ error: 'Failed to clear workflow state' });
    }
  });

  // API: Get dashboard stats
  app.get('/api/dashboard', (_req: Request, res: Response) => {
    const bugs = getBugsByProject(currentProject.id);
    const improvements = getImprovementsByProject(currentProject.id);
    const features = getFeaturesByProject(currentProject.id);
    const inbox = getInbox(currentProject.id);

    const stats: DashboardStats = {
      bugs: {
        total: bugs.length,
        active: bugs.filter(b => ['spec_draft', 'spec_ready', 'active'].includes(b.status)).length,
        inProgress: bugs.filter(b => b.status === 'in_progress').length,
        resolved: bugs.filter(b => b.status === 'resolved').length,
      },
      improvements: {
        total: improvements.length,
        active: improvements.filter(i => ['spec_draft', 'spec_ready', 'active'].includes(i.status)).length,
        inProgress: improvements.filter(i => i.status === 'in_progress').length,
        completed: improvements.filter(i => i.status === 'completed').length,
      },
      features: {
        total: features.length,
        complete: features.filter(f => f.status === 'complete').length,
        inProgress: features.filter(f => f.status === 'in_progress').length,
        notStarted: features.filter(f => ['not_started', 'spec_draft', 'spec_ready'].includes(f.status)).length,
      },
      inbox: {
        total: inbox.length,
        bugs: inbox.filter(i => i.type === 'bug').length,
        improvements: inbox.filter(i => i.type === 'improvement').length,
        features: inbox.filter(i => i.type === 'feature').length,
      },
    };

    res.json(stats);
  });

  // API: Get ROADMAP.md content
  app.get('/api/roadmap', (_req: Request, res: Response) => {
    const roadmapPath = join(currentProject.path, 'docs', 'knowledge', 'ROADMAP.md');

    if (!existsSync(roadmapPath)) {
      res.json({
        exists: false,
        content: null,
        message: 'ROADMAP.md not found. Run `spellbook generate` to create it.',
      });
      return;
    }

    try {
      const content = readFileSync(roadmapPath, 'utf-8');
      const stat = statSync(roadmapPath);

      res.json({
        exists: true,
        content,
        path: roadmapPath,
        modifiedAt: stat.mtime.toISOString(),
      });
    } catch (err) {
      console.error('Failed to read ROADMAP.md:', err);
      res.status(500).json({ error: 'Failed to read ROADMAP.md' });
    }
  });

  // API: Regenerate roadmap
  app.post('/api/roadmap', (_req: Request, res: Response) => {
    try {
      console.log('[Server] Regenerating roadmap for project:', currentProject.path);
      execSync('spellbook roadmap', {
        cwd: currentProject.path,
        timeout: 30000,
        encoding: 'utf-8',
      });
      console.log('[Server] Roadmap regenerated successfully');
      res.json({ success: true, message: 'Roadmap regenerated' });
    } catch (err: any) {
      console.error('[Server] Failed to regenerate roadmap:', err.message || err);
      res.status(500).json({ error: 'Failed to regenerate roadmap', details: err.message });
    }
  });

  // API: Get project info for dashboard
  app.get('/api/project-info', (_req: Request, res: Response) => {
    const bugs = getBugsByProject(currentProject.id);
    const improvements = getImprovementsByProject(currentProject.id);
    const features = getFeaturesByProject(currentProject.id);
    const inbox = getInbox(currentProject.id);

    // Try to read package.json for tech stack info
    let techStack: { name?: string; version?: string; dependencies?: Record<string, string> } = {};
    const packageJsonPath = join(currentProject.path, 'package.json');
    if (existsSync(packageJsonPath)) {
      try {
        techStack = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
      } catch {
        // Ignore parse errors
      }
    }

    // Get git info
    let gitInfo = { branch: 'unknown', remote: 'unknown' };
    try {
      gitInfo.branch = execSync('git rev-parse --abbrev-ref HEAD', {
        cwd: currentProject.path,
        encoding: 'utf-8',
      }).trim();

      gitInfo.remote = execSync('git remote get-url origin', {
        cwd: currentProject.path,
        encoding: 'utf-8',
      }).trim();
    } catch {
      // Ignore git errors
    }

    res.json({
      project: {
        id: currentProject.id,
        name: currentProject.name,
        path: currentProject.path,
      },
      git: gitInfo,
      techStack: {
        name: techStack.name,
        version: techStack.version,
        dependencies: techStack.dependencies ? Object.keys(techStack.dependencies).slice(0, 15) : [],
      },
      stats: {
        featuresComplete: features.filter(f => f.status === 'complete').length,
        featuresTotal: features.length,
        activeBugs: bugs.filter(b => !['resolved'].includes(b.status)).length,
        activeImprovements: improvements.filter(i => !['completed'].includes(i.status)).length,
        inboxItems: inbox.length,
      },
    });
  });

  // API: Get recent activity (enriched with item titles)
  app.get('/api/activity', (req: Request, res: Response) => {
    const limit = parseInt(req.query.limit as string) || 20;
    const activity = getRecentActivity(currentProject.id, limit);

    // Build lookup maps for titles
    const bugs = getBugsByProject(currentProject.id);
    const improvements = getImprovementsByProject(currentProject.id);
    const features = getFeaturesByProject(currentProject.id);

    const bugMap = new Map(bugs.map(b => [`bug-${b.number}`, b.title]));
    const impMap = new Map(improvements.map(i => [`improvement-${i.number}`, i.title]));
    const featureMap = new Map(features.map(f => [`feature-${f.number}`, f.name]));

    // Enrich activity with titles
    const enrichedActivity = activity.map(a => ({
      ...a,
      item_title: bugMap.get(a.item_ref) || impMap.get(a.item_ref) || featureMap.get(a.item_ref) || null,
    }));

    res.json(enrichedActivity);
  });

  // API: Get document content for an item
  app.get('/api/item/:type/:number/doc', (req: Request, res: Response) => {
    const type = req.params.type as string;
    const number = parseInt(req.params.number as string, 10);

    let docPath: string | null = null;

    if (type === 'bug') {
      const bugs = getBugsByProject(currentProject.id);
      const bug = bugs.find(b => b.number === number);
      docPath = bug?.doc_path || null;
    } else if (type === 'improvement') {
      const improvements = getImprovementsByProject(currentProject.id);
      const improvement = improvements.find(i => i.number === number);
      docPath = improvement?.doc_path || null;
    } else if (type === 'feature') {
      const features = getFeaturesByProject(currentProject.id);
      const feature = features.find(f => f.number === number);
      docPath = feature?.doc_path || null;
    }

    if (!docPath) {
      res.status(404).json({ error: 'Document not found', docPath: null });
      return;
    }

    // Resolve path - supports both relative and ~/.spellbook/ paths
    let fullPath = resolvePath(docPath, currentProject.id, currentProject.path);

    // For features, doc_path is a folder - look for README.md inside
    if (type === 'feature' && (docPath.endsWith('/') || !docPath.endsWith('.md'))) {
      fullPath = join(fullPath, 'README.md');
    }

    if (!existsSync(fullPath)) {
      res.status(404).json({ error: 'Document file not found', path: fullPath });
      return;
    }

    try {
      const content = readFileSync(fullPath, 'utf-8');
      res.json({ content, path: docPath });
    } catch (err) {
      res.status(500).json({ error: 'Failed to read document' });
    }
  });

  // API: Get plan file for an item
  app.get('/api/item/:type/:number/plan', (req: Request, res: Response) => {
    const type = req.params.type as string;
    const number = parseInt(req.params.number as string, 10);

    // Get the item to find its doc_path
    let docPath: string | null = null;
    let slug: string | null = null;

    if (type === 'bug') {
      const bugs = getBugsByProject(currentProject.id);
      const bug = bugs.find(b => b.number === number);
      docPath = bug?.doc_path || null;
      slug = bug?.slug || null;
    } else if (type === 'improvement') {
      const improvements = getImprovementsByProject(currentProject.id);
      const improvement = improvements.find(i => i.number === number);
      docPath = improvement?.doc_path || null;
      slug = improvement?.slug || null;
    } else if (type === 'feature') {
      const features = getFeaturesByProject(currentProject.id);
      const feature = features.find(f => f.number === number);
      docPath = feature?.doc_path || null;
      slug = feature?.name?.toLowerCase().replace(/[^a-z0-9]+/g, '-') || null;
    }

    if (!docPath || !slug) {
      res.status(404).json({ error: 'Item not found', exists: false });
      return;
    }

    // Derive plan file path from doc path
    // e.g., bugs/32-foo.md -> bugs/32-foo.plan.md
    const planPath = docPath.replace('.md', '.plan.md');
    const fullPath = resolvePath(planPath, currentProject.id, currentProject.path);

    if (!existsSync(fullPath)) {
      // No plan exists yet - return empty with exists: false
      res.json({
        exists: false,
        content: null,
        path: planPath,
        template: generatePlanTemplate(type, number, slug)
      });
      return;
    }

    try {
      const content = readFileSync(fullPath, 'utf-8');
      res.json({ exists: true, content, path: planPath });
    } catch (err) {
      res.status(500).json({ error: 'Failed to read plan file' });
    }
  });

  // API: Save/update plan file for an item
  app.put('/api/item/:type/:number/plan', (req: Request, res: Response) => {
    const type = req.params.type as string;
    const number = parseInt(req.params.number as string, 10);
    const { content } = req.body;

    if (!content) {
      res.status(400).json({ error: 'Content is required' });
      return;
    }

    // Get the item to find its doc_path
    let docPath: string | null = null;

    if (type === 'bug') {
      const bugs = getBugsByProject(currentProject.id);
      const bug = bugs.find(b => b.number === number);
      docPath = bug?.doc_path || null;
    } else if (type === 'improvement') {
      const improvements = getImprovementsByProject(currentProject.id);
      const improvement = improvements.find(i => i.number === number);
      docPath = improvement?.doc_path || null;
    } else if (type === 'feature') {
      const features = getFeaturesByProject(currentProject.id);
      const feature = features.find(f => f.number === number);
      docPath = feature?.doc_path || null;
    }

    if (!docPath) {
      res.status(404).json({ error: 'Item not found' });
      return;
    }

    // Derive plan file path
    const planPath = docPath.replace('.md', '.plan.md');

    // Need to resolve to central storage
    let normalizedPath = planPath.replace(/^docs\//, '');
    const fullPath = join(PROJECTS_DIR, currentProject.id, normalizedPath);

    try {
      // Ensure directory exists
      const dir = dirname(fullPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      writeFileSync(fullPath, content, 'utf-8');

      // Auto-commit to git
      debouncedSync(currentProject.id, `Updated plan for ${type}-${number}`);

      res.json({ success: true, path: planPath });
    } catch (err) {
      console.error('Failed to save plan file:', err);
      res.status(500).json({ error: 'Failed to save plan file' });
    }
  });

  // API: Get Claude's current plan from ~/.claude/plans/
  app.get('/api/claude-plan', (_req: Request, res: Response) => {
    const claudePlansDir = join(homedir(), '.claude', 'plans');

    if (!existsSync(claudePlansDir)) {
      res.json({ exists: false, content: null, message: 'No Claude plans directory found' });
      return;
    }

    try {
      // List all .md files and sort by modification time (newest first)
      const files = readdirSync(claudePlansDir)
        .filter(f => f.endsWith('.md'))
        .map(f => ({
          name: f,
          path: join(claudePlansDir, f),
          mtime: statSync(join(claudePlansDir, f)).mtime.getTime(),
        }))
        .sort((a, b) => b.mtime - a.mtime);

      if (files.length === 0) {
        res.json({ exists: false, content: null, message: 'No plan files found' });
        return;
      }

      // Get the most recent plan
      const latestPlan = files[0];
      const content = readFileSync(latestPlan.path, 'utf-8');

      res.json({
        exists: true,
        content,
        filename: latestPlan.name,
        path: latestPlan.path,
        modifiedAt: new Date(latestPlan.mtime).toISOString(),
      });
    } catch (err) {
      console.error('Failed to read Claude plans:', err);
      res.status(500).json({ error: 'Failed to read Claude plans' });
    }
  });

  // API: Update item status
  app.post('/api/item/:type/:number/status', (req: Request, res: Response) => {
    const type = req.params.type as string;
    const number = parseInt(req.params.number as string, 10);
    const { status } = req.body;

    if (!status) {
      res.status(400).json({ error: 'Status is required' });
      return;
    }

    let updated;
    if (type === 'bug') {
      updated = updateBug(currentProject.id, number, { status });
    } else if (type === 'improvement') {
      updated = updateImprovement(currentProject.id, number, { status });
    } else if (type === 'feature') {
      updated = updateFeature(currentProject.id, number, { status });
    }

    if (!updated) {
      res.status(404).json({ error: 'Item not found' });
      return;
    }

    // Auto-commit to git
    debouncedSync(currentProject.id, `${type}-${number}: ${status}`);

    res.json(updated);
  });

  // API: Update bug status/owner
  app.patch('/api/bugs/:number', (req: Request, res: Response) => {
    const numberParam = req.params.number as string;
    const number = parseInt(numberParam, 10);
    const { status, owner } = req.body;

    // Get current bug to access doc_path
    const currentBug = getBugsByProject(currentProject.id).find(b => b.number === number);
    if (!currentBug) {
      res.status(404).json({ error: 'Bug not found' });
      return;
    }

    const updates: Partial<Bug> = {};
    if (status) updates.status = status;
    if (owner !== undefined) updates.owner = owner;

    // If status is changing and we have a doc_path, update the file
    if (status && currentBug.doc_path) {
      const newDocPath = updateFileStatus(currentProject.id, currentBug.doc_path, status, 'bug');
      if (newDocPath !== currentBug.doc_path) {
        updates.doc_path = newDocPath;
      }
    }

    const updated = updateBug(currentProject.id, number, updates);
    if (updated) {
      // Auto-commit to git
      const changeDesc = status
        ? `bug-${number}: ${status}`
        : `bug-${number}: updated`;
      debouncedSync(currentProject.id, changeDesc);
      res.json(updated);
    } else {
      res.status(404).json({ error: 'Bug not found' });
    }
  });

  // API: Update improvement status/owner
  app.patch('/api/improvements/:number', (req: Request, res: Response) => {
    const numberParam = req.params.number as string;
    const number = parseInt(numberParam, 10);
    const { status, owner } = req.body;

    // Get current improvement to access doc_path
    const currentImprovement = getImprovementsByProject(currentProject.id).find(i => i.number === number);
    if (!currentImprovement) {
      res.status(404).json({ error: 'Improvement not found' });
      return;
    }

    const updates: Partial<Improvement> = {};
    if (status) updates.status = status;
    if (owner !== undefined) updates.owner = owner;

    // If status is changing and we have a doc_path, update the file
    if (status && currentImprovement.doc_path) {
      const newDocPath = updateFileStatus(currentProject.id, currentImprovement.doc_path, status, 'improvement');
      if (newDocPath !== currentImprovement.doc_path) {
        updates.doc_path = newDocPath;
      }
    }

    const updated = updateImprovement(currentProject.id, number, updates);
    if (updated) {
      // Auto-commit to git
      const changeDesc = status
        ? `improvement-${number}: ${status}`
        : `improvement-${number}: updated`;
      debouncedSync(currentProject.id, changeDesc);
      res.json(updated);
    } else {
      res.status(404).json({ error: 'Improvement not found' });
    }
  });

  // API: Update feature status
  app.patch('/api/features/:number', (req: Request, res: Response) => {
    const numberParam = req.params.number as string;
    const number = parseInt(numberParam, 10);
    const { status } = req.body;

    if (!status) {
      res.status(400).json({ error: 'Status is required' });
      return;
    }

    const feature = updateFeature(currentProject.id, number, { status });
    if (!feature) {
      res.status(404).json({ error: 'Feature not found' });
      return;
    }

    // Auto-commit to git
    debouncedSync(currentProject.id, `feature-${number}: ${status}`);
    res.json(feature);
  });

  // API: Add to inbox
  app.post('/api/inbox', (req: Request, res: Response) => {
    const { description, type, priority } = req.body;

    if (!description) {
      res.status(400).json({ error: 'Description is required' });
      return;
    }

    const item = addToInbox({
      project_id: currentProject.id,
      description,
      type: type || 'feature',
      priority: priority || 'medium',
    });

    res.status(201).json(item);
  });

  // API: Create bug directly (with markdown file)
  app.post('/api/bugs', (req: Request, res: Response) => {
    const { title, description, priority } = req.body;

    if (!title) {
      res.status(400).json({ error: 'Title is required' });
      return;
    }

    const number = getNextBugNumber(currentProject.id);
    const slug = generateSlug(title);

    // Create the markdown file
    const docPath = createBugFile({
      projectId: currentProject.id,
      number,
      slug,
      title,
      priority: priority || 'medium',
      description,
    });

    const bug = createBug({
      project_id: currentProject.id,
      number,
      slug,
      title,
      priority: priority || 'medium',
      status: 'active',
      owner: undefined,
      blocked_by: undefined,
      source_inbox_id: undefined,
      doc_path: docPath,
    });

    // Auto-commit to git
    debouncedSync(currentProject.id, `Created bug-${number}: ${title}`);

    res.status(201).json(bug);
  });

  // API: Create improvement directly (with markdown file)
  app.post('/api/improvements', (req: Request, res: Response) => {
    const { title, description, priority, linkedFeature } = req.body;

    if (!title) {
      res.status(400).json({ error: 'Title is required' });
      return;
    }

    const number = getNextImprovementNumber(currentProject.id);
    const slug = generateSlug(title);

    // Create the markdown file
    const docPath = createImprovementFile({
      projectId: currentProject.id,
      number,
      slug,
      title,
      priority: priority || 'medium',
      description,
      linkedFeature,
    });

    const improvement = createImprovement({
      project_id: currentProject.id,
      number,
      slug,
      title,
      priority: priority || 'medium',
      status: 'active',
      owner: undefined,
      blocked_by: undefined,
      linked_feature: linkedFeature,
      source_inbox_id: undefined,
      doc_path: docPath,
    });

    // Auto-commit to git
    debouncedSync(currentProject.id, `Created improvement-${number}: ${title}`);

    res.status(201).json(improvement);
  });

  // API: Get single inbox item
  app.get('/api/inbox/:id', (req: Request, res: Response) => {
    const id = parseInt(req.params.id as string, 10);
    const item = getInboxItem(id);

    if (item) {
      res.json(item);
    } else {
      res.status(404).json({ error: 'Inbox item not found' });
    }
  });

  // API: Delete inbox item
  app.delete('/api/inbox/:id', (req: Request, res: Response) => {
    const id = parseInt(req.params.id as string, 10);
    removeFromInbox(id);
    res.json({ success: true });
  });

  // API: Convert inbox item to bug or improvement
  app.post('/api/inbox/:id/convert', (req: Request, res: Response) => {
    const id = parseInt(req.params.id as string, 10);
    const item = getInboxItem(id);

    if (!item) {
      res.status(404).json({ error: 'Inbox item not found' });
      return;
    }

    const { title, priority, targetType } = req.body;
    const finalTitle = title || item.description.slice(0, 100);
    const finalPriority = priority || item.priority || 'medium';
    // Allow override of type via targetType parameter
    const convertType = targetType || item.type;

    // Generate slug from title
    const slug = finalTitle
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 50);

    try {
      if (convertType === 'bug') {
        const number = getNextBugNumber(currentProject.id);

        // Create the markdown file
        const docPath = createBugFile({
          projectId: currentProject.id,
          number,
          slug,
          title: finalTitle,
          priority: finalPriority,
          description: item.description,
        });

        const bug = createBug({
          project_id: currentProject.id,
          number,
          slug,
          title: finalTitle,
          priority: finalPriority,
          status: 'active',
          owner: undefined,
          blocked_by: undefined,
          source_inbox_id: id,
          doc_path: docPath,
        });

        // Remove from inbox after successful conversion
        removeFromInbox(id);

        // Auto-commit to git
        debouncedSync(currentProject.id, `Created bug-${number}: ${finalTitle}`);

        res.json({ success: true, type: 'bug', item: bug });
      } else if (convertType === 'improvement') {
        const number = getNextImprovementNumber(currentProject.id);

        // Create the markdown file
        const docPath = createImprovementFile({
          projectId: currentProject.id,
          number,
          slug,
          title: finalTitle,
          priority: finalPriority,
          description: item.description,
        });

        const improvement = createImprovement({
          project_id: currentProject.id,
          number,
          slug,
          title: finalTitle,
          priority: finalPriority,
          status: 'active',
          owner: undefined,
          blocked_by: undefined,
          linked_feature: undefined,
          source_inbox_id: id,
          doc_path: docPath,
        });

        // Remove from inbox after successful conversion
        removeFromInbox(id);

        // Auto-commit to git
        debouncedSync(currentProject.id, `Created improvement-${number}: ${finalTitle}`);

        res.json({ success: true, type: 'improvement', item: improvement });
      } else {
        // Features stay in inbox until properly planned
        res.status(400).json({ error: 'Features must be planned via /plan command, not converted directly' });
      }
    } catch (err) {
      console.error('Failed to convert inbox item:', err);
      res.status(500).json({ error: 'Failed to convert inbox item' });
    }
  });

  // ============================================
  // Terminal Management APIs
  // ============================================

  // API: List all terminals
  app.get('/api/terminals', (_req: Request, res: Response) => {
    const terminals = terminalManager.list();
    res.json({ terminals });
  });

  // API: Create a new terminal
  app.post('/api/terminals', (req: Request, res: Response) => {
    const { cwd, name, command, args, useTmux, tmuxSessionName } = req.body as CreateTerminalOptions & { command?: string; args?: string[] };

    // Default to project path if no cwd provided
    const targetCwd = cwd || currentProject.path;

    // Validate cwd exists
    if (!existsSync(targetCwd)) {
      res.status(400).json({ error: `Directory does not exist: ${targetCwd}` });
      return;
    }

    try {
      // Load project environment variables (from .env, .env.local, etc.)
      // SECURITY: These are loaded but NEVER sent to the frontend or logged
      const projectEnv = loadProjectEnv(currentProject.path);
      if (projectEnv.sources.length > 0) {
        console.log(`[Server] Loaded env from: ${projectEnv.sources.length} files`);
      }

      const terminal = terminalManager.create({
        cwd: targetCwd,
        name,
        command,
        args,
        env: projectEnv.env, // Pass project env vars to terminal
        useTmux: useTmux !== false, // Default to true (use tmux if available)
        tmuxSessionName,
      });

      res.status(201).json({
        terminalId: terminal.id,
        name: terminal.name,
        cwd: terminal.cwd,
        pid: terminal.pid,
        tmuxSession: terminal.tmuxSession,
      });
    } catch (err) {
      console.error('Failed to create terminal:', err);
      res.status(500).json({ error: 'Failed to create terminal' });
    }
  });

  // API: List persisted tmux sessions (for reconnection)
  // NOTE: This route MUST be defined BEFORE /api/terminals/:id to avoid matching "persisted" as an :id
  app.get('/api/terminals/persisted', (_req: Request, res: Response) => {
    try {
      const tmuxAvailable = terminalManager.isTmuxAvailable();
      if (!tmuxAvailable) {
        res.json({
          available: false,
          sessions: [],
          message: 'tmux not available on this system',
        });
        return;
      }

      const sessions = terminalManager.listTmuxSessions();
      res.json({
        available: true,
        sessions,
      });
    } catch (err) {
      console.error('Failed to list persisted sessions:', err);
      res.status(500).json({ error: 'Failed to list persisted sessions' });
    }
  });

  // API: Reconnect to a persisted tmux session
  // NOTE: This route MUST be defined BEFORE /api/terminals/:id to avoid matching "reconnect" as an :id
  app.post('/api/terminals/reconnect', (req: Request, res: Response) => {
    const { sessionName, cwd } = req.body;

    if (!sessionName) {
      res.status(400).json({ error: 'sessionName is required' });
      return;
    }

    // Default to project path if no cwd provided
    const targetCwd = cwd || currentProject.path;

    if (!existsSync(targetCwd)) {
      res.status(400).json({ error: `Directory does not exist: ${targetCwd}` });
      return;
    }

    try {
      // Load project environment variables
      const projectEnv = loadProjectEnv(currentProject.path);

      const terminal = terminalManager.reconnect(sessionName, targetCwd, projectEnv.env);

      if (!terminal) {
        res.status(404).json({
          error: 'Session not found or cannot reconnect',
          sessionName,
        });
        return;
      }

      res.status(200).json({
        terminalId: terminal.id,
        name: terminal.name,
        cwd: terminal.cwd,
        pid: terminal.pid,
        tmuxSession: terminal.tmuxSession,
        reconnected: true,
      });
    } catch (err) {
      console.error('Failed to reconnect to session:', err);
      res.status(500).json({ error: 'Failed to reconnect to session' });
    }
  });

  // API: Get terminal info
  app.get('/api/terminals/:id', (req: Request, res: Response) => {
    const terminalId = req.params.id as string;
    const terminal = terminalManager.get(terminalId);

    if (!terminal) {
      res.status(404).json({ error: 'Terminal not found' });
      return;
    }

    res.json({
      id: terminal.id,
      name: terminal.name,
      cwd: terminal.cwd,
      status: terminal.status,
      pid: terminal.pid,
      createdAt: terminal.createdAt.toISOString(),
      lastActivity: terminal.lastActivity.toISOString(),
    });
  });

  // API: Rename terminal
  app.patch('/api/terminals/:id', (req: Request, res: Response) => {
    const terminalId = req.params.id as string;
    const { name } = req.body;

    if (name) {
      const success = terminalManager.rename(terminalId, name);
      if (!success) {
        res.status(404).json({ error: 'Terminal not found' });
        return;
      }
    }

    const terminal = terminalManager.get(terminalId);
    res.json({
      id: terminal?.id,
      name: terminal?.name,
    });
  });

  // API: Close terminal
  app.delete('/api/terminals/:id', (req: Request, res: Response) => {
    const terminalId = req.params.id as string;

    console.log(`[Server] DELETE /api/terminals/${terminalId} - closing terminal`);

    // Get terminal info before closing for response
    const terminal = terminalManager.get(terminalId);
    const tmuxSession = terminal?.tmuxSession;

    const success = terminalManager.close(terminalId);

    if (!success) {
      console.log(`[Server] Terminal ${terminalId} not found`);
      res.status(404).json({ error: 'Terminal not found' });
      return;
    }

    console.log(`[Server] Terminal ${terminalId} closed successfully`);
    res.json({
      success: true,
      terminalId,
      tmuxSessionKilled: tmuxSession || null,
    });
  });

  // API: Kill tmux session directly (fallback for when terminal close fails)
  app.post('/api/terminals/kill-tmux', (req: Request, res: Response) => {
    const { sessionName } = req.body;

    if (!sessionName) {
      res.status(400).json({ error: 'sessionName is required' });
      return;
    }

    console.log(`[Server] POST /api/terminals/kill-tmux - killing tmux session: ${sessionName}`);

    try {
      terminalManager.killTmuxSession(sessionName);
      console.log(`[Server] tmux session ${sessionName} killed successfully`);
      res.json({
        success: true,
        sessionName,
        message: `tmux session ${sessionName} killed`,
      });
    } catch (error) {
      console.error(`[Server] Failed to kill tmux session ${sessionName}:`, error);
      res.status(500).json({
        error: 'Failed to kill tmux session',
        details: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // API: Write to terminal (for non-WebSocket usage)
  app.post('/api/terminals/:id/write', (req: Request, res: Response) => {
    const terminalId = req.params.id as string;
    const { data } = req.body;

    if (!data) {
      res.status(400).json({ error: 'data is required' });
      return;
    }

    const success = terminalManager.write(terminalId, data);

    if (!success) {
      res.status(404).json({ error: 'Terminal not found or closed' });
      return;
    }

    res.json({ success: true });
  });

  // API: Resize terminal
  app.post('/api/terminals/:id/resize', (req: Request, res: Response) => {
    const terminalId = req.params.id as string;
    const { cols, rows } = req.body;

    if (!cols || !rows) {
      res.status(400).json({ error: 'cols and rows are required' });
      return;
    }

    const success = terminalManager.resize(terminalId, cols, rows);

    if (!success) {
      res.status(404).json({ error: 'Terminal not found or closed' });
      return;
    }

    res.json({ success: true });
  });

  // API: Get recent terminal output for preview
  app.get('/api/terminals/:id/preview', (req: Request, res: Response) => {
    const terminalId = req.params.id as string;
    const maxLines = parseInt(req.query.lines as string) || 5;

    const lines = terminalManager.getRecentOutput(terminalId, maxLines);

    if (lines.length === 0) {
      // Could be a valid terminal with no output yet, or terminal not found
      const terminal = terminalManager.get(terminalId);
      if (!terminal) {
        res.status(404).json({ error: 'Terminal not found' });
        return;
      }
    }

    res.json({
      terminalId,
      lines,
      timestamp: new Date().toISOString(),
    });
  });

  // API: Detach from terminal (preserve tmux session for later reconnect)
  app.post('/api/terminals/:id/detach', (req: Request, res: Response) => {
    const terminalId = req.params.id as string;
    const terminal = terminalManager.get(terminalId);

    if (!terminal) {
      res.status(404).json({ error: 'Terminal not found' });
      return;
    }

    if (!terminal.tmuxSession) {
      res.status(400).json({
        error: 'Terminal does not have a tmux session, cannot detach',
        hint: 'Use DELETE /api/terminals/:id to close instead',
      });
      return;
    }

    const success = terminalManager.detach(terminalId);

    if (!success) {
      res.status(500).json({ error: 'Failed to detach terminal' });
      return;
    }

    res.json({
      success: true,
      tmuxSession: terminal.tmuxSession,
      message: 'Terminal detached. tmux session preserved for reconnection.',
    });
  });

  // ============================================
  // iTerm2 Integration APIs
  // ============================================

  // API: Open or focus iTerm tab
  app.post('/api/iterm/open', (req: Request, res: Response) => {
    const { sessionName, workingDir, command, tty } = req.body;

    if (!sessionName) {
      res.status(400).json({ error: 'sessionName is required' });
      return;
    }

    const dir = workingDir || currentProject.path;
    const baseCmd = command || 'claude --dangerously-skip-permissions';
    // Prepend escape sequence to set iTerm tab title, then run command
    // \x1b]0;TITLE\x07 sets both window and tab title
    // \x1b]1;TITLE\x07 sets just tab title (icon name)
    const cmd = `printf '\\e]1;${sessionName}\\a' && ${baseCmd}`;

    try {
      // If TTY is provided, try to focus by TTY first (more reliable)
      if (tty) {
        const focusByTtyScript = `
          tell application "iTerm2"
            activate
            set targetTTY to "${tty}"

            repeat with winIndex from 1 to count of windows
              set w to window winIndex
              repeat with tabIndex from 1 to count of tabs of w
                set t to tab tabIndex of w
                try
                  set sess to current session of t
                  set sessTTY to tty of sess
                  if sessTTY is targetTTY then
                    set index of w to 1
                    select t
                    activate
                    return "focused:" & (name of sess)
                  end if
                end try
              end repeat
            end repeat

            return "not_found"
          end tell
        `;

        const ttyFocusResult = execSync(`osascript -e '${focusByTtyScript.replace(/'/g, "'\"'\"'")}'`, {
          encoding: 'utf-8',
          timeout: 5000,
        }).trim();

        if (ttyFocusResult.startsWith('focused:')) {
          const foundName = ttyFocusResult.substring(8);
          res.json({ success: true, focused: true, message: `Focused existing tab: ${foundName}` });
          return;
        }
      }

      // Focus existing tab by session name - check multiple properties:
      // 1. Session name (set programmatically when tab created)
      // 2. Session variable "user.session_name" (custom variable we set)
      // 3. Window title (may be changed by shell/process)
      // 4. Tab title (iTerm's tab label)
      const focusScript = `
        tell application "iTerm2"
          activate
          set targetName to "${sessionName}"

          -- Search through all windows and tabs
          repeat with winIndex from 1 to count of windows
            set w to window winIndex
            repeat with tabIndex from 1 to count of tabs of w
              set t to tab tabIndex of w
              try
                set sess to current session of t
                set sessName to name of sess

                -- Check session name (our primary identifier)
                if sessName contains targetName then
                  -- Focus the window first
                  set index of w to 1
                  -- Then select the tab
                  select t
                  -- Bring iTerm to front
                  activate
                  return "focused:" & sessName
                end if

                -- Also check the tty path which might contain our identifier
                -- This helps when session name gets overwritten by shell
                try
                  set ttyPath to tty of sess
                  if ttyPath contains targetName then
                    set index of w to 1
                    select t
                    activate
                    return "focused:" & sessName
                  end if
                end try
              end try
            end repeat
          end repeat

          return "not_found"
        end tell
      `;

      const focusResult = execSync(`osascript -e '${focusScript.replace(/'/g, "'\"'\"'")}'`, {
        encoding: 'utf-8',
        timeout: 5000,
      }).trim();

      if (focusResult.startsWith('focused:')) {
        const foundName = focusResult.substring(8);
        res.json({ success: true, focused: true, message: `Focused existing tab: ${foundName}` });
        return;
      }

      // Tab not found, create a new one
      // Use both session name AND a custom variable for reliable detection
      const createScript = `
        tell application "iTerm2"
          activate
          if (count of windows) = 0 then
            create window with default profile
          end if
          tell current window
            create tab with default profile
            tell current session
              -- Set the session name (primary identifier)
              set name to "${sessionName}"
              -- Set a custom variable for backup identification
              set variable named "user.spellbook_session" to "${sessionName}"
              -- Navigate and run command
              write text "cd '${dir}' && ${cmd}"
            end tell
          end tell
        end tell
      `;

      execSync(`osascript -e '${createScript.replace(/'/g, "'\"'\"'")}'`, {
        encoding: 'utf-8',
        timeout: 5000,
      });

      // Schedule a delayed rename to override any title changes from Claude
      // This runs after Claude has started and potentially changed the title
      setTimeout(() => {
        try {
          const renameScript = `
            tell application "iTerm2"
              repeat with w in windows
                repeat with t in tabs of w
                  try
                    set sess to current session of t
                    -- Check if this is our session by the custom variable
                    set spellbookSession to variable named "user.spellbook_session" of sess
                    if spellbookSession is "${sessionName}" then
                      set name of sess to "${sessionName}"
                      return "renamed"
                    end if
                  end try
                end repeat
              end repeat
              return "not_found"
            end tell
          `;
          execSync(`osascript -e '${renameScript.replace(/'/g, "'\"'\"'")}'`, {
            encoding: 'utf-8',
            timeout: 3000,
          });
        } catch (err) {
          console.warn('[iTerm] Delayed rename failed:', err);
        }
      }, 2000); // 2 second delay to let Claude start

      res.json({ success: true, focused: false, message: `Created new tab: ${sessionName}` });
    } catch (err: any) {
      console.error('[iTerm] Failed to open/focus:', err);
      res.status(500).json({ error: `iTerm error: ${err.message}` });
    }
  });

  // API: List ALL iTerm sessions and detect which ones have Claude running
  app.get('/api/iterm/sessions', (_req: Request, res: Response) => {
    try {
      // Get ALL iTerm sessions with their names and TTYs
      const listScript = `
        tell application "iTerm2"
          set output to ""
          repeat with w in windows
            repeat with t in tabs of w
              try
                set sess to current session of t
                set sessName to name of sess
                set sessTTY to tty of sess
                set output to output & sessName & "|" & sessTTY & linefeed
              end try
            end repeat
          end repeat
          return output
        end tell
      `;

      const result = execSync(`osascript -e '${listScript.replace(/'/g, "'\"'\"'")}'`, {
        encoding: 'utf-8',
        timeout: 5000,
      }).trim();

      // Parse the output into session objects
      const lines = result.split('\n').filter(Boolean);
      const sessions: Array<{
        name: string;
        tty: string;
        hasClaude: boolean;
        matchedItem: string | null;
      }> = [];

      for (const line of lines) {
        const [name, tty] = line.split('|');
        if (!name || !tty) continue;

        // Check if Claude is running on this TTY
        // iTerm returns "/dev/ttys006" but ps needs "ttys006"
        const ttyName = tty.replace('/dev/', '');
        let hasClaude = false;
        try {
          const psResult = execSync(`ps -t ${ttyName} -o comm 2>/dev/null | grep -q claude && echo "yes" || echo "no"`, {
            encoding: 'utf-8',
            timeout: 2000,
          }).trim();
          hasClaude = psResult === 'yes';
        } catch {
          // ps command failed, assume no Claude
          hasClaude = false;
        }

        // Try to match session name to a work item using flexible patterns
        const matchedItem = extractWorkItemReference(name);

        sessions.push({
          name,
          tty,
          hasClaude,
          matchedItem,
        });
      }

      res.json({ success: true, sessions });
    } catch (err: any) {
      console.error('[iTerm] Failed to list sessions:', err);
      res.json({ success: true, sessions: [], error: err.message });
    }
  });

  // Helper: Extract work item reference from session name using flexible pattern matching
  function extractWorkItemReference(sessionName: string): string | null {
    // Patterns to match: "Bug 79", "bug-79", "bug_79", "bug79", etc.
    const patterns = [
      { regex: /bug[\s\-_]?(\d+)/i, prefix: 'bug' },
      { regex: /improvement[\s\-_]?(\d+)/i, prefix: 'improvement' },
      { regex: /feature[\s\-_]?(\d+)/i, prefix: 'feature' },
    ];

    for (const { regex, prefix } of patterns) {
      const match = sessionName.match(regex);
      if (match && match[1]) {
        return `${prefix}-${match[1]}`;
      }
    }

    return null;
  }

  // ============================================
  // Configuration APIs (MCP, ENV status)
  // ============================================

  // API: Get MCP servers (names only, no secrets)
  app.get('/api/config/mcp', (_req: Request, res: Response) => {
    try {
      const mcpConfig = loadMCPConfig();
      const servers = getMCPServers();

      res.json({
        configured: mcpConfig.config !== null,
        source: mcpConfig.source,
        servers: servers.map(s => ({
          name: s.name,
          // Don't expose full command which might contain paths/secrets
          type: s.command.includes('npx') ? 'npm' : s.command.includes('python') ? 'python' : 'other',
        })),
      });
    } catch (err) {
      console.error('Failed to load MCP config:', err);
      res.status(500).json({ error: 'Failed to load MCP configuration' });
    }
  });

  // API: Get environment status (NOT the actual values - security)
  app.get('/api/config/env', (_req: Request, res: Response) => {
    try {
      const envConfig = loadProjectEnv(currentProject.path);

      // SECURITY: Only return metadata, NEVER actual values
      res.json({
        loaded: envConfig.sources.length > 0,
        sources: envConfig.sources.map(s => s.replace(currentProject.path, '.')),
        variableCount: Object.keys(envConfig.env).length,
        // Only return variable names (not values) for debugging
        variables: Object.keys(envConfig.env),
        errors: envConfig.errors,
      });
    } catch (err) {
      console.error('Failed to check env config:', err);
      res.status(500).json({ error: 'Failed to check environment configuration' });
    }
  });

  // API: Check security status (gitignore coverage)
  app.get('/api/config/security', (_req: Request, res: Response) => {
    try {
      const gitignoreCheck = checkGitignoreSecurity(currentProject.path);

      res.json({
        gitignoreSecure: gitignoreCheck.isSecure,
        missingEntries: gitignoreCheck.missingEntries,
        warnings: gitignoreCheck.missingEntries.length > 0
          ? ['Some sensitive files may not be properly gitignored']
          : [],
      });
    } catch (err) {
      console.error('Failed to check security:', err);
      res.status(500).json({ error: 'Failed to check security status' });
    }
  });

  // ============================================
  // File Upload APIs
  // ============================================

  // API: Upload a file
  app.post('/api/upload', upload.single('file'), (req: Request, res: Response) => {
    if (!req.file) {
      res.status(400).json({ error: 'No file provided' });
      return;
    }

    const filePath = join(uploadDir, req.file.filename);

    res.status(201).json({
      success: true,
      path: filePath,
      filename: req.file.originalname,
      savedAs: req.file.filename,
      size: req.file.size,
      mimetype: req.file.mimetype,
    });
  });

  // API: List recent uploads
  app.get('/api/uploads', (_req: Request, res: Response) => {
    try {
      if (!existsSync(uploadDir)) {
        res.json({ uploads: [] });
        return;
      }

      const files = readdirSync(uploadDir)
        .map(filename => {
          const filePath = join(uploadDir, filename);
          const stat = statSync(filePath);
          return {
            filename,
            path: filePath,
            size: stat.size,
            createdAt: stat.birthtime.toISOString(),
            modifiedAt: stat.mtime.toISOString(),
          };
        })
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        .slice(0, 50); // Limit to 50 most recent

      res.json({ uploads: files, directory: uploadDir });
    } catch (err) {
      console.error('Failed to list uploads:', err);
      res.status(500).json({ error: 'Failed to list uploads' });
    }
  });

  // API: Delete an uploaded file
  app.delete('/api/uploads/:filename', (req: Request, res: Response) => {
    const filename = req.params.filename as string;

    if (!filename) {
      res.status(400).json({ error: 'Filename is required' });
      return;
    }

    // Security: prevent path traversal
    if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
      res.status(400).json({ error: 'Invalid filename' });
      return;
    }

    const filePath = join(uploadDir, filename);

    if (!existsSync(filePath)) {
      res.status(404).json({ error: 'File not found' });
      return;
    }

    try {
      unlinkSync(filePath);
      res.json({ success: true, deleted: filename });
    } catch (err) {
      console.error('Failed to delete file:', err);
      res.status(500).json({ error: 'Failed to delete file' });
    }
  });

  // Error handling middleware
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error('Server error:', err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

export function startServer(config: BoardConfig): Promise<{ close: () => void; url: string; server: Server }> {
  return new Promise((resolve, reject) => {
    const app = createServer(config);

    // Create HTTP server from Express app
    const server = createHttpServer(app);

    // Attach terminal manager WebSocket server
    terminalManager.attachToServer(server);

    server.listen(config.port, () => {
      const url = `http://localhost:${config.port}`;
      console.log(`[Server] HTTP server listening on ${url}`);
      console.log(`[Server] WebSocket available at ws://localhost:${config.port}/ws/terminal`);

      resolve({
        close: () => {
          console.log('[Server] Shutting down...');
          // Close all terminals first
          terminalManager.closeAll();
          // Then close HTTP server
          server.close();
        },
        url,
        server,
      });
    });

    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        reject(new Error(`Port ${config.port} is already in use`));
      } else {
        reject(err);
      }
    });
  });
}
