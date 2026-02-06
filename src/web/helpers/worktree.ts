import { join, dirname } from 'path';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, copyFileSync, symlinkSync, lstatSync, rmSync } from 'fs';
import { execSync } from 'child_process';
import { homedir } from 'os';
import { PROJECTS_DIR } from '../../db/index.js';

// Global worktree registry path
export const WORKTREE_REGISTRY_PATH = join(homedir(), '.claude', 'worktree-registry.json');
export const WORKTREE_CONFIG_PATH = join(homedir(), '.claude', 'skills', 'worktree-manager', 'config.json');

export interface WorktreeRegistryEntry {
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

export interface WorktreeRegistry {
  worktrees: WorktreeRegistryEntry[];
  portPool: {
    start: number;
    end: number;
    allocated: number[];
  };
}

export interface WorktreeConfig {
  terminal: string;
  shell: string;
  aiTool: 'claude' | 'codex';
  claudeCommand: string;
  codexCommand: string;
  portPool: { start: number; end: number };
  portsPerWorktree: number;
  worktreeBase: string;
  defaultCopyFiles: string[];
  defaultCopyDirs: string[];
}

export function getAiCommand(config: WorktreeConfig, aiToolOverride?: string): string {
  const tool = aiToolOverride || config.aiTool || 'claude';
  if (tool === 'codex') return config.codexCommand || 'codex --full-auto';
  return config.claudeCommand || 'claude --dangerously-skip-permissions';
}

export function loadWorktreeConfig(): WorktreeConfig {
  const defaultConfig: WorktreeConfig = {
    terminal: 'iterm2',
    shell: 'zsh',
    aiTool: 'claude',
    claudeCommand: 'claude --dangerously-skip-permissions',
    codexCommand: 'codex --full-auto',
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

export function loadWorktreeRegistry(): WorktreeRegistry {
  const defaultRegistry: WorktreeRegistry = {
    worktrees: [],
    portPool: {
      start: 8100,
      end: 8199,
      allocated: [],
    },
  };

  if (!existsSync(WORKTREE_REGISTRY_PATH)) {
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

export function saveWorktreeRegistry(registry: WorktreeRegistry): void {
  const registryDir = dirname(WORKTREE_REGISTRY_PATH);
  if (!existsSync(registryDir)) {
    mkdirSync(registryDir, { recursive: true });
  }
  writeFileSync(WORKTREE_REGISTRY_PATH, JSON.stringify(registry, null, 2));
}

export function allocatePorts(count: number): number[] {
  const registry = loadWorktreeRegistry();
  const { start, end, allocated } = registry.portPool;
  const ports: number[] = [];

  for (let port = start; port <= end && ports.length < count; port++) {
    if (!allocated.includes(port)) {
      try {
        execSync(`lsof -i :${port}`, { stdio: 'pipe' });
        continue;
      } catch {
        ports.push(port);
      }
    }
  }

  if (ports.length < count) {
    throw new Error(`Could not allocate ${count} ports. Only ${ports.length} available.`);
  }

  registry.portPool.allocated = [...registry.portPool.allocated, ...ports].sort((a, b) => a - b);
  saveWorktreeRegistry(registry);

  return ports;
}

export function registerWorktreeInGlobalRegistry(entry: WorktreeRegistryEntry): void {
  const registry = loadWorktreeRegistry();
  registry.worktrees = registry.worktrees.filter(w => w.worktreePath !== entry.worktreePath);
  registry.worktrees.push(entry);
  saveWorktreeRegistry(registry);
}

export function copyDirRecursive(src: string, dest: string): void {
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

export function setupWorktree(projectPath: string, worktreePath: string, projectId: string, config: WorktreeConfig): void {
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
      if (!existsSync(worktreeDocsPath)) {
        mkdirSync(worktreeDocsPath, { recursive: true });
      }

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

      symlinkSync(centralKnowledgePath, worktreeKnowledgePath);
      console.log(`[Worktree] Created symlink: docs/knowledge -> ${centralKnowledgePath}`);
    } catch (err) {
      console.warn(`[Worktree] Failed to create knowledge symlink:`, err);
    }
  }
}

export function detectInstallCommand(worktreePath: string): string | null {
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

export function generateWorktreeId(): string {
  return `wt-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}
