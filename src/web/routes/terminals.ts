import { Request, Response } from 'express';
import { existsSync } from 'fs';
import { terminalManager, TerminalManager, CreateTerminalOptions } from '../terminal-manager.js';
import { loadProjectEnv } from '../../utils/config.js';
import type { RouteContext } from '../types.js';

export function registerTerminalRoutes(ctx: RouteContext): void {
  const { app } = ctx;

  if (TerminalManager.isAvailable()) {
    // API: List all terminals
    app.get('/api/terminals', (_req: Request, res: Response) => {
      const terminals = terminalManager.list();
      res.json({ terminals });
    });

    // API: Create a new terminal
    app.post('/api/terminals', (req: Request, res: Response) => {
      const currentProject = ctx.getCurrentProject();
      const { cwd, name, command, args, useTmux, tmuxSessionName } = req.body as CreateTerminalOptions & { command?: string; args?: string[] };

      const targetCwd = cwd || currentProject.path;

      if (!existsSync(targetCwd)) {
        res.status(400).json({ error: `Directory does not exist: ${targetCwd}` });
        return;
      }

      try {
        const projectEnv = loadProjectEnv(currentProject.path);
        if (projectEnv.sources.length > 0) {
          console.log(`[Server] Loaded env from: ${projectEnv.sources.length} files`);
        }

        const terminal = terminalManager.create({
          cwd: targetCwd,
          name,
          command,
          args,
          env: projectEnv.env,
          useTmux: useTmux !== false,
          tmuxSessionName,
        });

        res.status(201).json({
          terminalId: terminal.id,
          name: terminal.name,
          cwd: terminal.cwd,
          pid: terminal.pid,
          tmuxSession: terminal.tmuxSession,
        });
      } catch (err) {
        console.error('Failed to create terminal:', err);
        res.status(500).json({ error: 'Failed to create terminal' });
      }
    });

    // API: List persisted tmux sessions
    // NOTE: MUST be defined BEFORE /api/terminals/:id
    app.get('/api/terminals/persisted', (_req: Request, res: Response) => {
      try {
        const tmuxAvailable = terminalManager.isTmuxAvailable();
        if (!tmuxAvailable) {
          res.json({
            available: false,
            sessions: [],
            message: 'tmux not available on this system',
          });
          return;
        }

        const sessions = terminalManager.listTmuxSessions();
        res.json({
          available: true,
          sessions,
        });
      } catch (err) {
        console.error('Failed to list persisted sessions:', err);
        res.status(500).json({ error: 'Failed to list persisted sessions' });
      }
    });

    // API: Reconnect to a persisted tmux session
    // NOTE: MUST be defined BEFORE /api/terminals/:id
    app.post('/api/terminals/reconnect', (req: Request, res: Response) => {
      const currentProject = ctx.getCurrentProject();
      const { sessionName, cwd } = req.body;

      if (!sessionName) {
        res.status(400).json({ error: 'sessionName is required' });
        return;
      }

      const targetCwd = cwd || currentProject.path;

      if (!existsSync(targetCwd)) {
        res.status(400).json({ error: `Directory does not exist: ${targetCwd}` });
        return;
      }

      try {
        const projectEnv = loadProjectEnv(currentProject.path);
        const terminal = terminalManager.reconnect(sessionName, targetCwd, projectEnv.env);

        if (!terminal) {
          res.status(404).json({
            error: 'Session not found or cannot reconnect',
            sessionName,
          });
          return;
        }

        res.status(200).json({
          terminalId: terminal.id,
          name: terminal.name,
          cwd: terminal.cwd,
          pid: terminal.pid,
          tmuxSession: terminal.tmuxSession,
          reconnected: true,
        });
      } catch (err) {
        console.error('Failed to reconnect to session:', err);
        res.status(500).json({ error: 'Failed to reconnect to session' });
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

      console.log(`[Server] DELETE /api/terminals/${terminalId} - closing terminal`);

      const terminal = terminalManager.get(terminalId);
      const tmuxSession = terminal?.tmuxSession;

      const success = terminalManager.close(terminalId);

      if (!success) {
        console.log(`[Server] Terminal ${terminalId} not found`);
        res.status(404).json({ error: 'Terminal not found' });
        return;
      }

      console.log(`[Server] Terminal ${terminalId} closed successfully`);
      res.json({
        success: true,
        terminalId,
        tmuxSessionKilled: tmuxSession || null,
      });
    });

    // API: Kill tmux session directly
    app.post('/api/terminals/kill-tmux', (req: Request, res: Response) => {
      const { sessionName } = req.body;

      if (!sessionName) {
        res.status(400).json({ error: 'sessionName is required' });
        return;
      }

      console.log(`[Server] POST /api/terminals/kill-tmux - killing tmux session: ${sessionName}`);

      try {
        terminalManager.killTmuxSession(sessionName);
        console.log(`[Server] tmux session ${sessionName} killed successfully`);
        res.json({
          success: true,
          sessionName,
          message: `tmux session ${sessionName} killed`,
        });
      } catch (error) {
        console.error(`[Server] Failed to kill tmux session ${sessionName}:`, error);
        res.status(500).json({
          error: 'Failed to kill tmux session',
          details: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });

    // API: Write to terminal
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

    // API: Get recent terminal output for preview
    app.get('/api/terminals/:id/preview', (req: Request, res: Response) => {
      const terminalId = req.params.id as string;
      const maxLines = parseInt(req.query.lines as string) || 5;

      const lines = terminalManager.getRecentOutput(terminalId, maxLines);

      if (lines.length === 0) {
        const terminal = terminalManager.get(terminalId);
        if (!terminal) {
          res.status(404).json({ error: 'Terminal not found' });
          return;
        }
      }

      res.json({
        terminalId,
        lines,
        timestamp: new Date().toISOString(),
      });
    });

    // API: Detach from terminal
    app.post('/api/terminals/:id/detach', (req: Request, res: Response) => {
      const terminalId = req.params.id as string;
      const terminal = terminalManager.get(terminalId);

      if (!terminal) {
        res.status(404).json({ error: 'Terminal not found' });
        return;
      }

      if (!terminal.tmuxSession) {
        res.status(400).json({
          error: 'Terminal does not have a tmux session, cannot detach',
          hint: 'Use DELETE /api/terminals/:id to close instead',
        });
        return;
      }

      const success = terminalManager.detach(terminalId);

      if (!success) {
        res.status(500).json({ error: 'Failed to detach terminal' });
        return;
      }

      res.json({
        success: true,
        tmuxSession: terminal.tmuxSession,
        message: 'Terminal detached. tmux session preserved for reconnection.',
      });
    });

  } else {
    // Fallback routes when node-pty is not available
    const terminalUnavailableHandler = (_req: Request, res: Response) => {
      res.status(503).json({
        error: 'Embedded terminals are not available',
        reason: 'node-pty is not installed',
        install: 'Run: npm install node-pty',
        note: 'All other Spellbook features work without node-pty',
      });
    };

    app.get('/api/terminals', terminalUnavailableHandler);
    app.post('/api/terminals', terminalUnavailableHandler);
    app.get('/api/terminals/persisted', terminalUnavailableHandler);
    app.post('/api/terminals/reconnect', terminalUnavailableHandler);
    app.get('/api/terminals/:id', terminalUnavailableHandler);
    app.patch('/api/terminals/:id', terminalUnavailableHandler);
    app.delete('/api/terminals/:id', terminalUnavailableHandler);
    app.post('/api/terminals/kill-tmux', terminalUnavailableHandler);
    app.post('/api/terminals/:id/write', terminalUnavailableHandler);
    app.post('/api/terminals/:id/resize', terminalUnavailableHandler);
    app.get('/api/terminals/:id/preview', terminalUnavailableHandler);
    app.post('/api/terminals/:id/detach', terminalUnavailableHandler);
  }
}
