// @vitest-environment node
import { spawn, type ChildProcess } from 'node:child_process';
import { copyFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/*
 * Starts the real add-on server (server.js) with no Home Assistant behind
 * it and talks to it over HTTP. server.js is CommonJS but the repo's
 * package.json says "type": "module", so it runs from a temp copy named
 * .cjs — the same way it runs in the container, where /app has no
 * package.json.
 */

const repo = fileURLToPath(new URL('.', import.meta.url));
let dir: string;
let server: ChildProcess;
let base: string;
let output = '';

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'family-server-'));
  copyFileSync(join(repo, 'server.js'), join(dir, 'server.cjs'));
  copyFileSync(join(repo, 'server-guards.cjs'), join(dir, 'server-guards.cjs'));
  copyFileSync(join(repo, 'chores-sync.cjs'), join(dir, 'chores-sync.cjs'));
  mkdirSync(join(dir, 'dist'));
  writeFileSync(join(dir, 'dist', 'index.html'), '<!doctype html><div id="root"></div>');

  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, [join(dir, 'server.cjs')], {
    env: {
      PATH: process.env.PATH,
      NODE_PATH: join(repo, 'node_modules'),
      BEACON_PORT: String(port),
      BEACON_DIST: join(dir, 'dist'),
      BEACON_DATA: join(dir, 'data'),
    },
  });
  server.stdout!.on('data', (chunk) => { output += chunk; });
  server.stderr!.on('data', (chunk) => { output += chunk; });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server didn't start:\n${output}`)), 10_000);
    server.stdout!.on('data', () => {
      if (output.includes('listening on port')) {
        clearTimeout(timer);
        resolve();
      }
    });
    server.once('exit', (code) => reject(new Error(`server exited (${code}):\n${output}`)));
  });
});

afterAll(() => {
  server?.kill();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('add-on server', () => {
  it('answers a malformed collection item id with 400 and keeps running', async () => {
    for (const method of ['GET', 'PUT', 'DELETE']) {
      const res = await fetch(`${base}/beacon-collection/beacon_chores/%E0%A4%A`, {
        method,
        ...(method === 'PUT' ? { body: '{}' } : {}),
      });
      expect(res.status).toBe(400);
    }
    expect(server.exitCode).toBeNull();
    expect((await fetch(`${base}/`)).status).toBe(200);
  });

  it('stores collection items across requests', async () => {
    const created = await fetch(`${base}/beacon-collection/test_items`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Feed the dog' }),
    }).then((r) => r.json());
    expect(created.id).toEqual(expect.any(String));

    const items = await fetch(`${base}/beacon-collection/test_items`).then((r) => r.json());
    expect(items).toEqual([created]);
  });
});
