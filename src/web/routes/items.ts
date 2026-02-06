import { Request, Response } from 'express';
import { join, dirname } from 'path';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'fs';
import { homedir } from 'os';
import {
  getBugsByProject,
  getImprovementsByProject,
  getFeaturesByProject,
  updateBug,
  updateImprovement,
  updateFeature,
  PROJECTS_DIR,
  Bug,
  Improvement,
} from '../../db/index.js';
import { debouncedSync } from '../../utils/git-sync.js';
import { updateFileStatus } from '../../utils/file-creator.js';
import { resolvePath } from '../helpers/path.js';
import { generatePlanTemplate } from '../helpers/template.js';
import type { RouteContext } from '../types.js';

interface ItemLookupResult {
  docPath: string | null;
  slug: string | null;
}

/**
 * Look up an item's doc_path and slug by type and number.
 */
function findItemByType(
  type: string,
  number: number,
  projectId: string,
): ItemLookupResult {
  if (type === 'bug') {
    const bug = getBugsByProject(projectId).find(b => b.number === number);
    return { docPath: bug?.doc_path || null, slug: bug?.slug || null };
  }
  if (type === 'improvement') {
    const improvement = getImprovementsByProject(projectId).find(i => i.number === number);
    return { docPath: improvement?.doc_path || null, slug: improvement?.slug || null };
  }
  if (type === 'feature') {
    const feature = getFeaturesByProject(projectId).find(f => f.number === number);
    const featureSlug = feature?.name?.toLowerCase().replace(/[^a-z0-9]+/g, '-') || null;
    return { docPath: feature?.doc_path || null, slug: featureSlug };
  }
  return { docPath: null, slug: null };
}

export function registerItemRoutes(ctx: RouteContext): void {
  const { app } = ctx;

  // API: Get document content for an item
  app.get('/api/item/:type/:number/doc', (req: Request, res: Response) => {
    const currentProject = ctx.getCurrentProject();
    const type = req.params.type as string;
    const number = parseInt(req.params.number as string, 10);

    const { docPath } = findItemByType(type, number, currentProject.id);

    if (!docPath) {
      res.status(404).json({ error: 'Document not found', docPath: null });
      return;
    }

    let fullPath = resolvePath(docPath, currentProject.id, currentProject.path);

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
    } catch (_err) {
      res.status(500).json({ error: 'Failed to read document' });
    }
  });

  // API: Get plan file for an item
  app.get('/api/item/:type/:number/plan', (req: Request, res: Response) => {
    const currentProject = ctx.getCurrentProject();
    const type = req.params.type as string;
    const number = parseInt(req.params.number as string, 10);

    const { docPath, slug } = findItemByType(type, number, currentProject.id);

    if (!docPath || !slug) {
      res.status(404).json({ error: 'Item not found', exists: false });
      return;
    }

    const planPath = docPath.replace('.md', '.plan.md');
    const fullPath = resolvePath(planPath, currentProject.id, currentProject.path);

    if (!existsSync(fullPath)) {
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
    } catch (_err) {
      res.status(500).json({ error: 'Failed to read plan file' });
    }
  });

  // API: Save/update plan file for an item
  app.put('/api/item/:type/:number/plan', (req: Request, res: Response) => {
    const currentProject = ctx.getCurrentProject();
    const type = req.params.type as string;
    const number = parseInt(req.params.number as string, 10);
    const { content } = req.body;

    if (!content) {
      res.status(400).json({ error: 'Content is required' });
      return;
    }

    const { docPath } = findItemByType(type, number, currentProject.id);

    if (!docPath) {
      res.status(404).json({ error: 'Item not found' });
      return;
    }

    const planPath = docPath.replace('.md', '.plan.md');
    const normalizedPath = planPath.replace(/^docs\//, '');
    const fullPath = join(PROJECTS_DIR, currentProject.id, normalizedPath);

    try {
      const dir = dirname(fullPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      writeFileSync(fullPath, content, 'utf-8');
      debouncedSync(currentProject.id, `Updated plan for ${type}-${number}`);
      res.json({ success: true, path: planPath });
    } catch (err) {
      console.error('Failed to save plan file:', err);
      res.status(500).json({ error: 'Failed to save plan file' });
    }
  });

  // API: Get Claude's current plan
  app.get('/api/claude-plan', (_req: Request, res: Response) => {
    const claudePlansDir = join(homedir(), '.claude', 'plans');

    if (!existsSync(claudePlansDir)) {
      res.json({ exists: false, content: null, message: 'No Claude plans directory found' });
      return;
    }

    try {
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
    const currentProject = ctx.getCurrentProject();
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

    debouncedSync(currentProject.id, `${type}-${number}: ${status}`);
    res.json(updated);
  });

  // API: Update bug status/owner
  app.patch('/api/bugs/:number', (req: Request, res: Response) => {
    const currentProject = ctx.getCurrentProject();
    const numberParam = req.params.number as string;
    const number = parseInt(numberParam, 10);
    const { status, owner } = req.body;

    const currentBug = getBugsByProject(currentProject.id).find(b => b.number === number);
    if (!currentBug) {
      res.status(404).json({ error: 'Bug not found' });
      return;
    }

    const updates: Partial<Bug> = {};
    if (status) updates.status = status;
    if (owner !== undefined) updates.owner = owner;

    if (status && currentBug.doc_path) {
      const newDocPath = updateFileStatus(currentProject.id, currentBug.doc_path, status, 'bug');
      if (newDocPath !== currentBug.doc_path) {
        updates.doc_path = newDocPath;
      }
    }

    const updated = updateBug(currentProject.id, number, updates);
    if (updated) {
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
    const currentProject = ctx.getCurrentProject();
    const numberParam = req.params.number as string;
    const number = parseInt(numberParam, 10);
    const { status, owner } = req.body;

    const currentImprovement = getImprovementsByProject(currentProject.id).find(i => i.number === number);
    if (!currentImprovement) {
      res.status(404).json({ error: 'Improvement not found' });
      return;
    }

    const updates: Partial<Improvement> = {};
    if (status) updates.status = status;
    if (owner !== undefined) updates.owner = owner;

    if (status && currentImprovement.doc_path) {
      const newDocPath = updateFileStatus(currentProject.id, currentImprovement.doc_path, status, 'improvement');
      if (newDocPath !== currentImprovement.doc_path) {
        updates.doc_path = newDocPath;
      }
    }

    const updated = updateImprovement(currentProject.id, number, updates);
    if (updated) {
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
    const currentProject = ctx.getCurrentProject();
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

    debouncedSync(currentProject.id, `feature-${number}: ${status}`);
    res.json(feature);
  });
}
