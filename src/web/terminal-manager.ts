import * as pty from 'node-pty';
import { WebSocket, WebSocketServer } from 'ws';
import { randomUUID } from 'crypto';
import type { Server } from 'http';

export interface Terminal {
  id: string;
  name: string;
  cwd: string;
  pty: pty.IPty;
  ws: WebSocket | null;
  status: 'running' | 'idle' | 'closed';
  pid: number;
  createdAt: Date;
  lastActivity: Date;
}

export interface TerminalInfo {
  id: string;
  name: string;
  cwd: string;
  status: string;
  pid: number;
  createdAt: string;
  lastActivity: string;
}

export interface CreateTerminalOptions {
  cwd: string;
  name?: string;
  command?: string;
  args?: string[];
  /** Additional environment variables to pass to the terminal */
  env?: Record<string, string>;
}

export class TerminalManager {
  private terminals: Map<string, Terminal> = new Map();
  private wss: WebSocketServer | null = null;

  /**
   * Initialize WebSocket server for terminal I/O
   */
  attachToServer(server: Server): void {
    this.wss = new WebSocketServer({ server, path: '/ws/terminal' });

    this.wss.on('connection', (ws, req) => {
      const url = new URL(req.url || '', 'http://localhost');
      const terminalId = url.searchParams.get('id');

      if (!terminalId) {
        ws.close(4000, 'Terminal ID required');
        return;
      }

      const terminal = this.terminals.get(terminalId);
      if (!terminal) {
        ws.close(4004, 'Terminal not found');
        return;
      }

      // Disconnect any existing connection
      if (terminal.ws && terminal.ws.readyState === WebSocket.OPEN) {
        terminal.ws.close(4001, 'Replaced by new connection');
      }

      terminal.ws = ws;
      terminal.status = 'running';
      terminal.lastActivity = new Date();

      console.log(`[TerminalManager] WebSocket connected to terminal ${terminalId}`);

      // Send initial message
      ws.send(JSON.stringify({
        type: 'connected',
        terminalId,
        cwd: terminal.cwd,
        name: terminal.name,
      }));

      // Handle incoming messages from browser
      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());

          switch (msg.type) {
            case 'input':
              // Send input to PTY
              terminal.pty.write(msg.data);
              terminal.lastActivity = new Date();
              terminal.status = 'running';
              break;

            case 'resize':
              // Resize PTY
              if (msg.cols && msg.rows) {
                terminal.pty.resize(msg.cols, msg.rows);
              }
              break;

            case 'ping':
              // Respond to keep-alive ping
              ws.send(JSON.stringify({ type: 'pong' }));
              break;
          }
        } catch (err) {
          console.error('[TerminalManager] Error parsing message:', err);
        }
      });

      // Handle WebSocket close
      ws.on('close', () => {
        console.log(`[TerminalManager] WebSocket disconnected from terminal ${terminalId}`);
        if (terminal.ws === ws) {
          terminal.ws = null;
          // Don't change status to closed - PTY is still running
          terminal.status = 'idle';
        }
      });

      ws.on('error', (err) => {
        console.error(`[TerminalManager] WebSocket error for terminal ${terminalId}:`, err);
      });
    });

    console.log('[TerminalManager] WebSocket server attached at /ws/terminal');
  }

  /**
   * Create a new terminal
   */
  create(options: CreateTerminalOptions): Terminal {
    const id = randomUUID();
    const shell = process.env.SHELL || '/bin/bash';

    // Determine what command to run
    const command = options.command || shell;
    const args = options.args || [];

    console.log(`[TerminalManager] Creating terminal ${id} in ${options.cwd}`);
    console.log(`[TerminalManager] Command: ${command} ${args.join(' ')}`);

    // Merge process env with any custom env vars (e.g., from project .env files)
    const terminalEnv = {
      ...process.env,
      ...(options.env || {}),
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      SPELLBOOK_TERMINAL: id,
    };

    const ptyProcess = pty.spawn(command, args, {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: options.cwd,
      env: terminalEnv,
    });

    const terminal: Terminal = {
      id,
      name: options.name || `Terminal ${this.terminals.size + 1}`,
      cwd: options.cwd,
      pty: ptyProcess,
      ws: null,
      status: 'idle',
      pid: ptyProcess.pid,
      createdAt: new Date(),
      lastActivity: new Date(),
    };

    // Forward PTY output to WebSocket
    ptyProcess.onData((data) => {
      terminal.lastActivity = new Date();
      terminal.status = 'running';

      if (terminal.ws && terminal.ws.readyState === WebSocket.OPEN) {
        terminal.ws.send(JSON.stringify({
          type: 'output',
          data,
        }));
      }
    });

    // Handle PTY exit
    ptyProcess.onExit(({ exitCode, signal }) => {
      console.log(`[TerminalManager] Terminal ${id} exited with code ${exitCode}, signal ${signal}`);
      terminal.status = 'closed';

      if (terminal.ws && terminal.ws.readyState === WebSocket.OPEN) {
        terminal.ws.send(JSON.stringify({
          type: 'exit',
          exitCode,
          signal,
        }));
      }
    });

    this.terminals.set(id, terminal);
    console.log(`[TerminalManager] Terminal ${id} created with PID ${ptyProcess.pid}`);

    return terminal;
  }

  /**
   * Get terminal by ID
   */
  get(id: string): Terminal | undefined {
    return this.terminals.get(id);
  }

  /**
   * List all terminals
   */
  list(): TerminalInfo[] {
    return Array.from(this.terminals.values()).map((t) => ({
      id: t.id,
      name: t.name,
      cwd: t.cwd,
      status: t.status,
      pid: t.pid,
      createdAt: t.createdAt.toISOString(),
      lastActivity: t.lastActivity.toISOString(),
    }));
  }

  /**
   * Close a terminal
   */
  close(id: string): boolean {
    const terminal = this.terminals.get(id);
    if (!terminal) return false;

    console.log(`[TerminalManager] Closing terminal ${id}`);

    // Close WebSocket
    if (terminal.ws && terminal.ws.readyState === WebSocket.OPEN) {
      terminal.ws.close(1000, 'Terminal closed');
    }

    // Kill PTY process
    terminal.pty.kill();

    // Remove from map
    this.terminals.delete(id);

    return true;
  }

  /**
   * Close all terminals (for server shutdown)
   */
  closeAll(): void {
    console.log(`[TerminalManager] Closing all ${this.terminals.size} terminals`);
    for (const id of this.terminals.keys()) {
      this.close(id);
    }
  }

  /**
   * Rename a terminal
   */
  rename(id: string, name: string): boolean {
    const terminal = this.terminals.get(id);
    if (!terminal) return false;

    terminal.name = name;
    return true;
  }

  /**
   * Send input to a terminal
   */
  write(id: string, data: string): boolean {
    const terminal = this.terminals.get(id);
    if (!terminal || terminal.status === 'closed') return false;

    terminal.pty.write(data);
    terminal.lastActivity = new Date();
    return true;
  }

  /**
   * Resize a terminal
   */
  resize(id: string, cols: number, rows: number): boolean {
    const terminal = this.terminals.get(id);
    if (!terminal || terminal.status === 'closed') return false;

    terminal.pty.resize(cols, rows);
    return true;
  }
}

// Singleton instance
export const terminalManager = new TerminalManager();
