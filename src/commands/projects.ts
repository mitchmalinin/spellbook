import { Command } from 'commander';
import chalk from 'chalk';
import Table from 'cli-table3';
import { getAllProjects } from '../db/index.js';
import { truncate } from '../utils/format.js';

export const projectsCommand = new Command('projects')
  .description('List all registered Spellbook projects')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    const projects = getAllProjects();

    if (options.json) {
      console.log(JSON.stringify(projects, null, 2));
      return;
    }

    if (projects.length === 0) {
      console.log(chalk.gray('No projects registered.'));
      console.log('');
      console.log(
        chalk.gray('Run'),
        chalk.white('spellbook init'),
        chalk.gray('in a project directory to register it.')
      );
      return;
    }

    console.log(chalk.bold.white(`REGISTERED PROJECTS (${projects.length})`));
    console.log('');

    const table = new Table({
      head: [chalk.gray('ID'), chalk.gray('Name'), chalk.gray('Path')],
      style: { head: [], border: [] },
      colWidths: [20, 25, 50],
    });

    for (const project of projects) {
      table.push([project.id, project.name, truncate(project.path, 48)]);
    }

    console.log(table.toString());
  });
