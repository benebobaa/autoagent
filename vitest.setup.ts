const defaultTestDatabaseUrl = 'postgresql://yield_agent_test:yield_agent_test@localhost:5433/yield_agent_test';

process.env['VITEST'] = 'true';
process.env['TEST_DATABASE_URL'] ??= defaultTestDatabaseUrl;
process.env['DATABASE_URL'] = process.env['TEST_DATABASE_URL'];
