import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  copyFileSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import {
  PROJECTS_DIR,
  getBugsByProject,
  getImprovementsByProject,
  getFeaturesByProject,
  updateBug,
  updateImprovement,
  updateFeature,
} from '../db/index.js';
import { getCurrentProject } from '../utils/project.js';
import { error } from '../utils/format.js';

export const migrateCommand = new Command('migrate')
  .description('Migrate project docs to ~/.spellbook/projects/ for centralized management')
  .option('--dry-run', 'Show what would be migrated without making changes')
  .option('--no-delete', 'Copy files instead of moving (keeps originals)')
  .option('--init-git', 'Initialize git repo in ~/.spellbook/projects/')
  .action(async (options) => {
    const spinner = ora('Preparing migration...').start();

    try {
      const context = getCurrentProject();
      if (!context) {
        spinner.fail('Not in a Spellbook project.');
        error('Run `spellbook init` first.');
        process.exit(1);
      }

      const { project } = context;
      const projectId = project.id;
      const projectPath = project.path;

      // Create destination directories
      const destBase = join(PROJECTS_DIR, projectId);
      const destDirs = [
        join(destBase, 'bugs', 'active'),
        join(destBase, 'bugs', 'resolved'),
        join(destBase, 'improvements', 'active'),
        join(destBase, 'improvements', 'completed'),
        join(destBase, 'features'),
        join(destBase, 'knowledge'),
      ];

      spinner.text = 'Creating directory structure...';

      if (!options.dryRun) {
        destDirs.forEach((dir) => {
          if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
          }
        });
      }

      console.log('');
      console.log(chalk.cyan('Migration Plan:'));
      console.log(chalk.gray(`  From: ${projectPath}/docs/`));
      console.log(chalk.gray(`  To:   ${destBase}/`));
      console.log('');

      let filesMoved = 0;
      let dirsCreated = 0;

      // Migrate bugs
      spinner.text = 'Migrating bugs...';
      const bugResult = await migrateDirectory(
        join(projectPath, 'docs/bugs'),
        join(destBase, 'bugs'),
        'bugs',
        projectId,
        options.dryRun,
        options.delete
      );
      filesMoved += bugResult.files;
      dirsCreated += bugResult.dirs;

      // Migrate improvements
      spinner.text = 'Migrating improvements...';
      const impResult = await migrateDirectory(
        join(projectPath, 'docs/improvements'),
        join(destBase, 'improvements'),
        'improvements',
        projectId,
        options.dryRun,
        options.delete
      );
      filesMoved += impResult.files;
      dirsCreated += impResult.dirs;

      // Migrate features (special handling - they're folders)
      spinner.text = 'Migrating features...';
      const featResult = await migrateFeatures(
        join(projectPath, 'docs/features'),
        join(destBase, 'features'),
        projectId,
        options.dryRun,
        options.delete
      );
      filesMoved += featResult.files;
      dirsCreated += featResult.dirs;

      // Migrate knowledge (if exists)
      const knowledgeSrc = join(projectPath, 'docs/knowledge');
      if (existsSync(knowledgeSrc)) {
        spinner.text = 'Migrating knowledge docs...';
        const knowResult = await migrateDirectory(
          knowledgeSrc,
          join(destBase, 'knowledge'),
          'knowledge',
          projectId,
          options.dryRun,
          options.delete
        );
        filesMoved += knowResult.files;
        dirsCreated += knowResult.dirs;
      }

      // Update database paths
      spinner.text = 'Updating database paths...';
      if (!options.dryRun) {
        await updateDatabasePaths(projectId, destBase);
      }

      // Initialize git if requested
      if (options.initGit && !options.dryRun) {
        spinner.text = 'Initializing git repository...';
        const gitDir = join(PROJECTS_DIR, '.git');
        if (!existsSync(gitDir)) {
          try {
            execSync('git init', { cwd: PROJECTS_DIR });
            writeFileSync(
              join(PROJECTS_DIR, '.gitignore'),
              '# Spellbook Projects\n.DS_Store\n*.tmp\n'
            );
            execSync('git add .', { cwd: PROJECTS_DIR });
            execSync('git commit -m "Initial commit: Spellbook projects"', {
              cwd: PROJECTS_DIR,
            });
            console.log(chalk.green('  ✓ Git repository initialized in ~/.spellbook/projects/'));
          } catch (e) {
            console.log(chalk.yellow('  ⚠ Failed to initialize git repository'));
          }
        } else {
          console.log(chalk.gray('  Git repository already exists'));
        }
      }

      spinner.succeed('Migration complete!');

      console.log('');
      console.log(chalk.green('Summary:'));
      console.log(`  Files migrated: ${filesMoved}`);
      console.log(`  Directories created: ${dirsCreated}`);
      console.log(`  Destination: ${destBase}`);

      if (options.dryRun) {
        console.log('');
        console.log(chalk.yellow('Dry run - no changes made.'));
        console.log(chalk.gray('Run without --dry-run to perform the migration.'));
      } else if (options.delete) {
        console.log('');
        console.log(chalk.cyan('Next steps:'));
        console.log('  1. Remove migrated folders from project:');
        console.log(chalk.gray(`     rm -rf ${projectPath}/docs/bugs`));
        console.log(chalk.gray(`     rm -rf ${projectPath}/docs/improvements`));
        console.log(chalk.gray(`     rm -rf ${projectPath}/docs/features`));
        console.log('  2. Keep docs/PLANNING.md (auto-generated)');
        console.log('  3. Run `spellbook generate` to update PLANNING.md');
      }
    } catch (err) {
      spinner.fail('Migration failed.');
      error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

interface MigrateResult {
  files: number;
  dirs: number;
}

async function migrateDirectory(
  srcBase: string,
  destBase: string,
  type: string,
  _projectId: string,
  dryRun: boolean,
  _deleteOriginal: boolean
): Promise<MigrateResult> {
  let files = 0;
  let dirs = 0;

  if (!existsSync(srcBase)) {
    return { files: 0, dirs: 0 };
  }

  const subdirs = ['active', 'resolved', 'completed'].filter((d) =>
    existsSync(join(srcBase, d))
  );

  for (const subdir of subdirs) {
    const srcDir = join(srcBase, subdir);
    const destDir = join(destBase, subdir);

    if (!existsSync(srcDir)) continue;

    if (!dryRun && !existsSync(destDir)) {
      mkdirSync(destDir, { recursive: true });
      dirs++;
    }

    const entries = readdirSync(srcDir);

    for (const entry of entries) {
      if (!entry.endsWith('.md')) continue;

      const srcFile = join(srcDir, entry);
      const destFile = join(destDir, entry);

      console.log(chalk.gray(`  ${type}/${subdir}/${entry}`));

      if (!dryRun) {
        copyFileSync(srcFile, destFile);
        files++;
      }
    }
  }

  return { files, dirs };
}

async function migrateFeatures(
  srcBase: string,
  destBase: string,
  _projectId: string,
  dryRun: boolean,
  _deleteOriginal: boolean
): Promise<MigrateResult> {
  let files = 0;
  let dirs = 0;

  if (!existsSync(srcBase)) {
    return { files: 0, dirs: 0 };
  }

  const entries = readdirSync(srcBase, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!entry.name.match(/^\d+-/)) continue;

    const srcDir = join(srcBase, entry.name);
    const destDir = join(destBase, entry.name);

    console.log(chalk.gray(`  features/${entry.name}/`));

    if (!dryRun) {
      // Copy entire feature directory
      copyDirectoryRecursive(srcDir, destDir);
      dirs++;

      // Count files
      const countFiles = (dir: string): number => {
        let count = 0;
        const items = readdirSync(dir, { withFileTypes: true });
        for (const item of items) {
          if (item.isDirectory()) {
            count += countFiles(join(dir, item.name));
          } else {
            count++;
          }
        }
        return count;
      };
      files += countFiles(srcDir);
    }
  }

  return { files, dirs };
}

function copyDirectoryRecursive(src: string, dest: string): void {
  if (!existsSync(dest)) {
    mkdirSync(dest, { recursive: true });
  }

  const entries = readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDirectoryRecursive(srcPath, destPath);
    } else {
      copyFileSync(srcPath, destPath);
    }
  }
}

