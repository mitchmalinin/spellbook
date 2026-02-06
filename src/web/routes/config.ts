import { Request, Response } from 'express';
import { loadProjectEnv, loadMCPConfig, getMCPServers, checkGitignoreSecurity } from '../../utils/config.js';
import type { RouteContext } from '../types.js';

export function registerConfigRoutes(ctx: RouteContext): void {
  const { app } = ctx;

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
          type: s.command.includes('npx') ? 'npm' : s.command.includes('python') ? 'python' : 'other',
        })),
      });
    } catch (err) {
      console.error('Failed to load MCP config:', err);
      res.status(500).json({ error: 'Failed to load MCP configuration' });
    }
  });

  // API: Get environment status (NOT the actual values)
  app.get('/api/config/env', (_req: Request, res: Response) => {
    const currentProject = ctx.getCurrentProject();
    try {
      const envConfig = loadProjectEnv(currentProject.path);

      res.json({
        loaded: envConfig.sources.length > 0,
        sources: envConfig.sources.map(s => s.replace(currentProject.path, '.')),
        variableCount: Object.keys(envConfig.env).length,
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
    const currentProject = ctx.getCurrentProject();
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
}
