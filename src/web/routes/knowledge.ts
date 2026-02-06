import { Request, Response } from 'express';
import { join, dirname } from 'path';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'fs';
import { PROJECTS_DIR } from '../../db/index.js';
import { debouncedSync } from '../../utils/git-sync.js';
import type { RouteContext } from '../types.js';

export function registerKnowledgeRoutes(ctx: RouteContext): void {
  const { app } = ctx;

  // API: Get knowledge base as tree structure
  app.get('/api/knowledge', (_req: Request, res: Response) => {
    const currentProject = ctx.getCurrentProject();
    const knowledgePath = join(PROJECTS_DIR, currentProject.id, 'knowledge');

    interface TreeNode {
      type: 'folder' | 'file';
      name: string;
      path: string;
      children?: TreeNode[];
      lastModified?: string;
    }

    function buildTree(dirPath: string, relativePath: string = ''): TreeNode[] {
      if (!existsSync(dirPath)) return [];

      const entries = readdirSync(dirPath, { withFileTypes: true });
      const nodes: TreeNode[] = [];

      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;

        const fullPath = join(dirPath, entry.name);
        const relPath = relativePath ? `${relativePath}/${entry.name}` : entry.name;

        if (entry.isDirectory()) {
          const children = buildTree(fullPath, relPath);
          nodes.push({
            type: 'folder',
            name: entry.name,
            path: relPath,
            children,
          });
        } else if (entry.isFile() && entry.name.endsWith('.md')) {
          const stat = statSync(fullPath);
          nodes.push({
            type: 'file',
            name: entry.name.replace('.md', ''),
            path: relPath,
            lastModified: stat.mtime.toISOString(),
          });
        }
      }

      return nodes.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    }

    try {
      if (!existsSync(knowledgePath)) {
        mkdirSync(knowledgePath, { recursive: true });
        const defaultDirs = ['architecture', 'decisions', 'guides', 'api', 'research'];
        for (const dir of defaultDirs) {
          mkdirSync(join(knowledgePath, dir), { recursive: true });
        }
      }

      const tree = buildTree(knowledgePath);

      function countByType(nodes: TreeNode[], type: 'file' | 'folder'): number {
        let count = 0;
        for (const node of nodes) {
          if (node.type === type) count++;
          if (node.children) count += countByType(node.children, type);
        }
        return count;
      }

      res.json({
        tree,
        root: `~/.spellbook/projects/${currentProject.id}/knowledge`,
        stats: {
          totalDocs: countByType(tree, 'file'),
          totalCategories: countByType(tree, 'folder'),
        },
      });
    } catch (err) {
      console.error('Failed to read knowledge base:', err);
      res.json({ tree: [], root: '', stats: { totalDocs: 0, totalCategories: 0 }, error: 'Failed to read knowledge base' });
    }
  });

  // API: Get knowledge document content
  app.get('/api/knowledge/content', (req: Request, res: Response) => {
    const currentProject = ctx.getCurrentProject();
    const docPath = req.query.path as string;
    if (!docPath) {
      res.status(400).json({ error: 'path is required' });
      return;
    }

    const knowledgePath = join(PROJECTS_DIR, currentProject.id, 'knowledge');
    const fullPath = join(knowledgePath, docPath);

    if (!fullPath.startsWith(knowledgePath)) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    const finalPath = fullPath.endsWith('.md') ? fullPath : `${fullPath}.md`;

    if (!existsSync(finalPath)) {
      res.status(404).json({ error: 'Document not found', path: docPath });
      return;
    }

    try {
      const content = readFileSync(finalPath, 'utf-8');
      const stat = statSync(finalPath);
      res.json({
        content,
        path: docPath,
        lastModified: stat.mtime.toISOString(),
      });
    } catch (err) {
      console.error('Failed to read document:', err);
      res.status(500).json({ error: 'Failed to read document' });
    }
  });

  // API: Update knowledge document content
  app.put('/api/knowledge/content', (req: Request, res: Response) => {
    const currentProject = ctx.getCurrentProject();
    const { path: docPath, content } = req.body;

    if (!docPath) {
      res.status(400).json({ error: 'path is required' });
      return;
    }

    if (content === undefined) {
      res.status(400).json({ error: 'content is required' });
      return;
    }

    const knowledgePath = join(PROJECTS_DIR, currentProject.id, 'knowledge');
    const fullPath = join(knowledgePath, docPath);

    if (!fullPath.startsWith(knowledgePath)) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    const finalPath = fullPath.endsWith('.md') ? fullPath : `${fullPath}.md`;

    try {
      const parentDir = dirname(finalPath);
      if (!existsSync(parentDir)) {
        mkdirSync(parentDir, { recursive: true });
      }

      writeFileSync(finalPath, content, 'utf-8');
      debouncedSync(currentProject.id, `Updated knowledge doc: ${docPath}`);
      res.json({ success: true, path: docPath });
    } catch (err) {
      console.error('Failed to save document:', err);
      res.status(500).json({ error: 'Failed to save document' });
    }
  });

  // API: Get specific knowledge doc content
  app.get('/api/knowledge/doc', (req: Request, res: Response) => {
    const currentProject = ctx.getCurrentProject();
    const docPath = req.query.path as string;
    if (!docPath) {
      res.status(400).json({ error: 'Path is required' });
      return;
    }

    const knowledgePath = join(PROJECTS_DIR, currentProject.id, 'knowledge');
    const fullPath = join(knowledgePath, docPath);
    try {
      if (existsSync(fullPath)) {
        const content = readFileSync(fullPath, 'utf-8');
        res.json({ content, path: docPath });
      } else {
        res.status(404).json({ error: 'Document not found', path: fullPath });
      }
    } catch (err) {
      console.error('Failed to read document:', err);
      res.status(500).json({ error: 'Failed to read document' });
    }
  });
}
