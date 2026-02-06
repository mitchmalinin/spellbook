import { Request, Response } from 'express';
import { join, dirname } from 'path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';
import { homedir } from 'os';
import { getWorktreesByProject, updateWorktree } from '../../db/index.js';
import { escapeAppleScript } from '../helpers/applescript.js';
import {
  loadWorktreeConfig,
  loadWorktreeRegistry,
  saveWorktreeRegistry,
  allocatePorts,
  registerWorktreeInGlobalRegistry,
  setupWorktree,
  detectInstallCommand,
  generateWorktreeId,
  getAiCommand,
  WorktreeRegistryEntry,
} from '../helpers/worktree.js';
import type { RouteContext } from '../types.js';
import type { WorktreeConfig } from '../helpers/worktree.js';

/**
 * Launch a terminal (iTerm2 or Ghostty) with an AI agent at the given worktree path.
 * Updates the global registry with the launch timestamp on success.
 */
function launchTerminalWithAgent(
  wtConfig: WorktreeConfig,
  worktreePath: string,
  aiTool?: string,
): boolean {
  const terminal = wtConfig.terminal || 'iterm2';
  const claudeCmd = getAiCommand(wtConfig, aiTool);

  if (terminal === 'iterm2') {
    execSync(`osascript -e 'tell application "iTerm2" to activate' -e 'tell application "iTerm2" to create window with default profile' -e 'tell application "iTerm2" to tell current session of current window to write text "cd \\"${worktreePath}\\" && ${claudeCmd}"'`, {
      stdio: 'pipe',
    });
    return true;
  }

  if (terminal === 'ghostty') {
    const safeWorktreePath = worktreePath.replace(/'/g, "'\\''");
    const safeClaudeCmd = claudeCmd.replace(/'/g, "'\\''");
    const sessionTitle = worktreePath.split('/').slice(-2).join('/');
    execSync(`open -na "Ghostty.app" --args --working-directory='${safeWorktreePath}' --title='${sessionTitle}' -e /bin/zsh -c '${safeClaudeCmd}; exec /bin/zsh -l -i'`, {
      stdio: 'pipe',
    });

    const registry = loadWorktreeRegistry();
    const entry = registry.worktrees.find(w => w.worktreePath === worktreePath);
    if (entry) {
      entry.agentLaunchedAt = new Date().toISOString();
      saveWorktreeRegistry(registry);
    }
    return true;
  }

  return false;
}

export function registerWorktreeRoutes(ctx: RouteContext): void {
  const { app } = ctx;

  // API: Get worktrees for current project
  app.get('/api/worktrees', (_req: Request, res: Response) => {
    const currentProject = ctx.getCurrentProject();
    try {
      const output = execSync('git worktree list --porcelain', {
        cwd: currentProject.path,
        encoding: 'utf-8',
      });

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
            worktrees.push(current as typeof worktrees[number]);
          }
          current = { path: line.slice(9), bare: false };
        } else if (line.startsWith('HEAD ')) {
          current.commit = line.slice(5);
        } else if (line.startsWith('branch ')) {
          current.branch = line.slice(7).replace('refs/heads/', '');
        } else if (line === 'bare') {
          current.bare = true;
        } else if (line === '' && current.path) {
          worktrees.push(current as typeof worktrees[number]);
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
    const { itemRef, branchName, task, installDeps = true, launchTerminal = true, aiTool } = req.body;
    const currentProject = ctx.getCurrentProject();

    if (!itemRef) {
      res.status(400).json({ error: 'itemRef is required (e.g., bug-44, improvement-31)' });
      return;
    }

    try {
      const match = itemRef.match(/^(bug|improvement|feature)-(\d+)$/);
      if (!match) {
        res.status(400).json({ error: 'Invalid itemRef format. Use: bug-44, improvement-31, or feature-5' });
        return;
      }

      const [, type, numStr] = match;
      const number = parseInt(numStr, 10);

      const wtConfig = loadWorktreeConfig();

      const worktreeBase = join(homedir(), 'tmp', 'worktrees', currentProject.id);
      const worktreePath = join(worktreeBase, `${type}-${number}`);

      const finalBranchName = branchName || `${type === 'bug' ? 'fix' : type}/${number}`;
      const branchSlug = finalBranchName.replace(/\//g, '-');

      if (existsSync(worktreePath)) {
        res.status(409).json({
          error: 'Worktree already exists',
          path: worktreePath,
          message: 'A worktree already exists at this path. Use the existing worktree or delete it first.',
        });
        return;
      }

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
      }

      // Step 2: Create the git worktree
      try {
        try {
          execSync('git fetch origin develop', { cwd: currentProject.path, stdio: 'pipe' });
        } catch (fetchErr) {
          console.warn('[Worktree] Could not fetch origin/develop:', fetchErr);
        }

        execSync(`git worktree add -b "${finalBranchName}" "${worktreePath}" origin/develop`, {
          cwd: currentProject.path,
          stdio: 'pipe',
        });
      } catch (_gitErr) {
        try {
          execSync(`git worktree add "${worktreePath}" "${finalBranchName}"`, {
            cwd: currentProject.path,
            stdio: 'pipe',
          });
        } catch (gitErr2) {
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

      // Step 4: Install dependencies
      let installError = '';
      if (installDeps) {
        const installCmd = detectInstallCommand(worktreePath);
        if (installCmd) {
          console.log(`[Worktree] Running: ${installCmd}`);
          try {
            execSync(installCmd, {
              cwd: worktreePath,
              encoding: 'utf-8',
              timeout: 300000,
              stdio: 'pipe',
            });
            console.log(`[Worktree] Dependencies installed successfully`);
          } catch (installErr) {
            installError = installErr instanceof Error ? installErr.message : String(installErr);
            console.warn(`[Worktree] Dependency installation failed:`, installError);
          }
        }
      }

      // Step 5: Register in Spellbook database
      const { createWorktree: dbCreateWorktree } = await import('../../db/index.js');
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

      // Step 7: Launch terminal with Claude agent
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

            const registry = loadWorktreeRegistry();
            const entry = registry.worktrees.find(w => w.worktreePath === worktreePath);
            if (entry) {
              entry.agentLaunchedAt = new Date().toISOString();
              saveWorktreeRegistry(registry);
            }
          } catch (_launchErr) {
            console.warn(`[Worktree] Failed to launch via script:`, _launchErr);
            try {
              terminalLaunched = launchTerminalWithAgent(wtConfig, worktreePath, aiTool);
            } catch (fallbackErr) {
              console.warn(`[Worktree] Terminal launch fallback failed:`, fallbackErr);
            }
          }
        } else {
          try {
            terminalLaunched = launchTerminalWithAgent(wtConfig, worktreePath, aiTool);
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
    const currentProject = ctx.getCurrentProject();

    if (!worktreePath || worktreePath === '/') {
      res.status(400).json({ error: 'Worktree path is required' });
      return;
    }

    try {
      const dbWorktrees = getWorktreesByProject(currentProject.id);
      const worktree = dbWorktrees.find(w => w.path === worktreePath);

      if (worktreePath === currentProject.path) {
        res.status(400).json({ error: 'Cannot remove the main repository' });
        return;
      }

      // Step 0: Kill associated iTerm sessions
      if (worktree?.working_on) {
        try {
          const itemRef = worktree.working_on;
          const safeItemRef = escapeAppleScript(itemRef);
          const safeItemRefSpaced = escapeAppleScript(itemRef.replace('-', ' '));
          const closeItermScript = `
            tell application "iTerm2"
              repeat with w in windows
                repeat with t in tabs of w
                  try
                    set sess to current session of t
                    set sessName to name of sess
                    if sessName contains "${safeItemRef}" or sessName contains "${safeItemRefSpaced}" then
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

      // Step 1: Kill any processes on ports
      try {
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
      } catch (_gitErr) {
        console.warn('[Server] git worktree remove failed, trying manual cleanup:', _gitErr);
        try {
          if (existsSync(worktreePath)) {
            execSync(`rm -rf "${worktreePath}"`, { stdio: 'pipe' });
          }
          execSync('git worktree prune', {
            cwd: currentProject.path,
            stdio: 'pipe',
          });
        } catch (manualErr) {
          console.error('[Server] Manual cleanup failed:', manualErr);
        }
      }

      // Step 3: Update database status
      if (worktree) {
        try {
          updateWorktree(worktreePath, { status: 'abandoned' });
          console.log(`[Server] Updated worktree status to abandoned: ${worktreePath}`);
        } catch (dbErr) {
          console.warn('[Server] Failed to update worktree in database:', dbErr);
        }
      }

      // Step 4: Clean up global worktree registry
      const registryPath = join(homedir(), '.claude', 'worktree-registry.json');
      if (existsSync(registryPath)) {
        try {
          const registry = JSON.parse(readFileSync(registryPath, 'utf-8'));
          if (registry.worktrees && Array.isArray(registry.worktrees)) {
            const entryIndex = registry.worktrees.findIndex((w: { worktreePath: string }) => w.worktreePath === worktreePath);
            if (entryIndex !== -1) {
              const entry = registry.worktrees[entryIndex];
              if (entry.ports && registry.portPool?.allocated) {
                registry.portPool.allocated = registry.portPool.allocated.filter(
                  (p: number) => !entry.ports.includes(p)
                );
              }
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
}
