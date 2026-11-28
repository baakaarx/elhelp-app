import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';

test('طابور الويب يحفظ البيانات القديمة والتغييرات المتزامنة بين تبويبين', async ({ page, context }) => {
  const second = await context.newPage();
  await Promise.all([page.goto('/'), second.goto('/')]);
  const moduleUrl = '/@fs' + resolve('mobile/src/queue.web.ts');
  await page.evaluate(() => localStorage.setItem('mandoub.outbox', JSON.stringify([{key:'legacy',kind:'report',payload:'{"id":"legacy"}',createdAt:1,attempts:0}])));
  const write = (p: typeof page, prefix: string) => p.evaluate(async ({ moduleUrl, prefix }) => {
    const { createQueue } = await import(/* @vite-ignore */ moduleUrl);
    const queue = await createQueue();
    await Promise.all(Array.from({ length: 50 }, (_, i) => queue.add('report', { id: `${prefix}-${i}` })));
    await queue.bump('legacy');
  }, { moduleUrl, prefix });
  await Promise.all([write(page,'a'),write(second,'b')]);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('mandoub.outbox')!));
  expect(saved).toHaveLength(101);
  expect(new Set(saved.map((x: {key:string}) => x.key)).size).toBe(101);
  expect(saved.find((x: {key:string}) => x.key === 'legacy').attempts).toBe(2);
});
