import express, { Request, Response, NextFunction } from 'express';
import { createServer as createHttpServer, Server } from 'http';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, existsSync, readdirSync, writeFileSync, mkdirSync, statSync } from 'fs';
import { execSync } from 'child_process';
import { homedir } from 'os';
import { terminalManager, CreateTerminalOptions } from './terminal-manager.js';
import { debouncedSync } from '../utils/git-sync.js';
import { createBugFile, createImprovementFile, generateSlug, updateFileStatus } from '../utils/file-creator.js';
import {
  loadProjectEnv,
  loadMCPConfig,
  getMCPServers,
  checkGitignoreSecurity,
} from '../utils/config.js';
import {
  getBugsByProject,
  getImprovementsByProject,
  getFeaturesByProject,
  getInbox,
  updateBug,
  updateImprovement,
  updateFeature,
  addToInbox,
  removeFromInbox,
  getInboxItem,
  getRecentActivity,
  getAllProjects,
  getProject,
  createBug,
  getNextBugNumber,
  createImprovement,
  getNextImprovementNumber,
  getWorktreesByProject,
  PROJECTS_DIR,
  Bug,
  Improvement,
  Feature,
  InboxItem,
  Project,
} from '../db/index.js';

// Resolve paths - first check central storage, then project path
function resolvePath(docPath: string, projectId: string, projectPath: string): string {
  // If it starts with ~/.spellbook/, expand the path
  if (docPath.startsWith('~/.spellbook/')) {
    return docPath.replace('~', homedir());
  }

  // Remove 'docs/' prefix if present (legacy paths)
  let normalizedPath = docPath.replace(/^docs\//, '');

  // Try central storage first
  const centralPath = join(PROJECTS_DIR, projectId, normalizedPath);
  if (existsSync(centralPath)) {
    return centralPath;
  }

  // Try with zero-padded number (e.g., "bugs/1-foo.md" -> "bugs/01-foo.md")
  const paddedPath = normalizedPath.replace(
    /^(bugs|improvements)\/(\d+)-/,
    (_match, folder, num) => `${folder}/${num.padStart(2, '0')}-`
  );
  const paddedCentralPath = join(PROJECTS_DIR, projectId, paddedPath);
  if (existsSync(paddedCentralPath)) {
    return paddedCentralPath;
  }

  // Try project path (original behavior)
  const projectFilePath = join(projectPath, docPath);
  if (existsSync(projectFilePath)) {
    return projectFilePath;
  }

  // Return central path (even if it doesn't exist, for error reporting)
  return centralPath;
}

// Generate a plan template for a new item
function generatePlanTemplate(type: string, number: number, slug: string): string {
  const today = new Date().toISOString().split('T')[0];
  const title = slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

  return `---
status: planning
created: ${today}
last_session: ${today}
phase: 0
---

# Implementation Plan: ${type === 'bug' ? 'Bug' : type === 'improvement' ? 'Improvement' : 'Feature'} #${number}

## Overview
${title}

## Phases

### Phase 1: Analysis & Setup
- [ ] Review the issue/improvement description
- [ ] Identify affected files and code paths
- [ ] Determine testing strategy

### Phase 2: Implementation
- [ ] [Add specific implementation tasks]

### Phase 3: Testing & Validation
- [ ] Write/update unit tests
- [ ] Manual testing
- [ ] Code review prep

## Session Log

### ${today} - Planning Session
- Created initial plan
- [Add notes as you work]

## Session Handoff

**Last completed:** Initial planning
**Next step:** Begin Phase 1 analysis
**Blocked:** None
**Warnings:** None

## How to Continue
Read this plan file. We're in the planning phase. Start by reviewing the main document and identifying the specific implementation approach.
`;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface BoardConfig {
  port: number;
  project: Project;
}

export interface StatusResponse {
  bugs: Bug[];
  improvements: Improvement[];
  features: Feature[];
  inbox: InboxItem[];
  project: {
    id: string;
    name: string;
    path: string;
  };
}

export interface DashboardStats {
  bugs: { total: number; active: number; inProgress: number; resolved: number };
  improvements: { total: number; active: number; inProgress: number; completed: number };
  features: { total: number; complete: number; inProgress: number; notStarted: number };
  inbox: { total: number; bugs: number; improvements: number; features: number };
}

export function createServer(config: BoardConfig) {
  const app = express();

  // Mutable current project - can be switched via API
  let currentProject: Project = config.project;

  app.use(express.json());

  // Serve static files from public directory
  const publicDir = join(__dirname, 'public');
  app.use(express.static(publicDir));

  // API: List all registered projects
  app.get('/api/projects', (_req: Request, res: Response) => {
    const projects = getAllProjects();
    res.json({
      projects,
      current: currentProject.id,
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

    currentProject = project;
    res.json({ success: true, project: currentProject });
  });

  // API: Get worktrees for current project
  app.get('/api/worktrees', (_req: Request, res: Response) => {
    try {
      // Run git worktree list from the project directory
      const output = execSync('git worktree list --porcelain', {
        cwd: currentProject.path,
        encoding: 'utf-8',
      });

      // Parse porcelain output
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
            worktrees.push(current as any);
          }
          current = { path: line.slice(9), bare: false };
        } else if (line.startsWith('HEAD ')) {
          current.commit = line.slice(5);
        } else if (line.startsWith('branch ')) {
          current.branch = line.slice(7).replace('refs/heads/', '');
        } else if (line === 'bare') {
          current.bare = true;
        } else if (line === '' && current.path) {
          worktrees.push(current as any);
          current = {};
        }
      }

      // Merge with database worktrees to get working_on assignments
      const dbWorktrees = getWorktreesByProject(currentProject.id);
      const dbWorktreeMap = new Map(dbWorktrees.map(w => [w.path, w]));

      // Enrich git worktrees with database info
      const enrichedWorktrees = worktrees.map(gitWt => {
        const dbWt = dbWorktreeMap.get(gitWt.path);
        return {
          ...gitWt,
          working_on: dbWt?.working_on || null,
          status: dbWt?.status || 'active',
        };
      });

      res.json({ worktrees: enrichedWorktrees, projectPath: currentProject.path });
    } catch (err) {
      console.error('Failed to list worktrees:', err);
      res.json({ worktrees: [], error: 'Failed to list worktrees' });
    }
  });

  // API: Create a worktree for an item
  app.post('/api/worktree/create', async (req: Request, res: Response) => {
    const { itemRef, branchName } = req.body;

    if (!itemRef) {
      res.status(400).json({ error: 'itemRef is required (e.g., bug-44, improvement-31)' });
      return;
    }

    try {
      // Parse the item reference
      const match = itemRef.match(/^(bug|improvement|feature)-(\d+)$/);
      if (!match) {
        res.status(400).json({ error: 'Invalid itemRef format. Use: bug-44, improvement-31, or feature-5' });
        return;
      }

      const [, type, numStr] = match;
      const number = parseInt(numStr, 10);

      // Determine worktree path
      const worktreeBase = join(homedir(), 'tmp', 'worktrees', currentProject.id);
      const worktreePath = join(worktreeBase, `${type}-${number}`);

      // Determine branch name (use provided or generate default)
      const finalBranchName = branchName || `${type === 'bug' ? 'fix' : type}/${number}`;

      // Check if worktree already exists
      if (existsSync(worktreePath)) {
        res.status(409).json({
          error: 'Worktree already exists',
          path: worktreePath,
          message: 'A worktree already exists at this path. Use the existing worktree or delete it first.',
        });
        return;
      }

      // Create worktree directory parent if needed
      const parentDir = dirname(worktreePath);
      if (!existsSync(parentDir)) {
        mkdirSync(parentDir, { recursive: true });
      }

      // Create the worktree using git
      try {
        // Try creating with new branch
        execSync(`git worktree add -b "${finalBranchName}" "${worktreePath}"`, {
          cwd: currentProject.path,
          stdio: 'pipe',
        });
      } catch (gitErr) {
        // Try without creating new branch (branch might already exist)
        try {
          execSync(`git worktree add "${worktreePath}" "${finalBranchName}"`, {
            cwd: currentProject.path,
            stdio: 'pipe',
          });
        } catch (gitErr2) {
          const errorMsg = gitErr2 instanceof Error ? gitErr2.message : String(gitErr2);
          res.status(500).json({
            error: 'Failed to create git worktree',
            details: errorMsg,
          });
          return;
        }
      }

      // Import createWorktree from db if not already done
      // Register in database
      const { createWorktree: dbCreateWorktree } = await import('../db/index.js');
      dbCreateWorktree({
        project_id: currentProject.id,
        path: worktreePath,
        branch: finalBranchName,
        working_on: itemRef,
        status: 'active',
      });

      console.log(`[Server] Created worktree for ${itemRef} at ${worktreePath}`);

      res.status(201).json({
        success: true,
        path: worktreePath,
        branch: finalBranchName,
        workingOn: itemRef,
      });
    } catch (err) {
      console.error('Failed to create worktree:', err);
      res.status(500).json({
        error: 'Failed to create worktree',
        details: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // API: Get current git branch for a path
  app.get('/api/git/branch', (req: Request, res: Response) => {
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

  // API: Get git diff (changed files)
  app.get('/api/git/diff', (req: Request, res: Response) => {
    const targetPath = (req.query.path as string) || currentProject.path;
    const base = (req.query.base as string) || 'HEAD';

    try {
      // Get list of changed files with stats
      const diffStat = execSync(`git diff --stat ${base}`, {
        cwd: targetPath,
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024, // 10MB buffer
      });

      // Get list of changed files (staged + unstaged)
      const statusOutput = execSync('git status --porcelain', {
        cwd: targetPath,
        encoding: 'utf-8',
      });

      // Parse status output into file list
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

        // Get diff stats for this file
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

      // Get total stats
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

  // API: Get knowledge base files from PROJECT docs folder (git-tracked)
  app.get('/api/knowledge', (_req: Request, res: Response) => {
    // Use project docs folder for knowledge base (git-tracked, shared with team)
    const knowledgePath = join(currentProject.path, 'docs', 'knowledge');
    const templatesPath = join(currentProject.path, 'docs', 'knowledge', 'templates');
    const files: Array<{ name: string; path: string; type: string; category?: string }> = [];

    // Scan knowledge/ directory
    function scanDirectory(dirPath: string, category?: string) {
      if (!existsSync(dirPath)) return;

      const entries = readdirSync(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(dirPath, entry.name);
        if (entry.isDirectory()) {
          // Skip templates folder here - it's scanned separately below
          if (entry.name === 'templates') continue;
          // Recurse into subdirectories (architecture, guides, operations, etc.)
          scanDirectory(fullPath, entry.name);
        } else if (entry.isFile() && entry.name.endsWith('.md')) {
          const name = entry.name.replace('.md', '').replace(/-/g, ' ').replace(/_/g, ' ');
          const relativePath = fullPath.replace(join(currentProject.path, 'docs') + '/', '');
          files.push({
            name: name.toUpperCase(),
            path: `docs/${relativePath}`,
            type: 'doc',
            category: category || 'general',
          });
        }
      }
    }

    try {
      // Scan knowledge folder
      scanDirectory(knowledgePath);

      // Also scan templates folder
      if (existsSync(templatesPath)) {
        const templateEntries = readdirSync(templatesPath, { withFileTypes: true });
        for (const entry of templateEntries) {
          if (entry.isFile() && entry.name.endsWith('.md')) {
            const name = entry.name.replace('.md', '').replace(/-/g, ' ').replace(/_/g, ' ');
            files.push({
              name: name.toUpperCase(),
              path: `docs/knowledge/templates/${entry.name}`,
              type: 'doc',
              category: 'templates',
            });
          }
        }
      }

      // Sort by category then name
      files.sort((a, b) => {
        if (a.category === b.category) return a.name.localeCompare(b.name);
        return a.category!.localeCompare(b.category!);
      });
      res.json({ files });
    } catch (err) {
      console.error('Failed to read knowledge base:', err);
      res.json({ files: [], error: 'Failed to read knowledge base' });
    }
  });

  // API: Get specific knowledge doc content from PROJECT docs folder
  app.get('/api/knowledge/doc', (req: Request, res: Response) => {
    const docPath = req.query.path as string;
    if (!docPath) {
      res.status(400).json({ error: 'Path is required' });
      return;
    }

    // Read from project docs folder
    const fullPath = join(currentProject.path, docPath);
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

  // API: Get file tree structure for current project
  app.get('/api/files', (_req: Request, res: Response) => {
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
        if (entry.name.startsWith('.')) continue; // Skip hidden files

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

      // Sort: folders first, then alphabetically
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
    const filePath = req.query.path as string;

    if (!filePath) {
      res.status(400).json({ error: 'path is required' });
      return;
    }

    // Security: ensure path is within project docs
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
    } catch (err) {
      res.status(500).json({ error: 'Failed to read file' });
    }
  });

  // API: Open terminal at a path (returns command, client executes)
  app.post('/api/terminal/open', (req: Request, res: Response) => {
    const { path: targetPath } = req.body;

    if (!targetPath) {
      res.status(400).json({ error: 'path is required' });
      return;
    }

    // Return the command - client can use it with a protocol handler or display instructions
    // For macOS with Ghostty
    const command = `open -a Ghostty --args --working-directory="${targetPath}"`;

    res.json({
      command,
      path: targetPath,
      instructions: `Run this command to open terminal: ${command}`,
    });
  });

  // API: Get all items for the kanban board
  app.get('/api/status', (_req: Request, res: Response) => {
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

  // API: Get dashboard stats
  app.get('/api/dashboard', (_req: Request, res: Response) => {
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
    try {
      console.log('[Server] Regenerating roadmap for project:', currentProject.path);
      execSync('spellbook roadmap', {
        cwd: currentProject.path,
        timeout: 30000,
        encoding: 'utf-8',
      });
      console.log('[Server] Roadmap regenerated successfully');
      res.json({ success: true, message: 'Roadmap regenerated' });
    } catch (err: any) {
      console.error('[Server] Failed to regenerate roadmap:', err.message || err);
      res.status(500).json({ error: 'Failed to regenerate roadmap', details: err.message });
    }
  });

  // API: Get project info for dashboard
  app.get('/api/project-info', (_req: Request, res: Response) => {
    const bugs = getBugsByProject(currentProject.id);
    const improvements = getImprovementsByProject(currentProject.id);
    const features = getFeaturesByProject(currentProject.id);
    const inbox = getInbox(currentProject.id);

    // Try to read package.json for tech stack info
    let techStack: { name?: string; version?: string; dependencies?: Record<string, string> } = {};
    const packageJsonPath = join(currentProject.path, 'package.json');
    if (existsSync(packageJsonPath)) {
      try {
        techStack = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
      } catch {
        // Ignore parse errors
      }
    }

    // Get git info
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

  // API: Get recent activity (enriched with item titles)
  app.get('/api/activity', (req: Request, res: Response) => {
    const limit = parseInt(req.query.limit as string) || 20;
    const activity = getRecentActivity(currentProject.id, limit);

    // Build lookup maps for titles
    const bugs = getBugsByProject(currentProject.id);
    const improvements = getImprovementsByProject(currentProject.id);
    const features = getFeaturesByProject(currentProject.id);

    const bugMap = new Map(bugs.map(b => [`bug-${b.number}`, b.title]));
    const impMap = new Map(improvements.map(i => [`improvement-${i.number}`, i.title]));
    const featureMap = new Map(features.map(f => [`feature-${f.number}`, f.name]));

    // Enrich activity with titles
    const enrichedActivity = activity.map(a => ({
      ...a,
      item_title: bugMap.get(a.item_ref) || impMap.get(a.item_ref) || featureMap.get(a.item_ref) || null,
    }));

    res.json(enrichedActivity);
  });

  // API: Get document content for an item
  app.get('/api/item/:type/:number/doc', (req: Request, res: Response) => {
    const type = req.params.type as string;
    const number = parseInt(req.params.number as string, 10);

    let docPath: string | null = null;

    if (type === 'bug') {
      const bugs = getBugsByProject(currentProject.id);
      const bug = bugs.find(b => b.number === number);
      docPath = bug?.doc_path || null;
    } else if (type === 'improvement') {
      const improvements = getImprovementsByProject(currentProject.id);
      const improvement = improvements.find(i => i.number === number);
      docPath = improvement?.doc_path || null;
    } else if (type === 'feature') {
      const features = getFeaturesByProject(currentProject.id);
      const feature = features.find(f => f.number === number);
      docPath = feature?.doc_path || null;
    }

    if (!docPath) {
      res.status(404).json({ error: 'Document not found', docPath: null });
      return;
    }

    // Resolve path - supports both relative and ~/.spellbook/ paths
    let fullPath = resolvePath(docPath, currentProject.id, currentProject.path);

    // For features, doc_path is a folder - look for README.md inside
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
    } catch (err) {
      res.status(500).json({ error: 'Failed to read document' });
    }
  });

  // API: Get plan file for an item
  app.get('/api/item/:type/:number/plan', (req: Request, res: Response) => {
    const type = req.params.type as string;
    const number = parseInt(req.params.number as string, 10);

    // Get the item to find its doc_path
    let docPath: string | null = null;
    let slug: string | null = null;

    if (type === 'bug') {
      const bugs = getBugsByProject(currentProject.id);
      const bug = bugs.find(b => b.number === number);
      docPath = bug?.doc_path || null;
      slug = bug?.slug || null;
    } else if (type === 'improvement') {
      const improvements = getImprovementsByProject(currentProject.id);
      const improvement = improvements.find(i => i.number === number);
      docPath = improvement?.doc_path || null;
      slug = improvement?.slug || null;
    } else if (type === 'feature') {
      const features = getFeaturesByProject(currentProject.id);
      const feature = features.find(f => f.number === number);
      docPath = feature?.doc_path || null;
      slug = feature?.name?.toLowerCase().replace(/[^a-z0-9]+/g, '-') || null;
    }

    if (!docPath || !slug) {
      res.status(404).json({ error: 'Item not found', exists: false });
      return;
    }

    // Derive plan file path from doc path
    // e.g., bugs/32-foo.md -> bugs/32-foo.plan.md
    const planPath = docPath.replace('.md', '.plan.md');
    const fullPath = resolvePath(planPath, currentProject.id, currentProject.path);

    if (!existsSync(fullPath)) {
      // No plan exists yet - return empty with exists: false
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
    } catch (err) {
      res.status(500).json({ error: 'Failed to read plan file' });
    }
  });

  // API: Save/update plan file for an item
  app.put('/api/item/:type/:number/plan', (req: Request, res: Response) => {
    const type = req.params.type as string;
    const number = parseInt(req.params.number as string, 10);
    const { content } = req.body;

    if (!content) {
      res.status(400).json({ error: 'Content is required' });
      return;
    }

    // Get the item to find its doc_path
    let docPath: string | null = null;

    if (type === 'bug') {
      const bugs = getBugsByProject(currentProject.id);
      const bug = bugs.find(b => b.number === number);
      docPath = bug?.doc_path || null;
    } else if (type === 'improvement') {
      const improvements = getImprovementsByProject(currentProject.id);
      const improvement = improvements.find(i => i.number === number);
      docPath = improvement?.doc_path || null;
    } else if (type === 'feature') {
      const features = getFeaturesByProject(currentProject.id);
      const feature = features.find(f => f.number === number);
      docPath = feature?.doc_path || null;
    }

    if (!docPath) {
      res.status(404).json({ error: 'Item not found' });
      return;
    }

    // Derive plan file path
    const planPath = docPath.replace('.md', '.plan.md');

    // Need to resolve to central storage
    let normalizedPath = planPath.replace(/^docs\//, '');
    const fullPath = join(PROJECTS_DIR, currentProject.id, normalizedPath);

    try {
      // Ensure directory exists
      const dir = dirname(fullPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      writeFileSync(fullPath, content, 'utf-8');

      // Auto-commit to git
      debouncedSync(currentProject.id, `Updated plan for ${type}-${number}`);

      res.json({ success: true, path: planPath });
    } catch (err) {
      console.error('Failed to save plan file:', err);
      res.status(500).json({ error: 'Failed to save plan file' });
    }
  });

  // API: Get Claude's current plan from ~/.claude/plans/
  app.get('/api/claude-plan', (_req: Request, res: Response) => {
    const claudePlansDir = join(homedir(), '.claude', 'plans');

    if (!existsSync(claudePlansDir)) {
      res.json({ exists: false, content: null, message: 'No Claude plans directory found' });
      return;
    }

    try {
      // List all .md files and sort by modification time (newest first)
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

      // Get the most recent plan
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

    // Auto-commit to git
    debouncedSync(currentProject.id, `${type}-${number}: ${status}`);

    res.json(updated);
  });

  // API: Update bug status/owner
  app.patch('/api/bugs/:number', (req: Request, res: Response) => {
    const numberParam = req.params.number as string;
    const number = parseInt(numberParam, 10);
    const { status, owner } = req.body;

    // Get current bug to access doc_path
    const currentBug = getBugsByProject(currentProject.id).find(b => b.number === number);
    if (!currentBug) {
      res.status(404).json({ error: 'Bug not found' });
      return;
    }

    const updates: Partial<Bug> = {};
    if (status) updates.status = status;
    if (owner !== undefined) updates.owner = owner;

    // If status is changing and we have a doc_path, update the file
    if (status && currentBug.doc_path) {
      const newDocPath = updateFileStatus(currentProject.id, currentBug.doc_path, status, 'bug');
      if (newDocPath !== currentBug.doc_path) {
        updates.doc_path = newDocPath;
      }
    }

    const updated = updateBug(currentProject.id, number, updates);
    if (updated) {
      // Auto-commit to git
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
    const numberParam = req.params.number as string;
    const number = parseInt(numberParam, 10);
    const { status, owner } = req.body;

    // Get current improvement to access doc_path
    const currentImprovement = getImprovementsByProject(currentProject.id).find(i => i.number === number);
    if (!currentImprovement) {
      res.status(404).json({ error: 'Improvement not found' });
      return;
    }

    const updates: Partial<Improvement> = {};
    if (status) updates.status = status;
    if (owner !== undefined) updates.owner = owner;

    // If status is changing and we have a doc_path, update the file
    if (status && currentImprovement.doc_path) {
      const newDocPath = updateFileStatus(currentProject.id, currentImprovement.doc_path, status, 'improvement');
      if (newDocPath !== currentImprovement.doc_path) {
        updates.doc_path = newDocPath;
      }
    }

    const updated = updateImprovement(currentProject.id, number, updates);
    if (updated) {
      // Auto-commit to git
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

    // Auto-commit to git
    debouncedSync(currentProject.id, `feature-${number}: ${status}`);
    res.json(feature);
  });

  // API: Add to inbox
  app.post('/api/inbox', (req: Request, res: Response) => {
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
    const { title, description, priority } = req.body;

    if (!title) {
      res.status(400).json({ error: 'Title is required' });
      return;
    }

    const number = getNextBugNumber(currentProject.id);
    const slug = generateSlug(title);

    // Create the markdown file
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

    // Auto-commit to git
    debouncedSync(currentProject.id, `Created bug-${number}: ${title}`);

    res.status(201).json(bug);
  });

  // API: Create improvement directly (with markdown file)
  app.post('/api/improvements', (req: Request, res: Response) => {
    const { title, description, priority, linkedFeature } = req.body;

    if (!title) {
      res.status(400).json({ error: 'Title is required' });
      return;
    }

    const number = getNextImprovementNumber(currentProject.id);
    const slug = generateSlug(title);

    // Create the markdown file
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

    // Auto-commit to git
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
    const id = parseInt(req.params.id as string, 10);
    const item = getInboxItem(id);

    if (!item) {
      res.status(404).json({ error: 'Inbox item not found' });
      return;
    }

    const { title, priority, targetType } = req.body;
    const finalTitle = title || item.description.slice(0, 100);
    const finalPriority = priority || item.priority || 'medium';
    // Allow override of type via targetType parameter
    const convertType = targetType || item.type;

    // Generate slug from title
    const slug = finalTitle
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 50);

    try {
      if (convertType === 'bug') {
        const number = getNextBugNumber(currentProject.id);

        // Create the markdown file
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

        // Remove from inbox after successful conversion
        removeFromInbox(id);

        // Auto-commit to git
        debouncedSync(currentProject.id, `Created bug-${number}: ${finalTitle}`);

        res.json({ success: true, type: 'bug', item: bug });
      } else if (convertType === 'improvement') {
        const number = getNextImprovementNumber(currentProject.id);

        // Create the markdown file
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

        // Remove from inbox after successful conversion
        removeFromInbox(id);

        // Auto-commit to git
        debouncedSync(currentProject.id, `Created improvement-${number}: ${finalTitle}`);

        res.json({ success: true, type: 'improvement', item: improvement });
      } else {
        // Features stay in inbox until properly planned
        res.status(400).json({ error: 'Features must be planned via /plan command, not converted directly' });
      }
    } catch (err) {
      console.error('Failed to convert inbox item:', err);
      res.status(500).json({ error: 'Failed to convert inbox item' });
    }
  });

  // ============================================
  // Terminal Management APIs
  // ============================================

  // API: List all terminals
  app.get('/api/terminals', (_req: Request, res: Response) => {
    const terminals = terminalManager.list();
    res.json({ terminals });
  });

  // API: Create a new terminal
  app.post('/api/terminals', (req: Request, res: Response) => {
    const { cwd, name, command, args } = req.body as CreateTerminalOptions & { command?: string; args?: string[] };

    // Default to project path if no cwd provided
    const targetCwd = cwd || currentProject.path;

    // Validate cwd exists
    if (!existsSync(targetCwd)) {
      res.status(400).json({ error: `Directory does not exist: ${targetCwd}` });
      return;
    }

    try {
      // Load project environment variables (from .env, .env.local, etc.)
      // SECURITY: These are loaded but NEVER sent to the frontend or logged
      const projectEnv = loadProjectEnv(currentProject.path);
      if (projectEnv.sources.length > 0) {
        console.log(`[Server] Loaded env from: ${projectEnv.sources.length} files`);
      }

      const terminal = terminalManager.create({
        cwd: targetCwd,
        name,
        command,
        args,
        env: projectEnv.env, // Pass project env vars to terminal
      });

      res.status(201).json({
        terminalId: terminal.id,
        name: terminal.name,
        cwd: terminal.cwd,
        pid: terminal.pid,
      });
    } catch (err) {
      console.error('Failed to create terminal:', err);
      res.status(500).json({ error: 'Failed to create terminal' });
    }
  });

  // API: Get terminal info
  app.get('/api/terminals/:id', (req: Request, res: Response) => {
    const terminalId = req.params.id as string;
    const terminal = terminalManager.get(terminalId);

    if (!terminal) {
      res.status(404).json({ error: 'Terminal not found' });
      return;
    }

    res.json({
      id: terminal.id,
      name: terminal.name,
      cwd: terminal.cwd,
      status: terminal.status,
      pid: terminal.pid,
      createdAt: terminal.createdAt.toISOString(),
      lastActivity: terminal.lastActivity.toISOString(),
    });
  });

  // API: Rename terminal
  app.patch('/api/terminals/:id', (req: Request, res: Response) => {
    const terminalId = req.params.id as string;
    const { name } = req.body;

    if (name) {
      const success = terminalManager.rename(terminalId, name);
      if (!success) {
        res.status(404).json({ error: 'Terminal not found' });
        return;
      }
    }

    const terminal = terminalManager.get(terminalId);
    res.json({
      id: terminal?.id,
      name: terminal?.name,
    });
  });

  // API: Close terminal
  app.delete('/api/terminals/:id', (req: Request, res: Response) => {
    const terminalId = req.params.id as string;
    const success = terminalManager.close(terminalId);

    if (!success) {
      res.status(404).json({ error: 'Terminal not found' });
      return;
    }

    res.json({ success: true });
  });

  // API: Write to terminal (for non-WebSocket usage)
  app.post('/api/terminals/:id/write', (req: Request, res: Response) => {
    const terminalId = req.params.id as string;
    const { data } = req.body;

    if (!data) {
      res.status(400).json({ error: 'data is required' });
      return;
    }

    const success = terminalManager.write(terminalId, data);

    if (!success) {
      res.status(404).json({ error: 'Terminal not found or closed' });
      return;
    }

    res.json({ success: true });
  });

  // API: Resize terminal
  app.post('/api/terminals/:id/resize', (req: Request, res: Response) => {
    const terminalId = req.params.id as string;
    const { cols, rows } = req.body;

    if (!cols || !rows) {
      res.status(400).json({ error: 'cols and rows are required' });
      return;
    }

    const success = terminalManager.resize(terminalId, cols, rows);

    if (!success) {
      res.status(404).json({ error: 'Terminal not found or closed' });
      return;
    }

    res.json({ success: true });
  });

  // ============================================
  // Configuration APIs (MCP, ENV status)
  // ============================================

  // API: Get MCP servers (names only, no secrets)
  app.get('/api/config/mcp', (_req: Request, res: Response) => {
    try {
      const mcpConfig = loadMCPConfig();
      const servers = getMCPServers();

      res.json({
        configured: mcpConfig.config !== null,
        source: mcpConfig.source,
        servers: servers.map(s => ({
          name: s.name,
          // Don't expose full command which might contain paths/secrets
          type: s.command.includes('npx') ? 'npm' : s.command.includes('python') ? 'python' : 'other',
        })),
      });
    } catch (err) {
      console.error('Failed to load MCP config:', err);
      res.status(500).json({ error: 'Failed to load MCP configuration' });
    }
  });

  // API: Get environment status (NOT the actual values - security)
  app.get('/api/config/env', (_req: Request, res: Response) => {
    try {
      const envConfig = loadProjectEnv(currentProject.path);

      // SECURITY: Only return metadata, NEVER actual values
      res.json({
        loaded: envConfig.sources.length > 0,
        sources: envConfig.sources.map(s => s.replace(currentProject.path, '.')),
        variableCount: Object.keys(envConfig.env).length,
        // Only return variable names (not values) for debugging
        variables: Object.keys(envConfig.env),
        errors: envConfig.errors,
      });
    } catch (err) {
      console.error('Failed to check env config:', err);
      res.status(500).json({ error: 'Failed to check environment configuration' });
    }
  });

  // API: Check security status (gitignore coverage)
  app.get('/api/config/security', (_req: Request, res: Response) => {
    try {
      const gitignoreCheck = checkGitignoreSecurity(currentProject.path);

      res.json({
        gitignoreSecure: gitignoreCheck.isSecure,
        missingEntries: gitignoreCheck.missingEntries,
        warnings: gitignoreCheck.missingEntries.length > 0
          ? ['Some sensitive files may not be properly gitignored']
          : [],
      });
    } catch (err) {
      console.error('Failed to check security:', err);
      res.status(500).json({ error: 'Failed to check security status' });
    }
  });

  // Error handling middleware
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error('Server error:', err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

export function startServer(config: BoardConfig): Promise<{ close: () => void; url: string; server: Server }> {
  return new Promise((resolve, reject) => {
    const app = createServer(config);

    // Create HTTP server from Express app
    const server = createHttpServer(app);

    // Attach terminal manager WebSocket server
    terminalManager.attachToServer(server);

    server.listen(config.port, () => {
      const url = `http://localhost:${config.port}`;
      console.log(`[Server] HTTP server listening on ${url}`);
      console.log(`[Server] WebSocket available at ws://localhost:${config.port}/ws/terminal`);

      resolve({
        close: () => {
          console.log('[Server] Shutting down...');
          // Close all terminals first
          terminalManager.closeAll();
          // Then close HTTP server
          server.close();
        },
        url,
        server,
      });
    });

    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        reject(new Error(`Port ${config.port} is already in use`));
      } else {
        reject(err);
      }
    });
  });
}
