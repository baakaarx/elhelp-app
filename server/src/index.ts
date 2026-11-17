import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createApp } from './app.js';
import { mountEngineerWebClient } from './engineer-web.js';

// The content-security policy is applied inside createApp (see csp.ts), before the routes.
const instance = createApp();
const dashboard = fileURLToPath(new URL('../../dashboard/dist', import.meta.url));
const engineerWeb = fileURLToPath(new URL('../../mobile/dist', import.meta.url));

// The iPhone engineer client is a separate static export; / remains the manager dashboard.
// The iPhone deployment guide points this web client at a distinct subdomain so localStorage
// cannot share a manager session across the two user surfaces.
mountEngineerWebClient(instance.app, engineerWeb);

if (existsSync(dashboard)) {
  instance.app.use(express.static(dashboard, { setHeaders(res, path) { if (path.endsWith('.html')) res.setHeader('Cache-Control', 'no-store'); } }));
  instance.app.get('/{*path}', (_req, res) => { res.setHeader('Cache-Control', 'no-store'); res.sendFile(`${dashboard}/index.html`); });
} else {
  instance.app.get('/', (_req, res) => res.type('html').send('<html lang="ar" dir="rtl"><body><h1>الهلب API</h1><p>شغّل لوحة التحكم من مجلد dashboard، أو نفّذ npm run build.</p></body></html>'));
}
instance.httpServer.listen(instance.config.port, '0.0.0.0', () => {
  console.log(`Elhelb engineer server is listening on 0.0.0.0:${instance.config.port}`);
  // The manager address comes from ADMIN_EMAIL; never print the password.
  console.log(`Manager account: ${instance.config.adminEmail}`);
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
