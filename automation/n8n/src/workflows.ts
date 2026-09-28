/**
 * ASTRA's n8n workflows, defined in code. Code-node logic lives in `src/nodes/*.ts` (typed and
 * unit-tested) and is inlined here; `pnpm --filter @astra/n8n build` writes the importable JSON
 * to `workflows/`, and a test fails if the committed JSON drifts from this definition.
 *
 * Rules (ADR-0005, ADR-0021): n8n schedules, fetches and delivers; ASTRA validates and decides.
 * Secrets live only in n8n credentials, referenced here by name.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

export const API = 'http://api:8080';

export const IDS = {
  heartbeat: 'astraHeartbeat01',
  errors: 'astraErrorHandle',
  news: 'astraNewsRss0001',
  calendar: 'astraCalendar001',
  signal: 'astraSignalHook1',
  alerts: 'astraAlerts00001',
  reports: 'astraReports0001',
  notify: 'astraNotify00001',
} as const;

export const CREDENTIALS = {
  astra: { httpHeaderAuth: { id: 'astraAutomationT', name: 'ASTRA automation token' } },
  signalSecret: { httpHeaderAuth: { id: 'astraSignalSecrt', name: 'ASTRA signal webhook secret' } },
  telegram: { telegramApi: { id: 'astraTelegramBot', name: 'ASTRA Telegram bot' } },
  discord: { discordWebhookApi: { id: 'astraDiscordHook', name: 'ASTRA Discord webhook' } },
  smtp: { smtp: { id: 'astraSmtpAccount', name: 'ASTRA SMTP' } },
} as const;

export interface N8nNode {
  id: string;
  name: string;
  type: string;
  typeVersion: number;
  position: [number, number];
  parameters: Record<string, unknown>;
  credentials?: Record<string, { id: string; name: string }>;
  webhookId?: string;
  notes?: string;
  notesInFlow?: boolean;
}

export interface N8nWorkflow {
  id: string;
  name: string;
  nodes: N8nNode[];
  connections: Record<string, { main: { node: string; type: 'main'; index: number }[][] }>;
  settings: Record<string, unknown>;
  active: false;
  pinData: Record<string, never>;
  meta: { astra: string };
}

const NODES_DIR = join(import.meta.dirname, 'nodes');

function uuid(seed: string): string {
  const h = createHash('sha256').update(seed).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** TypeScript node module → plain JavaScript without imports / exports (n8n cannot import). */
export function moduleJs(file: string): string {
  const source = readFileSync(join(NODES_DIR, file), 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      removeComments: false,
    },
  }).outputText;
  const out = js
    .replace(/^import\s[^;]*;\s*$/gm, '')
    .replace(/^export\s+\{\s*\};?\s*$/gm, '')
    .replace(/^export\s+(?=(async\s+)?(function|const|let|class)\b)/gm, '')
    .trim();
  if (/^\s*(import|export)\b/m.test(out)) throw new Error(`${file}: unsupported import/export`);
  if (/\$env\b/.test(out)) throw new Error(`${file}: code nodes must not read the environment`);
  return out;
}

interface CodeOptions {
  /** Exported function to call (default `run`). */
  entry?: string;
  /** ctx.extra keys → names of earlier nodes whose output is passed. */
  extra?: Record<string, string>;
  staticData?: boolean;
  notes?: string;
}

function code(
  wf: string,
  name: string,
  file: string,
  position: [number, number],
  o: CodeOptions = {},
): N8nNode {
  const extra = Object.entries(o.extra ?? {})
    .map(([k, node]) => `${k}: $(${JSON.stringify(node)}).all().map((i) => i.json)`)
    .join(', ');
  const jsCode = [
    `// Generated from automation/n8n/src/nodes/${file} — change it there and rebuild.`,
    moduleJs('shared.ts'),
    moduleJs(file),
    'const ctx = {',
    '  now: new Date(),',
    '  executionId: String($execution.id),',
    `  staticData: ${o.staticData ? "$getWorkflowStaticData('global')" : '{}'},`,
    `  extra: { ${extra} },`,
    '};',
    `return ${o.entry ?? 'run'}($input.all().map((i) => i.json), ctx).map((json) => ({ json }));`,
  ].join('\n');
  return {
    id: uuid(`${wf}:${name}`),
    name,
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position,
    parameters: { jsCode },
    ...(o.notes ? { notes: o.notes, notesInFlow: true } : {}),
  };
}

