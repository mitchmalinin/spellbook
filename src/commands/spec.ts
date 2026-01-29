import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import {
  getInboxItem,
  removeFromInbox,
  createBug,
  createImprovement,
  createFeature,
  getNextBugNumber,
  getNextImprovementNumber,
  getNextFeatureNumber,
  logActivity,
} from '../db/index.js';
import { getCurrentProject } from '../utils/project.js';
import { error, info } from '../utils/format.js';

// Central storage directory for Spellbook
const SPELLBOOK_DIR = join(homedir(), '.spellbook', 'projects');

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 40);
}

function getToday(): string {
  return new Date().toISOString().split('T')[0];
}

function generateBugSpec(number: number, title: string, priority: string): string {
  return `# Bug ${number}: ${title}

**Status:** 🔴 Spec Draft
**Priority:** ${priority.charAt(0).toUpperCase() + priority.slice(1)}
**Created:** ${getToday()}
**Environment:** [devnet | mainnet | both]

## Issue
[Description of the bug - expand on the original idea]

## Steps to Reproduce
1. [Step 1]
2. [Step 2]

## Expected vs Actual Behavior
- **Expected:** [What should happen]
- **Actual:** [What actually happens]

## Code Location
- \`[path/to/file.ts:lineNumber]\`

## Proposed Solution
[Implementation approach, if known]

## Definition of Ready
- [ ] Steps to reproduce are clear
- [ ] Code location identified
- [ ] Solution approach documented
- [ ] Priority confirmed

## Notes
[Additional context]

---

## Changelog

_Updated during implementation for context handover._

| Date | Change | Author |
|------|--------|--------|
| ${getToday()} | Created from inbox | Claude |
`;
}

function generateImprovementSpec(number: number, title: string, priority: string): string {
  return `# Improvement ${number}: ${title}

**Status:** 🔴 Spec Draft
**Priority:** ${priority.charAt(0).toUpperCase() + priority.slice(1)}
**Created:** ${getToday()}
**Linked Feature:** [Feature XX | None]

## Goal
[1-2 sentence description - expand on the original idea]

## Current State
[What's happening now / the problem]

## Desired State
[What it should be after improvement]

## Scope
- [ ] Task 1
- [ ] Task 2
- [ ] Task 3

## Files to Modify
- \`path/to/file.ts\`
- \`path/to/another-file.ts\`

## Definition of Ready
- [ ] Current state documented
- [ ] Desired state clear
- [ ] Scope defined
- [ ] Files identified

## Notes
[Additional context]

---

## Changelog

_Updated during implementation for context handover._

| Date | Change | Author |
|------|--------|--------|
| ${getToday()} | Created from inbox | Claude |
`;
}

function generateFeatureSpec(number: number, name: string): string {
  return `# Feature ${number}: ${name}

**Status:** 🔴 Spec Draft
**Created:** ${getToday()}

## Overview
[1-2 sentence description - expand on the original idea]

## Goals
- [ ] Goal 1
- [ ] Goal 2

## User Stories
- As a [user type], I want to [action], so that [benefit]

## Tasks
| # | Task | Status |
|---|------|--------|
| 1 | [Task name] | 🔴 |

## Technical Approach
[High-level implementation approach]

## Definition of Ready
- [ ] User stories defined
- [ ] Tasks broken down
- [ ] Technical approach documented
- [ ] Dependencies identified

## Related
- Feature XX: [Related feature]
- Bug XX: [Related bug]

## Notes
[Additional context]
`;
}

