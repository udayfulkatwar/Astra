import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalJson } from '@astra/core';
import { ConfigError, loadAstraConfig } from '../src/loader';

const REPO_CONFIG = resolve(__dirname, '../../../config');
const temps: string[] = [];

function copyConfig(): string {
  const dir = mkdtempSync(join(tmpdir(), 'astra-config-'));
  temps.push(dir);
  cpSync(REPO_CONFIG, dir, { recursive: true });
  return dir;
}

afterEach(() => {
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true });
});

function expectIssue(dir: string, pattern: RegExp) {
  try {
    loadAstraConfig(dir);
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).issues.join('\n')).toMatch(pattern);
    return;
  }
  throw new Error('expected ConfigError');
}

describe('loadAstraConfig', () => {
  it('loads and validates the repository configuration', () => {
    const cfg = loadAstraConfig(REPO_CONFIG);
    expect(cfg.accounts.get('paper-demo')?.propFirmProfileId).toBe('template-static-50k');
    expect(cfg.instruments.get('NQ')?.tickValue).toBe(5);
    expect(cfg.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    // Every shipped entity is a template/unverified and says so.
    expect(cfg.warnings.join('\n')).toMatch(/UNVERIFIED/);
    expect(cfg.warnings.join('\n')).toMatch(/TEMPLATE/);
  });

  it('produces a stable hash for identical config and a different hash after a change', () => {
    const dir = copyConfig();
    const a = loadAstraConfig(dir).hash;
    expect(loadAstraConfig(dir).hash).toBe(a);
    const f = join(dir, 'risk-policies/template-conservative.yaml');
    writeFileSync(
      f,
      readFileSync(f, 'utf8').replace('riskPercentOfEquity: 0.25', 'riskPercentOfEquity: 0.3'),
    );
    expect(loadAstraConfig(dir).hash).not.toBe(a);
  });

  it('rejects unknown references', () => {
    const dir = copyConfig();
    const f = join(dir, 'accounts/paper-demo.yaml');
    writeFileSync(
      f,
      readFileSync(f, 'utf8').replace(
        'riskPolicyId: template-conservative',
        'riskPolicyId: missing-policy',
      ),
    );
    expectIssue(dir, /unknown risk policy missing-policy/);
  });

  it('rejects embedded secrets', () => {
    const dir = copyConfig();
    const f = join(dir, 'accounts/paper-demo.yaml');
    writeFileSync(
      f,
      readFileSync(f, 'utf8').replace(
        'accountRef: PAPER-DEMO-1',
        'accountRef: PAPER-DEMO-1\n  apiKey: sk-live-123',
      ),
    );
    expectIssue(dir, /looks like an embedded secret/);
  });

  it('accepts credential references by env-var name', () => {
    const dir = copyConfig();
    const f = join(dir, 'accounts/paper-demo.yaml');
    writeFileSync(
      f,
      readFileSync(f, 'utf8').replace(
        'accountRef: PAPER-DEMO-1',
        'accountRef: PAPER-DEMO-1\n  credentialsEnv: BROKER_DEMO_TOKEN',
      ),
    );
    expect(() => loadAstraConfig(dir)).not.toThrow();
  });

  it('rejects ids that do not match file names and schema violations', () => {
    const dir = copyConfig();
    const f = join(dir, 'instruments/NQ.yaml');
    writeFileSync(f, readFileSync(f, 'utf8').replace('tickValue: 5.00', 'tickValue: -5'));
    writeFileSync(
      join(dir, 'instruments/ES.yaml'),
      readFileSync(join(dir, 'instruments/MNQ.yaml'), 'utf8'),
    );
    expectIssue(dir, /tickValue/);
    expectIssue(dir, /must match the file name "ES"/);
  });

  it('rejects a trailing lock on a static drawdown', () => {
    const dir = copyConfig();
    const f = join(dir, 'prop-firm-profiles/template-static-50k.yaml');
    writeFileSync(
      f,
      readFileSync(f, 'utf8').replace(
        'trailingStopsAt: { kind: NEVER }',
        'trailingStopsAt: { kind: INITIAL_BALANCE }',
      ),
    );
    expectIssue(dir, /STATIC drawdown cannot have a trailing stop level/);
  });

  it('rejects duplicate YAML keys', () => {
    const dir = copyConfig();
    const f = join(dir, 'strategies/paper-pipeline-test.yaml');
    writeFileSync(f, readFileSync(f, 'utf8') + '\nstatus: DISABLED\n');
    expectIssue(dir, /cannot parse YAML/);
  });

  it('refuses a missing astra.yaml', () => {
    const dir = copyConfig();
    rmSync(join(dir, 'astra.yaml'));
    expect(() => loadAstraConfig(dir)).toThrow(ConfigError);
  });
});

describe('canonicalJson', () => {
  it('sorts keys recursively', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [{ f: 1, e: 2 }] } })).toBe(
      '{"a":{"c":[{"e":2,"f":1}],"d":2},"b":1}',
    );
  });
});
