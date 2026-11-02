import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createApp } from './app.js';

const instance = createApp();
if (instance.config.production) {
  instance.app.use((req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/socket.io')) return next();
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data: blob: https://*.basemaps.cartocdn.com; connect-src 'self' wss:; object-src 'none'; base-uri 'self'");
    next();
  });
}
const dashboard = fileURLToPath(new URL('../../dashboard/dist', import.meta.url));
const mobile = fileURLToPath(new URL('../../mobile/dist', import.meta.url));
if (existsSync(mobile)) {
  instance.app.use('/app', express.static(mobile, { setHeaders(res, path) { if (path.endsWith('.html')) res.setHeader('Cache-Control', 'no-store'); } }));
  instance.app.get('/app/{*path}', (_req, res) => { res.setHeader('Cache-Control', 'no-store'); res.sendFile(`${mobile}/index.html`); });
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
