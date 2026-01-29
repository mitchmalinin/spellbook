import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import open from 'open';
import { getCurrentProject } from '../utils/project.js';
import { startServer } from '../web/server.js';
import { error, info } from '../utils/format.js';

const DEFAULT_PORT = 3333;

export const boardCommand = new Command('board')
  .description('Open kanban board web UI')
  .option('-p, --port <number>', 'Port number', String(DEFAULT_PORT))
  .option('--no-open', 'Do not open browser automatically')
  .action(async (options) => {
    const current = getCurrentProject();
    if (!current) {
      error('Not in a Spellbook project. Run `spellbook init` first.');
      process.exit(1);
    }

    const port = parseInt(options.port, 10);
    const spinner = ora('Starting kanban board server...').start();

    try {
      const { url, close } = await startServer({
        port,
        project: current.project,
      });

      spinner.succeed(`Kanban board running at ${chalk.cyan(url)}`);
      info(`Project: ${chalk.bold(current.project.name)}`);
      console.log(chalk.gray('Press Ctrl+C to stop the server'));

      // Open browser if not disabled
      if (options.open !== false) {
        await open(url);
      }

      // Handle graceful shutdown
      const shutdown = () => {
        console.log(chalk.gray('\nShutting down...'));
        close();
        process.exit(0);
      };

      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);

      // Keep process alive
      await new Promise(() => {});
    } catch (err) {
      spinner.fail('Failed to start server');
      if (err instanceof Error) {
        error(err.message);
      }
      process.exit(1);
    }
  });
