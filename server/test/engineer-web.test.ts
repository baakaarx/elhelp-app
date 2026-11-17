import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import express from 'express';
import { mountEngineerWebClient } from '../src/engineer-web.js';

async function start(app: express.Express): Promise<{ server: Server; base: string }> {
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { server, base: `http://127.0.0.1:${address.port}` };
}
async function stop(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

test('the engineer bundle, assets and HTML deep links stay separate from the manager SPA', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'elhelp-engineer-web-'));
  const scripts = join(directory, '_expo/static/js/web');
  await mkdir(scripts, { recursive: true });
  await writeFile(join(directory, 'index.html'), '<!doctype html><title>مهندس الميدان</title><script src="/app/_expo/static/js/web/index-abc.js"></script>');
  await writeFile(join(scripts, 'index-abc.js'), 'window.engineerClient = true;');

  const app = express();
  mountEngineerWebClient(app, directory);
  app.get('/{*path}', (_req, res) => res.status(200).send('manager dashboard'));
  const { server, base } = await start(app);
  try {
    const page = await fetch(`${base}/app`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /مهندس الميدان/);
    assert.equal(page.headers.get('cache-control'), 'no-store');
    assert.match(page.headers.get('content-security-policy') || '', /script-src 'self'/);
    assert.equal(page.headers.get('cross-origin-opener-policy'), 'same-origin-allow-popups');

    const trailingSlash = await fetch(`${base}/app/`);
    assert.equal(trailingSlash.status, 200);

    const asset = await fetch(`${base}/app/_expo/static/js/web/index-abc.js`);
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get('content-type') || '', /javascript/);
    assert.equal(await asset.text(), 'window.engineerClient = true;');

    for (const path of ['/app/visits/today', '/app/oauth?state=example', '/app/oauth/apple']) {
      const deepLink = await fetch(`${base}${path}`, { headers: { Accept: 'text/html' } });
      assert.equal(deepLink.status, 200, `${path} should return the engineer shell`);
      assert.match(await deepLink.text(), /مهندس الميدان/);
    }

    const missingAsset = await fetch(`${base}/app/_expo/missing.js`, { headers: { Accept: 'text/html' } });
    assert.equal(missingAsset.status, 404);
    assert.equal(await missingAsset.text(), 'Not found');

    const manager = await fetch(base);
    assert.equal(await manager.text(), 'manager dashboard');
  } finally {
    await stop(server);
    await rm(directory, { recursive: true, force: true });
  }
});

test('the engineer route never turns into the manager SPA when its bundle is missing', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'elhelp-engineer-web-empty-'));
  const app = express();
  mountEngineerWebClient(app, directory);
  app.get('/{*path}', (_req, res) => res.status(200).send('manager dashboard'));
  const { server, base } = await start(app);
  try {
    const response = await fetch(`${base}/app`);
    assert.equal(response.status, 404);
    assert.match(await response.text(), /موقع المهندسين غير جاهز/);
  } finally {
    await stop(server);
    await rm(directory, { recursive: true, force: true });
  }
});
