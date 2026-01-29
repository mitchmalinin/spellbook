import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import Table from 'cli-table3';
import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import {
  createWorktree,
  getWorktreesByProject,
  updateWorktree,
  getWorktreeByPath,
} from '../db/index.js';
import {
  getCurrentProject,
  getWorktreeList,
  getGitBranch,
} from '../utils/project.js';
import { success, error, parseRef, truncate } from '../utils/format.js';

export const worktreeCommand = new Command('worktree')
  .description('Manage git worktrees')
  .addCommand(createWorktreeCommand())
  .addCommand(listWorktreesCommand())
  .addCommand(cleanupWorktreesCommand())
  .addCommand(assignWorktreeCommand());

function createWorktreeCommand(): Command {
  return new Command('create')
    .description('Create a worktree for a bug or improvement')
    .argument('<ref>', 'Reference (e.g., bug-44, improvement-31)')
    .option('-d, --dir <directory>', 'Custom worktree directory')
    .action(async (ref: string, options) => {
      const spinner = ora('Creating worktree...').start();

      try {
        const context = getCurrentProject();
        if (!context) {
          spinner.fail('Not in a Spellbook project.');
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

        // Determine worktree path
        const worktreeBase =
          options.dir || join(process.env.HOME || '~', 'tmp/worktrees', project.id);
        const worktreePath = join(worktreeBase, `${type}-${number}`);

        // Determine branch name
        const branchName = `${type === 'bug' ? 'fix' : 'improvement'}/${number}`;

        // Check if worktree already exists
        if (existsSync(worktreePath)) {
          spinner.fail(`Worktree already exists at ${worktreePath}`);
          process.exit(1);
        }

        // Create the worktree
        try {
          execSync(`git worktree add -b "${branchName}" "${worktreePath}"`, {
            cwd: project.path,
            stdio: 'pipe',
          });
        } catch (gitErr) {
          // Try without creating new branch (branch might exist)
          try {
            execSync(`git worktree add "${worktreePath}" "${branchName}"`, {
              cwd: project.path,
              stdio: 'pipe',
            });
          } catch {
            spinner.fail('Failed to create git worktree.');
            error(gitErr instanceof Error ? gitErr.message : String(gitErr));
            process.exit(1);
          }
        }

        // Register in database
        createWorktree({
          project_id: project.id,
          path: worktreePath,
          branch: branchName,
          working_on: ref,
          status: 'active',
        });

        spinner.succeed(`Worktree created at ${worktreePath}`);
        console.log('');
        console.log(chalk.cyan('Path:'), worktreePath);
        console.log(chalk.cyan('Branch:'), branchName);
        console.log(chalk.cyan('Working on:'), ref);
        console.log('');
        console.log(chalk.gray('To start working:'));
        console.log(chalk.white(`  cd "${worktreePath}"`));
      } catch (err) {
        spinner.fail('Failed to create worktree.');
        error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}

function listWorktreesCommand(): Command {
  return new Command('list')
    .description('List worktrees for the current project')
    .option('--all', 'Include merged/abandoned worktrees')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      try {
        const context = getCurrentProject();
        if (!context) {
          error('Not in a Spellbook project.');
          process.exit(1);
        }

        const { project } = context;

        // Get from database
        const dbWorktrees = options.all
          ? getWorktreesByProject(project.id)
          : getWorktreesByProject(project.id, 'active');

        // Get from git (for comparison)
        const gitWorktrees = getWorktreeList(project.path);

        if (options.json) {
          console.log(JSON.stringify({ database: dbWorktrees, git: gitWorktrees }, null, 2));
          return;
        }

        console.log(chalk.bold.white(`WORKTREES (${dbWorktrees.length} registered)`));
        console.log('');

        if (dbWorktrees.length === 0) {
          console.log(chalk.gray('No worktrees registered.'));
          console.log('');
          console.log(
            chalk.gray('Create one with:'),
            chalk.white('spellbook worktree create bug-44')
          );
          return;
        }

        const table = new Table({
          head: [
            chalk.gray('Path'),
            chalk.gray('Branch'),
            chalk.gray('Working On'),
            chalk.gray('Status'),
          ],
          style: { head: [], border: [] },
        });

        for (const wt of dbWorktrees) {
          const statusColor = wt.status === 'active' ? chalk.green : chalk.gray;
          table.push([
            truncate(wt.path, 40),
            wt.branch || '-',
            wt.working_on || '-',
            statusColor(wt.status),
          ]);
        }

        console.log(table.toString());

        // Show unregistered git worktrees
        const registeredPaths = new Set(dbWorktrees.map((w) => w.path));
        const unregistered = gitWorktrees.filter((w) => !registeredPaths.has(w.path));

        if (unregistered.length > 0) {
          console.log('');
          console.log(chalk.yellow(`Unregistered git worktrees (${unregistered.length}):`));
          for (const wt of unregistered) {
            console.log(chalk.gray(`  • ${wt.path} (${wt.branch})`));
          }
        }
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}

function cleanupWorktreesCommand(): Command {
  return new Command('cleanup')
    .description('Remove merged or abandoned worktrees')
    .option('--dry-run', 'Show what would be removed without removing')
    .action(async (options) => {
      const spinner = ora('Scanning worktrees...').start();

      try {
        const context = getCurrentProject();
        if (!context) {
          spinner.fail('Not in a Spellbook project.');
          process.exit(1);
        }

        const { project } = context;
        const worktrees = getWorktreesByProject(project.id);
        const toRemove: string[] = [];

        for (const wt of worktrees) {
          // Check if directory still exists
          if (!existsSync(wt.path)) {
            toRemove.push(wt.path);
            continue;
          }

          // Check if merged
          if (wt.status === 'merged' || wt.status === 'abandoned') {
            toRemove.push(wt.path);
          }
        }

        spinner.stop();

        if (toRemove.length === 0) {
          console.log(chalk.green('No worktrees to clean up.'));
          return;
        }

        console.log(chalk.yellow(`Found ${toRemove.length} worktrees to remove:`));
        for (const path of toRemove) {
          console.log(chalk.gray(`  • ${path}`));
        }

        if (options.dryRun) {
          console.log('');
          console.log(chalk.gray('Dry run - no changes made.'));
          return;
        }

        // Remove worktrees
        for (const path of toRemove) {
          try {
            if (existsSync(path)) {
              execSync(`git worktree remove "${path}" --force`, {
                cwd: project.path,
                stdio: 'pipe',
              });
            }
            updateWorktree(path, { status: 'abandoned' });
            console.log(chalk.green(`  ✓ Removed ${path}`));
          } catch {
            console.log(chalk.red(`  ✗ Failed to remove ${path}`));
          }
        }

        console.log('');
        success(`Cleaned up ${toRemove.length} worktrees.`);
      } catch (err) {
        spinner.fail('Cleanup failed.');
        error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}

function assignWorktreeCommand(): Command {
  return new Command('assign')
    .description('Assign a bug/improvement to a worktree')
    .argument('<path>', 'Worktree path')
    .argument('<ref>', 'Reference (e.g., bug-44)')
    .action(async (path: string, ref: string) => {
      try {
        const context = getCurrentProject();
        if (!context) {
          error('Not in a Spellbook project.');
          process.exit(1);
        }

        const worktree = getWorktreeByPath(path);
        if (!worktree) {
          // Register it
          const branch = getGitBranch(path);
          createWorktree({
            project_id: context.project.id,
            path,
            branch: branch || undefined,
            working_on: ref,
            status: 'active',
          });
          success(`Worktree registered and assigned to ${ref}.`);
        } else {
          updateWorktree(path, { working_on: ref });
          success(`Worktree assigned to ${ref}.`);
        }
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}