function astra(
  wf: string,
  name: string,
  method: 'GET' | 'POST',
  url: string,
  position: [number, number],
  jsonBody?: string,
): N8nNode {
  return {
    id: uuid(`${wf}:${name}`),
    name,
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    position,
    parameters: {
      method,
      url,
      authentication: 'genericCredentialType',
      genericAuthType: 'httpHeaderAuth',
      ...(jsonBody ? { sendBody: true, specifyBody: 'json', jsonBody } : {}),
      options: { timeout: 15_000 },
    },
    credentials: { ...CREDENTIALS.astra },
  };
}

function fetchText(wf: string, name: string, position: [number, number]): N8nNode {
  return {
    id: uuid(`${wf}:${name}`),
    name,
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    position,
    parameters: {
      url: '={{ $json.url }}',
      options: {
        timeout: 20_000,
        response: { response: { responseFormat: 'text', outputPropertyName: 'data' } },
      },
    },
  };
}

type Rule =
  { field: 'minutes'; minutesInterval: number } | { field: 'cronExpression'; expression: string };

function schedule(wf: string, name: string, rule: Rule, position: [number, number]): N8nNode {
  return {
    id: uuid(`${wf}:${name}`),
    name,
    type: 'n8n-nodes-base.scheduleTrigger',
    typeVersion: 1.2,
    position,
    parameters: { rule: { interval: [rule] } },
  };
}

function notifyCall(wf: string, position: [number, number]): N8nNode {
  return {
    id: uuid(`${wf}:Notify`),
    name: 'Notify',
    type: 'n8n-nodes-base.executeWorkflow',
    typeVersion: 1,
    position,
    parameters: { source: 'database', workflowId: IDS.notify },
  };
}

function chain(...names: string[]): N8nWorkflow['connections'] {
  const c: N8nWorkflow['connections'] = {};
  for (let i = 0; i < names.length - 1; i++) link(c, names[i]!, names[i + 1]!);
  return c;
}

function link(c: N8nWorkflow['connections'], from: string, to: string): N8nWorkflow['connections'] {
  const out = (c[from] ??= { main: [[]] });
  out.main[0]!.push({ node: to, type: 'main', index: 0 });
  return c;
}

function workflow(
  id: string,
  name: string,
  nodes: N8nNode[],
  connections: N8nWorkflow['connections'],
  about: string,
  settings: Record<string, unknown> = {},
): N8nWorkflow {
  return {
    id,
    name,
    nodes,
    connections,
    settings: {
      executionOrder: 'v1',
      ...(id === IDS.errors ? {} : { errorWorkflow: IDS.errors }),
      ...settings,
    },
    active: false,
    pinData: {},
    meta: { astra: about },
  };
}

