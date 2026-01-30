import Database from 'better-sqlite3';
import { homedir } from 'os';
import { join } from 'path';
import { mkdirSync, existsSync } from 'fs';
import { SCHEMA } from './schema.js';

export const SPELLBOOK_DIR = join(homedir(), '.spellbook');
export const PROJECTS_DIR = join(SPELLBOOK_DIR, 'projects');
const DB_PATH = join(SPELLBOOK_DIR, 'spellbook.db');

let db: Database.Database | null = null;

export function ensureSpellbookDir(): void {
  if (!existsSync(SPELLBOOK_DIR)) {
    mkdirSync(SPELLBOOK_DIR, { recursive: true });
  }
  const backupsDir = join(SPELLBOOK_DIR, 'backups');
  if (!existsSync(backupsDir)) {
    mkdirSync(backupsDir, { recursive: true });
  }
}

export function getDb(): Database.Database {
  if (db) return db;

  ensureSpellbookDir();

  db = new Database(DB_PATH);

  // Apply schema
  db.exec(SCHEMA);

  // Run migrations for new columns (safe to run multiple times)
  try {
    db.exec('ALTER TABLE bugs ADD COLUMN pr_number INTEGER');
  } catch { /* column already exists */ }
  try {
    db.exec('ALTER TABLE bugs ADD COLUMN pr_url TEXT');
  } catch { /* column already exists */ }
  try {
    db.exec('ALTER TABLE improvements ADD COLUMN pr_number INTEGER');
  } catch { /* column already exists */ }
  try {
    db.exec('ALTER TABLE improvements ADD COLUMN pr_url TEXT');
  } catch { /* column already exists */ }

  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

// Project operations
export interface Project {
  id: string;
  name: string;
  path: string;
  description?: string;
  created_at?: string;
}

export function createProject(project: Omit<Project, 'created_at'>): Project {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO projects (id, name, path, description)
    VALUES (@id, @name, @path, @description)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      path = excluded.path,
      description = excluded.description
  `);
  stmt.run(project);
  return getProject(project.id)!;
}

export function getProject(id: string): Project | undefined {
  const db = getDb();
  return db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Project | undefined;
}

export function getProjectByPath(path: string): Project | undefined {
  const db = getDb();
  return db.prepare('SELECT * FROM projects WHERE path = ?').get(path) as Project | undefined;
}

export function getAllProjects(): Project[] {
  const db = getDb();
  return db.prepare('SELECT * FROM projects ORDER BY name').all() as Project[];
}

// Bug operations
export interface Bug {
  id?: number;
  project_id: string;
  number: number;
  slug: string;
  title: string;
  priority: string;
  status: string;
  owner?: string;
  blocked_by?: string;
  source_inbox_id?: number;
  doc_path?: string;
  pr_number?: number;
  pr_url?: string;
  created_at?: string;
  updated_at?: string;
}

export function createBug(bug: Omit<Bug, 'id' | 'created_at' | 'updated_at'>): Bug {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO bugs (project_id, number, slug, title, priority, status, owner, blocked_by, source_inbox_id, doc_path)
    VALUES (@project_id, @number, @slug, @title, @priority, @status, @owner, @blocked_by, @source_inbox_id, @doc_path)
  `);
  // Convert undefined to null for SQLite
  const params = {
    ...bug,
    owner: bug.owner ?? null,
    blocked_by: bug.blocked_by ?? null,
    source_inbox_id: bug.source_inbox_id ?? null,
  };
  stmt.run(params);
  return getBug(bug.project_id, bug.number)!;
}

export function getBug(projectId: string, number: number): Bug | undefined {
  const db = getDb();
  return db.prepare('SELECT * FROM bugs WHERE project_id = ? AND number = ?').get(projectId, number) as Bug | undefined;
}

