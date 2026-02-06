import { join } from 'path';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { PROJECTS_DIR } from '../../db/index.js';

export function resolvePath(docPath: string, projectId: string, projectPath: string): string {
  // If it starts with ~/.spellbook/, expand the path
  if (docPath.startsWith('~/.spellbook/')) {
    return docPath.replace('~', homedir());
  }

  // Remove 'docs/' prefix if present (legacy paths)
  let normalizedPath = docPath.replace(/^docs\//, '');

  // Try central storage first
  const centralPath = join(PROJECTS_DIR, projectId, normalizedPath);
  if (existsSync(centralPath)) {
    return centralPath;
  }

  // Try with zero-padded number (e.g., "bugs/1-foo.md" -> "bugs/01-foo.md")
  const paddedPath = normalizedPath.replace(
    /^(bugs|improvements)\/(\d+)-/,
    (_match, folder, num) => `${folder}/${num.padStart(2, '0')}-`
  );
  const paddedCentralPath = join(PROJECTS_DIR, projectId, paddedPath);
  if (existsSync(paddedCentralPath)) {
    return paddedCentralPath;
  }

  // Try project path (original behavior)
  const projectFilePath = join(projectPath, docPath);
  if (existsSync(projectFilePath)) {
    return projectFilePath;
  }

  // Return central path (even if it doesn't exist, for error reporting)
  return centralPath;
}