export function buildWorkflows(): N8nWorkflow[] {
  const hb = IDS.heartbeat;
  const heartbeat = workflow(
    hb,
    'ASTRA — Heartbeat',
    [
      schedule(hb, 'Every minute', { field: 'minutes', minutesInterval: 1 }, [0, 0]),
      astra(
        hb,
        'POST heartbeat to ASTRA',
        'POST',
        `${API}/api/v1/automation/heartbeat`,
        [260, 0],
        "={{ JSON.stringify({ status: 'ONLINE', detail: 'n8n heartbeat', workflowRunId: String($execution.id) }) }}",
      ),
    ],
    chain('Every minute', 'POST heartbeat to ASTRA'),
    'Health: tells ASTRA that automation is alive. Silence → AUTOMATION UNKNOWN → no new trades.',
  );

  const er = IDS.errors;
  const errors = workflow(
    er,
    'ASTRA — Error handler',
    [
      {
        id: uuid(`${er}:On workflow error`),
        name: 'On workflow error',
        type: 'n8n-nodes-base.errorTrigger',
        typeVersion: 1,
        position: [0, 0],
        parameters: {},
      },
      astra(
        er,
        'Report to ASTRA',
        'POST',
        `${API}/api/v1/automation/errors`,
        [260, 0],
        "={{ JSON.stringify({ workflow: $json.workflow?.name ?? 'unknown', error: String($json.execution?.error?.message ?? 'unknown error').slice(0, 4000), workflowRunId: String($json.execution?.id ?? '') }) }}",
      ),
    ],
    chain('On workflow error', 'Report to ASTRA'),
    'Error workflow of every ASTRA workflow: failures appear in ASTRA live activity (and, as ERROR events, in alerts).',
  );

  const nw = IDS.news;
  const news = workflow(
    nw,
    'ASTRA — News ingestion (RSS)',
    [
      schedule(nw, 'Every 5 minutes', { field: 'minutes', minutesInterval: 5 }, [0, 0]),
      code(nw, 'Sources (edit me)', 'news-sources.ts', [220, 0], {
        notes: 'Add your RSS / Atom feeds to SOURCES.',
      }),
      fetchText(nw, 'Fetch feed', [440, 0]),
      code(nw, 'Normalise', 'news-normalise.ts', [660, 0], {
        extra: { sources: 'Sources (edit me)' },
      }),
      astra(
        nw,
        'Push to ASTRA',
        'POST',
        `${API}/api/v1/news/items`,
        [880, 0],
        '={{ JSON.stringify({ source: $json.source, items: $json.items }) }}',
      ),
    ],
    chain('Every 5 minutes', 'Sources (edit me)', 'Fetch feed', 'Normalise', 'Push to ASTRA'),
    'Ingestion: owner-chosen RSS/Atom feeds → ASTRA news (classified by ASTRA). Any failed feed stops the run: ASTRA news goes stale → no new trades.',
  );

  const cw = IDS.calendar;
  const calendar = workflow(
    cw,
    'ASTRA — Calendar ingestion',
    [
      schedule(cw, 'Every 30 minutes', { field: 'minutes', minutesInterval: 30 }, [0, 0]),
      code(cw, 'Sources (edit me)', 'calendar-sources.ts', [220, 0], {
        notes: 'Add your calendar source(s) to SOURCES.',
      }),
      fetchText(cw, 'Fetch calendar', [440, 0]),
      code(cw, 'Normalise', 'calendar-normalise.ts', [660, 0], {
        extra: { sources: 'Sources (edit me)' },
      }),
      astra(
        cw,
        'Push to ASTRA',
        'POST',
        `${API}/api/v1/calendar/window`,
        [880, 0],
        '={{ JSON.stringify({ source: $json.source, window: $json.window }) }}',
      ),
    ],
    chain('Every 30 minutes', 'Sources (edit me)', 'Fetch calendar', 'Normalise', 'Push to ASTRA'),
    'Ingestion: owner-chosen economic calendar → ASTRA calendar window (ASTRA keeps it fresh for 1 h). A failure stops the run → calendar stale → no new trades.',
  );

  const sw = IDS.signal;
  const signal = workflow(
    sw,
    'ASTRA — Signal webhook',
    [
      {
        id: uuid(`${sw}:Alert received`),
        name: 'Alert received',
        type: 'n8n-nodes-base.webhook',
        typeVersion: 2,
        position: [0, 0],
        webhookId: uuid(`${sw}:webhook`),
        parameters: {
          httpMethod: 'POST',
          path: 'astra-signal',
          authentication: 'headerAuth',
          responseMode: 'responseNode',
          options: {},
        },
        credentials: { ...CREDENTIALS.signalSecret },
      },
      code(sw, 'Build candidate', 'signal-candidate.ts', [220, 0]),
      astra(
        sw,
        'Submit to ASTRA gate',
        'POST',
        `${API}/api/v1/decisions/evaluate`,
        [440, 0],
        '={{ JSON.stringify({ candidate: $json.candidate, autoExecute: $json.autoExecute }) }}',
      ),
      code(sw, 'Summarise', 'signal-summary.ts', [660, 0]),
      {
        id: uuid(`${sw}:Reply`),
        name: 'Reply',
        type: 'n8n-nodes-base.respondToWebhook',
        typeVersion: 1.1,
        position: [880, 0],
        parameters: { respondWith: 'firstIncomingItem', options: {} },
      },
    ],
    chain('Alert received', 'Build candidate', 'Submit to ASTRA gate', 'Summarise', 'Reply'),
    "Cycle: an external alert (e.g. TradingView) → ASTRA's gate. The gate decides; this only reshapes the alert.",
  );

  const aw = IDS.alerts;
  const alerts = workflow(
    aw,
    'ASTRA — Alerts',
    [
      schedule(aw, 'Every minute', { field: 'minutes', minutesInterval: 1 }, [0, 0]),
      astra(aw, 'Latest event', 'GET', `${API}/api/v1/events?limit=1`, [220, 0]),
      code(aw, 'Cursor', 'alerts-cursor.ts', [440, 0], {
        extra: { latest: 'Latest event' },
        staticData: true,
      }),
      astra(
        aw,
        'New events',
        'GET',
        `=${API}/api/v1/events?afterSeq={{ $json.afterSeq }}&order=asc&limit=200`,
        [660, 0],
      ),
      code(aw, 'Pick and format', 'alerts-format.ts', [880, 0], {
        extra: { cursor: 'Cursor' },
        staticData: true,
      }),
      notifyCall(aw, [1100, 0]),
    ],
    chain('Every minute', 'Latest event', 'Cursor', 'New events', 'Pick and format', 'Notify'),
    'Notifications: new ASTRA events worth a message → ASTRA — Notify (grouped, once each).',
  );

  const rw = IDS.reports;
  const reports = workflow(
    rw,
    'ASTRA — Reports',
    [
      schedule(
        rw,
        'Daily 17:10 New York (Mon–Fri)',
        { field: 'cronExpression', expression: '10 17 * * 1-5' },
        [0, 0],
      ),
      schedule(
        rw,
        'Weekly Fri 17:20 New York',
        { field: 'cronExpression', expression: '20 17 * * 5' },
        [0, 200],
      ),
      code(rw, 'Daily', 'report-message.ts', [220, 0], { entry: 'daily' }),
      code(rw, 'Weekly', 'report-message.ts', [220, 200], { entry: 'weekly' }),
      astra(rw, 'Get report', 'GET', `=${API}/api/v1/reports?kind={{ $json.kind }}`, [440, 100]),
      code(rw, 'Message', 'report-message.ts', [660, 100]),
      notifyCall(rw, [880, 100]),
    ],
    link(
      link(
        chain('Daily 17:10 New York (Mon–Fri)', 'Daily', 'Get report', 'Message', 'Notify'),
        'Weekly Fri 17:20 New York',
        'Weekly',
      ),
      'Weekly',
      'Get report',
    ),
    'Reports: ASTRA computes the daily / weekly report from its records; n8n delivers it.',
    { timezone: 'America/New_York' },
  );

  const nf = IDS.notify;
  const notify = workflow(
    nf,
    'ASTRA — Notify',
    [
      {
        id: uuid(`${nf}:Message in`),
        name: 'Message in',
        type: 'n8n-nodes-base.executeWorkflowTrigger',
        typeVersion: 1,
        position: [0, 100],
        parameters: {},
      },
      code(nf, 'Channels (edit me)', 'notify.ts', [220, 100], {
        notes: 'Enable your channels in CHANNELS and create their credentials.',
      }),
      code(nf, 'Telegram message', 'notify.ts', [440, 0], { entry: 'telegram' }),
      code(nf, 'Discord message', 'notify.ts', [440, 100], { entry: 'discord' }),
      code(nf, 'Email message', 'notify.ts', [440, 200], { entry: 'email' }),
      {
        id: uuid(`${nf}:Send Telegram`),
        name: 'Send Telegram',
        type: 'n8n-nodes-base.telegram',
        typeVersion: 1.2,
        position: [660, 0],
        parameters: {
          chatId: '={{ $json.chatId }}',
          text: '={{ $json.text }}',
          additionalFields: { appendAttribution: false },
        },
        credentials: { ...CREDENTIALS.telegram },
      },
      {
        id: uuid(`${nf}:Send Discord`),
        name: 'Send Discord',
        type: 'n8n-nodes-base.discord',
        typeVersion: 2,
        position: [660, 100],
        parameters: { authentication: 'webhook', content: '={{ $json.content }}', options: {} },
        credentials: { ...CREDENTIALS.discord },
      },
      {
        id: uuid(`${nf}:Send email`),
        name: 'Send email',
        type: 'n8n-nodes-base.emailSend',
        typeVersion: 2.1,
        position: [660, 200],
        parameters: {
          fromEmail: '={{ $json.from }}',
          toEmail: '={{ $json.to }}',
          subject: '={{ $json.subject }}',
          emailFormat: 'text',
          text: '={{ $json.text }}',
          options: { appendAttribution: false },
        },
        credentials: { ...CREDENTIALS.smtp },
      },
    ],
    [
      ['Message in', 'Channels (edit me)'],
      ['Channels (edit me)', 'Telegram message'],
      ['Channels (edit me)', 'Discord message'],
      ['Channels (edit me)', 'Email message'],
      ['Telegram message', 'Send Telegram'],
      ['Discord message', 'Send Discord'],
      ['Email message', 'Send email'],
    ].reduce((c, [a, b]) => link(c, a!, b!), {} as N8nWorkflow['connections']),
    'Delivery: one message → Telegram / Discord / email. Called by Alerts and Reports.',
  );

  return [heartbeat, errors, news, calendar, signal, alerts, reports, notify];
}

export const fileName = (w: N8nWorkflow) =>
  `${w.name
    .replace(/^ASTRA — /, 'astra-')
    .toLowerCase()
    .replace(/\(.*?\)/g, '')
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+$/, '')}.json`;
