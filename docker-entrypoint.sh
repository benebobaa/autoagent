#!/bin/sh
set -e

echo "Running database migrations..."
node_modules/.bin/node-pg-migrate up \
  --migration-file-language sql \
  --migrations-dir migrations \
  --database-url "$DATABASE_URL"

echo "Migrations complete. Starting agent..."
exec /sbin/tini -- node dist/agent.js
