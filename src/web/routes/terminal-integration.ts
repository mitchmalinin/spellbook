import { Request, Response } from 'express';
import { execSync } from 'child_process';
import { escapeAppleScript, extractWorkItemReference } from '../helpers/applescript.js';
import { loadWorktreeConfig, loadWorktreeRegistry, getAiCommand } from '../helpers/worktree.js';
import type { RouteContext } from '../types.js';

/**
 * Try to focus a Ghostty window whose title contains the search term.
 * Returns the matched window title if found, or null if no match.
 */
function focusGhosttyWindow(searchTerm: string): string | null {
  const safeSearch = searchTerm.replace(/"/g, '\\"');
  const focusScript = `
    tell application "Ghostty" to activate
    tell application "System Events"
      tell process "ghostty"
        repeat with w in windows
          if title of w contains "${safeSearch}" then
            perform action "AXRaise" of w
            return "focused:" & title of w
          end if
        end repeat
      end tell
    end tell
    return "not_found"
  `;
  const result = execSync(`osascript -e '${focusScript.replace(/'/g, "'\"'\"'")}'`, {
    encoding: 'utf-8',
    timeout: 5000,
  }).trim();

  if (result.startsWith('focused:')) {
    return result.replace('focused:', '');
  }
  return null;
}

export function registerTerminalIntegrationRoutes(ctx: RouteContext): void {
  const { app } = ctx;

  // API: Open terminal based on config (generic - supports iTerm2 and Ghostty)
  app.post('/api/terminal/open', (req: Request, res: Response) => {
    const currentProject = ctx.getCurrentProject();
    const { sessionName, workingDir, command, aiTool } = req.body;

    if (!sessionName) {
      res.status(400).json({ error: 'sessionName is required' });
      return;
    }

    const wtConfig = loadWorktreeConfig();
    const terminal = wtConfig.terminal || 'iterm2';
    const dir = workingDir || currentProject.path;
    const baseCmd = command || getAiCommand(wtConfig, aiTool);

    try {
      if (terminal === 'ghostty') {
        let matchedTitle: string | null = null;
        try {
          matchedTitle = focusGhosttyWindow(sessionName);
        } catch {
          // AppleScript failed - fall through to open new
        }

        if (matchedTitle) {
          res.json({ success: true, focused: true, message: `Focused existing Ghostty window: ${sessionName}` });
        } else {
          const safeDir = dir.replace(/'/g, "'\\''");
          const safeTitle = sessionName.replace(/'/g, "'\\''");
          const safeCmd = baseCmd.replace(/'/g, "'\\''");

          execSync(`open -na "Ghostty.app" --args --working-directory='${safeDir}' --title='${safeTitle}' -e /bin/zsh -c '${safeCmd}; exec /bin/zsh -l -i'`, {
            stdio: 'pipe',
          });
          res.json({ success: true, focused: false, message: `Opened new Ghostty: ${sessionName}` });
        }
      } else {
        res.redirect(307, '/api/iterm/open');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[Terminal] Failed to open ${terminal}:`, err);
      res.status(500).json({ error: `Terminal error: ${message}` });
    }
  });

  // API: List terminal sessions (generic)
  app.get('/api/terminal/sessions', (_req: Request, res: Response) => {
    const wtConfig = loadWorktreeConfig();
    const terminal = wtConfig.terminal || 'iterm2';

    if (terminal === 'ghostty') {
      try {
        const registry = loadWorktreeRegistry();
        const sessions = registry.worktrees
          .filter(w => w.status === 'active')
          .map(w => {
            const sessionName = w.worktreePath.split('/').slice(-2).join('/');
            const matchedItem = extractWorkItemReference(w.branch || '') || extractWorkItemReference(w.task || '');

            let hasClaude = false;
            try {
              const psResult = execSync(
                `ps aux | grep -v grep | grep claude | grep '${w.worktreePath}' | head -1`,
                { encoding: 'utf-8', timeout: 2000, stdio: ['pipe', 'pipe', 'pipe'] }
              ).trim();
              hasClaude = psResult.length > 0;
            } catch {
              hasClaude = false;
            }

            if (!hasClaude && w.agentLaunchedAt) {
              try {
                const anyClaudeResult = execSync(
                  `pgrep -f "claude" > /dev/null 2>&1 && echo "yes" || echo "no"`,
                  { encoding: 'utf-8', timeout: 2000 }
                ).trim();
                hasClaude = anyClaudeResult === 'yes';
              } catch {
                hasClaude = false;
              }
            }

            return {
              name: sessionName,
              tty: '',
              hasClaude,
              matchedItem,
              isFocused: false,
              worktreePath: w.worktreePath,
            };
          });
        res.json({ sessions, terminal: 'ghostty' });
      } catch (err) {
        console.error('[Terminal] Failed to get Ghostty sessions:', err);
        res.json({ sessions: [], terminal: 'ghostty' });
      }
    } else {
      res.redirect(307, '/api/iterm/sessions');
    }
  });

  // API: Focus terminal (bring to front)
  app.post('/api/terminal/focus', (req: Request, res: Response) => {
    const wtConfig = loadWorktreeConfig();
    const terminal = wtConfig.terminal || 'iterm2';

    if (terminal === 'ghostty') {
      const { sessionName, worktreePath } = req.body || {};
      const searchTerm = sessionName || worktreePath?.split('/').slice(-2).join('/') || '';
      try {
        if (searchTerm) {
          const matchedTitle = focusGhosttyWindow(searchTerm);
          if (matchedTitle) {
            res.json({ success: true, message: `Focused Ghostty window: ${matchedTitle}` });
          } else {
            execSync(`open -a "Ghostty.app"`, { stdio: 'pipe' });
            res.json({ success: true, message: 'No matching window found, brought Ghostty to front' });
          }
        } else {
          execSync(`open -a "Ghostty.app"`, { stdio: 'pipe' });
          res.json({ success: true, message: 'Brought Ghostty to front' });
        }
      } catch {
        try {
          execSync(`open -a "Ghostty.app"`, { stdio: 'pipe' });
          res.json({ success: true, message: 'Brought Ghostty to front (fallback)' });
        } catch (fallbackErr) {
          const message = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
          res.status(500).json({ error: `Failed to focus Ghostty: ${message}` });
        }
      }
    } else {
      res.redirect(307, '/api/iterm/open');
    }
  });

  // API: Open or focus iTerm tab
  app.post('/api/iterm/open', (req: Request, res: Response) => {
    const currentProject = ctx.getCurrentProject();
    const { sessionName, workingDir, command, tty } = req.body;

    if (!sessionName) {
      res.status(400).json({ error: 'sessionName is required' });
      return;
    }

    const safeSessionName = escapeAppleScript(sessionName);
    const safeTty = tty ? escapeAppleScript(tty) : '';

    const dir = workingDir || currentProject.path;
    const baseCmd = command || 'claude --dangerously-skip-permissions';
    const cmd = `printf '\\e]1;${sessionName}\\a' && ${baseCmd}`;

    try {
      if (tty) {
        const focusByTtyScript = `
          tell application "iTerm2"
            activate
            set targetTTY to "${safeTty}"

            repeat with winIndex from 1 to count of windows
              set w to window winIndex
              repeat with tabIndex from 1 to count of tabs of w
                set t to tab tabIndex of w
                try
                  set sess to current session of t
                  set sessTTY to tty of sess
                  if sessTTY is targetTTY then
                    set index of w to 1
                    select t
                    activate
                    return "focused:" & (name of sess)
                  end if
                end try
              end repeat
            end repeat

            return "not_found"
          end tell
        `;

        const ttyFocusResult = execSync(`osascript -e '${focusByTtyScript.replace(/'/g, "'\"'\"'")}'`, {
          encoding: 'utf-8',
          timeout: 5000,
        }).trim();

        if (ttyFocusResult.startsWith('focused:')) {
          const foundName = ttyFocusResult.substring(8);
          res.json({ success: true, focused: true, message: `Focused existing tab: ${foundName}` });
          return;
        }
      }

      const focusScript = `
        tell application "iTerm2"
          activate
          set targetName to "${safeSessionName}"

          repeat with winIndex from 1 to count of windows
            set w to window winIndex
            repeat with tabIndex from 1 to count of tabs of w
              set t to tab tabIndex of w
              try
                set sess to current session of t
                set sessName to name of sess

                if sessName contains targetName then
                  set index of w to 1
                  select t
                  activate
                  return "focused:" & sessName
                end if

                try
                  set ttyPath to tty of sess
                  if ttyPath contains targetName then
                    set index of w to 1
                    select t
                    activate
                    return "focused:" & sessName
                  end if
                end try
              end try
            end repeat
          end repeat

          return "not_found"
        end tell
      `;

      const focusResult = execSync(`osascript -e '${focusScript.replace(/'/g, "'\"'\"'")}'`, {
        encoding: 'utf-8',
        timeout: 5000,
      }).trim();

      if (focusResult.startsWith('focused:')) {
        const foundName = focusResult.substring(8);
        res.json({ success: true, focused: true, message: `Focused existing tab: ${foundName}` });
        return;
      }

      const createScript = `
        tell application "iTerm2"
          activate
          if (count of windows) = 0 then
            create window with default profile
          end if
          tell current window
            create tab with default profile
            tell current session
              set name to "${safeSessionName}"
              set variable named "user.spellbook_session" to "${safeSessionName}"
              write text "cd '${dir}' && ${cmd}"
            end tell
          end tell
        end tell
      `;

      execSync(`osascript -e '${createScript.replace(/'/g, "'\"'\"'")}'`, {
        encoding: 'utf-8',
        timeout: 5000,
      });

      // Schedule delayed /rename command
      setTimeout(() => {
        try {
          const renameScript = `
            tell application "iTerm2"
              repeat with w in windows
                repeat with t in tabs of w
                  try
                    set sess to current session of t
                    set spellbookSession to variable named "user.spellbook_session" of sess
                    if spellbookSession is "${safeSessionName}" then
                      tell sess
                        write text "/rename ${safeSessionName}"
                      end tell
                      return "sent"
                    end if
                  end try
                end repeat
              end repeat
              return "not_found"
            end tell
          `;
          execSync(`osascript -e '${renameScript.replace(/'/g, "'\"'\"'")}'`, {
            encoding: 'utf-8',
            timeout: 3000,
          });
        } catch (err) {
          console.warn('[iTerm] Delayed /rename command failed:', err);
        }
      }, 4000);

      res.json({ success: true, focused: false, message: `Created new tab: ${sessionName}` });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[iTerm] Failed to open/focus:', err);
      res.status(500).json({ error: `iTerm error: ${message}` });
    }
  });

  // API: List ALL iTerm sessions
  app.get('/api/iterm/sessions', (_req: Request, res: Response) => {
    try {
      const listScript = `
        tell application "iTerm2"
          set output to ""
          set focusedTTY to ""

          try
            set focusedTTY to tty of current session of current tab of current window
          end try

          repeat with w in windows
            repeat with t in tabs of w
              try
                set sess to current session of t
                set sessName to name of sess
                set sessTTY to tty of sess
                set isFocused to "0"
                if sessTTY is focusedTTY then
                  set isFocused to "1"
                end if
                set output to output & sessName & "|" & sessTTY & "|" & isFocused & linefeed
              end try
            end repeat
          end repeat
          return output
        end tell
      `;

      const result = execSync(`osascript -e '${listScript.replace(/'/g, "'\"'\"'")}'`, {
        encoding: 'utf-8',
        timeout: 5000,
      }).trim();

      const lines = result.split('\n').filter(Boolean);
      const sessions: Array<{
        name: string;
        tty: string;
        hasClaude: boolean;
        matchedItem: string | null;
        isFocused: boolean;
      }> = [];

      for (const line of lines) {
        const [name, tty, focusedFlag] = line.split('|');
        if (!name || !tty) continue;
        const isFocused = focusedFlag === '1';

        const ttyName = tty.replace('/dev/', '');
        let hasClaude = false;
        try {
          const psResult = execSync(`ps -t ${ttyName} -o comm 2>/dev/null | grep -q claude && echo "yes" || echo "no"`, {
            encoding: 'utf-8',
            timeout: 2000,
          }).trim();
          hasClaude = psResult === 'yes';
        } catch {
          hasClaude = false;
        }

        const matchedItem = extractWorkItemReference(name);

        sessions.push({
          name,
          tty,
          hasClaude,
          matchedItem,
          isFocused,
        });
      }

      res.json({ success: true, sessions });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[iTerm] Failed to list sessions:', err);
      res.json({ success: true, sessions: [], error: message });
    }
  });
}
