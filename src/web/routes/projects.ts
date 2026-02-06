import { Request, Response } from 'express';
import { getAllProjects, getProject } from '../../db/index.js';
import type { RouteContext } from '../types.js';

export function registerProjectRoutes(ctx: RouteContext): void {
  const { app } = ctx;

  // API: List all registered projects
  app.get('/api/projects', (_req: Request, res: Response) => {
    const projects = getAllProjects();
    res.json({
      projects,
      current: ctx.getCurrentProject().id,
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

    ctx.setCurrentProject(project);
    res.json({ success: true, project: ctx.getCurrentProject() });
  });
}
