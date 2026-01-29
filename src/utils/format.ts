import chalk from 'chalk';
import dayjs from 'dayjs';

export function formatDate(date: string | Date): string {
  return dayjs(date).format('YYYY-MM-DD');
}

export function formatDateTime(date: string | Date): string {
  return dayjs(date).format('YYYY-MM-DD HH:mm');
}

export function formatRelativeTime(date: string | Date): string {
  const d = dayjs(date);
  const now = dayjs();
  const diffDays = now.diff(d, 'day');

  if (diffDays === 0) return 'today';
  if (diffDays === 1) return 'yesterday';
  if (diffDays < 7) return `${diffDays} days ago`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)} weeks ago`;
  return d.format('MMM D, YYYY');
}

export function formatStatus(status: string): string {
  const statusMap: Record<string, string> = {
    active: chalk.red('🔴'),
    in_progress: chalk.yellow('🟡'),
    resolved: chalk.green('✅'),
    completed: chalk.green('✅'),
    complete: chalk.green('✅'),
    not_started: chalk.red('🔴'),
  };
  return statusMap[status.toLowerCase()] || status;
}

export function formatPriority(priority: string): string {
  const priorityMap: Record<string, string> = {
    critical: chalk.red.bold('Critical'),
    high: chalk.red('High'),
    medium: chalk.yellow('Medium'),
    low: chalk.gray('Low'),
  };
  return priorityMap[priority.toLowerCase()] || priority;
}

export function formatRef(type: string, number: number): string {
  return `${type}-${number}`;
}

export function parseRef(ref: string): { type: string; number: number } | null {
  const match = ref.match(/^(bug|improvement|feature)-(\d+)$/i);
  if (!match) return null;
  return {
    type: match[1].toLowerCase(),
    number: parseInt(match[2], 10),
  };
}

export function truncate(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str;
  return str.substring(0, maxLength - 3) + '...';
}

export function padNumber(num: number, width: number = 2): string {
  return num.toString().padStart(width, '0');
}

export function success(message: string): void {
  console.log(chalk.green('✓'), message);
}

export function error(message: string): void {
  console.error(chalk.red('✗'), message);
}

export function warn(message: string): void {
  console.warn(chalk.yellow('⚠'), message);
}

export function info(message: string): void {
  console.log(chalk.blue('ℹ'), message);
}
