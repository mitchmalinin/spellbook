import express, { Request, Response, NextFunction } from 'express';
import { createServer as createHttpServer, Server } from 'http';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { terminalManager, TerminalManager } from './terminal-manager.js';
import type { Project } from '../db/index.js';
import type { BoardConfig, RouteContext } from './types.js';

// Route modules
import { registerProjectRoutes } from './routes/projects.js';
import { registerWorktreeRoutes } from './routes/worktrees.js';
import { registerGitRoutes } from './routes/git.js';
import { registerKnowledgeRoutes } from './routes/knowledge.js';
import { registerFileRoutes } from './routes/files.js';
import { registerStatusRoutes } from './routes/status.js';
import { registerItemRoutes } from './routes/items.js';
import { registerInboxRoutes } from './routes/inbox.js';
import { registerTerminalRoutes } from './routes/terminals.js';
import { registerTerminalIntegrationRoutes } from './routes/terminal-integration.js';
import { registerConfigRoutes } from './routes/config.js';
import { registerUploadRoutes } from './routes/uploads.js';

// Re-export types for backward compatibility
export type { BoardConfig, StatusResponse, DashboardStats } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export function createServer(config: BoardConfig) {
  const app = express();

  // Mutable current project - can be switched via API
  let currentProject: Project = config.project;

  app.use(express.json());

  // Serve static files from public directory
  const publicDir = join(__dirname, 'public');
  app.use(express.static(publicDir));

  // Build shared route context
  const ctx: RouteContext = {
    app,
    getCurrentProject: () => currentProject,
    setCurrentProject: (project: Project) => { currentProject = project; },
    terminalAvailable: TerminalManager.isAvailable(),
  };

  // Register all route groups
  registerProjectRoutes(ctx);
  registerWorktreeRoutes(ctx);
  registerGitRoutes(ctx);
  registerKnowledgeRoutes(ctx);
  registerFileRoutes(ctx);
  registerStatusRoutes(ctx);
  registerItemRoutes(ctx);
  registerInboxRoutes(ctx);
  registerTerminalRoutes(ctx);
  registerTerminalIntegrationRoutes(ctx);
  registerConfigRoutes(ctx);
  registerUploadRoutes(ctx);

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

    // Attach terminal manager WebSocket server (only if node-pty available)
    if (TerminalManager.isAvailable()) {
      terminalManager.attachToServer(server);
    }

    server.listen(config.port, () => {
      const url = `http://localhost:${config.port}`;
      console.log(`[Server] HTTP server listening on ${url}`);
      console.log(`[Server] WebSocket available at ws://localhost:${config.port}/ws/terminal`);

      resolve({
        close: () => {
          console.log('[Server] Shutting down...');
          if (TerminalManager.isAvailable()) {
            terminalManager.closeAll();
          }
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
