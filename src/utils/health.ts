import * as http from 'http';
import { getPool } from '../storage/pg-pool.js';
import { logger } from './logger.js';
import type { SignalLoopSupervisor } from '../signals/supervisor.js';

export type HealthDbCheck = () => Promise<boolean>;

async function defaultDbCheck(): Promise<boolean> {
  try {
    await getPool().query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

async function getReadiness(supervisor: SignalLoopSupervisor, dbCheck: HealthDbCheck) {
  const now = Date.now();
  const lastTickTime = supervisor.lastTickTime;
  const tickCount = supervisor.tickCount;
  const uptimeSec = Math.floor(process.uptime());

  // Poller is considered alive if it hasn't been more than 10 mins since last tick
  // OR if it's still in the first 10 minutes of process lifetime (starting up/first poll)
  // Actually standard interval is 5 mins, so 10 mins is a 2x leeway.
  const timeSinceLastTick = now - lastTickTime;
  const isInitialStartup = uptimeSec < 600 && tickCount === 0;
  const pollerAlive = isInitialStartup || timeSinceLastTick < 10 * 60 * 1000;
  const databaseAlive = await dbCheck();
  const ready = pollerAlive && databaseAlive;

  return {
    status: ready ? 'ok' : 'error',
    uptimeSec,
    lastTickTime,
    tickCount,
    pollerAlive,
    databaseAlive,
  };
}

export function startHealthServer(
  supervisor: SignalLoopSupervisor,
  port: number = 3000,
  dbCheck: HealthDbCheck = defaultDbCheck,
): http.Server {
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'GET') {
      res.writeHead(404);
      res.end();
      return;
    }

    if (req.url === '/live') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', uptimeSec: Math.floor(process.uptime()) }));
      return;
    }

    if (req.url === '/ready' || req.url === '/health') {
      const readiness = await getReadiness(supervisor, dbCheck);
      res.writeHead(readiness.status === 'ok' ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(readiness));
      return;
    }

    res.writeHead(404);
    res.end();
  });

  server.listen(port, '0.0.0.0', () => {
    logger.info({ port }, 'Health server started');
  });

  return server;
}
