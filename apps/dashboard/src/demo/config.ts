/**
 * Demo configuration: the repository's real config/ YAML files, bundled at build time and
 * validated with the same schemas the server uses. Nothing here is invented for the demo.
 */
import { SystemConfigSchema, type SystemConfig } from '@astra/config/system';
import {
  AccountDefinitionSchema,
  InstrumentSpecSchema,
  StrategyDefinitionSchema,
  canonicalJson,
  type AccountDefinition,
  type InstrumentSpec,
  type StrategyDefinition,
} from '@astra/core';
import { PropFirmRuleProfileSchema, type PropFirmRuleProfile } from '@astra/prop-firm';
import { RiskPolicySchema, type RiskPolicy } from '@astra/risk';
import { parse } from 'yaml';
import type { z } from 'zod';

const RAW = import.meta.glob('../../../../config/**/*.yaml', {
  query: '?raw',
  import: 'default',
  eager: true,
});

export interface DemoConfig {
  readonly system: SystemConfig;
  readonly profiles: ReadonlyMap<string, PropFirmRuleProfile>;
  readonly riskPolicies: ReadonlyMap<string, RiskPolicy>;
  readonly instruments: ReadonlyMap<string, InstrumentSpec>;
  readonly strategies: ReadonlyMap<string, StrategyDefinition>;
  readonly accounts: ReadonlyMap<string, AccountDefinition>;
  readonly hash: string;
  readonly warnings: readonly string[];
}

function collection<T>(dir: string, schema: z.ZodType<T>, id: (t: T) => string): Map<string, T> {
  const out = new Map<string, T>();
  for (const [path, text] of Object.entries(RAW)) {
    if (!path.includes(`/config/${dir}/`)) continue;
    const parsed = schema.safeParse(parse(text));
    if (!parsed.success)
      throw new Error(`${path}: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
    out.set(id(parsed.data), parsed.data);
  }
  return out;
}

/** FNV-1a (64-bit) — a short, synchronous identifier for the bundled configuration. */
function fnv1a64(text: string): string {
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i++) {
    h ^= BigInt(text.charCodeAt(i));
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, '0');
}

export function loadDemoConfig(): DemoConfig {
  const systemEntry = Object.entries(RAW).find(([p]) => p.endsWith('/config/astra.yaml'));
  if (!systemEntry) throw new Error('config/astra.yaml not bundled');
  const system = SystemConfigSchema.parse(parse(systemEntry[1]));
  const profiles = collection('prop-firm-profiles', PropFirmRuleProfileSchema, (p) => p.id);
  const riskPolicies = collection('risk-policies', RiskPolicySchema, (p) => p.id);
  const instruments = collection('instruments', InstrumentSpecSchema, (i) => i.symbol);
  const strategies = collection('strategies', StrategyDefinitionSchema, (s) => s.id);
  const accounts = collection('accounts', AccountDefinitionSchema, (a) => a.id);
  const warnings = [
    ...[...strategies.values()]
      .filter((s) => s.ownership === 'TEMPLATE')
      .map((s) => `strategy ${s.id} is a TEMPLATE (not the owner's strategy); blocked in LIVE`),
    ...[...profiles.values()]
      .filter((p) => p.verification.status !== 'USER_VERIFIED')
      .map((p) => `prop-firm profile ${p.id} is UNVERIFIED; blocked in LIVE`),
    ...[...instruments.values()]
      .filter((i) => i.verification.status !== 'USER_VERIFIED')
      .map((i) => `instrument ${i.symbol} spec is UNVERIFIED; blocked in LIVE`),
    ...[...riskPolicies.values()]
      .filter((r) => r.ownership === 'TEMPLATE')
      .map((r) => `risk policy ${r.id} is a TEMPLATE; blocked in LIVE`),
  ];
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
    hash: `demo:${fnv1a64(canonical)}`,
    warnings,
  };
}
