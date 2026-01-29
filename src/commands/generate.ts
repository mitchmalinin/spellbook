import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import {
  getBugsByProject,
  getImprovementsByProject,
  getFeaturesByProject,
  getInbox,
} from '../db/index.js';
import { getCurrentProject } from '../utils/project.js';
import { error, formatDate } from '../utils/format.js';

export const generateCommand = new Command('generate')
  .description('Regenerate ROADMAP.md from database (preserves custom sections)')
  .option('--force', 'Overwrite without preserving custom sections')
  .action(async (options) => {
    const spinner = ora('Generating ROADMAP.md...').start();

    try {
      const context = getCurrentProject();
      if (!context) {
        spinner.fail('Not in a Spellbook project.');
        error('Run `spellbook init` first.');
        process.exit(1);
      }

      const { project } = context;
      const planningPath = join(project.path, 'docs/knowledge/ROADMAP.md');

      // Read existing ROADMAP.md to preserve custom sections
      let customSections: CustomSections = {
        technicalDecisions: '',
        openIssues: '',
        resources: '',
      };

      if (!options.force && existsSync(planningPath)) {
        const existingContent = readFileSync(planningPath, 'utf-8');
        customSections = extractCustomSections(existingContent);
        spinner.text = 'Preserving custom sections...';
      }

      // Fetch all data from database
      const bugs = getBugsByProject(project.id);
      const improvements = getImprovementsByProject(project.id);
      const features = getFeaturesByProject(project.id);
      const inbox = getInbox(project.id);

      // Generate ROADMAP.md with preserved custom sections
      const planningContent = generatePlanningMd(
        project.name,
        features,
        bugs,
        improvements,
        inbox,
        customSections
      );
      writeFileSync(planningPath, planningContent, 'utf-8');

      spinner.succeed('Generated ROADMAP.md');

      console.log('');
      console.log(chalk.cyan('Managed sections regenerated:'));
      console.log(chalk.gray('  • Quick Status'));
      console.log(chalk.gray('  • Feature Inbox'));
      console.log(chalk.gray('  • Feature Roadmap'));
      console.log(chalk.gray('  • Active Improvements'));
      console.log(chalk.gray('  • Active Bugs'));
      console.log('');
      if (customSections.technicalDecisions || customSections.openIssues || customSections.resources) {
        console.log(chalk.cyan('Custom sections preserved:'));
        if (customSections.technicalDecisions) console.log(chalk.gray('  • Technical Decisions'));
        if (customSections.openIssues) console.log(chalk.gray('  • Open Issues & Decisions Needed'));
        if (customSections.resources) console.log(chalk.gray('  • Resources'));
      }
    } catch (err) {
      spinner.fail('Generation failed.');
      error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

interface CustomSections {
  technicalDecisions: string;
  openIssues: string;
  resources: string;
}

interface Feature {
  number: number;
  name: string;
  status: string;
  doc_path?: string;
  tasks: number;
}

interface Bug {
  number: number;
  slug: string;
  title: string;
  priority: string;
  status: string;
  doc_path?: string;
}

interface Improvement {
  number: number;
  slug: string;
  title: string;
  priority: string;
  linked_feature?: number;
  status: string;
  doc_path?: string;
}

interface InboxItem {
  id?: number;
  description: string;
  type: string;
  priority: string;
}

function extractCustomSections(content: string): CustomSections {
  const sections: CustomSections = {
    technicalDecisions: '',
    openIssues: '',
    resources: '',
  };

  // Extract Technical Decisions section
  const techMatch = content.match(/## 🔧 Technical Decisions\n([\s\S]*?)(?=\n## ⚠️|\n## 📚|\n---\n\n\*\*END|\n\*\*END|$)/);
  if (techMatch) {
    sections.technicalDecisions = techMatch[1].trim();
  }

  // Extract Open Issues section
  const issuesMatch = content.match(/## ⚠️ Open Issues & Decisions Needed\n([\s\S]*?)(?=\n## 📚|\n---\n\n\*\*END|\n\*\*END|$)/);
  if (issuesMatch) {
    sections.openIssues = issuesMatch[1].trim();
  }

  // Extract Resources section
  const resourcesMatch = content.match(/## 📚 Resources\n([\s\S]*?)(?=\n---\n\n\*\*END|\n\*\*END|$)/);
  if (resourcesMatch) {
    sections.resources = resourcesMatch[1].trim();
  }

  return sections;
}

function generatePlanningMd(
  projectName: string,
  features: Feature[],
  bugs: Bug[],
  improvements: Improvement[],
  inbox: InboxItem[],
  customSections: CustomSections
): string {
  const today = formatDate(new Date());
  const completeFeatures = features.filter((f) => f.status === 'complete' || f.status === 'completed').length;
  const activeBugs = bugs.filter((b) => b.status !== 'resolved');
  const activeImprovements = improvements.filter((i) => i.status !== 'completed');

  // Categorize inbox by type
  const featureInbox = inbox.filter((i) => i.type === 'feature');
  const improvementInbox = inbox.filter((i) => i.type === 'improvement');
  const bugInbox = inbox.filter((i) => i.type === 'bug');

  // Status icon helper
  const statusIcon = (status: string): string => {
    if (status === 'complete' || status === 'completed' || status === 'resolved') return '✅';
    if (status === 'in_progress' || status === 'active') return '🟡';
    if (status === 'spec_ready') return '🟢';
    if (status === 'spec_draft') return '📝';
    return '🔴';
  };

  // Priority emoji
  const priorityEmoji = (priority: string): string => {
    if (priority === 'high' || priority === 'critical') return '🔴';
    if (priority === 'medium') return '🟡';
    return '🟢';
  };

  // Feature rows - sorted by number
  const sortedFeatures = [...features].sort((a, b) => a.number - b.number);
  const featureRows = sortedFeatures
    .map((f) => {
      const num = f.number.toString().padStart(2, '0');
      const docLink = f.doc_path ? `[→](${f.doc_path.replace('docs/', './')})` : '-';
      return `| ${num}  | ${f.name.padEnd(30)} | ${statusIcon(f.status)}     | ${f.tasks}     | ${docLink} |`;
    })
    .join('\n');

  // Bug rows - active only, sorted by number
  const sortedBugs = [...activeBugs].sort((a, b) => a.number - b.number);
  const bugRows = sortedBugs
    .map((b) => {
      const link = b.doc_path
        ? `[${b.title}](${b.doc_path.replace('docs/', './')})`
        : b.title;
      const priority = b.priority.charAt(0).toUpperCase() + b.priority.slice(1);
      return `| ${b.number}  | ${link.padEnd(70)} | ${priority.padEnd(8)} | ${statusIcon(b.status)}     |`;
    })
    .join('\n');

  // Improvement rows - active only, sorted by number
  const sortedImprovements = [...activeImprovements].sort((a, b) => a.number - b.number);
  const improvementRows = sortedImprovements
    .map((i) => {
      const link = i.doc_path
        ? `[${i.slug}](${i.doc_path.replace('docs/', './')})`
        : i.slug;
      const linkedFeature = i.linked_feature ? `Feature ${i.linked_feature}` : 'None';
      const priority = i.priority.charAt(0).toUpperCase() + i.priority.slice(1);
      return `| ${i.number.toString().padStart(2, '0')}  | ${link.padEnd(90)} | ${priority.padEnd(8)} | ${linkedFeature.padEnd(14)} | ${statusIcon(i.status)}     |`;
    })
    .join('\n');

  // Inbox items - grouped and formatted
  const formatInboxItems = (items: InboxItem[]): string => {
    if (items.length === 0) return '';
    return items
      .map((i) => {
        const emoji = priorityEmoji(i.priority);
        return `- ${emoji} \`idea-${i.id}\` ${i.description}`;
      })
      .join('\n');
  };

  const featureInboxStr = featureInbox.length > 0
    ? `### Feature Ideas (${featureInbox.length})\n\n${formatInboxItems(featureInbox)}`
    : '';

  const improvementInboxStr = improvementInbox.length > 0
    ? `### Improvement Ideas (${improvementInbox.length})\n\n${formatInboxItems(improvementInbox)}`
    : '';

  const bugInboxStr = bugInbox.length > 0
    ? `### Bug Reports (${bugInbox.length})\n\n${formatInboxItems(bugInbox)}`
    : '';

  const inboxContent = [featureInboxStr, improvementInboxStr, bugInboxStr]
    .filter(Boolean)
    .join('\n\n') || '_No items in inbox. Use `spellbook idea "description"` to capture ideas._';

  // Build the document
  let content = `# ${projectName} - Project Roadmap

**Last Updated:** ${today}
**Project Status:** 🟡 In Progress

---

## 📋 Quick Status

- **Features Complete:** ${completeFeatures}/${features.length}
- **Active Bugs:** ${activeBugs.length}
- **Active Improvements:** ${activeImprovements.length}
- **Inbox Items:** ${inbox.length}
- **Blockers:** None

**Creating New Features:** Follow the structure defined in [FEATURE_TEMPLATE.md](./templates/FEATURE_TEMPLATE.md)

---

## 💡 Inbox

Quick-captured ideas waiting to be converted to specs. Use \`spellbook spec idea-<id>\` to create detailed specification.

${inboxContent}

---

## 📦 Feature Roadmap

Detailed specifications for each feature are in the [features/](./features/) folder.

| #   | Feature                        | Status | Tasks | Doc                                             |
| --- | ------------------------------ | ------ | ----- | ----------------------------------------------- |
${featureRows || '_No features defined._'}

### Status Legend

- ✅ Complete
- 🟡 In Progress
- 🟢 Spec Ready
- 📝 Spec Draft
- 🔴 Not Started

---

## 🔧 Active Improvements

Tech debt, refactors, and enhancements. Individual files in \`improvements/active/\`.

| #   | Improvement                                                                                                   | Priority | Linked Feature | Status |
| --- | ------------------------------------------------------------------------------------------------------------- | -------- | -------------- | ------ |
${improvementRows || '_No active improvements._'}

**Commands:**

- \`spellbook idea --improvement "description"\` - Capture improvement idea
- \`spellbook spec idea-<id>\` - Create detailed spec from idea
- \`/implement improvement-[number]\` - Implement a logged improvement

---

## 🐛 Active Bugs

Individual bug files in \`bugs/active/\`.

| #   | Bug                                                                                | Priority | Status |
| --- | ---------------------------------------------------------------------------------- | -------- | ------ |
${bugRows || '_No active bugs._'}

**Commands:**

- \`spellbook idea --bug "description"\` - Capture bug report
- \`spellbook spec idea-<id>\` - Create detailed spec from idea
- \`/implement bug-[number]\` - Implement a bug fix

---

`;

  // Add custom sections if they exist
  if (customSections.technicalDecisions) {
    content += `## 🔧 Technical Decisions

${customSections.technicalDecisions}

---

`;
  }

  if (customSections.openIssues) {
    content += `## ⚠️ Open Issues & Decisions Needed

${customSections.openIssues}

---

`;
  }

  if (customSections.resources) {
    content += `## 📚 Resources

${customSections.resources}

---

`;
  }

  content += `**END OF ROADMAP**

> **Note:** This roadmap is auto-generated by Spellbook from data in \`~/.spellbook/projects/\`.
> Managed sections (Status, Inbox, Roadmap, Improvements, Bugs) are regenerated on each run.
> Custom sections (Technical Decisions, Open Issues, Resources) are preserved.
`;

  return content;
}
