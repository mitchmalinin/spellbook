import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { addToInbox, getInbox, logActivity } from '../db/index.js';
import { getCurrentProject } from '../utils/project.js';
import { error, info } from '../utils/format.js';

export const ideaCommand = new Command('idea')
  .description('Quick capture an idea to the inbox (no spec file created)')
  .argument('[description]', 'Short description of the idea')
  .option('--bug', 'Mark as a bug idea')
  .option('--improvement', 'Mark as an improvement idea')
  .option('--feature', 'Mark as a feature idea (default)')
  .option('--priority <level>', 'Priority level: high, medium, low', 'medium')
  .action(async (description, options) => {
    const spinner = ora('Capturing idea...').start();

    try {
      const context = getCurrentProject();
      if (!context) {
        spinner.fail('Not in a Spellbook project.');
        error('Run `spellbook init` first.');
        process.exit(1);
      }

      if (!description) {
        spinner.fail('Description required.');
        error('Usage: spellbook idea "description"');
        process.exit(1);
      }

      // Determine type
      let type = 'feature';
      if (options.bug) type = 'bug';
      else if (options.improvement) type = 'improvement';
      else if (options.feature) type = 'feature';
      else {
        // Auto-detect from keywords
        const lowerDesc = description.toLowerCase();
        if (/\b(broken|error|crash|bug|issue|fails?|stuck|wrong|incorrect|not working|doesn't work)\b/.test(lowerDesc)) {
          type = 'bug';
        } else if (/\b(refactor|cleanup|optimize|improve|tech debt|slow|messy|duplicated|simplify)\b/.test(lowerDesc)) {
          type = 'improvement';
        }
      }

      // Validate priority
      const priority = ['high', 'medium', 'low'].includes(options.priority.toLowerCase())
        ? options.priority.toLowerCase()
        : 'medium';

      const { project } = context;

      // Add to inbox
      const item = addToInbox({
        project_id: project.id,
        description,
        type,
        priority,
      });

      // Log activity
      logActivity({
        project_id: project.id,
        item_type: 'inbox',
        item_ref: `idea-${item.id}`,
        action: 'created',
        message: `Captured ${type} idea: ${description.substring(0, 50)}...`,
        author: 'Claude',
      });

      spinner.succeed(`Idea captured!`);

      console.log('');
      console.log(chalk.cyan(`  Type:     `) + chalk.white(type));
      console.log(chalk.cyan(`  Priority: `) + chalk.white(priority));
      console.log(chalk.cyan(`  ID:       `) + chalk.white(`idea-${item.id}`));
      console.log('');
      info(`To create a detailed spec: spellbook spec idea-${item.id}`);

    } catch (err) {
      spinner.fail('Failed to capture idea.');
      error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

export const inboxCommand = new Command('inbox')
  .description('List inbox items')
  .option('--bugs', 'Show only bug ideas')
  .option('--improvements', 'Show only improvement ideas')
  .option('--features', 'Show only feature ideas')
  .action(async (options) => {
    const spinner = ora('Loading inbox...').start();

    try {
      const context = getCurrentProject();
      if (!context) {
        spinner.fail('Not in a Spellbook project.');
        error('Run `spellbook init` first.');
        process.exit(1);
      }

      const { project } = context;

      // Determine type filter
      let typeFilter: string | undefined;
      if (options.bugs) typeFilter = 'bug';
      else if (options.improvements) typeFilter = 'improvement';
      else if (options.features) typeFilter = 'feature';

      const items = getInbox(project.id, typeFilter);

      spinner.stop();

      if (items.length === 0) {
        console.log('');
        console.log(chalk.yellow('Inbox is empty.'));
        console.log('');
        info('Capture ideas with: spellbook idea "description"');
        return;
      }

      console.log('');
      console.log(chalk.bold.cyan(`INBOX${typeFilter ? ` (${typeFilter}s)` : ''} - ${items.length} items`));
      console.log('');

      // Group by type
      const byType: Record<string, typeof items> = {};
      for (const item of items) {
        if (!byType[item.type]) byType[item.type] = [];
        byType[item.type].push(item);
      }

      for (const [type, typeItems] of Object.entries(byType)) {
        const typeIcon = type === 'bug' ? '🐛' : type === 'improvement' ? '🔧' : '✨';
        console.log(chalk.bold(`${typeIcon} ${type.toUpperCase()}S (${typeItems.length})`));
        console.log('');

        for (const item of typeItems) {
          const priorityColor = item.priority === 'high' ? chalk.red : item.priority === 'medium' ? chalk.yellow : chalk.gray;
          console.log(`  ${chalk.gray(`idea-${item.id}`)} ${priorityColor(`[${item.priority}]`)} ${item.description}`);
        }
        console.log('');
      }

      console.log(chalk.gray('─'.repeat(60)));
      console.log(chalk.gray('To create spec: spellbook spec idea-<id>'));

    } catch (err) {
      spinner.fail('Failed to load inbox.');
      error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });
