import * as pty from 'node-pty';
import { WebSocket, WebSocketServer } from 'ws';
import { randomUUID } from 'crypto';
import { execSync } from 'child_process';
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
  tmuxSession?: string; // tmux session name if using tmux
  outputBuffer: string[]; // Circular buffer of recent output lines for preview
}

export interface TerminalInfo {
  id: string;
  name: string;
  cwd: string;
  status: string;
  pid: number;
  createdAt: string;
  lastActivity: string;
  tmuxSession?: string;
}

export interface TmuxSessionInfo {
  name: string;
  created: Date;
  attached: boolean;
  windows: number;
}

export interface CreateTerminalOptions {
  cwd: string;
  name?: string;
  command?: string;
  args?: string[];
  /** Additional environment variables to pass to the terminal */
  env?: Record<string, string>;
  /** Use tmux for session persistence */
  useTmux?: boolean;
  /** Specific tmux session name (defaults to terminal name) */
  tmuxSessionName?: string;
}

export class TerminalManager {
  private terminals: Map<string, Terminal> = new Map();
  private wss: WebSocketServer | null = null;
  private tmuxAvailable: boolean | null = null;
  private readonly TMUX_SESSION_PREFIX = 'spellbook-';
  private readonly OUTPUT_BUFFER_MAX_LINES = 50; // Keep last 50 lines for preview

  /**
   * Check if tmux is available on the system
   */
  isTmuxAvailable(): boolean {
    if (this.tmuxAvailable !== null) {
      return this.tmuxAvailable;
    }

    try {
      execSync('which tmux', { stdio: 'pipe' });
      this.tmuxAvailable = true;
      console.log('[TerminalManager] tmux is available');
    } catch {
      this.tmuxAvailable = false;
      console.log('[TerminalManager] tmux is not available, session persistence disabled');
    }

    return this.tmuxAvailable;
  }

  /**
   * Get the tmux session name for a given terminal name
   */
  private getTmuxSessionName(name: string): string {
    // Sanitize session name (tmux doesn't allow dots or colons)
    const sanitized = name.replace(/[.:]/g, '-');
    return `${this.TMUX_SESSION_PREFIX}${sanitized}`;
  }