export function getBugsByProject(projectId: string, status?: string): Bug[] {
  const db = getDb();
  if (status) {
    return db.prepare('SELECT * FROM bugs WHERE project_id = ? AND status = ? ORDER BY number').all(projectId, status) as Bug[];
  }
  return db.prepare('SELECT * FROM bugs WHERE project_id = ? ORDER BY number').all(projectId) as Bug[];
}

export function updateBug(projectId: string, number: number, updates: Partial<Bug>): Bug | undefined {
  const db = getDb();
  const fields = Object.keys(updates).filter(k => k !== 'project_id' && k !== 'number');
  if (fields.length === 0) return getBug(projectId, number);

  const setClause = fields.map(f => `${f} = @${f}`).join(', ');
  const stmt = db.prepare(`
    UPDATE bugs SET ${setClause}, updated_at = CURRENT_TIMESTAMP
    WHERE project_id = @project_id AND number = @number
  `);
  stmt.run({ ...updates, project_id: projectId, number });
  return getBug(projectId, number);
}

export function getNextBugNumber(projectId: string): number {
  const db = getDb();
  const result = db.prepare('SELECT MAX(number) as max FROM bugs WHERE project_id = ?').get(projectId) as { max: number | null };
  return (result.max || 0) + 1;
}

// Improvement operations
export interface Improvement {
  id?: number;
  project_id: string;
  number: number;
  slug: string;
  title: string;
  priority: string;
  linked_feature?: number;
  status: string;
  owner?: string;
  blocked_by?: string;
  source_inbox_id?: number;
  doc_path?: string;
  pr_number?: number;
  pr_url?: string;
  created_at?: string;
  updated_at?: string;
}

export function createImprovement(improvement: Omit<Improvement, 'id' | 'created_at' | 'updated_at'>): Improvement {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO improvements (project_id, number, slug, title, priority, linked_feature, status, owner, blocked_by, source_inbox_id, doc_path)
    VALUES (@project_id, @number, @slug, @title, @priority, @linked_feature, @status, @owner, @blocked_by, @source_inbox_id, @doc_path)
  `);
  // Convert undefined to null for SQLite
  const params = {
    ...improvement,
    linked_feature: improvement.linked_feature ?? null,
    owner: improvement.owner ?? null,
    blocked_by: improvement.blocked_by ?? null,
    source_inbox_id: improvement.source_inbox_id ?? null,
  };
  stmt.run(params);
  return getImprovement(improvement.project_id, improvement.number)!;
}

export function getImprovement(projectId: string, number: number): Improvement | undefined {
  const db = getDb();
  return db.prepare('SELECT * FROM improvements WHERE project_id = ? AND number = ?').get(projectId, number) as Improvement | undefined;
}

export function getImprovementsByProject(projectId: string, status?: string): Improvement[] {
  const db = getDb();
  if (status) {
    return db.prepare('SELECT * FROM improvements WHERE project_id = ? AND status = ? ORDER BY number').all(projectId, status) as Improvement[];
  }
  return db.prepare('SELECT * FROM improvements WHERE project_id = ? ORDER BY number').all(projectId) as Improvement[];
}

export function updateImprovement(projectId: string, number: number, updates: Partial<Improvement>): Improvement | undefined {
  const db = getDb();
  const fields = Object.keys(updates).filter(k => k !== 'project_id' && k !== 'number');
  if (fields.length === 0) return getImprovement(projectId, number);

  const setClause = fields.map(f => `${f} = @${f}`).join(', ');
  const stmt = db.prepare(`
    UPDATE improvements SET ${setClause}, updated_at = CURRENT_TIMESTAMP
    WHERE project_id = @project_id AND number = @number
  `);
  stmt.run({ ...updates, project_id: projectId, number });
  return getImprovement(projectId, number);
}

export function getNextImprovementNumber(projectId: string): number {
  const db = getDb();
  const result = db.prepare('SELECT MAX(number) as max FROM improvements WHERE project_id = ?').get(projectId) as { max: number | null };
  return (result.max || 0) + 1;
}

// Feature operations
export interface Feature {
  id?: number;
  project_id: string;
  number: number;
  name: string;
  status: string;
  doc_path?: string;
  tasks: number;
  source_inbox_id?: number;
  created_at?: string;
  updated_at?: string;
}

export function createFeature(feature: Omit<Feature, 'id' | 'created_at' | 'updated_at'>): Feature {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO features (project_id, number, name, status, doc_path, tasks, source_inbox_id)
    VALUES (@project_id, @number, @name, @status, @doc_path, @tasks, @source_inbox_id)
    ON CONFLICT(project_id, number) DO UPDATE SET
      name = excluded.name,
      status = excluded.status,
      doc_path = excluded.doc_path,
      tasks = excluded.tasks,
      source_inbox_id = excluded.source_inbox_id,
      updated_at = CURRENT_TIMESTAMP
  `);
  stmt.run(feature);
  return getFeature(feature.project_id, feature.number)!;
}

