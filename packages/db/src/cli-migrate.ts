/* eslint-disable no-console -- CLI entry point */
import { createDb } from './client';
import { migrate } from './migrate';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}
const sql = createDb({ url, maxConnections: 1, applicationName: 'astra-migrate' });
try {
  const { applied } = await migrate(sql);
  console.log(applied.length ? `applied: ${applied.join(', ')}` : 'database is up to date');
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await sql.end();
}
