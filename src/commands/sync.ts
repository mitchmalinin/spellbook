import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { readdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import {
  createBug,
  createImprovement,
  createFeature,
  getBug,
  getImprovement,
  updateBug,
  updateImprovement,
} from '../db/index.js';
import { getCurrentProject } from '../utils/project.js';
import { error } from '../utils/format.js';

// Central storage directory for Spellbook
const SPELLBOOK_DIR = join(homedir(), '.spellbook', 'projects');

export const syncCommand = new Command('sync')
  .description('Sync database with markdown files')
  .option('--dry-run', 'Show what would be synced without making changes')
  .option('--direction <dir>', 'Sync direction: db-to-md, md-to-db, or both', 'both')
  .action(async (options) => {
    const spinner = ora('Syncing...').start();

    try {
      const context = getCurrentProject();
      if (!context) {
        spinner.fail('Not in a Spellbook project.');
        error('Run `spellbook init` first.');
        process.exit(1);
      }

      const { project } = context;
      let synced = 0;

      // Sync bugs from markdown to database (using centralized storage)
      if (options.direction === 'md-to-db' || options.direction === 'both') {
        const centralDir = join(SPELLBOOK_DIR, project.id);

        spinner.text = 'Scanning bugs...';
        const bugsDir = join(centralDir, 'bugs');
        synced += await syncBugsFromDir(project.id, bugsDir, options.dryRun);

        spinner.text = 'Scanning improvements...';
        const improvementsDir = join(centralDir, 'improvements');
        synced += await syncImprovementsFromDir(project.id, improvementsDir, options.dryRun);

        spinner.text = 'Scanning features...';
        const featuresDir = join(centralDir, 'features');
        synced += await syncFeaturesFromDir(project.id, featuresDir, options.dryRun);
      }

      spinner.succeed(`Sync complete. ${synced} items processed.`);

      if (options.dryRun) {
        console.log('');
        console.log(chalk.yellow('Dry run - no changes made.'));
      }
    } catch (err) {
      spinner.fail('Sync failed.');
      error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

async function syncBugsFromDir(
  projectId: string,
  dirPath: string,
  dryRun: boolean
): Promise<number> {
  if (!existsSync(dirPath)) return 0;

  const files = readdirSync(dirPath).filter((f) => f.endsWith('.md'));
  let count = 0;

  for (const file of files) {
    const match = file.match(/^(\d+)-(.+)\.md$/);
    if (!match) continue;

    const number = parseInt(match[1], 10);
    const slug = match[2];
    const filePath = join(dirPath, file);
    const content = readFileSync(filePath, 'utf-8');

    // Parse title from markdown
    const titleMatch = content.match(/^# Bug \d+: (.+)$/m);
    const title = titleMatch ? titleMatch[1] : slug;

    // Parse priority from markdown
    const priorityMatch = content.match(/\*\*Priority:\*\* (\w+)/);
    const priority = priorityMatch ? priorityMatch[1].toLowerCase() : 'medium';

    // Parse status from markdown (centralized storage uses file content, not folder location)
    let status = 'active';
    if (content.includes('**Status:** ✅') || content.includes('Resolved')) {
      status = 'resolved';
    } else if (content.includes('**Status:** 🟡') || content.includes('In Progress')) {
      status = 'in_progress';
    }

    // Check if exists in database
    const existing = getBug(projectId, number);

    if (!dryRun) {
      if (existing) {
        updateBug(projectId, number, { status, priority, title, slug });
      } else {
        createBug({
          project_id: projectId,
          number,
          slug,
          title,
          priority,
          status,
          owner: undefined,
          blocked_by: undefined,
          source_inbox_id: undefined,
          doc_path: `bugs/${file}`,
        });
      }
    }

    count++;
  }

  return count;
}

async function syncImprovementsFromDir(
  projectId: string,
  dirPath: string,
  dryRun: boolean
): Promise<number> {
  if (!existsSync(dirPath)) return 0;

  const files = readdirSync(dirPath).filter((f) => f.endsWith('.md'));
  let count = 0;

  for (const file of files) {
    const match = file.match(/^(\d+)-(.+)\.md$/);
    if (!match) continue;

    const number = parseInt(match[1], 10);
    const slug = match[2];
    const filePath = join(dirPath, file);
    const content = readFileSync(filePath, 'utf-8');

    // Parse title from markdown
    const titleMatch = content.match(/^# Improvement \d+: (.+)$/m);
    const title = titleMatch ? titleMatch[1] : slug;

    // Parse priority from markdown
    const priorityMatch = content.match(/\*\*Priority:\*\* (\w+)/);
    const priority = priorityMatch ? priorityMatch[1].toLowerCase() : 'medium';

    // Parse linked feature
    const featureMatch = content.match(/\*\*Linked Feature:\*\* Feature (\d+)/);
    const linkedFeature = featureMatch ? parseInt(featureMatch[1], 10) : undefined;

    // Parse status from markdown (centralized storage uses file content, not folder location)
    let status = 'active';
    if (content.includes('**Status:** ✅') || content.includes('Completed')) {
      status = 'completed';
    } else if (content.includes('**Status:** 🟡') || content.includes('In Progress')) {
      status = 'in_progress';
    }

    // Check if exists in database
    const existing = getImprovement(projectId, number);

    if (!dryRun) {
      if (existing) {
        updateImprovement(projectId, number, { status, priority, title, slug, linked_feature: linkedFeature });
      } else {
        createImprovement({
          project_id: projectId,
          number,
          slug,
          title,
          priority,
          linked_feature: linkedFeature,
          status,
          owner: undefined,
          blocked_by: undefined,
          source_inbox_id: undefined,
          doc_path: `improvements/${file}`,
        });
      }
    }

    count++;
  }

  return count;
}

async function syncFeaturesFromDir(
  projectId: string,
  dirPath: string,
  dryRun: boolean
): Promise<number> {
  if (!existsSync(dirPath)) return 0;

  const entries = readdirSync(dirPath, { withFileTypes: true });
  let count = 0;

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const match = entry.name.match(/^(\d+)-(.+)$/);
    if (!match) continue;

    const number = parseInt(match[1], 10);
    const name = match[2].replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    const readmePath = join(dirPath, entry.name, 'README.md');

    let status = 'not_started';
    let tasks = 0;

    if (existsSync(readmePath)) {
      const content = readFileSync(readmePath, 'utf-8');

      // Parse status
      if (content.includes('**Status:** ✅') || content.includes('Status:** Complete')) {
        status = 'complete';
      } else if (content.includes('**Status:** 🟡') || content.includes('In Progress')) {
        status = 'in_progress';
      }

      // Count tasks
      const taskMatches = content.match(/^\| \d+ \|/gm);
      tasks = taskMatches ? taskMatches.length : 0;
    }

    if (!dryRun) {
      createFeature({
        project_id: projectId,
        number,
        name,
        status,
        doc_path: `features/${entry.name}/`,
        tasks,
        source_inbox_id: undefined,
      });
    }

    count++;
  }

  return count;
}
