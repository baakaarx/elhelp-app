export interface SkillFrontmatter {
  name: string;
  description: string;
}

export interface Skill {
  id: string; // folder name
  name: string;
  description: string;
  filePath: string;
  content: string; // markdown body after frontmatter
  loadedAt: number;
}

export type AgentTaskName =
  | 'review-daily-reports'
  | 'summarize-day'
  | 'analyze-route'
  | 'field-alerts';

export interface AgentRunInput {
  task: AgentTaskName;
  repId?: string;
  date?: string; // YYYY-MM-DD
  limit?: number;
}

export interface AgentResult {
  task: AgentTaskName;
  skill: string; // which skill was used
  summary: string; // عربي
  details: any;
  suggestions: string[];
  generatedAt: number;
  durationMs: number;
}

export interface AgentStatus {
  ready: boolean;
  skills: Skill[];
  lastRun: AgentResult | null;
  uptime: number;
  version: string;
}