async function updateDatabasePaths(projectId: string, _destBase: string): Promise<void> {
  // Update bugs
  const bugs = getBugsByProject(projectId);
  for (const bug of bugs) {
    const subdir = bug.status === 'resolved' ? 'resolved' : 'active';
    const newPath = `~/.spellbook/projects/${projectId}/bugs/${subdir}/${bug.number}-${bug.slug}.md`;
    updateBug(projectId, bug.number, { doc_path: newPath });
  }

  // Update improvements
  const improvements = getImprovementsByProject(projectId);
  for (const imp of improvements) {
    const subdir = imp.status === 'completed' ? 'completed' : 'active';
    const newPath = `~/.spellbook/projects/${projectId}/improvements/${subdir}/${imp.number}-${imp.slug}.md`;
    updateImprovement(projectId, imp.number, { doc_path: newPath });
  }

  // Update features
  const features = getFeaturesByProject(projectId);
  for (const feat of features) {
    // Construct folder name from feature number and name
    const folderName = `${String(feat.number).padStart(2, '0')}-${feat.name
      .toLowerCase()
      .replace(/\s+/g, '-')}`;
    const newPath = `~/.spellbook/projects/${projectId}/features/${folderName}/`;
    updateFeature(projectId, feat.number, { doc_path: newPath });
  }
}