export function getFeature(projectId: string, number: number): Feature | undefined {
  const db = getDb();
  return db.prepare('SELECT * FROM features WHERE project_id = ? AND number = ?').get(projectId, number) as Feature | undefined;
}

export function getFeaturesByProject(projectId: string): Feature[] {
  const db = getDb();
  return db.prepare('SELECT * FROM features WHERE project_id = ? ORDER BY number').all(projectId) as Feature[];
}

export function getNextFeatureNumber(projectId: string): number {
  const db = getDb();
  const result = db.prepare('SELECT MAX(number) as max FROM features WHERE project_id = ?').get(projectId) as { max: number | null };
  return (result.max || 0) + 1;
}

export function updateFeature(projectId: string, number: number, updates: Partial<Feature>): Feature | undefined {
  const db = getDb();
  const fields = Object.keys(updates).filter(k => k !== 'project_id' && k !== 'number');
  if (fields.length === 0) return getFeature(projectId, number);

  const setClause = fields.map(f => `${f} = @${f}`).join(', ');
  const stmt = db.prepare(`
    UPDATE features SET ${setClause}, updated_at = CURRENT_TIMESTAMP
    WHERE project_id = @project_id AND number = @number
  `);
  stmt.run({ ...updates, project_id: projectId, number });
  return getFeature(projectId, number);
}

// Activity operations
export interface Activity {
  id?: number;
  project_id: string;
  item_type: string;
  item_ref: string;
  action: string;
  message?: string;
  author: string;
  created_at?: string;
}

export function logActivity(activity: Omit<Activity, 'id' | 'created_at'>): Activity {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO activity (project_id, item_type, item_ref, action, message, author)
    VALUES (@project_id, @item_type, @item_ref, @action, @message, @author)
  `);
  stmt.run(activity);
  return activity as Activity;
}

export function getActivityByItem(projectId: string, itemRef: string): Activity[] {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM activity
    WHERE project_id = ? AND item_ref = ?
    ORDER BY created_at DESC
  `).all(projectId, itemRef) as Activity[];
}

export function getRecentActivity(projectId: string, limit: number = 20): Activity[] {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM activity
    WHERE project_id = ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(projectId, limit) as Activity[];
}

// Worktree operations
export interface Worktree {
  id?: number;
  project_id: string;
  path: string;
  branch?: string;
  working_on?: string;
  status: string;
  created_at?: string;
  updated_at?: string;
}

