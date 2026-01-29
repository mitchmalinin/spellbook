/**
 * Configuration loader for Spellbook
 *
 * SECURITY: This module handles sensitive data (.env, MCP configs)
 * These files must NEVER be committed to git.
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { config as dotenvConfig } from 'dotenv';

// ============================================================================
// SECURITY CONSTANTS - Files that should NEVER be committed
// ============================================================================

export const SENSITIVE_FILES = [
  '.env',
  '.env.local',
  '.env.development.local',
  '.env.production.local',
  '.env.*.local',
  'claude_desktop_config.json',
  'settings.json',
  'settings.local.json',
];

export const SENSITIVE_PATTERNS = [
  /\.env($|\.)/,
  /secrets?\./i,
  /credentials?\./i,
  /api[_-]?keys?\./i,
  /_TOKEN$/,
  /_SECRET$/,
  /_KEY$/,
];

// ============================================================================
// ENV FILE LOADING
// ============================================================================

export interface EnvConfig {
  /** Loaded environment variables */
  env: Record<string, string>;
  /** Source files that were loaded */
  sources: string[];
  /** Any errors during loading */
  errors: string[];
}

/**
 * Load environment variables from a project directory
 * Loads in order: .env -> .env.local -> .env.development.local
 * Later files override earlier ones
 */
export function loadProjectEnv(projectPath: string): EnvConfig {
  const result: EnvConfig = {
    env: {},
    sources: [],
    errors: [],
  };

  const envFiles = [
    '.env',
    '.env.local',
    '.env.development.local',
  ];

  for (const file of envFiles) {
    const filePath = join(projectPath, file);
    if (existsSync(filePath)) {
      try {
        const parsed = dotenvConfig({ path: filePath, override: true });
        if (parsed.parsed) {
          Object.assign(result.env, parsed.parsed);
          result.sources.push(filePath);
        }
      } catch (err) {
        result.errors.push(`Failed to load ${file}: ${err}`);
      }
    }
  }

  return result;
}

/**
 * Get a merged environment with project env vars
 * Combines process.env with project-specific vars
 */
export function getMergedEnv(projectPath: string): Record<string, string> {
  const projectEnv = loadProjectEnv(projectPath);
  return {
    ...process.env as Record<string, string>,
    ...projectEnv.env,
  };
}

// ============================================================================
// MCP CONFIGURATION
// ============================================================================

export interface MCPServer {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface MCPConfig {
  mcpServers?: Record<string, MCPServer>;
}

export interface LoadedMCPConfig {
  config: MCPConfig | null;
  source: string | null;
  error: string | null;
}

/**
 * Load MCP configuration from Claude settings
 * Checks multiple possible locations
 */
export function loadMCPConfig(): LoadedMCPConfig {
  const possiblePaths = [
    join(homedir(), '.claude', 'claude_desktop_config.json'),
    join(homedir(), '.claude', 'settings.json'),
    join(homedir(), '.config', 'claude', 'settings.json'),
  ];

  for (const configPath of possiblePaths) {
    if (existsSync(configPath)) {
      try {
        const content = readFileSync(configPath, 'utf-8');
        const config = JSON.parse(content) as MCPConfig;
        return {
          config,
          source: configPath,
          error: null,
        };
      } catch (err) {
        return {
          config: null,
          source: configPath,
          error: `Failed to parse ${configPath}: ${err}`,
        };
      }
    }
  }

  return {
    config: null,
    source: null,
    error: 'No MCP configuration file found',
  };
}

/**
 * Get list of configured MCP servers
 */
export function getMCPServers(): { name: string; command: string }[] {
  const loaded = loadMCPConfig();
  if (!loaded.config?.mcpServers) {
    return [];
  }

  return Object.entries(loaded.config.mcpServers).map(([name, server]) => ({
    name,
    command: server.command,
  }));
}

// ============================================================================
// SECURITY CHECKS
// ============================================================================

/**
 * Check if a file path appears to be sensitive
 */
export function isSensitiveFile(filePath: string): boolean {
  const fileName = filePath.split('/').pop() || '';

  // Check exact matches
  if (SENSITIVE_FILES.includes(fileName)) {
    return true;
  }

  // Check patterns
  for (const pattern of SENSITIVE_PATTERNS) {
    if (pattern.test(fileName)) {
      return true;
    }
  }

  return false;
}

/**
 * Check if content appears to contain secrets
 */
export function containsSecrets(content: string): boolean {
  const secretPatterns = [
    /api[_-]?key\s*[:=]\s*["']?[a-zA-Z0-9_-]{20,}/i,
    /secret\s*[:=]\s*["']?[a-zA-Z0-9_-]{20,}/i,
    /token\s*[:=]\s*["']?[a-zA-Z0-9_-]{20,}/i,
    /password\s*[:=]\s*["']?[^\s"']{8,}/i,
    /private[_-]?key/i,
    /-----BEGIN.*PRIVATE KEY-----/,
  ];

  for (const pattern of secretPatterns) {
    if (pattern.test(content)) {
      return true;
    }
  }

  return false;
}

/**
 * Get required .gitignore entries for security
 */
export function getSecurityGitignoreEntries(): string[] {
  return [
    '# Security - NEVER commit these',
    '.env',
    '.env.*',
    '.env.local',
    '.env.*.local',
    '*.pem',
    '*.key',
    'secrets/',
    'credentials/',
    '',
    '# Claude/MCP configs with potential secrets',
    'claude_desktop_config.json',
    'settings.local.json',
  ];
}

/**
 * Check if .gitignore properly excludes sensitive files
 */
export function checkGitignoreSecurity(projectPath: string): {
  isSecure: boolean;
  missingEntries: string[];
} {
  const gitignorePath = join(projectPath, '.gitignore');

  if (!existsSync(gitignorePath)) {
    return {
      isSecure: false,
      missingEntries: ['.env', '.env.*', '.env.local'],
    };
  }

  const content = readFileSync(gitignorePath, 'utf-8');
  const lines = content.split('\n').map(l => l.trim());

  const requiredEntries = ['.env', '.env.local'];
  const missing = requiredEntries.filter(entry =>
    !lines.some(line => line === entry || line.startsWith(entry))
  );

  return {
    isSecure: missing.length === 0,
    missingEntries: missing,
  };
}
