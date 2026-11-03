#!/usr/bin/env tsx
/**
 * ElHelp Local Agent CLI — يعمل بدون API
 * Usage:
 *   npm run agent -- review
 *   npm run agent -- summarize --repId <uuid> --date 2026-11-02
 *   npm run agent -- route --repId <uuid> --date 2026-11-02
 *   npm run agent -- alerts
 *   npm run agent -- skills
 */
import { Store } from '../db.js';
import { readConfig } from '../config.js';
import { ElHelpAgent } from './index.js';

const args = process.argv.slice(2);
const cmd = args[0] || 'help';

function getArg(name: string) {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1) return undefined;
  return args[idx + 1];
}

async function main() {
  const config = readConfig();
  const store = new Store(config.dbPath);
  const agent = new ElHelpAgent(store, config.timezone, { retentionDays: config.retentionDays });

  if (cmd === 'skills') {
    console.log('Loaded skills:');
    for (const s of agent.skills) console.log(`- ${s.id} (${s.name}): ${s.description}`);
    process.exit(0);
  }

  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(`
ElHelp Agent (بدون API) — الأوامر:

  skills                              عرض الـ Skills المحملة
  review                              مراجعة التقارير اليومية المعلقة
  alerts                              تنبيهات ميدانية ذكية
  summarize [--repId UUID] [--date YYYY-MM-DD]
                                      ملخص يوم مهندس أو كل الفريق
  route --repId UUID [--date YYYY-MM-DD]
                                      تحليل مسار GPS

أمثلة:
  npm run agent -- review
  npm run agent -- alerts
`);
    process.exit(0);
  }

  let input: any = {};
  if (cmd === 'review') input = { task: 'review-daily-reports' };
  else if (cmd === 'alerts') input = { task: 'field-alerts' };
  else if (cmd === 'summarize') input = { task: 'summarize-day', repId: getArg('repId'), date: getArg('date') };
  else if (cmd === 'route') {
    const repId = getArg('repId');
    if (!repId) { console.error('route يحتاج --repId'); process.exit(1); }
    input = { task: 'analyze-route', repId, date: getArg('date') };
  } else {
    console.error(`أمر غير معروف: ${cmd} — استخدم help`);
    process.exit(1);
  }

  const result = await agent.run(input);
  console.log('\n=== النتيجة ===');
  console.log(result.summary);
  if (result.suggestions.length) {
    console.log('\nاقتراحات:');
    result.suggestions.forEach(s => console.log(' - ' + s));
  }
  console.log('\nتفاصيل:', JSON.stringify(result.details, null, 2));
  store.close();
}

main().catch(e => { console.error(e); process.exit(1); });
