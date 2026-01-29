import { Command } from 'commander';
import ora from 'ora';
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import {
  getBugsByProject,
  getImprovementsByProject,
  getFeaturesByProject,
  getInbox,
  getKnowledgeByProject,
} from '../db/index.js';
import { getCurrentProject } from '../utils/project.js';
import { error, info } from '../utils/format.js';

function getToday(): string {
  return new Date().toISOString().split('T')[0];
}

function getStatusEmoji(status: string): string {
  switch (status) {
    case 'resolved':
    case 'completed':
    case 'complete':
      return '✅';
    case 'in_progress':
    case 'active':
      return '🟡';
    case 'spec_ready':
      return '🟢';
    case 'spec_draft':
      return '📝';
    default:
      return '🔴';
  }
}


function capitalizeFirst(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

interface CustomSections {
  technicalDecisions: string;
  openIssues: string;
  resources: string;
}

function extractCustomSections(content: string): CustomSections {
  const sections: CustomSections = {
    technicalDecisions: '',
    openIssues: '',
    resources: '',
  };

  // Extract Technical Decisions section
  const techMatch = content.match(/## 🔧 Technical Decisions\n([\s\S]*?)(?=\n---\n\n## ⚠️ Open Issues|$)/);
  if (techMatch) {
    sections.technicalDecisions = techMatch[1].trim().replace(/\n---\s*$/, '');
  }

  // Extract Open Issues section
  const issuesMatch = content.match(/## ⚠️ Open Issues & Decisions Needed\n([\s\S]*?)(?=\n---\n\n## 📚 Resources|$)/);
  if (issuesMatch) {
    sections.openIssues = issuesMatch[1].trim().replace(/\n---\s*$/, '');
  }

  // Extract Resources section (everything after ## 📚 Resources until END OF ROADMAP)
  const resourcesMatch = content.match(/## 📚 Resources\n([\s\S]*?)(?=\n---\n\n\*\*END OF ROADMAP|$)/);
  if (resourcesMatch) {
    sections.resources = resourcesMatch[1].trim().replace(/\n---\s*$/, '');
  }

  return sections;
}

function getDefaultCustomSections(): CustomSections {
  return {
    technicalDecisions: `### Stack

- **Frontend:** [Your framework]
- **Database:** [Your database]
- **Auth:** [Your auth provider]

### Key Architecture Decisions

| Decision | Status | Description |
|----------|--------|-------------|
| Example Decision | ✅ | Description of the decision |`,

    openIssues: `### Critical (Blocking Launch)

| Issue | Impact | Status |
|-------|--------|--------|

### High Priority

| Issue | Impact | Status |
|-------|--------|--------|

### Medium Priority

| Issue | Status |
|-------|--------|`,

    resources: `### Documentation

- [Feature Template](./templates/FEATURE_TEMPLATE.md)
- [Task Template](./templates/TASK_TEMPLATE.md)

### External Docs

- Add your external documentation links here`,
  };
}

export const roadmapCommand = new Command('roadmap')
  .description('Generate ROADMAP.md - the single source of truth for project status')
  .option('--stdout', 'Output to stdout instead of file')
  .option('--reset-custom', 'Reset custom sections to defaults')
  .action(async (options) => {
    const spinner = ora('Generating roadmap...').start();

    try {
      const context = getCurrentProject();
      if (!context) {
        spinner.fail('Not in a Spellbook project.');
        error('Run `spellbook init` first.');
        process.exit(1);
      }

      const { project } = context;
      const projectPath = project.path;
      const roadmapPath = join(projectPath, 'docs', 'knowledge', 'ROADMAP.md');

      // Read existing custom sections (preserve user content)
      let customSections: CustomSections;
      if (!options.resetCustom && existsSync(roadmapPath)) {
        const existingContent = readFileSync(roadmapPath, 'utf-8');
        customSections = extractCustomSections(existingContent);
        // Use defaults if sections are empty
        const defaults = getDefaultCustomSections();
        if (!customSections.technicalDecisions) customSections.technicalDecisions = defaults.technicalDecisions;
        if (!customSections.openIssues) customSections.openIssues = defaults.openIssues;
        if (!customSections.resources) customSections.resources = defaults.resources;
      } else {
        customSections = getDefaultCustomSections();
      }

      // Gather data from database
      const bugs = getBugsByProject(project.id);
      const improvements = getImprovementsByProject(project.id);
      const features = getFeaturesByProject(project.id);
      const inbox = getInbox(project.id);
      const knowledge = getKnowledgeByProject(project.id);

      // Categorize by status
      const activeBugs = bugs.filter(b => b.status === 'active' || b.status === 'in_progress');
      const bugInbox = inbox.filter(i => i.type === 'bug');

      const activeImps = improvements.filter(i => i.status === 'active' || i.status === 'in_progress');
      const impInbox = inbox.filter(i => i.type === 'improvement');

      const completeFeats = features.filter(f => f.status === 'complete');
      const featInbox = inbox.filter(i => i.type === 'feature');

      // Generate markdown
      let content = `# ${project.name} - Roadmap

**Last Updated:** ${getToday()}
**Project Status:** 🟡 In Progress

---

## 📋 Quick Status

- **Features Complete:** ${completeFeats.length}/${features.length}
- **Active Bugs:** ${activeBugs.length}
- **Active Improvements:** ${activeImps.length}
- **Inbox Items:** ${inbox.length}
- **Blockers:** None

---

## 💡 Inbox

Quick-captured ideas waiting to be converted to specs. Use \`spellbook spec idea-<id>\` to create detailed specification.

`;

      // Feature Inbox
      if (featInbox.length > 0) {
        content += `### Feature Ideas (${featInbox.length})\n\n`;
        for (const item of featInbox) {
          content += `- 🟡 \`idea-${item.id}\` ${item.description}\n`;
        }
        content += `\n`;
      }

      // Improvement Inbox
      if (impInbox.length > 0) {
        content += `### Improvement Ideas (${impInbox.length})\n\n`;
        for (const item of impInbox) {
          content += `- 🟡 \`idea-${item.id}\` ${item.description}\n`;
        }
        content += `\n`;
      }

      // Bug Inbox
      if (bugInbox.length > 0) {
        content += `### Bug Reports (${bugInbox.length})\n\n`;
        for (const item of bugInbox) {
          content += `- 🔴 \`idea-${item.id}\` ${item.description}\n`;
        }
        content += `\n`;
      }

      if (inbox.length === 0) {
        content += `_No items in inbox._\n\n`;
      }

      // Feature Roadmap (full table like PLANNING.md had)
      content += `---

## 📦 Feature Roadmap

| # | Feature | Status | Tasks | Doc |
|---|---------|--------|-------|-----|
`;

      const sortedFeatures = [...features].sort((a, b) => a.number - b.number);
      for (const feat of sortedFeatures) {
        const status = getStatusEmoji(feat.status);
        const docLink = feat.doc_path ? `[→](${feat.doc_path})` : '-';
        content += `| ${String(feat.number).padStart(2, '0')} | ${feat.name} | ${status} | ${feat.tasks} | ${docLink} |\n`;
      }

      content += `
### Status Legend

- ✅ Complete
- 🟡 In Progress
- 🟢 Spec Ready
- 📝 Spec Draft
- 🔴 Not Started

`;

      // Active Improvements
      content += `---

## 🔧 Active Improvements

Tech debt, refactors, and enhancements.

`;

      if (activeImps.length > 0) {
        content += `| # | Improvement | Priority | Status |
|---|-------------|----------|--------|
`;
        for (const imp of activeImps) {
          const link = imp.doc_path ? `[${imp.slug}](${imp.doc_path})` : imp.slug;
          content += `| ${imp.number} | ${link} | ${capitalizeFirst(imp.priority)} | ${getStatusEmoji(imp.status)} |\n`;
        }
        content += `\n`;
      } else {
        content += `_No active improvements._\n\n`;
      }

      content += `**Commands:**

- \`spellbook log improvement "description"\` - Log a new improvement
- \`/implement improvement-[number]\` - Implement a logged improvement

`;

      // Active Bugs
      content += `---

## 🐛 Active Bugs

`;

      if (activeBugs.length > 0) {
        content += `| # | Bug | Priority | Status |
|---|-----|----------|--------|
`;
        for (const bug of activeBugs) {
          const link = bug.doc_path ? `[${bug.title}](${bug.doc_path})` : bug.title;
          content += `| ${bug.number} | ${link} | ${capitalizeFirst(bug.priority)} | ${getStatusEmoji(bug.status)} |\n`;
        }
        content += `\n`;
      } else {
        content += `_No active bugs._\n\n`;
      }

      content += `**Commands:**

- \`spellbook log bug "description"\` - Log a new bug
- \`/implement bug-[number]\` - Implement a bug fix

`;

      // Knowledge Base
      if (knowledge.length > 0) {
        content += `---

## 📖 Knowledge Base

`;
        const byType: Record<string, typeof knowledge> = {};
        for (const doc of knowledge) {
          if (!byType[doc.doc_type]) byType[doc.doc_type] = [];
          byType[doc.doc_type].push(doc);
        }

        for (const [type, docs] of Object.entries(byType)) {
          content += `### ${capitalizeFirst(type)} (${docs.length})\n\n`;
          for (const doc of docs) {
            content += `- [${doc.title}](${doc.doc_path})\n`;
          }
          content += `\n`;
        }
      }

      // Custom Sections (preserved from existing file)
      content += `---

## 🔧 Technical Decisions

${customSections.technicalDecisions}

---

## ⚠️ Open Issues & Decisions Needed

${customSections.openIssues}

---

## 📚 Resources

${customSections.resources}

---

**END OF ROADMAP**

> **Note:** Auto-generated sections (Status, Inbox, Features, Improvements, Bugs, Knowledge) are updated by \`spellbook roadmap\`.
> Custom sections (Technical Decisions, Open Issues, Resources) are preserved during regeneration.
`;

      if (options.stdout) {
        spinner.stop();
        console.log(content);
      } else {
        writeFileSync(roadmapPath, content, 'utf-8');
        spinner.succeed(`Generated ${roadmapPath}`);
        console.log('');
        info('Custom sections (Technical Decisions, Open Issues, Resources) were preserved.');
      }

    } catch (err) {
      spinner.fail('Failed to generate roadmap.');
      error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

// Export for use by other commands
export async function regenerateRoadmap(_projectId: string, projectPath: string): Promise<void> {
  const roadmapPath = join(projectPath, 'docs', 'knowledge', 'ROADMAP.md');

  // This is a simplified version - just mark that roadmap needs regeneration
  // The full regeneration happens via the command
  // For now, we'll just update the timestamp
  if (existsSync(roadmapPath)) {
    let content = readFileSync(roadmapPath, 'utf-8');
    content = content.replace(
      /\*\*Last Updated:\*\* .+/,
      `**Last Updated:** ${getToday()}`
    );
    writeFileSync(roadmapPath, content, 'utf-8');
  }
}
