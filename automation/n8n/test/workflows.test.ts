import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { API, IDS, buildWorkflows, fileName, type N8nNode } from '../src/workflows';

const DIR = join(import.meta.dirname, '..', 'workflows');
const workflows = buildWorkflows();

/** Runs a generated Code node the way n8n does: a function body over $input/$execution/$(). */
function runCode(
  node: N8nNode,
  input: unknown[],
  nodes: Record<string, unknown[]> = {},
  staticData = {},
) {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval -- executes the generated node code
  const fn = new Function(
    '$input',
    '$execution',
    '$getWorkflowStaticData',
    '$',
    String(node.parameters.jsCode),
  );
  return fn(
    { all: () => input.map((json) => ({ json })) },
    { id: 'exec-1' },
    () => staticData,
    (name: string) => ({ all: () => (nodes[name] ?? []).map((json) => ({ json })) }),
  ) as { json: Record<string, unknown> }[];
}

const node = (wfId: string, name: string) => {
  const n = workflows.find((w) => w.id === wfId)!.nodes.find((x) => x.name === name);
  if (!n) throw new Error(`no node ${name}`);
  return n;
};

describe('generated workflows', () => {
  it('match the committed JSON (run `pnpm --filter @astra/n8n build` after changes)', () => {
    const files = readdirSync(DIR)
      .filter((f) => f.endsWith('.json'))
      .sort();
    expect(files).toEqual(workflows.map(fileName).sort());
    for (const w of workflows) {
      expect(JSON.parse(readFileSync(join(DIR, fileName(w)), 'utf8'))).toEqual(
        JSON.parse(JSON.stringify(w)),
      );
    }
  });

  it('are well formed: unique ids and names, valid connections, error workflow set', () => {
    const ids = new Set<string>();
    for (const w of workflows) {
      expect(w.id).toMatch(/^[A-Za-z0-9]{16}$/);
      const names = w.nodes.map((n) => n.name);
      expect(new Set(names).size).toBe(names.length);
      for (const n of w.nodes) {
        expect(ids.has(n.id)).toBe(false);
        ids.add(n.id);
      }
      for (const [from, out] of Object.entries(w.connections)) {
        expect(names).toContain(from);
        for (const c of out.main.flat()) expect(names).toContain(c.node);
      }
      if (w.id !== IDS.errors) expect(w.settings.errorWorkflow).toBe(IDS.errors);
      expect(w.active).toBe(false);
    }
  });

  it('keep secrets out: ASTRA calls use the named credential; no tokens, no environment access', () => {
    for (const w of workflows) {
      const text = JSON.stringify(w);
      expect(text).not.toMatch(/Bearer\s+[A-Za-z0-9]/);
      expect(text).not.toMatch(/\$env\b|process\.env/);
      for (const n of w.nodes) {
        const url = typeof n.parameters.url === 'string' ? n.parameters.url : '';
        if (n.type === 'n8n-nodes-base.httpRequest' && url.includes(API)) {
          expect(n.credentials?.httpHeaderAuth?.name).toBe('ASTRA automation token');
          expect(n.parameters.authentication).toBe('genericCredentialType');
        }
      }
    }
  });

  it('generated Code nodes run as n8n runs them', () => {
    // Signal webhook: the real node code turns a webhook item into a candidate.
    const out = runCode(node(IDS.signal, 'Build candidate'), [
      {
        body: {
          accountId: 'paper-demo',
          strategyId: 'paper-pipeline-test',
          symbol: 'MNQ',
          direction: 'LONG',
          entry: 20000,
          stop: 19990,
          target: 20030,
        },
      },
    ]);
    expect(out[0]!.json).toMatchObject({
      candidate: { workflowRunId: 'exec-1', signal: { direction: 'LONG' } },
    });

    // Alerts: the cursor lives in workflow static data.
    const staticData: Record<string, unknown> = {};
    const cursor = runCode(
      node(IDS.alerts, 'Cursor'),
      [{}],
      { 'Latest event': [{ events: [{ seq: 7 }] }] },
      staticData,
    );
    expect(cursor[0]!.json).toEqual({ afterSeq: 7 });
    const picked = runCode(
      node(IDS.alerts, 'Pick and format'),
      [
        {
          events: [
            {
              seq: 8,
              at: '2026-09-28T14:00:00.000Z',
              level: 'CRITICAL',
              component: 'x',
              type: 'Y',
              message: 'm',
            },
          ],
        },
      ],
      { Cursor: [{ afterSeq: 7 }] },
      staticData,
    );
    expect(picked).toHaveLength(1);
    expect(staticData).toEqual({ lastSeq: 8 });

    // "Edit me" nodes ship empty and stop the run with an explanation.
    expect(() => runCode(node(IDS.news, 'Sources (edit me)'), [{}])).toThrow(
      'No news feeds configured',
    );
    expect(() => runCode(node(IDS.calendar, 'Sources (edit me)'), [{}])).toThrow(
      'No calendar source',
    );
    expect(() =>
      runCode(node(IDS.notify, 'Channels (edit me)'), [{ title: 't', text: 'x' }]),
    ).toThrow('No notification channel');
    expect(runCode(node(IDS.reports, 'Weekly'), [{}])[0]!.json).toEqual({ kind: 'weekly' });
  });
});
