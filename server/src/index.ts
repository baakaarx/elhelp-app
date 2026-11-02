import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createApp } from './app.js';

const instance = createApp();
if (instance.config.production) {
  instance.app.use((req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/socket.io')) return next();
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data: blob: https://server.arcgisonline.com https://*.basemaps.cartocdn.com https://*.tile.openstreetmap.org; connect-src 'self' wss:; object-src 'none'; base-uri 'self'");
    next();
  });
}
const dashboard = fileURLToPath(new URL('../../dashboard/dist', import.meta.url));
const mobile = fileURLToPath(new URL('../../mobile/dist', import.meta.url));
if (existsSync(mobile)) {
  instance.app.use('/app', express.static(mobile, { setHeaders(res, path) { if (path.endsWith('.html')) res.setHeader('Cache-Control', 'no-store'); } }));
  instance.app.get('/app/{*path}', (_req, res) => { res.setHeader('Cache-Control', 'no-store'); res.sendFile(`${mobile}/index.html`); });
} else {
  // /app must never fall through to the manager SPA: representatives would land on a login
  // screen that rejects them. Tell the operator how to build the engineer bundle instead.
  const placeholder = `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" /><title>تطبيق المهندس · الهلب</title>
    <style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f7f4ec;color:#14231c;font-family:"Noto Naskh Arabic",Tahoma,sans-serif}
    main{max-width:460px;padding:28px;background:#fffdf8;border:1px solid #e2e8e1;border-radius:20px;text-align:center;line-height:1.9}
    h1{color:#16382c;font-size:22px;margin:0 0 8px}p{margin:6px 0;color:#4b5a51}code{background:#e8f1ea;padding:2px 6px;border-radius:6px;direction:ltr;display:inline-block}
    a{color:#1f513f;font-weight:700}</style></head>
    <body><main><h1>تطبيق المهندس</h1><p>نسخة الويب من تطبيق الموبايل لسه ما اتبنيتش على السيرفر ده.</p>
    <p>شغّل <code>npm run export:mobile</code> ثم أعد تشغيل الخادم.</p>
    <p><a href="/">الدخول إلى لوحة المدير</a></p></main></body></html>`;
  const sendPlaceholder = (_req: express.Request, res: express.Response) => { res.setHeader('Cache-Control', 'no-store'); res.status(200).type('html').send(placeholder); };
  instance.app.get('/app', sendPlaceholder);
  instance.app.get('/app/{*path}', sendPlaceholder);
}
if (existsSync(dashboard)) {
  instance.app.use(express.static(dashboard, { setHeaders(res, path) { if (path.endsWith('.html')) res.setHeader('Cache-Control', 'no-store'); } }));
  instance.app.get('/{*path}', (_req, res) => { res.setHeader('Cache-Control', 'no-store'); res.sendFile(`${dashboard}/index.html`); });
} else {
  instance.app.get('/', (_req, res) => res.type('html').send('<html lang="ar" dir="rtl"><body><h1>الهلب API</h1><p>شغّل لوحة التحكم من مجلد dashboard، أو نفّذ npm run build.</p></body></html>'));
}
instance.httpServer.listen(instance.config.port, '0.0.0.0', () => {
  console.log(`Elhelb engineer server is listening on 0.0.0.0:${instance.config.port} | demo=${instance.config.demo}`);
  if (instance.config.demo) console.log('Demo manager: admin@mandoub.test / Demo1234! | GPS test rep: rep@mandoub.test / Demo1234!');
});
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await instance.close();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