  /**
   * List all spellbook tmux sessions
   */
  listTmuxSessions(): TmuxSessionInfo[] {
    if (!this.isTmuxAvailable()) {
      return [];
    }

    try {
      const output = execSync('tmux list-sessions -F "#{session_name}|#{session_created}|#{session_attached}|#{session_windows}"', {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const sessions: TmuxSessionInfo[] = [];
      for (const line of output.trim().split('\n')) {
        if (!line) continue;
        const [name, created, attached, windows] = line.split('|');
        if (name.startsWith(this.TMUX_SESSION_PREFIX)) {
          sessions.push({
            name: name.replace(this.TMUX_SESSION_PREFIX, ''),
            created: new Date(parseInt(created) * 1000),
            attached: attached === '1',
            windows: parseInt(windows) || 1,
          });
        }
      }

      return sessions;
    } catch (err) {
      // No sessions exist or tmux server not running
      return [];
    }
  }

  /**
   * Check if a specific tmux session exists
   */
  tmuxSessionExists(sessionName: string): boolean {
    if (!this.isTmuxAvailable()) {
      return false;
    }

    const fullName = this.getTmuxSessionName(sessionName);
    try {
      execSync(`tmux has-session -t "${fullName}"`, { stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Kill a tmux session and all its child processes
   */
  killTmuxSession(sessionName: string): boolean {
    console.log(`[TerminalManager] killTmuxSession called with sessionName: ${sessionName}`);

    if (!this.isTmuxAvailable()) {
      console.log('[TerminalManager] Cannot kill tmux session: tmux not available');
      return false;
    }

    const fullName = this.getTmuxSessionName(sessionName);
    console.log(`[TerminalManager] Full tmux session name: ${fullName}`);

    // First check if the session exists
    const sessionExists = this.tmuxSessionExists(sessionName);
    console.log(`[TerminalManager] Session exists check: ${sessionExists}`);

    try {
      // First, try to get PIDs of processes running in the tmux session
      // This ensures we kill any child processes (like claude, node, etc.)
      try {
        const pidsOutput = execSync(
          `tmux list-panes -t "${fullName}" -F "#{pane_pid}"`,
          { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
        );
        const pids = pidsOutput.trim().split('\n').filter(Boolean);
        console.log(`[TerminalManager] Found pane PIDs: ${pids.join(', ')}`);

        for (const pid of pids) {
          try {
            // Kill the process tree for each pane
            // Using SIGTERM first, then SIGKILL if needed
            console.log(`[TerminalManager] Sending SIGTERM to process tree for PID ${pid}`);
            execSync(`pkill -TERM -P ${pid} 2>/dev/null || true`, { stdio: 'pipe' });
            execSync(`kill -TERM ${pid} 2>/dev/null || true`, { stdio: 'pipe' });
          } catch {
            // Ignore errors - process might already be dead
          }
        }

        // Give processes a moment to terminate gracefully
        // Then force kill any stragglers
        setTimeout(() => {
          for (const pid of pids) {
            try {
              console.log(`[TerminalManager] Sending SIGKILL to process tree for PID ${pid}`);
              execSync(`pkill -KILL -P ${pid} 2>/dev/null || true`, { stdio: 'pipe' });
              execSync(`kill -KILL ${pid} 2>/dev/null || true`, { stdio: 'pipe' });
            } catch {
              // Ignore
            }
          }
        }, 100);

      } catch (listErr) {
        // Session might not exist or already be dead
        const listErrMsg = listErr instanceof Error ? listErr.message : String(listErr);
        console.log(`[TerminalManager] Could not list panes for ${fullName}: ${listErrMsg}`);
      }

      // Now kill the tmux session itself
      console.log(`[TerminalManager] Executing: tmux kill-session -t "${fullName}"`);
      execSync(`tmux kill-session -t "${fullName}"`, { stdio: 'pipe' });
      console.log(`[TerminalManager] Killed tmux session: ${fullName}`);

      // Verify the session is gone
      const stillExists = this.tmuxSessionExists(sessionName);
      console.log(`[TerminalManager] Session still exists after kill: ${stillExists}`);

      return true;
    } catch (err) {
      // Log the actual error for debugging
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.log(`[TerminalManager] Failed to kill tmux session ${fullName}: ${errorMsg}`);

      // Try one more time with force
      try {
        console.log(`[TerminalManager] Retrying kill with 2>/dev/null || true`);
        execSync(`tmux kill-session -t "${fullName}" 2>/dev/null || true`, { stdio: 'pipe' });
      } catch {
        // Truly failed
        console.log(`[TerminalManager] Retry also failed`);
      }

      return false;
    }
  }

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

    // Determine if we should use tmux
    const useTmux = options.useTmux !== false && this.isTmuxAvailable();
    const terminalName = options.name || `Terminal ${this.terminals.size + 1}`;
    const tmuxSessionName = options.tmuxSessionName || terminalName;

    console.log(`[TerminalManager] Creating terminal ${id} in ${options.cwd}`);
    console.log(`[TerminalManager] Command: ${command} ${args.join(' ')}`);
    console.log(`[TerminalManager] Using tmux: ${useTmux}`);

    // Merge process env with any custom env vars (e.g., from project .env files)
    const terminalEnv = {
      ...process.env,
      ...(options.env || {}),
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      SPELLBOOK_TERMINAL: id,
    };

    let ptyProcess: pty.IPty;
    let tmuxSession: string | undefined;

    if (useTmux) {
      const fullTmuxName = this.getTmuxSessionName(tmuxSessionName);
      tmuxSession = tmuxSessionName;

      // Build the command to run inside tmux
      const fullCommand = args.length > 0 ? `${command} ${args.join(' ')}` : command;

      // Wrap the command in a bash shell that persists after the command exits.
      // This allows users to run `claude --resume` or other commands after Claude exits,
      // instead of the tmux session closing immediately.
      const wrappedCommand = `bash -c '${fullCommand.replace(/'/g, "'\\''")}; exec bash'`;

      // Create tmux session with the wrapped command
      // Use new-session with -d to create detached, then attach
      ptyProcess = pty.spawn('tmux', [
        'new-session',
        '-d',          // Start detached
        '-s', fullTmuxName,
        '-x', '120',   // Width
        '-y', '30',    // Height
        wrappedCommand,
      ], {
        name: 'xterm-256color',
        cols: 120,
        rows: 30,
        cwd: options.cwd,
        env: terminalEnv,
      });

      // Wait briefly for session to be created, then attach
      // We need to kill this initial process and spawn an attach
      setTimeout(() => {
        try {
          ptyProcess.kill();
        } catch {
          // Ignore if already dead
        }

        // Configure tmux for better UI experience
        try {
          // Disable status bar for cleaner terminal UI
          execSync(`tmux set-option -t "${fullTmuxName}" status off`, { stdio: 'pipe' });
          // Enable mouse mode for scroll support
          execSync(`tmux set-option -t "${fullTmuxName}" mouse on`, { stdio: 'pipe' });
        } catch {
          // Ignore if setting fails
        }
      }, 100);

      // Spawn a new PTY that attaches to the tmux session
      setTimeout(() => {
        const terminal = this.terminals.get(id);
        if (terminal) {
          const attachProcess = pty.spawn('tmux', [
            'attach-session',
            '-t', fullTmuxName,
          ], {
            name: 'xterm-256color',
            cols: 120,
            rows: 30,
            cwd: options.cwd,
            env: terminalEnv,
          });

          terminal.pty = attachProcess;
          terminal.pid = attachProcess.pid;

          this.setupPtyHandlers(terminal, attachProcess);
          console.log(`[TerminalManager] Attached to tmux session: ${fullTmuxName}`);
        }
      }, 200);

      console.log(`[TerminalManager] Created tmux session: ${fullTmuxName}`);
    } else {
      // Standard PTY without tmux
      ptyProcess = pty.spawn(command, args, {
        name: 'xterm-256color',
        cols: 120,
        rows: 30,
        cwd: options.cwd,
        env: terminalEnv,
      });
    }

    const terminal: Terminal = {
      id,
      name: terminalName,
      cwd: options.cwd,
      pty: ptyProcess,
      ws: null,
      status: 'idle',
      pid: ptyProcess.pid,
      createdAt: new Date(),
      lastActivity: new Date(),
      tmuxSession,
      outputBuffer: [],
    };

    if (!useTmux) {
      this.setupPtyHandlers(terminal, ptyProcess);
    }

    this.terminals.set(id, terminal);
    console.log(`[TerminalManager] Terminal ${id} created with PID ${ptyProcess.pid}`);

    return terminal;
  }

  /**
   * Set up PTY event handlers for a terminal
   */
  private setupPtyHandlers(terminal: Terminal, ptyProcess: pty.IPty): void {
    // Forward PTY output to WebSocket
    ptyProcess.onData((data) => {
      terminal.lastActivity = new Date();
      terminal.status = 'running';

      // Buffer output for preview functionality
      this.appendToOutputBuffer(terminal, data);

      if (terminal.ws && terminal.ws.readyState === WebSocket.OPEN) {
        terminal.ws.send(JSON.stringify({
          type: 'output',
          data,
        }));
      }
    });

    // Handle PTY exit
    ptyProcess.onExit(({ exitCode, signal }) => {
      console.log(`[TerminalManager] Terminal ${terminal.id} exited with code ${exitCode}, signal ${signal}`);
      terminal.status = 'closed';

      if (terminal.ws && terminal.ws.readyState === WebSocket.OPEN) {
        terminal.ws.send(JSON.stringify({
          type: 'exit',
          exitCode,
          signal,
        }));
      }
    });
  }

  /**
   * Reconnect to an existing tmux session
   */
  reconnect(sessionName: string, cwd: string, env?: Record<string, string>): Terminal | null {
    if (!this.isTmuxAvailable()) {
      console.log('[TerminalManager] Cannot reconnect: tmux not available');
      return null;
    }

    const fullTmuxName = this.getTmuxSessionName(sessionName);

    // Check if session exists
    if (!this.tmuxSessionExists(sessionName)) {
      console.log(`[TerminalManager] Cannot reconnect: tmux session ${fullTmuxName} does not exist`);
      return null;
    }

    const id = randomUUID();
    const terminalEnv = {
      ...process.env,
      ...(env || {}),
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      SPELLBOOK_TERMINAL: id,
    };

    console.log(`[TerminalManager] Reconnecting to tmux session: ${fullTmuxName}`);

    // Ensure tmux settings are applied (in case session was created before these were added)
    try {
      execSync(`tmux set-option -t "${fullTmuxName}" status off`, { stdio: 'pipe' });
      execSync(`tmux set-option -t "${fullTmuxName}" mouse on`, { stdio: 'pipe' });
    } catch {
      // Ignore if setting fails
    }

    const ptyProcess = pty.spawn('tmux', [
      'attach-session',
      '-t', fullTmuxName,
    ], {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd,
      env: terminalEnv,
    });

    const terminal: Terminal = {
      id,
      name: sessionName,
      cwd,
      pty: ptyProcess,
      ws: null,
      status: 'idle',
      pid: ptyProcess.pid,
      createdAt: new Date(),
      lastActivity: new Date(),
      tmuxSession: sessionName,
      outputBuffer: [],
    };

    this.setupPtyHandlers(terminal, ptyProcess);

    this.terminals.set(id, terminal);
    console.log(`[TerminalManager] Reconnected terminal ${id} to tmux session ${fullTmuxName}`);

    return terminal;
  }

  /**
   * Get terminal by ID
   */
  get(id: string): Terminal | undefined {
    return this.terminals.get(id);
  }

  /**
   * Append output data to terminal's buffer for preview
   * Handles ANSI escape sequences and line splitting
   */
  private appendToOutputBuffer(terminal: Terminal, data: string): void {
    // Strip most ANSI escape sequences for cleaner preview
    const cleanData = data
      .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '') // CSI sequences
      .replace(/\x1b\][^\x07]*\x07/g, '')     // OSC sequences
      .replace(/\x1b[PX^_][^\x1b]*\x1b\\/g, '') // DCS/APC/etc sequences
      .replace(/\r/g, '');                     // Carriage returns

    // Split into lines and append to buffer
    const lines = cleanData.split('\n');

    for (const line of lines) {
      if (line.length > 0) {
        terminal.outputBuffer.push(line);
      }
    }

    // Keep buffer within max size (circular buffer behavior)
    while (terminal.outputBuffer.length > this.OUTPUT_BUFFER_MAX_LINES) {
      terminal.outputBuffer.shift();
    }
  }

  /**
   * Get recent output lines for a terminal (for preview)
   */
  getRecentOutput(id: string, maxLines: number = 5): string[] {
    const terminal = this.terminals.get(id);
    if (!terminal) {
      return [];
    }

    // Return last N lines from buffer
    const startIdx = Math.max(0, terminal.outputBuffer.length - maxLines);
    return terminal.outputBuffer.slice(startIdx);
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
      tmuxSession: t.tmuxSession,
    }));
  }

  /**
   * Close a terminal
   * @param killTmux If true and terminal has a tmux session, also kill the tmux session
   */
  close(id: string, killTmux: boolean = true): boolean {
    console.log(`[TerminalManager] close() called with id: ${id}, killTmux: ${killTmux}`);
    console.log(`[TerminalManager] Current terminals in map: ${Array.from(this.terminals.keys()).join(', ')}`);

    const terminal = this.terminals.get(id);
    if (!terminal) {
      console.log(`[TerminalManager] Terminal ${id} not found, nothing to close`);
      return false;
    }

    console.log(`[TerminalManager] Closing terminal ${id} (pid: ${terminal.pid}, tmux: ${terminal.tmuxSession || 'none'}, status: ${terminal.status})`);

    // Close WebSocket first to stop I/O
    if (terminal.ws && terminal.ws.readyState === WebSocket.OPEN) {
      console.log(`[TerminalManager] Closing WebSocket for terminal ${id}`);
      terminal.ws.close(1000, 'Terminal closed');
    } else {
      console.log(`[TerminalManager] WebSocket already closed or null for terminal ${id}`);
    }
    terminal.ws = null;

    // Kill tmux session BEFORE killing PTY if requested
    // This ensures all processes in the tmux session are terminated
    if (killTmux && terminal.tmuxSession) {
      console.log(`[TerminalManager] Killing tmux session: ${terminal.tmuxSession}`);
      const killed = this.killTmuxSession(terminal.tmuxSession);
      console.log(`[TerminalManager] Tmux session kill result: ${killed}`);
    } else {
      console.log(`[TerminalManager] Skipping tmux kill (killTmux: ${killTmux}, tmuxSession: ${terminal.tmuxSession})`);
    }

    // Kill PTY process (this is the tmux attach-session process)
    try {
      console.log(`[TerminalManager] Killing PTY process for terminal ${id}`);
      terminal.pty.kill();
      console.log(`[TerminalManager] Killed PTY process for terminal ${id}`);
    } catch (err) {
      console.log(`[TerminalManager] PTY kill failed (may already be dead): ${err}`);
    }

    // Also try to kill by PID directly as a fallback
    if (terminal.pid) {
      try {
        console.log(`[TerminalManager] Force killing PID ${terminal.pid}`);
        execSync(`kill -9 ${terminal.pid} 2>/dev/null || true`, { stdio: 'pipe' });
      } catch {
        // Process might already be dead
      }
    }

    // Remove from map
    this.terminals.delete(id);

    console.log(`[TerminalManager] Terminal ${id} closed successfully`);
    return true;
  }

  /**
   * Detach from a terminal without killing the tmux session
   * This allows reconnecting later
   */
  detach(id: string): boolean {
    const terminal = this.terminals.get(id);
    if (!terminal) {
      console.log(`[TerminalManager] Terminal ${id} not found, nothing to detach`);
      return false;
    }
    if (!terminal.tmuxSession) {
      // No tmux session, just close normally (without killing non-existent tmux)
      console.log(`[TerminalManager] Terminal ${id} has no tmux session, closing instead of detaching`);
      return this.close(id, false);
    }

    console.log(`[TerminalManager] Detaching from terminal ${id} (tmux session ${terminal.tmuxSession} preserved)`);

    // Close WebSocket
    if (terminal.ws && terminal.ws.readyState === WebSocket.OPEN) {
      terminal.ws.close(1000, 'Terminal detached');
    }
    terminal.ws = null;

    // Kill PTY process (but not tmux session)
    try {
      terminal.pty.kill();
      console.log(`[TerminalManager] Killed PTY attach process for terminal ${id}`);
    } catch (err) {
      console.log(`[TerminalManager] PTY kill failed (may already be dead): ${err}`);
    }

    // Remove from map
    this.terminals.delete(id);

    console.log(`[TerminalManager] Terminal ${id} detached, tmux session ${terminal.tmuxSession} still running`);
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
