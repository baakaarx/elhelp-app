// Isolated Playwright server. The browser suite issues hundreds of requests as one test user;
// give only this disposable server a larger API budget, never the production server.
import { resolve } from 'node:path';
import { createApp } from '../server/src/app.js';
import { mountEngineerWebClient } from '../server/src/engineer-web.js';

if (process.env.NODE_ENV !== 'development' || !process.env.DB_PATH || !process.env.ADMIN_EMAIL || !process.env.ADMIN_PASSWORD) {
  throw new Error('The E2E server requires development mode and an explicitly configured disposable database and admin.');
}
const instance = createApp({ apiRateLimit: { windowMs: 60000, limit: 5000 } });
mountEngineerWebClient(instance.app, resolve('mobile/dist'));
instance.httpServer.listen(instance.config.port, '0.0.0.0', () => console.log(`E2E server listening on ${instance.config.port}`));
let closing = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => {
  if (closing) return;
  closing = true;
  void instance.close().finally(() => process.exit(0));
});
