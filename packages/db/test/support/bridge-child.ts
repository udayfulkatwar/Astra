/**
 * Child process for the P002 offline journal tests. It opens its OWN database connection, so the
 * parent observes persisted state, not a shared in-memory object. Modes:
 *  - crash-after-begin:  journal INTENT, then SIGKILL (the marker was never committed)
 *  - crash-after-marker: INTENT + SEND_MAY_HAVE_STARTED committed, then SIGKILL before any result
 *  - execute:            run the bridge against a fresh fake terminal and print what happened
 */
import { OfflineBridge, FakeTerminal, parseCommand } from '@astra/execution';
import { createDb } from '../../src/client';
import { PgBridgeJournal } from '../../src/repositories/bridge-journal';

const env = (k: string): string => {
  const v = process.env[k];
  if (v === undefined) throw new Error(`missing ${k}`);
  return v;
};

const sql = createDb({ url: env('CHILD_DB_URL'), schema: env('CHILD_SCHEMA'), maxConnections: 2 });
const journal = new PgBridgeJournal(sql);
const fence = { ownerId: env('CHILD_OWNER'), epoch: env('CHILD_EPOCH') };
const parsed = parseCommand(JSON.parse(env('CHILD_COMMAND')));
if (!parsed.ok) throw new Error('child command invalid');
const command = parsed.command;
const mode = env('CHILD_MODE');

if (mode === 'crash-after-begin') {
  await journal.begin(fence, command);
  process.kill(process.pid, 'SIGKILL');
} else if (mode === 'crash-after-marker') {
  await journal.begin(fence, command);
  await journal.markSendMayHaveStarted(fence, command.accountRef, command.commandId);
  process.kill(process.pid, 'SIGKILL');
} else {
  const terminal = new FakeTerminal();
  const bridge = new OfflineBridge(journal, terminal, fence);
  const outcome = await bridge.execute(command, {
    now: new Date('2026-10-05T10:00:10.000Z'),
    entryPermitted: true,
  });
  process.stdout.write(
    JSON.stringify({ kind: outcome.kind, invocations: terminal.invocations.length }) + '\n',
  );
  await sql.end({ timeout: 5 });
}
