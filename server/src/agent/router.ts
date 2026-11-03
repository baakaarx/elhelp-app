import { Router } from 'express';
import { z } from 'zod';
import type { Store } from '../db.js';
import type { Config } from '../config.js';
import { ElHelpAgent } from './index.js';

export function createAgentRouter(store: Store, config: Config) {
  const agent = new ElHelpAgent(store, config.timezone, { retentionDays: config.retentionDays });
  const router = Router();

  // Public status (needs auth elsewhere)
  router.get('/status', (_req, res) => {
    res.json(agent.getStatus());
  });

  router.get('/skills', (_req, res) => {
    res.json({ skills: agent.skills, count: agent.skills.length });
  });

  router.post('/refresh', (_req, res) => {
    agent.refreshSkills();
    res.json({ ok: true, skills: agent.skills });
  });

  const runSchema = z.object({
    task: z.enum(['review-daily-reports', 'summarize-day', 'analyze-route', 'kpi-insights', 'field-alerts']),
    repId: z.string().uuid().optional(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  });

  router.post('/run', async (req, res) => {
    const parsed = runSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'بيانات المهمة غير صحيحة', issues: parsed.error.issues });
      return;
    }
    try {
      const result = await agent.run(parsed.data as any);
      // audit
      const userId = (res.locals as any)?.user?.id || 'anonymous';
      try { store.audit(userId, `agent.run:${result.task}`, { task: result.task, skill: result.skill }); } catch {}
      res.json({ result });
    } catch (e: any) {
      res.status(400).json({ error: e.message || 'فشل تنفيذ المهمة' });
    }
  });

  // Convenience: GET shortcuts for dashboard
  router.get('/run/review', async (_req, res) => {
    const result = await agent.run({ task: 'review-daily-reports' });
    res.json({ result });
  });

  return { router, agent };
}
