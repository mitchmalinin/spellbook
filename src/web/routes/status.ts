import { Request, Response } from 'express';
import { join } from 'path';
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, statSync } from 'fs';
import { execSync } from 'child_process';
import {
  getBugsByProject,
  getImprovementsByProject,
  getFeaturesByProject,
  getInbox,
  getRecentActivity,
} from '../../db/index.js';
import type { RouteContext, StatusResponse, DashboardStats } from '../types.js';

export function registerStatusRoutes(ctx: RouteContext): void {
  const { app } = ctx;

  // API: Get terminal command for a path (legacy)
  app.post('/api/terminal/get-command', (req: Request, res: Response) => {
    const { path: targetPath } = req.body;

    if (!targetPath) {
      res.status(400).json({ error: 'path is required' });
      return;
    }

    const command = `open -a Ghostty --args --working-directory="${targetPath}"`;

    res.json({
      command,
      path: targetPath,
      instructions: `Run this command to open terminal: ${command}`,
    });
  });

  // API: Get all items for the kanban board
  app.get('/api/status', (_req: Request, res: Response) => {
    const currentProject = ctx.getCurrentProject();
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

  // API: Get workflow state
  app.get('/api/workflow-state', (_req: Request, res: Response) => {
    const currentProject = ctx.getCurrentProject();
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

  // API: Set workflow state
  app.post('/api/workflow-state', (req: Request, res: Response) => {
    const currentProject = ctx.getCurrentProject();
    const { ref, status, itemType, itemNumber } = req.body;
    const stateDir = join(currentProject.path, '.claude', 'state');
    const stateFile = join(stateDir, 'workflow.json');

    try {
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

  // API: Clear workflow state
  app.delete('/api/workflow-state', (_req: Request, res: Response) => {
    const currentProject = ctx.getCurrentProject();
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
    const currentProject = ctx.getCurrentProject();
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
    const currentProject = ctx.getCurrentProject();
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
    const currentProject = ctx.getCurrentProject();
    try {
      console.log('[Server] Regenerating roadmap for project:', currentProject.path);
      execSync('spellbook roadmap', {
        cwd: currentProject.path,
        timeout: 30000,
        encoding: 'utf-8',
      });
      console.log('[Server] Roadmap regenerated successfully');
      res.json({ success: true, message: 'Roadmap regenerated' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[Server] Failed to regenerate roadmap:', message);
      res.status(500).json({ error: 'Failed to regenerate roadmap', details: message });
    }
  });

  // API: Get project info for dashboard
  app.get('/api/project-info', (_req: Request, res: Response) => {
    const currentProject = ctx.getCurrentProject();
    const bugs = getBugsByProject(currentProject.id);
    const improvements = getImprovementsByProject(currentProject.id);
    const features = getFeaturesByProject(currentProject.id);
    const inbox = getInbox(currentProject.id);

    let techStack: { name?: string; version?: string; dependencies?: Record<string, string> } = {};
    const packageJsonPath = join(currentProject.path, 'package.json');
    if (existsSync(packageJsonPath)) {
      try {
        techStack = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
      } catch {
        // Ignore parse errors
      }
    }

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

  // API: Get recent activity
  app.get('/api/activity', (req: Request, res: Response) => {
    const currentProject = ctx.getCurrentProject();
    const limit = parseInt(req.query.limit as string) || 20;
    const activity = getRecentActivity(currentProject.id, limit);

    const bugs = getBugsByProject(currentProject.id);
    const improvements = getImprovementsByProject(currentProject.id);
    const features = getFeaturesByProject(currentProject.id);

    const bugMap = new Map(bugs.map(b => [`bug-${b.number}`, b.title]));
    const impMap = new Map(improvements.map(i => [`improvement-${i.number}`, i.title]));
    const featureMap = new Map(features.map(f => [`feature-${f.number}`, f.name]));

    const enrichedActivity = activity.map(a => ({
      ...a,
      item_title: bugMap.get(a.item_ref) || impMap.get(a.item_ref) || featureMap.get(a.item_ref) || null,
    }));

    res.json(enrichedActivity);
  });
}
