import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const PROJECTS_DIR = join(homedir(), '.spellbook', 'projects');

// Status emoji mapping
const STATUS_EMOJI: Record<string, string> = {
  'active': '🔵 Active',
  'planning': '📋 Planning',
  'in_progress': '🟡 In Progress',
  'blocked': '🔴 Blocked',
  'resolved': '✅ Resolved',
  'completed': '✅ Completed',
};

export interface BugFileData {
  projectId: string;
  number: number;
  slug: string;
  title: string;
  priority: string;
  description?: string;
}

export interface ImprovementFileData {
  projectId: string;
  number: number;
  slug: string;
  title: string;
  priority: string;
  description?: string;
  linkedFeature?: number;
}

/**
 * Create a bug markdown file from template
 */
export function createBugFile(data: BugFileData): string {
  const { projectId, number, slug, title, priority, description } = data;

  const projectPath = join(PROJECTS_DIR, projectId);
  const bugsDir = join(projectPath, 'bugs');
  const filePath = join(bugsDir, `${number}-${slug}.md`);
  const docPath = `docs/bugs/${number}-${slug}.md`;

  // Ensure directory exists
  if (!existsSync(bugsDir)) {
    mkdirSync(bugsDir, { recursive: true });
  }

  const today = new Date().toISOString().split('T')[0];
  const priorityEmoji = priority === 'high' ? '🔴' : priority === 'medium' ? '🟡' : '🟢';
  
  const content = `# Bug ${number}: ${title}

**Status:** 🔵 Active
**Priority:** ${priorityEmoji} ${priority.charAt(0).toUpperCase() + priority.slice(1)}
**Created:** ${today}

---

## Issue

${description || 'Description pending...'}

## Steps to Reproduce

1. [Step 1]
2. [Step 2]
3. [Step 3]

## Expected vs Actual Behavior

- **Expected:** [What should happen]
- **Actual:** [What actually happens]

## Code Location

- [File path and line numbers where the issue occurs]

---

## Plan

_Added by Claude during /plan phase_

### Approach

[Implementation strategy will be added here]

### Files to Modify

- [Files will be listed here]

### Acceptance Criteria

- [ ] Bug is fixed
- [ ] No regression in related functionality
- [ ] Tests added/updated if applicable

---

## Changelog

_Updated during implementation for context handover._

| Date | Change | Author |
|------|--------|--------|
| ${today} | Bug logged | User |
`;

  writeFileSync(filePath, content, 'utf-8');
  console.log(`[FileCreator] Created bug file: ${filePath}`);
  
  return docPath;
}

/**
 * Create an improvement markdown file from template
 */
export function createImprovementFile(data: ImprovementFileData): string {
  const { projectId, number, slug, title, priority, description, linkedFeature } = data;

  const projectPath = join(PROJECTS_DIR, projectId);
  const improvementsDir = join(projectPath, 'improvements');
  const filePath = join(improvementsDir, `${number}-${slug}.md`);
  const docPath = `docs/improvements/${number}-${slug}.md`;

  // Ensure directory exists
  if (!existsSync(improvementsDir)) {
    mkdirSync(improvementsDir, { recursive: true });
  }

  const today = new Date().toISOString().split('T')[0];
  const priorityEmoji = priority === 'high' ? '🔴' : priority === 'medium' ? '🟡' : '🟢';
  
  const content = `# Improvement ${number}: ${title}

**Status:** 🔵 Active
**Priority:** ${priorityEmoji} ${priority.charAt(0).toUpperCase() + priority.slice(1)}
**Created:** ${today}
${linkedFeature ? `**Linked Feature:** Feature ${linkedFeature}\n` : ''}
---

## Overview

${description || 'Description pending...'}

## Current State

[Describe how things work currently]

## Proposed Changes

[Describe what will be improved]

---

## Plan

_Added by Claude during /plan phase_

### Approach

[Implementation strategy will be added here]

### Files to Modify

- [Files will be listed here]

### Acceptance Criteria

- [ ] Improvement implemented
- [ ] No regression in related functionality
- [ ] Code reviewed
- [ ] Tests added/updated if applicable

---

## Changelog

_Updated during implementation for context handover._

| Date | Change | Author |
|------|--------|--------|
| ${today} | Improvement logged | User |
`;

  writeFileSync(filePath, content, 'utf-8');
  console.log(`[FileCreator] Created improvement file: ${filePath}`);
  
  return docPath;
}

/**
 * Generate a URL-friendly slug from a title
 */
export function generateSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

/**
 * Update status in a markdown file (flat folder structure - no file moving)
 * Status is tracked in the file header, not by folder location
 */
export function updateFileStatus(
  projectId: string,
  docPath: string,
  newStatus: string,
  _itemType: 'bug' | 'improvement'
): string {
  if (!docPath) {
    console.error('[FileCreator] No doc_path provided');
    return docPath;
  }

  const projectPath = join(PROJECTS_DIR, projectId);
  // docPath is like "docs/bugs/74-slug.md"
  const relativePath = docPath.replace(/^docs\//, '');
  const fullPath = join(projectPath, relativePath);

  if (!existsSync(fullPath)) {
    console.error(`[FileCreator] File not found: ${fullPath}`);
    return docPath;
  }

  // Read file content
  let content = readFileSync(fullPath, 'utf-8');

  // Update status in the file
  const statusEmoji = STATUS_EMOJI[newStatus] || newStatus;

  // Match the status line - flexible pattern
  const statusPattern = /\*\*Status:\*\*[^\n]*/;

  if (statusPattern.test(content)) {
    content = content.replace(statusPattern, `**Status:** ${statusEmoji}`);
    console.log(`[FileCreator] Updated status to: ${statusEmoji}`);
  } else {
    console.warn('[FileCreator] Could not find status field to update');
  }

  // Add changelog entry
  const today = new Date().toISOString().split('T')[0];
  const changelogEntry = `| ${today} | Status changed to ${newStatus} | Kanban |`;

  // Find changelog table and add entry
  const changelogPattern = /(\| Date \| Change \| Author \|\n\|---+\|---+\|---+\|\n)/;
  if (changelogPattern.test(content)) {
    content = content.replace(changelogPattern, `$1${changelogEntry}\n`);
  }

  // Write updated content in place (no file moving in flat structure)
  writeFileSync(fullPath, content, 'utf-8');
  console.log(`[FileCreator] Updated status in: ${fullPath}`);

  return docPath;
}
