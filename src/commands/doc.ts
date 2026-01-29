import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import Table from 'cli-table3';
import { writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import {
  createKnowledge,
  getKnowledgeByProject,
  logActivity,
} from '../db/index.js';
import { getCurrentProject, generateSlug } from '../utils/project.js';
import { error, formatDate, truncate } from '../utils/format.js';

export const docCommand = new Command('doc')
  .description('Create or list project documentation')
  .argument('[title]', 'Document title (creates new doc if provided)')
  .option('-t, --type <type>', 'Doc type: architecture, decision, guide, api, research, prd, cron, analytics, design', 'guide')
  .option('--tags <tags>', 'Comma-separated tags')
  .option('-l, --list', 'List all project docs')
  .option('--import <path>', 'Import an existing markdown file to knowledge base')
  .action(async (title: string | undefined, options) => {
    try {
      const context = getCurrentProject();
      if (!context) {
        error('Not in a Spellbook project. Run `spellbook init` first.');
        process.exit(1);
      }

      const { project } = context;

      // List mode
      if (options.list || !title) {
        const docs = getKnowledgeByProject(project.id, options.type !== 'guide' ? options.type : undefined);

        if (docs.length === 0) {
          console.log(chalk.gray('No documentation found.'));
          console.log('');
          console.log(
            chalk.gray('Create one with:'),
            chalk.white('spellbook doc "Title" --type guide')
          );
          return;
        }

        console.log(chalk.bold.white(`PROJECT DOCUMENTATION (${docs.length})`));
        console.log('');

        const table = new Table({
          head: [
            chalk.gray('Slug'),
            chalk.gray('Title'),
            chalk.gray('Type'),
            chalk.gray('Tags'),
          ],
          style: { head: [], border: [] },
        });

        for (const doc of docs) {
          table.push([
            doc.slug,
            truncate(doc.title, 35),
            doc.doc_type,
            doc.tags || '-',
          ]);
        }

        console.log(table.toString());
        return;
      }

      // Create mode
      const spinner = ora('Creating documentation...').start();

      const slug = generateSlug(title);
      const docType = options.type.toLowerCase();

      // Validate doc type
      const validTypes = ['architecture', 'decision', 'guide', 'api', 'research', 'prd', 'cron', 'analytics', 'design'];
      if (!validTypes.includes(docType)) {
        spinner.fail(`Invalid doc type: ${docType}`);
        error(`Valid types: ${validTypes.join(', ')}`);
        process.exit(1);
      }

      // Import mode - register existing file
      if (options.import) {
        const importPath = options.import;
        const absolutePath = importPath.startsWith('/') ? importPath : join(project.path, importPath);

        if (!existsSync(absolutePath)) {
          spinner.fail(`File not found: ${importPath}`);
          process.exit(1);
        }

        // Use the import path as doc_path
        const relPath = absolutePath.replace(project.path + '/', '');

        createKnowledge({
          project_id: project.id,
          slug,
          title,
          doc_type: docType,
          doc_path: relPath,
          tags: options.tags,
        });

        logActivity({
          project_id: project.id,
          item_type: 'doc',
          item_ref: `doc-${slug}`,
          action: 'imported',
          message: `Imported ${title} from ${relPath}`,
          author: 'Spellbook',
        });

        spinner.succeed(`Documentation imported.`);
        console.log('');
        console.log(chalk.cyan('Title:'), chalk.white(title));
        console.log(chalk.cyan('Type:'), chalk.yellow(docType));
        console.log(chalk.cyan('File:'), chalk.gray(relPath));
        if (options.tags) {
          console.log(chalk.cyan('Tags:'), chalk.gray(options.tags));
        }
        return;
      }

      // Determine path - use PROJECT docs folder (git-tracked, shared with team)
      const docDir = join(project.path, 'docs', 'knowledge', docType);
      const docPath = join(docDir, `${slug}.md`);
      const relDocPath = `docs/knowledge/${docType}/${slug}.md`;

      // Ensure directory exists
      if (!existsSync(docDir)) {
        mkdirSync(docDir, { recursive: true });
      }

      // Check if already exists
      if (existsSync(docPath)) {
        spinner.fail(`Document already exists: ${relDocPath}`);
        process.exit(1);
      }

      // Create document
      const content = generateDocMarkdown(title, docType, options.tags);
      writeFileSync(docPath, content, 'utf-8');

      // Add to database
      createKnowledge({
        project_id: project.id,
        slug,
        title,
        doc_type: docType,
        doc_path: relDocPath,
        tags: options.tags,
      });

      // Log activity
      logActivity({
        project_id: project.id,
        item_type: 'doc',
        item_ref: `doc-${slug}`,
        action: 'created',
        message: title,
        author: 'Spellbook',
      });

      spinner.succeed(`Documentation created.`);
      console.log('');
      console.log(chalk.cyan('Title:'), chalk.white(title));
      console.log(chalk.cyan('Type:'), chalk.yellow(docType));
      console.log(chalk.cyan('File:'), chalk.gray(relDocPath));
      if (options.tags) {
        console.log(chalk.cyan('Tags:'), chalk.gray(options.tags));
      }
    } catch (err) {
      error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

function generateDocMarkdown(title: string, docType: string, _tags?: string): string {
  const date = formatDate(new Date());

  const templates: Record<string, string> = {
    architecture: `# ${title}

**Last Updated:** ${date}
**Type:** Architecture

## Overview
[High-level description of this architectural component]

## Context
[Why does this architecture exist? What problem does it solve?]

## Components
[List and describe the main components]

## Data Flow
[Describe how data flows through the system]

## Diagrams
[Add diagrams if helpful]

## Trade-offs
[What trade-offs were made?]

## Related
- [Link to related docs]
`,

    decision: `# ADR: ${title}

**Status:** Proposed
**Date:** ${date}
**Deciders:** [List decision makers]

## Context
[What is the issue that we're seeing that motivates this decision?]

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

## Related
- [Link to related decisions]
`,

    guide: `# ${title}

**Last Updated:** ${date}
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
`,

    api: `# ${title}

**Last Updated:** ${date}
**Base URL:** [API base URL]

## Authentication
[How to authenticate]

## Endpoints

### GET /endpoint
[Description]

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| param | string | Yes | Description |

**Response:**
\`\`\`json
{
  "data": {}
}
\`\`\`

## Error Codes
| Code | Description |
|------|-------------|
| 400 | Bad Request |
| 401 | Unauthorized |

## Examples
[Code examples]
`,

    research: `# ${title}

**Date:** ${date}
**Status:** In Progress

## Objective
[What are we trying to learn?]

## Background
[Context and motivation]

## Findings

### Finding 1
[Description]

### Finding 2
[Description]

## Conclusions
[Summary of conclusions]

## Next Steps
- [ ] Action item 1
- [ ] Action item 2

## References
- [Link 1]
- [Link 2]
`,
  };

  return templates[docType] || templates.guide;
}
