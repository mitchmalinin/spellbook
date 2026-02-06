import { Request, Response } from 'express';
import {
  addToInbox,
  removeFromInbox,
  getInboxItem,
  getNextBugNumber,
  getNextImprovementNumber,
  createBug,
  createImprovement,
} from '../../db/index.js';
import { debouncedSync } from '../../utils/git-sync.js';
import { createBugFile, createImprovementFile, generateSlug } from '../../utils/file-creator.js';
import type { RouteContext } from '../types.js';

export function registerInboxRoutes(ctx: RouteContext): void {
  const { app } = ctx;

  // API: Add to inbox
  app.post('/api/inbox', (req: Request, res: Response) => {
    const currentProject = ctx.getCurrentProject();
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
    const currentProject = ctx.getCurrentProject();
    const { title, description, priority } = req.body;

    if (!title) {
      res.status(400).json({ error: 'Title is required' });
      return;
    }

    const number = getNextBugNumber(currentProject.id);
    const slug = generateSlug(title);

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

    debouncedSync(currentProject.id, `Created bug-${number}: ${title}`);
    res.status(201).json(bug);
  });

  // API: Create improvement directly (with markdown file)
  app.post('/api/improvements', (req: Request, res: Response) => {
    const currentProject = ctx.getCurrentProject();
    const { title, description, priority, linkedFeature } = req.body;

    if (!title) {
      res.status(400).json({ error: 'Title is required' });
      return;
    }

    const number = getNextImprovementNumber(currentProject.id);
    const slug = generateSlug(title);

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
    const currentProject = ctx.getCurrentProject();
    const id = parseInt(req.params.id as string, 10);
    const item = getInboxItem(id);

    if (!item) {
      res.status(404).json({ error: 'Inbox item not found' });
      return;
    }

    const { title, priority, targetType } = req.body;
    const finalTitle = title || item.description.slice(0, 100);
    const finalPriority = priority || item.priority || 'medium';
    const convertType = targetType || item.type;

    const slug = finalTitle
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 50);

    try {
      if (convertType === 'bug') {
        const number = getNextBugNumber(currentProject.id);

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

        removeFromInbox(id);
        debouncedSync(currentProject.id, `Created bug-${number}: ${finalTitle}`);
        res.json({ success: true, type: 'bug', item: bug });
      } else if (convertType === 'improvement') {
        const number = getNextImprovementNumber(currentProject.id);

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

        removeFromInbox(id);
        debouncedSync(currentProject.id, `Created improvement-${number}: ${finalTitle}`);
        res.json({ success: true, type: 'improvement', item: improvement });
      } else {
        res.status(400).json({ error: 'Features must be planned via /plan command, not converted directly' });
      }
    } catch (err) {
      console.error('Failed to convert inbox item:', err);
      res.status(500).json({ error: 'Failed to convert inbox item' });
    }
  });
}
