import { Request, Response } from 'express';
import { join } from 'path';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { PROJECTS_DIR } from '../../db/index.js';
import type { RouteContext } from '../types.js';

export function registerFileRoutes(ctx: RouteContext): void {
  const { app } = ctx;

  // API: Get file tree structure for current project
  app.get('/api/files', (_req: Request, res: Response) => {
    const currentProject = ctx.getCurrentProject();

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
        if (entry.name.startsWith('.')) continue;

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
    const currentProject = ctx.getCurrentProject();
    const filePath = req.query.path as string;

    if (!filePath) {
      res.status(400).json({ error: 'path is required' });
      return;
    }

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
    } catch (_err) {
      res.status(500).json({ error: 'Failed to read file' });
    }
  });
}
