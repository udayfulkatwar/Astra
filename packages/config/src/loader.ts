/**
 * Configuration loader (ADR-0006). Reads config/ YAML, validates every entity with its schema,
 * cross-checks references, refuses anything that looks like an embedded secret, and hashes the
 * canonical result so every decision can be traced to the exact configuration in force.
 *
 * Any problem → ConfigError listing every issue. The service refuses to start on invalid config
 * rather than running with a partially valid one.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import {
  AccountDefinitionSchema,
  AstraError,
  InstrumentSpecSchema,
  StrategyDefinitionSchema,
  canonicalJson,
  type AccountDefinition,
  type InstrumentSpec,
  type StrategyDefinition,
} from '@astra/core';
import { PropFirmRuleProfileSchema, type PropFirmRuleProfile } from '@astra/prop-firm';
import { RiskPolicySchema, type RiskPolicy } from '@astra/risk';
import { sha256 } from '@astra/core/node';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

import { SystemConfigSchema, type SystemConfig } from './system';

export interface AstraConfig {
  readonly system: SystemConfig;
  readonly profiles: ReadonlyMap<string, PropFirmRuleProfile>;
  readonly riskPolicies: ReadonlyMap<string, RiskPolicy>;
  readonly instruments: ReadonlyMap<string, InstrumentSpec>;
  readonly strategies: ReadonlyMap<string, StrategyDefinition>;
  readonly accounts: ReadonlyMap<string, AccountDefinition>;
  /** SHA-256 of the canonical JSON of everything above. */
  readonly hash: string;
  /** Canonical JSON (stored in config_versions for audit). */
  readonly canonical: string;
  /** Non-fatal observations (templates, unverified items). */
  readonly warnings: readonly string[];
}

export class ConfigError extends AstraError {
  readonly issues: readonly string[];
  constructor(issues: readonly string[]) {
    super('CONFIG_INVALID', `invalid configuration:\n  - ${issues.join('\n  - ')}`, { issues });
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

const COLLECTIONS = {
  profiles: 'prop-firm-profiles',
  riskPolicies: 'risk-policies',
  instruments: 'instruments',
  strategies: 'strategies',
  accounts: 'accounts',
} as const;

/** Keys whose presence with a literal value indicates a secret committed to config. */
const SECRET_KEY =
  /(password|passwd|secret|token|api[_-]?key|private[_-]?key|credential)(?!s?Env$)/i;

function findSecrets(value: unknown, path: string[] = []): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => findSecrets(v, [...path, String(i)]));
  if (value !== null && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => {
      const p = [...path, k];
      if (SECRET_KEY.test(k) && typeof v === 'string' && v.length > 0) {
        return [
          `${p.join('.')} looks like an embedded secret; reference an environment variable name instead (e.g. credentialsEnv)`,
        ];
      }
      return findSecrets(v, p);
    });
  }
  return [];
}

function readYamlFile(file: string, issues: string[]): unknown {
  try {
    return parseYaml(readFileSync(file, 'utf8'), { uniqueKeys: true });
  } catch (err) {
    issues.push(`${file}: cannot parse YAML (${err instanceof Error ? err.message : String(err)})`);
    return undefined;
  }
}

function yamlFiles(dir: string): string[] {
  try {
    if (!statSync(dir).isDirectory()) return [];
  } catch {
    return [];
  }
  return readdirSync(dir)
    .filter((f) => ['.yaml', '.yml'].includes(extname(f)))
    .sort()
    .map((f) => join(dir, f));
}

function loadCollection<T>(
  dir: string,
  schema: z.ZodType<T>,
  idOf: (item: T) => string,
  issues: string[],
): Map<string, T> {
  const out = new Map<string, T>();
  for (const file of yamlFiles(dir)) {
    const raw = readYamlFile(file, issues);
    if (raw === undefined) continue;
    for (const s of findSecrets(raw)) issues.push(`${file}: ${s}`);
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      issues.push(`${file}: ${z.prettifyError(parsed.error).replace(/\n/g, '; ')}`);
      continue;
    }
    const id = idOf(parsed.data);
    const expected = basename(file, extname(file));
    if (id !== expected) issues.push(`${file}: id "${id}" must match the file name "${expected}"`);
    if (out.has(id)) issues.push(`${file}: duplicate id "${id}"`);
    out.set(id, parsed.data);
  }
  return out;
}

