import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import {
  getBug,
  getImprovement,
  updateBug,
  updateImprovement,
  logActivity,
} from '../db/index.js';
import { getCurrentProject } from '../utils/project.js';
import { error, parseRef, formatDate } from '../utils/format.js';

// Central storage directory for Spellbook
const SPELLBOOK_DIR = join(homedir(), '.spellbook', 'projects');

export const updateCommand = new Command('update')
  .description('Update the status of a bug or improvement')
  .argument('<ref>', 'Reference (e.g., bug-44, improvement-31)')
  .option('-s, --status <status>', 'New status: active, in_progress, resolved/completed')
  .option('-p, --priority <level>', 'New priority: critical, high, medium, low')
  .option('-o, --owner <owner>', 'Assign owner')
  .option('-b, --blocked-by <refs>', 'Set blocked by (comma-separated)')
  .action(async (ref: string, options) => {
    const spinner = ora('Updating item...').start();

    try {
      const context = getCurrentProject();
      if (!context) {
        spinner.fail('Not in a Spellbook project.');
        error('Run `spellbook init` first.');
        process.exit(1);
      }

      const { project } = context;
      const parsed = parseRef(ref);

      if (!parsed) {
        spinner.fail('Invalid reference format.');
        error('Use format: bug-44 or improvement-31');
        process.exit(1);
      }

      const { type, number } = parsed;
      const today = formatDate(new Date());

      if (type === 'bug') {
        const bug = getBug(project.id, number);
        if (!bug) {
          spinner.fail(`Bug #${number} not found.`);
          process.exit(1);
        }

        const updates: Record<string, string | undefined> = {};
        if (options.status) updates.status = options.status;
        if (options.priority) updates.priority = options.priority;
        if (options.owner) updates.owner = options.owner;
        if (options.blockedBy) updates.blocked_by = options.blockedBy;

        if (Object.keys(updates).length === 0) {
          spinner.fail('No updates specified.');
          error('Use --status, --priority, --owner, or --blocked-by');
          process.exit(1);
        }

        // Update database
        updateBug(project.id, number, updates);

        // Update markdown file in centralized storage
        if (bug.doc_path && options.status) {
          const centralPath = join(SPELLBOOK_DIR, project.id, bug.doc_path.replace(/^docs\//, ''));
          updateMarkdownStatus(centralPath, options.status, today);
        }

        // Log activity
        const action = options.status === 'in_progress' ? 'started' : 'changed';
        logActivity({
          project_id: project.id,
          item_type: 'bug',
          item_ref: ref,
          action,
          message: `Updated: ${Object.entries(updates).map(([k, v]) => `${k}=${v}`).join(', ')}`,
          author: 'Spellbook',
        });

        spinner.succeed(`Bug #${number} updated.`);
        if (options.status) {
          console.log(chalk.cyan('Status:'), chalk.yellow(options.status));
        }

      } else if (type === 'improvement') {
        const improvement = getImprovement(project.id, number);
        if (!improvement) {
          spinner.fail(`Improvement #${number} not found.`);
          process.exit(1);
        }

        const updates: Record<string, string | number | undefined> = {};
        if (options.status) updates.status = options.status;
        if (options.priority) updates.priority = options.priority;
        if (options.owner) updates.owner = options.owner;
        if (options.blockedBy) updates.blocked_by = options.blockedBy;

        if (Object.keys(updates).length === 0) {
          spinner.fail('No updates specified.');
          error('Use --status, --priority, --owner, or --blocked-by');
          process.exit(1);
        }

        // Update database
        updateImprovement(project.id, number, updates);

        // Update markdown file in centralized storage
        if (improvement.doc_path && options.status) {
          const centralPath = join(SPELLBOOK_DIR, project.id, improvement.doc_path.replace(/^docs\//, ''));
          updateMarkdownStatus(centralPath, options.status, today);
        }

        // Log activity
        const action = options.status === 'in_progress' ? 'started' : 'changed';
        logActivity({
          project_id: project.id,
          item_type: 'improvement',
          item_ref: ref,
          action,
          message: `Updated: ${Object.entries(updates).map(([k, v]) => `${k}=${v}`).join(', ')}`,
          author: 'Spellbook',
        });

        spinner.succeed(`Improvement #${number} updated.`);
        if (options.status) {
          console.log(chalk.cyan('Status:'), chalk.yellow(options.status));
        }

      } else {
        spinner.fail(`Unknown type: ${type}`);
        process.exit(1);
      }
    } catch (err) {
      spinner.fail('Update failed.');
      error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

function updateMarkdownStatus(filePath: string, status: string, date: string): void {
  if (!existsSync(filePath)) return;

  let content = readFileSync(filePath, 'utf-8');

  // Update status line
  const statusMap: Record<string, string> = {
    active: '🔴 Not Started',
    in_progress: '🟡 In Progress',
    resolved: '✅ Resolved',
    completed: '✅ Completed',
  };

  const newStatus = statusMap[status.toLowerCase()] || status;
  content = content.replace(/\*\*Status:\*\* .+/, `**Status:** ${newStatus}`);

  // Add changelog entry
  const changelogPattern = /(\| Date \| Change \| Author \|\n\|------\|--------\|--------\|\n)/;
  const match = content.match(changelogPattern);
  if (match) {
    const entry = `| ${date} | Status → ${newStatus} | Spellbook |\n`;
    content = content.replace(changelogPattern, `$1${entry}`);
  }

  writeFileSync(filePath, content, 'utf-8');
}
