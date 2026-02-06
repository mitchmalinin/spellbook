import type { Express } from 'express';
import type { Bug, Improvement, Feature, InboxItem, Project } from '../db/index.js';

export interface RouteContext {
  app: Express;
  getCurrentProject: () => Project;
  setCurrentProject: (project: Project) => void;
  terminalAvailable: boolean;
}

export interface BoardConfig {
  port: number;
  project: Project;
}

export interface StatusResponse {
  bugs: Bug[];
  improvements: Improvement[];
  features: Feature[];
  inbox: InboxItem[];
  project: {
    id: string;
    name: string;
    path: string;
  };
}

export interface DashboardStats {
  bugs: { total: number; active: number; inProgress: number; resolved: number };
  improvements: { total: number; active: number; inProgress: number; completed: number };
  features: { total: number; complete: number; inProgress: number; notStarted: number };
  inbox: { total: number; bugs: number; improvements: number; features: number };
}