export function loadAstraConfig(configDir: string): AstraConfig {
  const issues: string[] = [];
  const warnings: string[] = [];

  const systemFile = join(configDir, 'astra.yaml');
  const rawSystem = readYamlFile(systemFile, issues);
  let system: SystemConfig | undefined;
  if (rawSystem !== undefined) {
    for (const s of findSecrets(rawSystem)) issues.push(`${systemFile}: ${s}`);
    const parsed = SystemConfigSchema.safeParse(rawSystem);
    if (parsed.success) system = parsed.data;
    else issues.push(`${systemFile}: ${z.prettifyError(parsed.error).replace(/\n/g, '; ')}`);
  }

  const profiles = loadCollection(
    join(configDir, COLLECTIONS.profiles),
    PropFirmRuleProfileSchema,
    (p) => p.id,
    issues,
  );
  const riskPolicies = loadCollection(
    join(configDir, COLLECTIONS.riskPolicies),
    RiskPolicySchema,
    (p) => p.id,
    issues,
  );
  const instruments = loadCollection(
    join(configDir, COLLECTIONS.instruments),
    InstrumentSpecSchema,
    (i) => i.symbol,
    issues,
  );
  const strategies = loadCollection(
    join(configDir, COLLECTIONS.strategies),
    StrategyDefinitionSchema,
    (s) => s.id,
    issues,
  );
  const accounts = loadCollection(
    join(configDir, COLLECTIONS.accounts),
    AccountDefinitionSchema,
    (a) => a.id,
    issues,
  );

  // Cross-references.
  for (const s of strategies.values()) {
    for (const sym of s.instruments) {
      if (!instruments.has(sym)) issues.push(`strategy ${s.id}: unknown instrument ${sym}`);
    }
    for (const id of s.sessions ?? []) {
      if (!system?.sessions.some((x) => x.id === id))
        issues.push(`strategy ${s.id}: unknown session ${id}`);
    }
    if (s.ownership === 'TEMPLATE')
      warnings.push(`strategy ${s.id} is a TEMPLATE (not the owner's strategy); blocked in LIVE`);
  }
  for (const a of accounts.values()) {
    const profile = profiles.get(a.propFirmProfileId);
    if (!profile) issues.push(`account ${a.id}: unknown prop-firm profile ${a.propFirmProfileId}`);
    else if (profile.currency !== a.currency) {
      issues.push(
        `account ${a.id}: currency ${a.currency} differs from profile ${profile.id} currency ${profile.currency}`,
      );
    }
    if (!riskPolicies.has(a.riskPolicyId))
      issues.push(`account ${a.id}: unknown risk policy ${a.riskPolicyId}`);
    for (const s of a.strategies)
      if (!strategies.has(s)) issues.push(`account ${a.id}: unknown strategy ${s}`);
    for (const sym of a.instruments)
      if (!instruments.has(sym)) issues.push(`account ${a.id}: unknown instrument ${sym}`);
    if (a.liveTradingAuthorized) warnings.push(`account ${a.id} has liveTradingAuthorized=true`);
  }
  for (const p of profiles.values()) {
    if (p.verification.status !== 'USER_VERIFIED')
      warnings.push(`prop-firm profile ${p.id} is UNVERIFIED; blocked in LIVE`);
  }
  for (const i of instruments.values()) {
    if (i.verification.status !== 'USER_VERIFIED')
      warnings.push(`instrument ${i.symbol} spec is UNVERIFIED; blocked in LIVE`);
  }
  for (const r of riskPolicies.values()) {
    if (r.ownership === 'TEMPLATE')
      warnings.push(`risk policy ${r.id} is a TEMPLATE; blocked in LIVE`);
  }
  for (const sym of Object.keys(system?.news?.instrumentKeywords ?? {}))
    if (!instruments.has(sym))
      issues.push(`astra.yaml news.instrumentKeywords: unknown instrument ${sym}`);
  const ai = system?.ai;
  if (ai) {
    for (const [task, route] of Object.entries(ai.routes)) {
      if (!ai.prices[route.model])
        issues.push(`astra.yaml ai.routes.${task}: no price for model ${route.model} in ai.prices`);
      if (route.provider === 'anthropic' && !ai.providers.anthropic)
        issues.push(`astra.yaml ai.routes.${task}: provider anthropic is not configured`);
    }
  }

  if (issues.length > 0 || !system)
    throw new ConfigError(issues.length > 0 ? issues : ['astra.yaml missing']);

  const canonical = canonicalJson({
    system,
    profiles: Object.fromEntries(profiles),
    riskPolicies: Object.fromEntries(riskPolicies),
    instruments: Object.fromEntries(instruments),
    strategies: Object.fromEntries(strategies),
    accounts: Object.fromEntries(accounts),
  });
  return {
    system,
    profiles,
    riskPolicies,
    instruments,
    strategies,
    accounts,
    hash: sha256(canonical),
    canonical,
    warnings,
  };
}
