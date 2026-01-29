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

export const finalizeCommand = new Command('finalize')
  .description('Mark a bug or improvement as resolved/completed and move to archive')
  .argument('<ref>', 'Reference (e.g., bug-44, improvement-31)')
  .option('-m, --message <message>', 'Completion message for changelog')
  .action(async (ref: string, options) => {
    const spinner = ora('Finalizing item...').start();

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

        // Update status in centralized storage (flat structure - no file moving)
        if (bug.doc_path) {
          const normalizedPath = bug.doc_path.replace(/^docs\//, '');
          const centralPath = join(SPELLBOOK_DIR, project.id, normalizedPath);

          if (existsSync(centralPath)) {
            // Update markdown status in place
            let content = readFileSync(centralPath, 'utf-8');
            content = content.replace(/\*\*Status:\*\* .+/, '**Status:** ✅ Resolved');

            // Add changelog entry
            const changelogPattern = /(\| Date \| Change \| Author \|\n\|------\|--------\|--------\|\n)/;
            const match = content.match(changelogPattern);
            if (match) {
              const message = options.message || 'Resolved';
              const entry = `| ${today} | ${message} | Spellbook |\n`;
              content = content.replace(changelogPattern, `$1${entry}`);
            }

            writeFileSync(centralPath, content, 'utf-8');
          }
        }

        // Update status in database (no path change needed in flat structure)
        updateBug(project.id, number, { status: 'resolved' });

        // Log activity
        logActivity({
          project_id: project.id,
          item_type: 'bug',
          item_ref: ref,
          action: 'completed',
          message: options.message || 'Resolved',
          author: 'Spellbook',
        });

        spinner.succeed(`Bug #${number} resolved.`);

      } else if (type === 'improvement') {
        const improvement = getImprovement(project.id, number);
        if (!improvement) {
          spinner.fail(`Improvement #${number} not found.`);
          process.exit(1);
        }

        // Update status in centralized storage (flat structure - no file moving)
        if (improvement.doc_path) {
          const normalizedPath = improvement.doc_path.replace(/^docs\//, '');
          const centralPath = join(SPELLBOOK_DIR, project.id, normalizedPath);

          if (existsSync(centralPath)) {
            // Update markdown status in place
            let content = readFileSync(centralPath, 'utf-8');
            content = content.replace(/\*\*Status:\*\* .+/, '**Status:** ✅ Completed');

            // Add changelog entry
            const changelogPattern = /(\| Date \| Change \| Author \|\n\|------\|--------\|--------\|\n)/;
            const match = content.match(changelogPattern);
            if (match) {
              const message = options.message || 'Completed';
              const entry = `| ${today} | ${message} | Spellbook |\n`;
              content = content.replace(changelogPattern, `$1${entry}`);
            }

            writeFileSync(centralPath, content, 'utf-8');
          }
        }

        // Update status in database (no path change needed in flat structure)
        updateImprovement(project.id, number, { status: 'completed' });

        // Log activity
        logActivity({
          project_id: project.id,
          item_type: 'improvement',
          item_ref: ref,
          action: 'completed',
          message: options.message || 'Completed',
          author: 'Spellbook',
        });

        spinner.succeed(`Improvement #${number} completed.`);

      } else {
        spinner.fail(`Unknown type: ${type}`);
        process.exit(1);
      }

      console.log('');
      console.log(chalk.gray('The item status has been updated.'));
      console.log(chalk.gray('Run `spellbook roadmap` to update ROADMAP.md.'));

    } catch (err) {
      spinner.fail('Finalize failed.');
      error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });
