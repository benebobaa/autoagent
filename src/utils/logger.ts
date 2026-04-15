import pino from 'pino';
import { loadConfig } from '../config/loader.js';

const config = loadConfig();

export const DRY_RUN = config.dryRun;
const level = config.logLevel;

// exactOptionalPropertyTypes: only pass transport when it's defined
export const logger = process.stdout.isTTY
  ? pino({ level, transport: { target: 'pino-pretty', options: { colorize: true } } })
  : pino({ level });
