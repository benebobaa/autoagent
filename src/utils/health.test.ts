import { afterEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'net';
import { once } from 'events';
import type { SignalLoopSupervisor } from '../signals/supervisor.js';
import { startHealthServer } from './health.js';

type SupervisorStub = Pick<SignalLoopSupervisor, 'lastTickTime' | 'tickCount'>;

const servers: Array<ReturnType<typeof startHealthServer>> = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(async (server) => {
      server.close();
      await once(server, 'close');
    })
  );
});

async function startServer(supervisor: SupervisorStub, dbAlive = true) {
  const server = startHealthServer(supervisor as SignalLoopSupervisor, 0, async () => dbAlive);
  servers.push(server);
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

describe('startHealthServer', () => {
  it('returns 200 for /live even before the first poll tick', async () => {
    const baseUrl = await startServer({ lastTickTime: 0, tickCount: 0 });

    const response = await fetch(`${baseUrl}/live`);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'ok' });
  });

  it('returns 503 for /ready when the poller is stale', async () => {
    const staleTickTime = Date.now() - 11 * 60 * 1000;
    const baseUrl = await startServer({ lastTickTime: staleTickTime, tickCount: 1 });

    const response = await fetch(`${baseUrl}/ready`);

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ status: 'error', pollerAlive: false, databaseAlive: true });
  });

  it('keeps /health aligned with readiness semantics for compatibility', async () => {
    const staleTickTime = Date.now() - 11 * 60 * 1000;
    const baseUrl = await startServer({ lastTickTime: staleTickTime, tickCount: 1 });

    const response = await fetch(`${baseUrl}/health`);

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ status: 'error', pollerAlive: false, databaseAlive: true });
  });

  it('returns 503 for /ready when the database is unavailable', async () => {
    const baseUrl = await startServer({ lastTickTime: Date.now(), tickCount: 1 }, false);

    const response = await fetch(`${baseUrl}/ready`);

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ status: 'error', pollerAlive: true, databaseAlive: false });
  });
});
