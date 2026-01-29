import { existsSync, readFileSync } from 'fs';
import { join, basename, dirname } from 'path';
import { execSync } from 'child_process';
import yaml from 'yaml';
import { getProject, Project } from '../db/index.js';

export interface SpellbookConfig {
  project: {
    id: string;
    name: string;
  };
  settings?: {
    templates?: string;
    knowledge_folder?: string;
    auto_generate?: boolean;
    show_resolved?: boolean;
  };
}

export function findProjectRoot(startPath: string = process.cwd()): string | null {
  let current = startPath;
  while (current !== '/') {
    // Check for .spellbook.yaml
    if (existsSync(join(current, '.spellbook.yaml'))) {
      return current;
    }
    // Check for .git as fallback
    if (existsSync(join(current, '.git'))) {
      return current;
    }
    current = dirname(current);
  }
  return null;
}

export function getProjectConfig(projectPath: string): SpellbookConfig | null {
  const configPath = join(projectPath, '.spellbook.yaml');
  if (!existsSync(configPath)) {
    return null;
  }
  const content = readFileSync(configPath, 'utf-8');
  return yaml.parse(content) as SpellbookConfig;
}

export function getCurrentProject(): { project: Project; config: SpellbookConfig } | null {
  const projectPath = findProjectRoot();
  if (!projectPath) return null;

  const config = getProjectConfig(projectPath);
  if (!config) return null;

  // Use project ID from config - this allows worktrees to work
  // since they have the same .spellbook.yaml but different paths
  const project = getProject(config.project.id);
  if (!project) return null;

  return { project, config };
}

export function generateProjectId(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export function generateSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 40);
}

export function isGitRepo(path: string): boolean {
  return existsSync(join(path, '.git'));
}

export function getGitBranch(path: string): string | null {
  try {
    const result = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: path,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return result.trim();
  } catch {
    return null;
  }
}

export function getGitRoot(path: string): string | null {
  try {
    const result = execSync('git rev-parse --show-toplevel', {
      cwd: path,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return result.trim();
  } catch {
    return null;
  }
}

export function isWorktree(path: string): boolean {
  try {
    const gitDir = join(path, '.git');
    if (!existsSync(gitDir)) return false;
    const stat = readFileSync(gitDir, 'utf-8');
    return stat.startsWith('gitdir:');
  } catch {
    return false;
  }
}

export function getWorktreeList(projectPath: string): Array<{ path: string; branch: string }> {
  try {
    const result = execSync('git worktree list --porcelain', {
      cwd: projectPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const worktrees: Array<{ path: string; branch: string }> = [];
    let current: { path?: string; branch?: string } = {};

    for (const line of result.split('\n')) {
      if (line.startsWith('worktree ')) {
        if (current.path) {
          worktrees.push({ path: current.path, branch: current.branch || '' });
        }
        current = { path: line.slice(9) };
      } else if (line.startsWith('branch ')) {
        current.branch = line.slice(7).replace('refs/heads/', '');
      }
    }
    if (current.path) {
      worktrees.push({ path: current.path, branch: current.branch || '' });
    }
    return worktrees;
  } catch {
    return [];
  }
}

export function getProjectName(path: string): string {
  // Try to get from package.json
  const pkgPath = join(path, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      if (pkg.name) return pkg.name;
    } catch {
      // Fall through
    }
  }
  // Use directory name
  return basename(path);
}
