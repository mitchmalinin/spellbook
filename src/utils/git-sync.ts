import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const PROJECTS_DIR = join(homedir(), '.spellbook', 'projects');

export interface GitSyncResult {
  success: boolean;
  message: string;
  commitHash?: string;
}

/**
 * Auto-commit and push changes to the planning docs repo
 */
export function syncToGit(projectId: string, commitMessage: string): GitSyncResult {
  const projectPath = join(PROJECTS_DIR, projectId);
  const gitDir = join(projectPath, '.git');

  // Check if this project has a git repo
  if (!existsSync(gitDir)) {
    return { success: false, message: 'No git repo initialized for this project' };
  }

  try {
    // Check if there are any changes
    const status = execSync('git status --porcelain', { 
      cwd: projectPath, 
      encoding: 'utf-8' 
    }).trim();

    if (!status) {
      return { success: true, message: 'No changes to commit' };
    }

    // Stage all changes
    execSync('git add -A', { cwd: projectPath });

    // Commit
    execSync(`git commit -m "${commitMessage.replace(/"/g, '\\"')}"`, { 
      cwd: projectPath,
      encoding: 'utf-8'
    });

    // Get commit hash
    const commitHash = execSync('git rev-parse --short HEAD', { 
      cwd: projectPath, 
      encoding: 'utf-8' 
    }).trim();

    // Push (async, don't wait)
    execSync('git push origin main 2>/dev/null &', { 
      cwd: projectPath,
      shell: '/bin/bash'
    });

    console.log(`[GitSync] Committed and pushing: ${commitMessage} (${commitHash})`);
    return { success: true, message: `Committed: ${commitMessage}`, commitHash };

  } catch (err: any) {
    console.error('[GitSync] Failed:', err.message);
    return { success: false, message: err.message };
  }
}

/**
 * Debounced sync - waits for activity to settle before committing
 */
let syncTimeout: NodeJS.Timeout | null = null;
let pendingChanges: string[] = [];

export function debouncedSync(projectId: string, changeDescription: string, delayMs = 5000): void {
  pendingChanges.push(changeDescription);

  if (syncTimeout) {
    clearTimeout(syncTimeout);
  }

  syncTimeout = setTimeout(() => {
    const message = pendingChanges.length === 1
      ? pendingChanges[0]
      : `Multiple updates: ${pendingChanges.slice(0, 3).join(', ')}${pendingChanges.length > 3 ? ` (+${pendingChanges.length - 3} more)` : ''}`;
    
    syncToGit(projectId, message);
    pendingChanges = [];
    syncTimeout = null;
  }, delayMs);
}
