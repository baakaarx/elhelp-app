import { useEffect, useState } from 'react';
import { api, post } from './api';

type TaskName = 'review-daily-reports' | 'summarize-day' | 'analyze-route' | 'kpi-insights' | 'field-alerts';

interface AgentSkill { id: string; name: string; description: string; }
interface AgentResult {
  task: TaskName;
  skill: string;
  summary: string;
  details: any;
  suggestions: string[];
  generatedAt: number;
  durationMs: number;
}

export default function AgentPanel({ reps }: { reps: { id: string; name: string }[] }) {
  const [skills, setSkills] = useState<AgentSkill[]>([]);
  const [status, setStatus] = useState<any>(null);
  const [result, setResult] = useState<AgentResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // form fields — use Africa/Cairo for correct local date (not UTC)
  const cairoDate = (d = new Date()) => new Date(d).toLocaleDateString('en-CA', { timeZone: 'Africa/Cairo' });
  const [task, setTask] = useState<TaskName>('field-alerts');
  const [repId, setRepId] = useState('');
  const [date, setDate] = useState(cairoDate());
  const [from, setFrom] = useState(cairoDate(new Date(Date.now() - 7 * 86400000)));
  const [to, setTo] = useState(cairoDate());

  const load = async () => {
    try {
      const [s, st] = await Promise.all([
        api<{ skills: AgentSkill[]; count: number }>('/api/agent/skills'),
        api<any>('/api/agent/status'),
      ]);
      setSkills(s.skills);
      setStatus(st);
    } catch (e: any) { setError(e.message); }
  };

  useEffect(() => { load(); }, []);

  const run = async () => {
    setLoading(true); setError(''); setResult(null);
    const body: any = { task };
    if ((task === 'summarize-day' || task === 'analyze-route') && repId) body.repId = repId;
    if ((task === 'summarize-day' || task === 'analyze-route') && date) body.date = date;
    if (task === 'kpi-insights') { body.from = from; body.to = to; }
    try {
      const res = await post<{ result: AgentResult }>('/api/agent/run', body);
      setResult(res.result);
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  };

  return (
    <section className="panel agent-panel" dir="rtl">
      <div className="agent-head">
        <h3>المساعد الذكي المحلي 🤖 <span className="pill">بدون API</span></h3>
        <p className="muted small">يستخدم الـ Skills المحلية — لا يتصل بالإنترنت، لا يحتاج OpenAI/Anthropic</p>
      </div>

      {status && (
        <div className="stats" style={{ margin: '12px 0' }}>
          <div className="stat"><span>الحالة</span><strong>{status.ready ? 'جاهز ✓' : 'غير جاهز'}</strong></div>
          <div className="stat"><span>الـ Skills</span><strong>{skills.length}</strong></div>
          <div className="stat"><span>الإصدار</span><strong>{status.version}</strong></div>
        </div>
      )}

      <details className="agent-skills" open>
        <summary>الـ Skills المحملة ({skills.length})</summary>
        <ul className="muted small" style={{ marginTop: 8 }}>
          {skills.map(s => <li key={s.id}><strong>{s.name}</strong> — {s.description}</li>)}
        </ul>
      </details>

      <div className="agent-controls" style={{ marginTop: 16, display: 'grid', gap: 10 }}>
        <label className="field">
          <span>المهمة</span>
          <select value={task} onChange={e => setTask(e.target.value as TaskName)}>
            <option value="field-alerts">تنبيهات ميدانية ذكية</option>
            <option value="review-daily-reports">مراجعة التقارير اليومية</option>
            <option value="summarize-day">ملخص يوم مهندس/فريق</option>
            <option value="analyze-route">تحليل مسار GPS</option>
            <option value="kpi-insights">تحليل مؤشرات الأداء KPI</option>
          </select>
        </label>

        {(task === 'summarize-day' || task === 'analyze-route') && (
          <label className="field">
            <span>المهندس</span>
            <select value={repId} onChange={e => setRepId(e.target.value)}>
              <option value="">— كل الفريق —</option>
              {reps.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </label>
        )}

        {(task === 'summarize-day' || task === 'analyze-route') && (
          <label className="field">
            <span>التاريخ</span>
            <input type="date" value={date} onChange={e => setDate(e.target.value)} />
          </label>
        )}

        {task === 'kpi-insights' && (
          <div style={{ display: 'flex', gap: 8 }}>
            <label className="field" style={{ flex: 1 }}><span>من</span><input type="date" value={from} onChange={e => setFrom(e.target.value)} /></label>
            <label className="field" style={{ flex: 1 }}><span>إلى</span><input type="date" value={to} onChange={e => setTo(e.target.value)} /></label>
          </div>
        )}

        <button className="btn" onClick={run} disabled={loading}>
          {loading ? 'جاري التشغيل…' : 'شغّل الـ Agent ▶'}
        </button>
        {error && <p className="error" role="alert">{error}</p>}
      </div>

      {result && (
        <div className="agent-result" style={{ marginTop: 16, border: '1px solid #e2e8e1', borderRadius: 12, padding: 14, background: '#fffdf8' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <strong>النتيجة — {result.skill}</strong>
            <span className="muted small">{result.durationMs}ms</span>
          </div>
          <p style={{ margin: '8px 0', lineHeight: 1.8 }}>{result.summary}</p>
          {result.suggestions.length > 0 && (
            <>
              <strong className="small">اقتراحات:</strong>
              <ul className="small" style={{ margin: '6px 0' }}>
                {result.suggestions.map((s, i) => <li key={i}>{s}</li>)}
              </ul>
            </>
          )}
          <details style={{ marginTop: 10 }}>
            <summary className="small muted">تفاصيل JSON</summary>
            <pre style={{ fontSize: 12, overflow: 'auto', background: '#f7f4ec', padding: 10, borderRadius: 8, direction: 'ltr', textAlign: 'left' }}>{JSON.stringify(result.details, null, 2)}</pre>
          </details>
        </div>
      )}

      <div className="muted small" style={{ marginTop: 16, borderTop: '1px dashed #e2e8e1', paddingTop: 10 }}>
        <strong>كيف يعمل بدون API؟</strong> كل مهمة هي كود TypeScript محلي يقرأ من SQLite مباشرة — نفس حسابات الخادم للمسافة والـ KPI، لكن مع تلخيص ذكي بالعربية. تقدر تشغّله أيضاً من الطرفية: <code>npm run agent -- alerts</code>
      </div>
    </section>
  );
}
