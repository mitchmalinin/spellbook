import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { join } from 'path';
import yaml from 'yaml';
import { createProject, getProjectByPath, getDb } from '../db/index.js';
import {
  findProjectRoot,
  generateProjectId,
  getProjectName,
  isGitRepo,
  SpellbookConfig,
} from '../utils/project.js';
import { success, error, info, warn } from '../utils/format.js';

export const initCommand = new Command('init')
  .description('Initialize Spellbook for the current project')
  .option('--full', 'Full setup: docs structure + Claude skills')
  .option('--name <name>', 'Project name (defaults to directory name)')
  .option('--id <id>', 'Project ID (defaults to slugified name)')
  .action(async (options) => {
    const spinner = ora('Initializing Spellbook...').start();

    try {
      const cwd = process.cwd();

      // Check if already initialized
      if (existsSync(join(cwd, '.spellbook.yaml'))) {
        spinner.stop();
        warn('Project already initialized with Spellbook.');
        info(`Config: ${join(cwd, '.spellbook.yaml')}`);
        return;
      }

      // Determine project root
      const projectPath = findProjectRoot(cwd) || cwd;

      // Warn if not a git repo
      if (!isGitRepo(projectPath)) {
        spinner.warn('Not a git repository. Spellbook works best with git.');
      }

      // Get project name and ID
      const projectName = options.name || getProjectName(projectPath);
      const projectId = options.id || generateProjectId(projectName);

      // Check if project already exists in DB
      const existing = getProjectByPath(projectPath);
      if (existing) {
        spinner.stop();
        warn(`Project already registered as '${existing.id}'.`);
        info('Creating .spellbook.yaml with existing registration...');
      }

      // Create project in database
      const project = createProject({
        id: projectId,
        name: projectName,
        path: projectPath,
        description: `Spellbook project for ${projectName}`,
      });

      // Create .spellbook.yaml
      const config: SpellbookConfig = {
        project: {
          id: project.id,
          name: project.name,
        },
        settings: {
          auto_generate: true,
          show_resolved: false,
        },
      };

      writeFileSync(
        join(projectPath, '.spellbook.yaml'),
        yaml.stringify(config),
        'utf-8'
      );

      spinner.succeed(`Project '${project.name}' registered.`);

      // Full setup
      if (options.full) {
        spinner.start('Creating docs structure...');

        // Create directory structure
        const dirs = [
          'docs/bugs/active',
          'docs/bugs/resolved',
          'docs/improvements/active',
          'docs/improvements/completed',
          'docs/features',
          'docs/knowledge/architecture',
          'docs/knowledge/decisions',
          'docs/knowledge/guides',
          'docs/knowledge/api',
          'docs/knowledge/research',
          'docs/knowledge/templates',
        ];

        for (const dir of dirs) {
          const fullPath = join(projectPath, dir);
          if (!existsSync(fullPath)) {
            mkdirSync(fullPath, { recursive: true });
          }
        }

        spinner.succeed('Created docs structure.');

        // Create template files
        spinner.start('Creating templates...');
        createTemplates(projectPath);
        spinner.succeed('Created templates.');

        // Create ROADMAP.md if it doesn't exist
        if (!existsSync(join(projectPath, 'docs/knowledge/ROADMAP.md'))) {
          spinner.start('Creating ROADMAP.md...');
          createRoadmapFile(projectPath, project.name);
          spinner.succeed('Created ROADMAP.md.');
        }

        // Create Claude skills
        spinner.start('Generating Claude skills...');
        createClaudeSkills(projectPath);
        spinner.succeed('Generated Claude skills.');
      }

      // Scan existing skills
      spinner.start('Scanning for existing skills...');
      const skillCount = scanSkills(projectPath, projectId);
      spinner.succeed(`Found ${skillCount} skills.`);

      console.log('');
      success('Spellbook initialized!');
      console.log('');
      console.log(chalk.cyan('Next steps:'));
      console.log(`  ${chalk.gray('•')} Log a bug:        ${chalk.white('spellbook log bug "description"')}`);
      console.log(`  ${chalk.gray('•')} Log improvement:  ${chalk.white('spellbook log improvement "description"')}`);
      console.log(`  ${chalk.gray('•')} View status:      ${chalk.white('spellbook status')}`);

    } catch (err) {
      spinner.fail('Initialization failed.');
      error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

function createTemplates(projectPath: string): void {
  const templates = {
    'BUG_TEMPLATE.md': `# Bug [NUMBER]: [Title]

**Status:** 🔴 Not Started
**Priority:** [High | Medium | Low]
**Created:** [YYYY-MM-DD]
**Environment:** [devnet | mainnet | both]

## Issue
[Description of the bug]

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

## Notes
[Additional context]

---

## Changelog

_Updated during implementation for context handover._

| Date | Change | Author |
|------|--------|--------|
| [YYYY-MM-DD] | Created | Claude |
`,

    'IMPROVEMENT_TEMPLATE.md': `# Improvement [NUMBER]: [Title]

**Status:** 🔴 Not Started
**Priority:** [Critical | High | Medium | Low]
**Created:** [YYYY-MM-DD]
**Linked Feature:** [Feature XX | None]

## Goal
[1-2 sentence description]

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

## Notes
[Additional context]

---

## Changelog

_Updated during implementation for context handover._

| Date | Change | Author |
|------|--------|--------|
| [YYYY-MM-DD] | Created | Claude |
`,

    'FEATURE_TEMPLATE.md': `# Feature [NUMBER]: [Name]

**Status:** 🔴 Not Started
**Created:** [YYYY-MM-DD]

## Overview
[1-2 sentence description of what this feature does]

## Goals
- [ ] Goal 1
- [ ] Goal 2

## Tasks
See \`tasks/\` folder for individual task files.

| # | Task | Status |
|---|------|--------|
| 1 | [Task name] | 🔴 |

## Technical Approach
[High-level implementation approach]

## Related
- Feature XX: [Related feature]
- Bug XX: [Related bug]

## Notes
[Additional context]
`,

    'ADR_TEMPLATE.md': `# ADR-[NUMBER]: [Title]

**Status:** [Proposed | Accepted | Deprecated | Superseded]
**Date:** [YYYY-MM-DD]
**Deciders:** [List of decision makers]

## Context
[What is the issue that we're seeing that is motivating this decision?]

## Decision
[What is the change that we're proposing and/or doing?]

## Consequences
### Positive
- [Benefit 1]

### Negative
- [Drawback 1]

### Neutral
- [Note 1]

## Alternatives Considered
### Option A: [Name]
[Description]
- Pros: [...]
- Cons: [...]

### Option B: [Name]
[Description]
- Pros: [...]
- Cons: [...]

## Related
- ADR-XX: [Related decision]
- Feature XX: [Related feature]
`,

    'GUIDE_TEMPLATE.md': `# [Guide Title]

**Last Updated:** [YYYY-MM-DD]
**Author:** [Name]

## Overview
[What this guide covers]

## Prerequisites
- [Prerequisite 1]
- [Prerequisite 2]

## Steps

### 1. [First Step]
[Detailed instructions]

### 2. [Second Step]
[Detailed instructions]

## Troubleshooting
### Problem: [Common issue]
**Solution:** [How to fix it]

## Related
- [Link to related guide]
- [Link to related doc]
`,
  };

  for (const [filename, content] of Object.entries(templates)) {
    const filePath = join(projectPath, 'docs/knowledge/templates', filename);
    if (!existsSync(filePath)) {
      writeFileSync(filePath, content, 'utf-8');
    }
  }
}

function createRoadmapFile(projectPath: string, projectName: string): void {
  const today = new Date().toISOString().split('T')[0];
  const content = `# ${projectName} - Roadmap

**Last Updated:** ${today}
**Project Status:** 🟡 In Progress

---

## 📋 Quick Status

- **Features Complete:** 0/0
- **Active Bugs:** 0
- **Active Improvements:** 0
- **Inbox Items:** 0
- **Blockers:** None

---

## 💡 Inbox

Quick-captured ideas waiting to be converted to specs. Use \`spellbook spec idea-<id>\` to create detailed specification.

_No items in inbox._

---

## 📦 Feature Roadmap

| # | Feature | Status | Tasks | Doc |
|---|---------|--------|-------|-----|

### Status Legend

- ✅ Complete
- 🟡 In Progress
- 🟢 Spec Ready
- 📝 Spec Draft
- 🔴 Not Started

---

## 🔧 Active Improvements

Tech debt, refactors, and enhancements.

_No active improvements._

**Commands:**

- \`spellbook log improvement "description"\` - Log a new improvement
- \`/implement improvement-[number]\` - Implement a logged improvement

---

## 🐛 Active Bugs

_No active bugs._

**Commands:**

- \`spellbook log bug "description"\` - Log a new bug
- \`/implement bug-[number]\` - Implement a bug fix

---

## 🔧 Technical Decisions

### Stack

- **Frontend:** [Your framework]
- **Database:** [Your database]
- **Auth:** [Your auth provider]

### Key Architecture Decisions

| Decision | Status | Description |
|----------|--------|-------------|
| Example Decision | ✅ | Description of the decision |

---

## ⚠️ Open Issues & Decisions Needed

### Critical (Blocking Launch)

| Issue | Impact | Status |
|-------|--------|--------|

### High Priority

| Issue | Impact | Status |
|-------|--------|--------|

### Medium Priority

| Issue | Status |
|-------|--------|

---

## 📚 Resources

### Documentation

- [Feature Template](./templates/FEATURE_TEMPLATE.md)
- [Task Template](./templates/TASK_TEMPLATE.md)

### External Docs

- Add your external documentation links here

---

**END OF ROADMAP**

> **Note:** Auto-generated sections (Status, Inbox, Features, Improvements, Bugs) are updated by \`spellbook roadmap\`.
> Custom sections (Technical Decisions, Open Issues, Resources) are preserved during regeneration.
`;

  writeFileSync(join(projectPath, 'docs/knowledge/ROADMAP.md'), content, 'utf-8');
}

function createClaudeSkills(projectPath: string): void {
  const skillsDir = join(projectPath, '.claude/skills');
  if (!existsSync(skillsDir)) {
    mkdirSync(skillsDir, { recursive: true });
  }

  // Create thin log skill
  const logSkillDir = join(skillsDir, 'log');
  if (!existsSync(logSkillDir)) {
    mkdirSync(logSkillDir, { recursive: true });
  }

  writeFileSync(
    join(logSkillDir, 'skill.md'),
    `---
name: log
description: Log bugs, improvements, or features via Spellbook CLI
---

# Log Skill

Thin wrapper around \`spellbook log\` CLI command.

## When to Activate

- User wants to log, track, or document something
- User reports a bug, issue, or broken behavior
- User mentions tech debt, refactoring, or cleanup
- User has a feature idea to capture

## Workflow

1. **Detect type** from keywords:
   - Bug: "broken", "error", "not working", "crash", "bug"
   - Improvement: "refactor", "cleanup", "optimize", "tech debt"
   - Feature: "add", "new", "implement", "feature"

2. **Extract details**:
   - Title (required)
   - Priority (ask if unclear: high/medium/low)

3. **Execute spellbook CLI**:
   \`\`\`bash
   spellbook log bug "title" --priority high
   spellbook log improvement "title" --priority medium
   spellbook log feature "title"
   \`\`\`

4. **Report result** to user with file path and next steps.

## Options

- \`--bug\`: Explicit bug type
- \`--improvement\`: Explicit improvement type
- \`--feature\`: Explicit feature type (goes to inbox)
- \`--priority <level>\`: high, medium, or low
- \`--blocked-by <ref>\`: What blocks this (e.g., "bug-44")

## What This Skill Does NOT Do

- ❌ Does NOT implement any code changes
- ❌ Does NOT enter plan mode
- ❌ Does NOT create feature folders

**For feature planning:** Use \`/plan\`
**For implementation:** Use \`/implement\`
`,
    'utf-8'
  );

  // Create thin implement skill
  const implementSkillDir = join(skillsDir, 'implement');
  if (!existsSync(implementSkillDir)) {
    mkdirSync(implementSkillDir, { recursive: true });
  }

  writeFileSync(
    join(implementSkillDir, 'SKILL.md'),
    `---
name: implement
description: Implement a logged bug, improvement, or feature
---

# Implement Skill

Implements logged items using Spellbook for state management.

## Arguments

\`\`\`
/implement bug-44
/implement improvement-31
/implement feature-22
\`\`\`

## Workflow

### 1. Parse Reference
Extract type and number from the reference (e.g., "bug-44").

### 2. Read Logged Item
\`\`\`bash
# Find the doc file
spellbook status --json | jq '.bugs[] | select(.number == 44)'
\`\`\`

Read the corresponding markdown file from \`docs/bugs/active/\` or \`docs/improvements/active/\`.

### 3. Mark In Progress
\`\`\`bash
spellbook update bug-44 --status in_progress
\`\`\`

### 4. Enter Plan Mode
**REQUIRED**: Always enter plan mode before implementing.
- Explore codebase
- Design implementation approach
- Get user approval

### 5. Implement Changes
After plan approval, implement the fix/improvement/feature.

### 6. Quality Checks
Run typecheck and lint before completing.

### 7. Finalize
\`\`\`bash
spellbook finalize bug-44
\`\`\`
This updates the status. Run \`spellbook roadmap\` to regenerate ROADMAP.md.

### 8. Log Changelog Entry
\`\`\`bash
spellbook log-change bug-44 "Fixed the modal scroll issue"
\`\`\`

## Important Notes

- Always read the logged item first to understand context
- Plan mode is REQUIRED for all implementations
- Run quality checks before finalizing
- Update changelog for context handover
`,
    'utf-8'
  );
}

function scanSkills(projectPath: string, projectId: string): number {
  const skillsDir = join(projectPath, '.claude/skills');
  if (!existsSync(skillsDir)) return 0;

  const database = getDb();
  const entries = readdirSync(skillsDir, { withFileTypes: true });
  let count = 0;

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const skillFile = join(skillsDir, entry.name, 'skill.md');
      const skillFileAlt = join(skillsDir, entry.name, 'SKILL.md');

      if (existsSync(skillFile) || existsSync(skillFileAlt)) {
        const stmt = database.prepare(`
          INSERT OR REPLACE INTO skills (project_id, name, path)
          VALUES (?, ?, ?)
        `);
        stmt.run(projectId, entry.name, join('.claude/skills', entry.name));
        count++;
      }
    }
  }

  return count;
}