export const specCommand = new Command('spec')
  .description('Convert an inbox item to a detailed spec file')
  .argument('<reference>', 'Inbox item reference (e.g., idea-5)')
  .option('--priority <level>', 'Override priority: high, medium, low')
  .action(async (reference, options) => {
    const spinner = ora('Creating spec...').start();

    try {
      const context = getCurrentProject();
      if (!context) {
        spinner.fail('Not in a Spellbook project.');
        error('Run `spellbook init` first.');
        process.exit(1);
      }

      // Parse reference
      const match = reference.match(/^idea-(\d+)$/);
      if (!match) {
        spinner.fail('Invalid reference format.');
        error('Expected format: idea-<number> (e.g., idea-5)');
        process.exit(1);
      }

      const ideaId = parseInt(match[1], 10);
      const inboxItem = getInboxItem(ideaId);

      if (!inboxItem) {
        spinner.fail(`Inbox item idea-${ideaId} not found.`);
        process.exit(1);
      }

      const { project } = context;
      const projectPath = project.path;
      const priority = options.priority || inboxItem.priority;
      const title = inboxItem.description;
      const slug = slugify(title);

      let specPath: string;
      let itemRef: string;
      let number: number;

      if (inboxItem.type === 'bug') {
        // Create bug spec in centralized storage (branch-independent)
        number = getNextBugNumber(project.id);
        const bugsDir = join(SPELLBOOK_DIR, project.id, 'bugs');
        if (!existsSync(bugsDir)) {
          mkdirSync(bugsDir, { recursive: true });
        }

        const fileName = `${number}-${slug}.md`;
        specPath = join(bugsDir, fileName);
        const content = generateBugSpec(number, title, priority);
        writeFileSync(specPath, content, 'utf-8');

        createBug({
          project_id: project.id,
          number,
          slug,
          title,
          priority,
          status: 'spec_draft',
          owner: undefined,
          blocked_by: undefined,
          source_inbox_id: ideaId,
          doc_path: `bugs/${fileName}`,
        });

        itemRef = `bug-${number}`;

      } else if (inboxItem.type === 'improvement') {
        // Create improvement spec in centralized storage (branch-independent)
        number = getNextImprovementNumber(project.id);
        const improvementsDir = join(SPELLBOOK_DIR, project.id, 'improvements');
        if (!existsSync(improvementsDir)) {
          mkdirSync(improvementsDir, { recursive: true });
        }

        const fileName = `${number}-${slug}.md`;
        specPath = join(improvementsDir, fileName);
        const content = generateImprovementSpec(number, title, priority);
        writeFileSync(specPath, content, 'utf-8');

        createImprovement({
          project_id: project.id,
          number,
          slug,
          title,
          priority,
          linked_feature: undefined,
          status: 'spec_draft',
          owner: undefined,
          blocked_by: undefined,
          source_inbox_id: ideaId,
          doc_path: `improvements/${fileName}`,
        });

        itemRef = `improvement-${number}`;

      } else {
        // Create feature spec in centralized storage (branch-independent)
        number = getNextFeatureNumber(project.id);
        const featureDir = join(SPELLBOOK_DIR, project.id, 'features', `${String(number).padStart(2, '0')}-${slug}`);
        if (!existsSync(featureDir)) {
          mkdirSync(featureDir, { recursive: true });
        }

        specPath = join(featureDir, 'README.md');
        const content = generateFeatureSpec(number, title);
        writeFileSync(specPath, content, 'utf-8');

        createFeature({
          project_id: project.id,
          number,
          name: title,
          status: 'spec_draft',
          doc_path: `features/${String(number).padStart(2, '0')}-${slug}/`,
          tasks: 0,
          source_inbox_id: ideaId,
        });

        itemRef = `feature-${number}`;
      }

      // Remove from inbox
      removeFromInbox(ideaId);

      // Log activity
      logActivity({
        project_id: project.id,
        item_type: inboxItem.type,
        item_ref: itemRef,
        action: 'created',
        message: `Created spec from idea-${ideaId}: ${title.substring(0, 50)}...`,
        author: 'Claude',
      });

      spinner.succeed(`Spec created!`);

      console.log('');
      console.log(chalk.cyan(`  Reference: `) + chalk.white(itemRef));
      console.log(chalk.cyan(`  File:      `) + chalk.white(specPath.replace(projectPath, '.')));
      console.log(chalk.cyan(`  Status:    `) + chalk.yellow('spec_draft'));
      console.log('');
      info(`Edit the spec file to add details, then: spellbook ready ${itemRef}`);

    } catch (err) {
      spinner.fail('Failed to create spec.');
      error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

export const readyCommand = new Command('ready')
  .description('Mark a spec as ready for implementation (Definition of Ready met)')
  .argument('<reference>', 'Item reference (e.g., bug-44, improvement-31, feature-22)')
  .action(async (reference) => {
    const spinner = ora('Marking as ready...').start();

    try {
      const context = getCurrentProject();
      if (!context) {
        spinner.fail('Not in a Spellbook project.');
        error('Run `spellbook init` first.');
        process.exit(1);
      }

      // Import update functions dynamically to avoid circular deps
      const { updateBug, updateImprovement, getBug, getImprovement } = await import('../db/index.js');

      const { project } = context;

      // Parse reference
      const bugMatch = reference.match(/^bug-(\d+)$/);
      const impMatch = reference.match(/^improvement-(\d+)$/);
      const featMatch = reference.match(/^feature-(\d+)$/);

      if (bugMatch) {
        const number = parseInt(bugMatch[1], 10);
        const bug = getBug(project.id, number);
        if (!bug) {
          spinner.fail(`Bug ${number} not found.`);
          process.exit(1);
        }
        if (bug.status !== 'spec_draft') {
          spinner.fail(`Bug ${number} is not in spec_draft status (current: ${bug.status}).`);
          process.exit(1);
        }
        updateBug(project.id, number, { status: 'spec_ready' });

        logActivity({
          project_id: project.id,
          item_type: 'bug',
          item_ref: reference,
          action: 'ready',
          message: 'Marked as spec_ready - Definition of Ready met',
          author: 'Claude',
        });

      } else if (impMatch) {
        const number = parseInt(impMatch[1], 10);
        const imp = getImprovement(project.id, number);
        if (!imp) {
          spinner.fail(`Improvement ${number} not found.`);
          process.exit(1);
        }
        if (imp.status !== 'spec_draft') {
          spinner.fail(`Improvement ${number} is not in spec_draft status (current: ${imp.status}).`);
          process.exit(1);
        }
        updateImprovement(project.id, number, { status: 'spec_ready' });

        logActivity({
          project_id: project.id,
          item_type: 'improvement',
          item_ref: reference,
          action: 'ready',
          message: 'Marked as spec_ready - Definition of Ready met',
          author: 'Claude',
        });

      } else if (featMatch) {
        spinner.fail('Feature ready command not yet implemented.');
        process.exit(1);

      } else {
        spinner.fail('Invalid reference format.');
        error('Expected: bug-<n>, improvement-<n>, or feature-<n>');
        process.exit(1);
      }

      spinner.succeed(`${reference} marked as ready for implementation!`);
      console.log('');
      info(`To start implementation: spellbook start ${reference}`);

    } catch (err) {
      spinner.fail('Failed to mark as ready.');
      error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

export const startCommand = new Command('start')
  .description('Start implementation (move from spec_ready to active)')
  .argument('<reference>', 'Item reference (e.g., bug-44, improvement-31)')
  .action(async (reference) => {
    const spinner = ora('Starting implementation...').start();

    try {
      const context = getCurrentProject();
      if (!context) {
        spinner.fail('Not in a Spellbook project.');
        error('Run `spellbook init` first.');
        process.exit(1);
      }

      const { updateBug, updateImprovement, getBug, getImprovement } = await import('../db/index.js');

      const { project } = context;

      // Parse reference
      const bugMatch = reference.match(/^bug-(\d+)$/);
      const impMatch = reference.match(/^improvement-(\d+)$/);

      if (bugMatch) {
        const number = parseInt(bugMatch[1], 10);
        const bug = getBug(project.id, number);
        if (!bug) {
          spinner.fail(`Bug ${number} not found.`);
          process.exit(1);
        }
        if (bug.status !== 'spec_ready') {
          spinner.fail(`Bug ${number} is not in spec_ready status (current: ${bug.status}).`);
          info('Mark as ready first: spellbook ready ' + reference);
          process.exit(1);
        }
        updateBug(project.id, number, { status: 'active' });

        logActivity({
          project_id: project.id,
          item_type: 'bug',
          item_ref: reference,
          action: 'started',
          message: 'Started implementation',
          author: 'Claude',
        });

      } else if (impMatch) {
        const number = parseInt(impMatch[1], 10);
        const imp = getImprovement(project.id, number);
        if (!imp) {
          spinner.fail(`Improvement ${number} not found.`);
          process.exit(1);
        }
        if (imp.status !== 'spec_ready') {
          spinner.fail(`Improvement ${number} is not in spec_ready status (current: ${imp.status}).`);
          info('Mark as ready first: spellbook ready ' + reference);
          process.exit(1);
        }
        updateImprovement(project.id, number, { status: 'active' });

        logActivity({
          project_id: project.id,
          item_type: 'improvement',
          item_ref: reference,
          action: 'started',
          message: 'Started implementation',
          author: 'Claude',
        });

      } else {
        spinner.fail('Invalid reference format.');
        error('Expected: bug-<n> or improvement-<n>');
        process.exit(1);
      }

      spinner.succeed(`${reference} is now active!`);
      console.log('');
      info(`Use /implement ${reference} in Claude Code to implement.`);

    } catch (err) {
      spinner.fail('Failed to start implementation.');
      error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });
