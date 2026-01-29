import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import {
  createBug,
  createImprovement,
  addToInbox,
  getNextBugNumber,
  getNextImprovementNumber,
  logActivity,
} from '../db/index.js';
import { getCurrentProject, generateSlug } from '../utils/project.js';
import { error, formatDate } from '../utils/format.js';
import { debouncedSync } from '../utils/git-sync.js';

// Central storage directory for Spellbook
const SPELLBOOK_DIR = join(homedir(), '.spellbook', 'projects');

export const logCommand = new Command('log')
  .description('Log a bug, improvement, or feature idea')
  .argument('<type>', 'Type: bug, improvement, or feature')
  .argument('<title>', 'Title/description of the item')
  .option('-p, --priority <level>', 'Priority: critical, high, medium, low', 'medium')
  .option('-d, --description <text>', 'Detailed description of the issue/improvement')
  .option('-f, --linked-feature <number>', 'Link to a feature number')
  .option('-b, --blocked-by <refs>', 'Blocked by (comma-separated refs)')
  .option('--steps <text>', 'Steps to reproduce (for bugs)')
  .option('--expected <text>', 'Expected behavior (for bugs)')
  .option('--actual <text>', 'Actual behavior (for bugs)')
  .option('--location <text>', 'Code location (file paths)')
  .option('--solution <text>', 'Proposed solution')
  .action(async (type: string, title: string, options) => {
    const spinner = ora('Logging item...').start();

    try {
      const context = getCurrentProject();
      if (!context) {
        spinner.fail('Not in a Spellbook project.');
        error('Run `spellbook init` first.');
        process.exit(1);
      }

      const { project } = context;
      const today = formatDate(new Date());

      switch (type.toLowerCase()) {
        case 'bug': {
          const number = getNextBugNumber(project.id);
          const slug = generateSlug(title);
          // Use centralized storage path (branch-independent)
          const docPath = `bugs/${number}-${slug}.md`;
          const centralBugsDir = join(SPELLBOOK_DIR, project.id, 'bugs');
          const fullDocPath = join(centralBugsDir, `${number}-${slug}.md`);

          // Ensure central bugs directory exists
          if (!existsSync(centralBugsDir)) {
            mkdirSync(centralBugsDir, { recursive: true });
          }

          // Create bug in database
          createBug({
            project_id: project.id,
            number,
            slug,
            title,
            priority: options.priority,
            status: 'active',
            owner: undefined,
            blocked_by: options.blockedBy || undefined,
            source_inbox_id: undefined,
            doc_path: docPath,
          });

          // Create markdown file
          const content = generateBugMarkdown(number, title, options.priority, today, {
            description: options.description,
            steps: options.steps,
            expected: options.expected,
            actual: options.actual,
            location: options.location,
            solution: options.solution,
          });
          writeFileSync(fullDocPath, content, 'utf-8');

          // Log activity
          logActivity({
            project_id: project.id,
            item_type: 'bug',
            item_ref: `bug-${number}`,
            action: 'created',
            message: title,
            author: 'Spellbook',
          });

          // Auto-commit to git for backup
          debouncedSync(project.id, `Created bug-${number}: ${title}`);

          spinner.succeed(`Bug #${number} logged.`);
          console.log('');
          console.log(chalk.cyan('Bug:'), chalk.white(`#${number} - ${title}`));
          console.log(chalk.cyan('File:'), chalk.gray(`~/.spellbook/projects/${project.id}/${docPath}`));
          console.log(chalk.cyan('Priority:'), chalk.yellow(options.priority));
          console.log('');
          console.log(chalk.gray('Next:'), `Run ${chalk.white(`/implement bug-${number}`)} when ready to fix.`);
          break;
        }

        case 'improvement': {
          const number = getNextImprovementNumber(project.id);
          const slug = generateSlug(title);
          // Use centralized storage path (branch-independent)
          const docPath = `improvements/${number}-${slug}.md`;
          const centralImprovementsDir = join(SPELLBOOK_DIR, project.id, 'improvements');
          const fullDocPath = join(centralImprovementsDir, `${number}-${slug}.md`);

          // Ensure central improvements directory exists
          if (!existsSync(centralImprovementsDir)) {
            mkdirSync(centralImprovementsDir, { recursive: true });
          }

          // Create improvement in database
          createImprovement({
            project_id: project.id,
            number,
            slug,
            title,
            priority: options.priority,
            linked_feature: options.linkedFeature ? parseInt(options.linkedFeature, 10) : undefined,
            status: 'active',
            owner: undefined,
            blocked_by: options.blockedBy || undefined,
            source_inbox_id: undefined,
            doc_path: docPath,
          });

          // Create markdown file
          const content = generateImprovementMarkdown(
            number,
            title,
            options.priority,
            today,
            options.linkedFeature,
            {
              description: options.description,
              location: options.location,
              solution: options.solution,
            }
          );
          writeFileSync(fullDocPath, content, 'utf-8');

          // Log activity
          logActivity({
            project_id: project.id,
            item_type: 'improvement',
            item_ref: `improvement-${number}`,
            action: 'created',
            message: title,
            author: 'Spellbook',
          });

          // Auto-commit to git for backup
          debouncedSync(project.id, `Created improvement-${number}: ${title}`);

          spinner.succeed(`Improvement #${number} logged.`);
          console.log('');
          console.log(chalk.cyan('Improvement:'), chalk.white(`#${number} - ${title}`));
          console.log(chalk.cyan('File:'), chalk.gray(`~/.spellbook/projects/${project.id}/${docPath}`));
          console.log(chalk.cyan('Priority:'), chalk.yellow(options.priority));
          console.log('');
          console.log(
            chalk.gray('Next:'),
            `Run ${chalk.white(`/implement improvement-${number}`)} when ready to implement.`
          );
          break;
        }

        case 'feature': {
          // Features go to inbox
          addToInbox({
            project_id: project.id,
            description: title,
            type: 'feature',
            priority: options.priority || 'medium',
          });

          // Log activity
          logActivity({
            project_id: project.id,
            item_type: 'feature',
            item_ref: 'inbox',
            action: 'created',
            message: title,
            author: 'Spellbook',
          });

          spinner.succeed('Feature idea added to inbox.');
          console.log('');
          console.log(chalk.cyan('Feature:'), chalk.white(title));
          console.log(chalk.cyan('Location:'), chalk.gray('Feature Inbox (run `spellbook roadmap` to update)'));
          console.log('');
          console.log(
            chalk.gray('Next:'),
            `Run ${chalk.white('/plan')} when ready to fully plan the feature.`
          );
          break;
        }

        default:
          spinner.fail(`Unknown type: ${type}`);
          error('Valid types: bug, improvement, feature');
          process.exit(1);
      }
    } catch (err) {
      spinner.fail('Failed to log item.');
      error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

interface BugDetails {
  description?: string;
  steps?: string;
  expected?: string;
  actual?: string;
  location?: string;
  solution?: string;
}

function generateBugMarkdown(
  number: number,
  title: string,
  priority: string,
  date: string,
  details: BugDetails = {}
): string {
  const description = details.description || '[Description of the bug]';
  const steps = details.steps
    ? details.steps.split('\\n').map((s, i) => `${i + 1}. ${s.trim()}`).join('\n')
    : '1. [Step 1]\n2. [Step 2]';
  const expected = details.expected || '[What should happen]';
  const actual = details.actual || '[What actually happens]';
  const location = details.location
    ? details.location.split(',').map(l => `- \`${l.trim()}\``).join('\n')
    : '- `[path/to/file.ts:lineNumber]`';
  const solution = details.solution || '[Implementation approach, if known]';

  return `# Bug ${number}: ${title}

**Status:** 🔴 Not Started
**Priority:** ${priority.charAt(0).toUpperCase() + priority.slice(1)}
**Created:** ${date}
**Environment:** [devnet | mainnet | both]

## Issue
${description}

## Steps to Reproduce
${steps}

## Expected vs Actual Behavior
- **Expected:** ${expected}
- **Actual:** ${actual}

## Code Location
${location}

## Proposed Solution
${solution}

## Notes
[Additional context]

---

## Changelog

_Updated during implementation for context handover._

| Date | Change | Author |
|------|--------|--------|
| ${date} | Created | Spellbook |
`;
}

interface ImprovementDetails {
  description?: string;
  location?: string;
  solution?: string;
}

function generateImprovementMarkdown(
  number: number,
  title: string,
  priority: string,
  date: string,
  linkedFeature?: string,
  details: ImprovementDetails = {}
): string {
  const featureLink = linkedFeature ? `Feature ${linkedFeature}` : 'None';
  const description = details.description || '[1-2 sentence description]';
  const location = details.location
    ? details.location.split(',').map(l => `- \`${l.trim()}\``).join('\n')
    : '- `path/to/file.ts`\n- `path/to/another-file.ts`';
  const solution = details.solution || '';

  return `# Improvement ${number}: ${title}

**Status:** 🔴 Not Started
**Priority:** ${priority.charAt(0).toUpperCase() + priority.slice(1)}
**Created:** ${date}
**Linked Feature:** ${featureLink}

## Goal
${description}

## Current State
[What's happening now / the problem]

## Desired State
[What it should be after improvement]
${solution ? `\n## Proposed Approach\n${solution}\n` : ''}
## Scope
- [ ] Task 1
- [ ] Task 2
- [ ] Task 3

## Files to Modify
${location}

## Notes
[Additional context]

---

## Changelog

_Updated during implementation for context handover._

| Date | Change | Author |
|------|--------|--------|
| ${date} | Created | Spellbook |
`;
}