export function createWorktree(worktree: Omit<Worktree, 'id' | 'created_at' | 'updated_at'>): Worktree {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO worktrees (project_id, path, branch, working_on, status)
    VALUES (@project_id, @path, @branch, @working_on, @status)
  `);
  stmt.run(worktree);
  return getWorktreeByPath(worktree.path)!;
}

export function getWorktreeByPath(path: string): Worktree | undefined {
  const db = getDb();
  return db.prepare('SELECT * FROM worktrees WHERE path = ?').get(path) as Worktree | undefined;
}

export function getWorktreesByProject(projectId: string, status?: string): Worktree[] {
  const db = getDb();
  if (status) {
    return db.prepare('SELECT * FROM worktrees WHERE project_id = ? AND status = ? ORDER BY created_at DESC').all(projectId, status) as Worktree[];
  }
  return db.prepare('SELECT * FROM worktrees WHERE project_id = ? ORDER BY created_at DESC').all(projectId) as Worktree[];
}

export function updateWorktree(path: string, updates: Partial<Worktree>): Worktree | undefined {
  const db = getDb();
  const fields = Object.keys(updates).filter(k => k !== 'path');
  if (fields.length === 0) return getWorktreeByPath(path);

  const setClause = fields.map(f => `${f} = @${f}`).join(', ');
  const stmt = db.prepare(`
    UPDATE worktrees SET ${setClause}, updated_at = CURRENT_TIMESTAMP
    WHERE path = @path
  `);
  stmt.run({ ...updates, path });
  return getWorktreeByPath(path);
}

// Inbox operations
export interface InboxItem {
  id?: number;
  project_id: string;
  description: string;
  type: string;
  priority: string;
  created_at?: string;
}

export function addToInbox(item: Omit<InboxItem, 'id' | 'created_at'>): InboxItem {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO inbox (project_id, description, type, priority)
    VALUES (@project_id, @description, @type, @priority)
  `);
  const result = stmt.run(item);
  return { ...item, id: Number(result.lastInsertRowid) };
}

export function getInboxItem(id: number): InboxItem | undefined {
  const db = getDb();
  return db.prepare('SELECT * FROM inbox WHERE id = ?').get(id) as InboxItem | undefined;
}

export function getInbox(projectId: string, type?: string): InboxItem[] {
  const db = getDb();
  if (type) {
    return db.prepare('SELECT * FROM inbox WHERE project_id = ? AND type = ? ORDER BY created_at DESC').all(projectId, type) as InboxItem[];
  }
  return db.prepare('SELECT * FROM inbox WHERE project_id = ? ORDER BY created_at DESC').all(projectId) as InboxItem[];
}

export function removeFromInbox(id: number): void {
  const db = getDb();
  db.prepare('DELETE FROM inbox WHERE id = ?').run(id);
}

// Knowledge operations
export interface Knowledge {
  id?: number;
  project_id: string;
  slug: string;
  title: string;
  doc_type: string;
  doc_path?: string;
  tags?: string;
  created_at?: string;
  updated_at?: string;
}

export function createKnowledge(doc: Omit<Knowledge, 'id' | 'created_at' | 'updated_at'>): Knowledge {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO knowledge (project_id, slug, title, doc_type, doc_path, tags)
    VALUES (@project_id, @slug, @title, @doc_type, @doc_path, @tags)
  `);
  stmt.run(doc);
  return getKnowledge(doc.project_id, doc.slug)!;
}

export function getKnowledge(projectId: string, slug: string): Knowledge | undefined {
  const db = getDb();
  return db.prepare('SELECT * FROM knowledge WHERE project_id = ? AND slug = ?').get(projectId, slug) as Knowledge | undefined;
}

export function getKnowledgeByProject(projectId: string, docType?: string): Knowledge[] {
  const db = getDb();
  if (docType) {
    return db.prepare('SELECT * FROM knowledge WHERE project_id = ? AND doc_type = ? ORDER BY title').all(projectId, docType) as Knowledge[];
  }
  return db.prepare('SELECT * FROM knowledge WHERE project_id = ? ORDER BY doc_type, title').all(projectId) as Knowledge[];
}

// Export database path for external access
export function getDbPath(): string {
  return DB_PATH;
}

export function getSpellbookDir(): string {
  return SPELLBOOK_DIR;
}
