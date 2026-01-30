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

export const prCommand = new Command('pr')
  .description('Mark a bug or improvement as having an open PR (waiting for merge)')
  .argument('<ref>', 'Reference (e.g., bug-44, improvement-31)')
  .option('-u, --url <url>', 'PR URL (e.g., https://github.com/org/repo/pull/123)')
  .option('-n, --number <number>', 'PR number')
  .action(async (ref: string, options) => {
    const spinner = ora('Setting PR status...').start();

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

      // Extract PR number from URL if not provided
      let prNumber = options.number ? parseInt(options.number) : undefined;
      let prUrl = options.url;

      if (prUrl && !prNumber) {
        const match = prUrl.match(/\/pull\/(\d+)/);
        if (match) {
          prNumber = parseInt(match[1]);
        }
      }

      if (type === 'bug') {
        const bug = getBug(project.id, number);
        if (!bug) {
          spinner.fail(`Bug #${number} not found.`);
          process.exit(1);
        }

        // Update status in centralized storage
        if (bug.doc_path) {
          const normalizedPath = bug.doc_path.replace(/^docs\//, '');
          const centralPath = join(SPELLBOOK_DIR, project.id, normalizedPath);

          if (existsSync(centralPath)) {
            let content = readFileSync(centralPath, 'utf-8');
            content = content.replace(/\*\*Status:\*\* .+/, '**Status:** 🔄 PR Open');

            // Add PR link if URL provided
            if (prUrl) {
              // Check if PR link section exists
              if (!content.includes('**PR:**')) {
                // Add after status line
                content = content.replace(
                  /(\*\*Status:\*\* .+)/,
                  `$1\n**PR:** [#${prNumber || 'PR'}](${prUrl})`
                );
              } else {
                content = content.replace(
                  /\*\*PR:\*\* .+/,
                  `**PR:** [#${prNumber || 'PR'}](${prUrl})`
                );
              }
            }

            // Add changelog entry
            const changelogPattern = /(\| Date \| Change \| Author \|\n\|------\|--------\|--------\|\n)/;
            const match = content.match(changelogPattern);
            if (match) {
              const message = prUrl
                ? `PR created: [#${prNumber}](${prUrl})`
                : 'PR created - waiting for review';
              const entry = `| ${today} | ${message} | Spellbook |\n`;
              content = content.replace(changelogPattern, `$1${entry}`);
            }

            writeFileSync(centralPath, content, 'utf-8');
          }
        }

        // Update status in database
        const updates: Record<string, unknown> = { status: 'pr_open' };
        if (prNumber) updates.pr_number = prNumber;
        if (prUrl) updates.pr_url = prUrl;
        updateBug(project.id, number, updates);

        // Log activity
        logActivity({
          project_id: project.id,
          item_type: 'bug',
          item_ref: ref,
          action: 'pr_created',
          message: prUrl ? `PR #${prNumber}: ${prUrl}` : 'PR created',
          author: 'Spellbook',
        });

        spinner.succeed(`Bug #${number} marked as PR open.`);

      } else if (type === 'improvement') {
        const improvement = getImprovement(project.id, number);
        if (!improvement) {
          spinner.fail(`Improvement #${number} not found.`);
          process.exit(1);
        }

        // Update status in centralized storage
        if (improvement.doc_path) {
          const normalizedPath = improvement.doc_path.replace(/^docs\//, '');
          const centralPath = join(SPELLBOOK_DIR, project.id, normalizedPath);

          if (existsSync(centralPath)) {
            let content = readFileSync(centralPath, 'utf-8');
            content = content.replace(/\*\*Status:\*\* .+/, '**Status:** 🔄 PR Open');

            // Add PR link if URL provided
            if (prUrl) {
              if (!content.includes('**PR:**')) {
                content = content.replace(
                  /(\*\*Status:\*\* .+)/,
                  `$1\n**PR:** [#${prNumber || 'PR'}](${prUrl})`
                );
              } else {
                content = content.replace(
                  /\*\*PR:\*\* .+/,
                  `**PR:** [#${prNumber || 'PR'}](${prUrl})`
                );
              }
            }

            // Add changelog entry
            const changelogPattern = /(\| Date \| Change \| Author \|\n\|------\|--------\|--------\|\n)/;
            const match = content.match(changelogPattern);
            if (match) {
              const message = prUrl
                ? `PR created: [#${prNumber}](${prUrl})`
                : 'PR created - waiting for review';
              const entry = `| ${today} | ${message} | Spellbook |\n`;
              content = content.replace(changelogPattern, `$1${entry}`);
            }

            writeFileSync(centralPath, content, 'utf-8');
          }
        }

        // Update status in database
        const updates: Record<string, unknown> = { status: 'pr_open' };
        if (prNumber) updates.pr_number = prNumber;
        if (prUrl) updates.pr_url = prUrl;
        updateImprovement(project.id, number, updates);

        // Log activity
        logActivity({
          project_id: project.id,
          item_type: 'improvement',
          item_ref: ref,
          action: 'pr_created',
          message: prUrl ? `PR #${prNumber}: ${prUrl}` : 'PR created',
          author: 'Spellbook',
        });

        spinner.succeed(`Improvement #${number} marked as PR open.`);

      } else {
        spinner.fail(`Unknown type: ${type}`);
        process.exit(1);
      }

      console.log('');
      console.log(chalk.gray('Status changed to pr_open. Run `spellbook finalize` after PR is merged.'));
      if (prUrl) {
        console.log(chalk.cyan(`PR: ${prUrl}`));
      }

    } catch (err) {
      spinner.fail('Failed to set PR status.');
      error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });
