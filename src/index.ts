import { Command } from 'commander';
import chalk from 'chalk';
import { initCommand } from './commands/init.js';
import { logCommand } from './commands/log.js';
import { updateCommand } from './commands/update.js';
import { statusCommand } from './commands/status.js';
import { generateCommand } from './commands/generate.js';
import { syncCommand } from './commands/sync.js';
import { projectsCommand } from './commands/projects.js';
import { worktreeCommand } from './commands/worktree.js';
import { docCommand } from './commands/doc.js';
import { activityCommand } from './commands/activity.js';
import { rebuildCommand } from './commands/rebuild.js';
import { finalizeCommand } from './commands/finalize.js';
import { prCommand } from './commands/pr.js';
import { ideaCommand, inboxCommand } from './commands/idea.js';
import { specCommand, readyCommand, startCommand } from './commands/spec.js';
import { roadmapCommand } from './commands/roadmap.js';
import { boardCommand } from './commands/board.js';
import { migrateCommand } from './commands/migrate.js';

const program = new Command();

program
  .name('spellbook')
  .description('Project planning CLI for AI-assisted development')
  .version('0.1.0');

// Setup commands
program.addCommand(initCommand);
program.addCommand(logCommand);
program.addCommand(updateCommand);
program.addCommand(finalizeCommand);
program.addCommand(prCommand);        // Mark item as having open PR
program.addCommand(statusCommand);
program.addCommand(generateCommand);
program.addCommand(syncCommand);
program.addCommand(projectsCommand);
program.addCommand(worktreeCommand);
program.addCommand(docCommand);
program.addCommand(activityCommand);
program.addCommand(rebuildCommand);

// New pipeline commands
program.addCommand(ideaCommand);     // Quick capture to inbox
program.addCommand(inboxCommand);    // List inbox items
program.addCommand(specCommand);     // Convert inbox to spec
program.addCommand(readyCommand);    // Mark spec as ready
program.addCommand(startCommand);    // Start implementation
program.addCommand(roadmapCommand);  // Generate ROADMAP.md (not PLANNING.md!)

// Visualization commands
program.addCommand(boardCommand);    // Kanban board web UI

// Migration commands
program.addCommand(migrateCommand);  // Migrate docs to ~/.spellbook/projects/

// Handle unknown commands
program.on('command:*', () => {
  console.error(chalk.red(`Unknown command: ${program.args.join(' ')}`));
  console.log(`Run ${chalk.cyan('spellbook --help')} for available commands.`);
  process.exit(1);
});

// Parse arguments
program.parse();
