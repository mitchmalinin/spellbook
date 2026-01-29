import { Command } from 'commander';
import chalk from 'chalk';
import Table from 'cli-table3';
import boxen from 'boxen';
import {
  getBugsByProject,
  getImprovementsByProject,
  getFeaturesByProject,
  getWorktreesByProject,
  getInbox,
} from '../db/index.js';
import { getCurrentProject } from '../utils/project.js';
import { error, formatStatus, truncate } from '../utils/format.js';

export const statusCommand = new Command('status')
  .description('Show project status dashboard')
  .option('--json', 'Output as JSON')
  .option('--bugs', 'Show only bugs')
  .option('--improvements', 'Show only improvements')
  .option('--features', 'Show only features')
  .option('--worktrees', 'Show only worktrees')
  .action(async (options) => {
    try {
      const context = getCurrentProject();
      if (!context) {
        error('Not in a Spellbook project. Run `spellbook init` first.');
        process.exit(1);
      }

      const { project } = context;

      // Fetch data
      const bugs = getBugsByProject(project.id);
      const improvements = getImprovementsByProject(project.id);
      const features = getFeaturesByProject(project.id);
      const worktrees = getWorktreesByProject(project.id, 'active');
      const inbox = getInbox(project.id);

      // JSON output
      if (options.json) {
        console.log(
          JSON.stringify(
            {
              project: project,
              bugs: bugs,
              improvements: improvements,
              features: features,
              worktrees: worktrees,
              inbox: inbox,
            },
            null,
            2
          )
        );
        return;
      }

      // Filter mode
      const showAll = !options.bugs && !options.improvements && !options.features && !options.worktrees;

      // Header
      console.log(
        boxen(chalk.bold.cyan('SPELLBOOK') + '\n' + chalk.gray(`Project: ${project.name}`), {
          padding: { top: 0, bottom: 0, left: 2, right: 2 },
          borderColor: 'cyan',
          borderStyle: 'round',
        })
      );
      console.log('');

      // Worktrees
      if (showAll || options.worktrees) {
        console.log(chalk.bold.white(`ACTIVE WORKTREES (${worktrees.length})`));
        if (worktrees.length > 0) {
          const worktreeTable = new Table({
            head: [
              chalk.gray('Path'),
              chalk.gray('Branch'),
              chalk.gray('Working On'),
            ],
            style: { head: [], border: [] },
          });

          for (const wt of worktrees) {
            worktreeTable.push([
              truncate(wt.path, 40),
              wt.branch || '-',
              wt.working_on || '-',
            ]);
          }

          console.log(worktreeTable.toString());
        } else {
          console.log(chalk.gray('  No active worktrees.'));
        }
        console.log('');
      }

      // Bugs
      if (showAll || options.bugs) {
        const activeBugs = bugs.filter((b) => b.status !== 'resolved');
        console.log(chalk.bold.white(`BUGS (${activeBugs.length} active)`));

        if (activeBugs.length > 0) {
          const bugTable = new Table({
            head: [
              chalk.gray('#'),
              chalk.gray('Title'),
              chalk.gray('Priority'),
              chalk.gray('Status'),
              chalk.gray('Owner'),
            ],
            style: { head: [], border: [] },
            colWidths: [6, 40, 10, 8, 15],
          });

          for (const bug of activeBugs) {
            bugTable.push([
              bug.number.toString(),
              truncate(bug.title, 38),
              bug.priority,
              formatStatus(bug.status),
              bug.owner || '-',
            ]);
          }

          console.log(bugTable.toString());
        } else {
          console.log(chalk.gray('  No active bugs.'));
        }
        console.log('');
      }

      // Improvements
      if (showAll || options.improvements) {
        const activeImprovements = improvements.filter((i) => i.status !== 'completed');
        console.log(chalk.bold.white(`IMPROVEMENTS (${activeImprovements.length} active)`));

        if (activeImprovements.length > 0) {
          const improvementTable = new Table({
            head: [
              chalk.gray('#'),
              chalk.gray('Title'),
              chalk.gray('Priority'),
              chalk.gray('Status'),
              chalk.gray('Owner'),
            ],
            style: { head: [], border: [] },
            colWidths: [6, 40, 10, 8, 15],
          });

          for (const imp of activeImprovements) {
            improvementTable.push([
              imp.number.toString(),
              truncate(imp.title, 38),
              imp.priority,
              formatStatus(imp.status),
              imp.owner || '-',
            ]);
          }

          console.log(improvementTable.toString());
        } else {
          console.log(chalk.gray('  No active improvements.'));
        }
        console.log('');
      }

      // Features
      if (showAll || options.features) {
        const inProgressFeatures = features.filter(
          (f) => f.status === 'in_progress' || f.status === 'not_started'
        );
        const completeCount = features.filter((f) => f.status === 'complete').length;
        console.log(
          chalk.bold.white(
            `FEATURES (${completeCount}/${features.length} complete)`
          )
        );

        if (inProgressFeatures.length > 0) {
          const featureTable = new Table({
            head: [
              chalk.gray('#'),
              chalk.gray('Name'),
              chalk.gray('Tasks'),
              chalk.gray('Status'),
            ],
            style: { head: [], border: [] },
            colWidths: [6, 50, 8, 8],
          });

          for (const feat of inProgressFeatures.slice(0, 10)) {
            featureTable.push([
              feat.number.toString(),
              truncate(feat.name, 48),
              feat.tasks.toString(),
              formatStatus(feat.status),
            ]);
          }

          console.log(featureTable.toString());
          if (inProgressFeatures.length > 10) {
            console.log(chalk.gray(`  ... and ${inProgressFeatures.length - 10} more`));
          }
        } else {
          console.log(chalk.gray('  All features complete!'));
        }
        console.log('');
      }

      // Inbox summary (always show if there are items)
      if (showAll && inbox.length > 0) {
        console.log(chalk.bold.white(`FEATURE INBOX (${inbox.length} ideas)`));
        for (const item of inbox.slice(0, 5)) {
          console.log(chalk.gray('  •'), truncate(item.description, 60));
        }
        if (inbox.length > 5) {
          console.log(chalk.gray(`  ... and ${inbox.length - 5} more`));
        }
        console.log('');
      }

      // Quick commands
      if (showAll) {
        console.log(chalk.gray('─'.repeat(60)));
        console.log(chalk.gray('Commands:'));
        console.log(
          chalk.gray('  • Log bug:'),
          chalk.white('spellbook log bug "description"')
        );
        console.log(
          chalk.gray('  • Log improvement:'),
          chalk.white('spellbook log improvement "description"')
        );
        console.log(
          chalk.gray('  • Update status:'),
          chalk.white('spellbook update bug-44 --status in_progress')
        );
      }
    } catch (err) {
      error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });
