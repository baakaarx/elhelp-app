import type { Store } from '../db.js';
import type { AgentRunInput, AgentResult, AgentStatus, Skill } from './types.js';
import { loadSkills } from './skills.js';
import { localDate } from '../geo.js';
import { reviewDailyReports } from './tasks/reviewDailyReports.js';
import { summarizeDay } from './tasks/summarizeDay.js';
import { analyzeRoute } from './tasks/analyzeRoute.js';
import { fieldAlerts } from './tasks/fieldAlerts.js';

export class ElHelpAgent {
  skills: Skill[] = [];
  lastRun: AgentResult | null = null;
  startedAt = Date.now();
  version = '1.0.0-local';

  constructor(private store: Store, private timezone: string, private config: { retentionDays: number }) {
    this.refreshSkills();
  }

  refreshSkills() {
    this.skills = loadSkills();
  }

  getStatus(): AgentStatus {
    return {
      ready: this.skills.length > 0,
      skills: this.skills,
      lastRun: this.lastRun,
      uptime: Date.now() - this.startedAt,
      version: this.version,
    };
  }

  async run(input: AgentRunInput): Promise<AgentResult> {
    const start = Date.now();
    let result: Omit<AgentResult, 'durationMs' | 'generatedAt' | 'task'>;

    switch (input.task) {
      case 'review-daily-reports': {
        const r = reviewDailyReports(this.store, { limit: input.limit });
        result = { summary: r.summary, details: r.details, suggestions: r.suggestions, skill: 'elhelp-daily-report' };
        break;
      }
      case 'summarize-day': {
        if (!input.date) input.date = localDate(this.timezone);
        // validate date via dayBounds indirectly
        const r = summarizeDay(this.store, { repId: input.repId, date: input.date, timezone: this.timezone });
        result = { summary: r.summary, details: r.details, suggestions: r.suggestions, skill: 'elhelp-tracking' };
        break;
      }
      case 'analyze-route': {
        if (!input.repId) throw new Error('repId مطلوب لتحليل المسار');
        const r = analyzeRoute(this.store, { repId: input.repId, date: input.date, timezone: this.timezone });
        result = { summary: r.summary, details: r.details, suggestions: r.suggestions, skill: 'elhelp-tracking' };
        break;
      }
      case 'field-alerts': {
        const r = fieldAlerts(this.store, { timezone: this.timezone });
        result = { summary: r.summary, details: r.details, suggestions: r.suggestions, skill: 'elhelp-agent-core' };
        break;
      }
      default:
        throw new Error(`مهمة غير معروفة: ${input.task}`);
    }

    const agentResult: AgentResult = {
      task: input.task,
      skill: result.skill,
      summary: result.summary,
      details: result.details,
      suggestions: result.suggestions,
      generatedAt: Date.now(),
      durationMs: Date.now() - start,
    };
    this.lastRun = agentResult;
    return agentResult;
  }
}
