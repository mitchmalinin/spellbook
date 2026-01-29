import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { getDb } from '../db/index.js';
import { getCurrentProject } from '../utils/project.js';
import { error } from '../utils/format.js';

export const rebuildCommand = new Command('rebuild')
  .description('Rebuild database from markdown files (useful if database is lost)')
  .option('--force', 'Force rebuild even if project exists')
  .action(async (options) => {
    const spinner = ora('Rebuilding database...').start();

    try {
      const context = getCurrentProject();
      if (!context) {
        spinner.fail('Not in a Spellbook project.');
        error('Run `spellbook init` first.');
        process.exit(1);
      }

      const { project } = context;

      if (!options.force) {
        spinner.info('This will clear and rebuild the project data from markdown files.');
        spinner.stop();
        console.log(chalk.yellow('Run with --force to proceed.'));
        return;
      }

      // Clear existing data for this project
      spinner.text = 'Clearing existing data...';
      const db = getDb();

      db.prepare('DELETE FROM bugs WHERE project_id = ?').run(project.id);
      db.prepare('DELETE FROM improvements WHERE project_id = ?').run(project.id);
      db.prepare('DELETE FROM features WHERE project_id = ?').run(project.id);
      db.prepare('DELETE FROM activity WHERE project_id = ?').run(project.id);
      db.prepare('DELETE FROM inbox WHERE project_id = ?').run(project.id);
      db.prepare('DELETE FROM worktrees WHERE project_id = ?').run(project.id);

      // Now sync from markdown
      spinner.text = 'Rebuilding from markdown files...';

      // Import sync command logic
      const { syncCommand } = await import('./sync.js');

      // Run sync
      process.argv = ['node', 'spellbook', 'sync', '--direction', 'md-to-db'];
      await syncCommand.parseAsync(['node', 'spellbook', 'sync', '--direction', 'md-to-db']);

      spinner.succeed('Database rebuilt successfully.');
      console.log('');
      console.log(chalk.gray('Run `spellbook status` to verify the data.'));
    } catch (err) {
      spinner.fail('Rebuild failed.');
      error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });
