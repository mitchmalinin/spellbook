import { Request, Response } from 'express';
import { execSync } from 'child_process';
import type { RouteContext } from '../types.js';

export function registerGitRoutes(ctx: RouteContext): void {
  const { app } = ctx;

  // API: Get git sync status (ahead/behind origin)
  app.get('/api/git/sync-status', (req: Request, res: Response) => {
    const currentProject = ctx.getCurrentProject();
    const targetPath = (req.query.path as string) || currentProject.path;
    const branch = (req.query.branch as string) || 'develop';

    try {
      try {
        execSync(`git fetch origin ${branch}`, {
          cwd: targetPath,
          encoding: 'utf-8',
          timeout: 30000,
          stdio: 'pipe',
        });
      } catch (fetchErr) {
        console.warn('[Server] git fetch failed, using cached refs:', fetchErr instanceof Error ? fetchErr.message : fetchErr);
      }

      const revListOutput = execSync(`git rev-list --left-right --count origin/${branch}...${branch}`, {
        cwd: targetPath,
        encoding: 'utf-8',
      }).trim();

      const [behind, ahead] = revListOutput.split('\t').map(n => parseInt(n, 10) || 0);

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

  // API: Get uncommitted changes
  app.get('/api/git/uncommitted', (req: Request, res: Response) => {
    const currentProject = ctx.getCurrentProject();
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
    const currentProject = ctx.getCurrentProject();
    const targetPath = (req.query.path as string) || currentProject.path;

    try {
      try {
        execSync('git fetch origin main develop', {
          cwd: targetPath,
          encoding: 'utf-8',
          timeout: 30000,
          stdio: 'pipe',
        });
      } catch (_fetchErr) {
        console.warn('[Server] git fetch for main/develop failed, using cached refs');
      }

      const currentBranch = execSync('git rev-parse --abbrev-ref HEAD', {
        cwd: targetPath,
        encoding: 'utf-8',
      }).trim();

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
    const currentProject = ctx.getCurrentProject();
    const targetPath = (req.query.path as string) || currentProject.path;
    const branch = (req.body.branch as string) || 'develop';

    try {
      const output = execSync(`git pull origin ${branch}`, {
        cwd: targetPath,
        encoding: 'utf-8',
        timeout: 60000,
      });

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

  // API: Pull main into develop
  app.post('/api/git/pull-main', (req: Request, res: Response) => {
    const currentProject = ctx.getCurrentProject();
    const targetPath = (req.query.path as string) || currentProject.path;

    try {
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

      try {
        execSync('git fetch origin main', {
          cwd: targetPath,
          encoding: 'utf-8',
          timeout: 30000,
          stdio: 'pipe',
        });
      } catch (_fetchErr) {
        console.error('Failed to fetch origin/main:', _fetchErr);
        res.status(500).json({
          success: false,
          error: 'Failed to fetch origin/main',
          hint: 'Check your network connection or if the main branch exists on origin.',
        });
        return;
      }

      let mergeOutput: string;
      try {
        mergeOutput = execSync('git merge origin/main --no-edit', {
          cwd: targetPath,
          encoding: 'utf-8',
          timeout: 60000,
        });
      } catch (_mergeErr) {
        const mergeStatus = execSync('git status --porcelain', {
          cwd: targetPath,
          encoding: 'utf-8',
        }).trim();

        if (mergeStatus.includes('UU') || mergeStatus.includes('AA') || mergeStatus.includes('DD')) {
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

        throw _mergeErr;
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
    const currentProject = ctx.getCurrentProject();
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

  // API: Get git diff
  app.get('/api/git/diff', (req: Request, res: Response) => {
    const currentProject = ctx.getCurrentProject();
    const targetPath = (req.query.path as string) || currentProject.path;
    const base = (req.query.base as string) || 'HEAD';

    try {
      const diffStat = execSync(`git diff --stat ${base}`, {
        cwd: targetPath,
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024,
      });

      const statusOutput = execSync('git status --porcelain', {
        cwd: targetPath,
        encoding: 'utf-8',
      });

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
    const currentProject = ctx.getCurrentProject();
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
}
