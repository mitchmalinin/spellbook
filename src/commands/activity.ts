import { Command } from 'commander';
import chalk from 'chalk';
import Table from 'cli-table3';
import {
  getRecentActivity,
  getActivityByItem,
  logActivity,
} from '../db/index.js';
import { getCurrentProject } from '../utils/project.js';
import { error, formatRelativeTime, truncate, parseRef } from '../utils/format.js';

export const activityCommand = new Command('activity')
  .description('View activity log or add changelog entry')
  .argument('[ref]', 'Reference to filter by (e.g., bug-44)')
  .option('-n, --limit <number>', 'Number of entries to show', '20')
  .option('-a, --add <message>', 'Add a changelog entry')
  .option('--json', 'Output as JSON')
  .action(async (ref: string | undefined, options) => {
    try {
      const context = getCurrentProject();
      if (!context) {
        error('Not in a Spellbook project. Run `spellbook init` first.');
        process.exit(1);
      }

      const { project } = context;

      // Add mode
      if (options.add && ref) {
        const parsed = parseRef(ref);
        if (!parsed) {
          error('Invalid reference format. Use: bug-44 or improvement-31');
          process.exit(1);
        }

        logActivity({
          project_id: project.id,
          item_type: parsed.type,
          item_ref: ref,
          action: 'changed',
          message: options.add,
          author: 'Spellbook',
        });

        console.log(chalk.green('✓'), `Logged activity for ${ref}: ${options.add}`);
        return;
      }

      // View mode
      const activities = ref
        ? getActivityByItem(project.id, ref)
        : getRecentActivity(project.id, parseInt(options.limit, 10));

      if (options.json) {
        console.log(JSON.stringify(activities, null, 2));
        return;
      }

      const title = ref ? `ACTIVITY FOR ${ref.toUpperCase()}` : 'RECENT ACTIVITY';
      console.log(chalk.bold.white(title));
      console.log('');

      if (activities.length === 0) {
        console.log(chalk.gray('No activity found.'));
        return;
      }

      const table = new Table({
        head: [
          chalk.gray('Time'),
          chalk.gray('Item'),
          chalk.gray('Action'),
          chalk.gray('Message'),
        ],
        style: { head: [], border: [] },
        colWidths: [15, 18, 12, 40],
      });

      for (const activity of activities) {
        const actionColor =
          activity.action === 'completed'
            ? chalk.green
            : activity.action === 'started'
            ? chalk.yellow
            : chalk.white;

        table.push([
          formatRelativeTime(activity.created_at || new Date().toISOString()),
          activity.item_ref,
          actionColor(activity.action),
          truncate(activity.message || '-', 38),
        ]);
      }

      console.log(table.toString());

      // Tip for adding entries
      if (!ref) {
        console.log('');
        console.log(
          chalk.gray('Add entry:'),
          chalk.white('spellbook activity bug-44 --add "Fixed the issue"')
        );
      }
    } catch (err) {
      error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

// Alias command for convenience
export const logChangeCommand = new Command('log-change')
  .description('Add a changelog entry for a bug or improvement')
  .argument('<ref>', 'Reference (e.g., bug-44, improvement-31)')
  .argument('<message>', 'Changelog message')
  .action(async (ref: string, message: string) => {
    try {
      const context = getCurrentProject();
      if (!context) {
        error('Not in a Spellbook project. Run `spellbook init` first.');
        process.exit(1);
      }

      const { project } = context;
      const parsed = parseRef(ref);

      if (!parsed) {
        error('Invalid reference format. Use: bug-44 or improvement-31');
        process.exit(1);
      }

      logActivity({
        project_id: project.id,
        item_type: parsed.type,
        item_ref: ref,
        action: 'changed',
        message: message,
        author: 'Spellbook',
      });

      console.log(chalk.green('✓'), `Logged: ${ref} - ${message}`);
    } catch (err) {
      error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });
