/**
 * Deterministic news classification (CONTEXT): category, impact and affected instruments, with
 * the rules that fired listed on every item so a human can see why. These rules are ASTRA's
 * generic DEFAULTS (ADR-0019), not trading rules; AI classification (Phase 6) may later add to
 * them but never lower an impact.
 *
 * Conservative by construction: impact is the highest of the provider's rating, the matching
 * rules and an escalation ("breaking", "emergency", …); a HIGH-impact item whose relevance cannot
 * be determined affects every instrument. Sentiment is only ever the provider's — never guessed
 * from keywords.
 */
import type { DataSourceKind } from '@astra/core';
import type { NewsImpact, NewsItem, SentimentLabel } from './item';

export const NEWS_CATEGORIES = [
  'MACRO',
  'CENTRAL_BANK',
  'INFLATION',
  'EMPLOYMENT',
  'GEOPOLITICS',
  'BANKING',
  'ENERGY',
  'COMMODITIES',
  'CRYPTO',
  'EQUITIES',
  'CORPORATE',
  'REGULATORY',
  'MARKET_STRUCTURE',
  'OTHER',
] as const;
export type NewsCategory = (typeof NEWS_CATEGORIES)[number];

export const CLASSIFIER_VERSION = 'rules-v1';

interface Rule {
  readonly id: string;
  readonly category: NewsCategory;
  readonly impact: NewsImpact;
  readonly pattern: RegExp;
  /** Currencies the rule implies (e.g. a named central bank). */
  readonly currencies?: readonly string[];
}

const w = (words: string) => new RegExp(`\\b(?:${words})\\b`, 'i');

/** Ordered: for equal impact the earlier rule names the category. */
export const DEFAULT_NEWS_RULES: readonly Rule[] = [
  {
    id: 'central-bank-emergency',
    category: 'CENTRAL_BANK',
    impact: 'HIGH',
    pattern: w('emergency (?:rate|meeting|cut|hike)|intermeeting|unscheduled (?:rate|meeting)'),
  },
  {
    id: 'market-disruption',
    category: 'MARKET_STRUCTURE',
    impact: 'HIGH',
    pattern: w(
      'trading halt|halted trading|circuit breakers?|flash crash|exchange outage|market closure|limit down|limit up',
    ),
  },
  {
    id: 'armed-conflict',
    category: 'GEOPOLITICS',
    impact: 'HIGH',
    pattern: w(
      '(?<!(?:trade|price|bidding|currency|talent) )war|invasion|invades?|missiles?|air ?strikes?|military (?:strike|attack)|terror(?:ist)? attack|nuclear (?:strike|attack|test|threat)',
    ),
  },
  {
    id: 'banking-stress',
    category: 'BANKING',
    impact: 'HIGH',
    pattern: w(
      'bank (?:failure|collapse|run|rescue|bailout)|bailout|insolven(?:t|cy)|default(?:s|ed)? on|liquidity crisis|contagion',
    ),
  },
  {
    id: 'fed',
    category: 'CENTRAL_BANK',
    impact: 'MEDIUM',
    pattern: w('fed|fomc|federal reserve|powell'),
    currencies: ['USD'],
  },
  {
    id: 'ecb',
    category: 'CENTRAL_BANK',
    impact: 'MEDIUM',
    pattern: w('ecb|european central bank|lagarde'),
    currencies: ['EUR'],
  },
  {
    id: 'boe',
    category: 'CENTRAL_BANK',
    impact: 'MEDIUM',
    pattern: w('boe|bank of england'),
    currencies: ['GBP'],
  },
  {
    id: 'boj',
    category: 'CENTRAL_BANK',
    impact: 'MEDIUM',
    pattern: w('boj|bank of japan'),
    currencies: ['JPY'],
  },
  {
    id: 'central-bank',
    category: 'CENTRAL_BANK',
    impact: 'MEDIUM',
    pattern: w(
      'central bank|monetary policy|rate (?:decision|hike|cut|increase|reduction)s?|(?:raises|cuts|holds) rates',
    ),
  },
  {
    id: 'inflation',
    category: 'INFLATION',
    impact: 'MEDIUM',
    pattern: w('cpi|inflation|pce|ppi|consumer prices|producer prices'),
  },
  {
    id: 'employment',
    category: 'EMPLOYMENT',
    impact: 'MEDIUM',
    pattern: w('payrolls|nfp|jobless claims|unemployment|jobs report|labou?r market'),
  },
  {
    id: 'growth',
    category: 'MACRO',
    impact: 'MEDIUM',
    pattern: w('gdp|retail sales|pmi|recession|industrial production|consumer confidence'),
  },
  {
    id: 'trade-policy',
    category: 'MACRO',
    impact: 'MEDIUM',
    pattern: w('tariffs?|trade war|export controls?|embargo'),
  },
  {
    id: 'geopolitical-tension',
    category: 'GEOPOLITICS',
    impact: 'MEDIUM',
    pattern: w('sanctions?|ceasefire|coup|border (?:clash|tension)s?'),
  },
  { id: 'opec', category: 'ENERGY', impact: 'MEDIUM', pattern: w('opec\\+?') },
  {
    id: 'energy',
    category: 'ENERGY',
    impact: 'LOW',
    pattern: w('oil|crude|brent|wti|natural gas|lng'),
  },
  {
    id: 'metals',
    category: 'COMMODITIES',
    impact: 'LOW',
    pattern: w('gold|bullion|silver|copper|precious metals?'),
  },
  {
    id: 'crypto',
    category: 'CRYPTO',
    impact: 'LOW',
    pattern: w('bitcoin|crypto(?:currency|currencies)?|ethereum|stablecoins?'),
  },
  {
    id: 'equities',
    category: 'EQUITIES',
    impact: 'LOW',
    pattern: w('stocks?|equities|shares|nasdaq|s&p ?500|dow jones|wall street|index futures'),
  },
  {
    id: 'corporate',
    category: 'CORPORATE',
    impact: 'LOW',
    pattern: w('earnings|guidance|profit warning|mergers?|acquisitions?|takeover|ipo|ceo|layoffs?'),
  },
  {
    id: 'regulatory',
    category: 'REGULATORY',
    impact: 'LOW',
    pattern: w('sec|regulators?|regulation|antitrust|lawsuit|probe|investigation'),
  },
  { id: 'banking', category: 'BANKING', impact: 'LOW', pattern: w('banks?|lenders?') },
];

/** Words that raise a matched impact by one level. */
const ESCALATION = w('breaking|urgent|emergency|surprise|unexpected(?:ly)?|shock');

/** Country names in text → currency (case-sensitive where the word is also common English). */
const TEXT_CURRENCIES: readonly { pattern: RegExp; currency: string }[] = [
  {
    pattern: /\b(?:US|U\.S\.|USA)\b|\b(?:united states|american|treasur(?:y|ies))\b/i,
    currency: 'USD',
  },
  {
    pattern: /\b(?:euro ?zone|european union|germany|german|france|french|italy|italian)\b/i,
    currency: 'EUR',
  },
  { pattern: /\b(?:UK|U\.K\.)\b|\b(?:britain|british|england)\b/i, currency: 'GBP' },
  { pattern: /\b(?:japan|japanese|tokyo)\b/i, currency: 'JPY' },
  { pattern: /\b(?:china|chinese|beijing)\b/i, currency: 'CNY' },
  { pattern: /\b(?:canada|canadian)\b/i, currency: 'CAD' },
  { pattern: /\b(?:australia|australian)\b/i, currency: 'AUD' },
  { pattern: /\b(?:switzerland|swiss)\b/i, currency: 'CHF' },
];

const COUNTRY_CURRENCY: Readonly<Record<string, string>> = {
  US: 'USD',
  GB: 'GBP',
  JP: 'JPY',
  CN: 'CNY',
  CA: 'CAD',
  AU: 'AUD',
  NZ: 'NZD',
  CH: 'CHF',
  DE: 'EUR',
  FR: 'EUR',
  IT: 'EUR',
  ES: 'EUR',
  NL: 'EUR',
  BE: 'EUR',
  AT: 'EUR',
  PT: 'EUR',
  IE: 'EUR',
  FI: 'EUR',
  GR: 'EUR',
  EU: 'EUR',
};

const LEVEL: Record<NewsImpact, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 };
const BY_LEVEL: readonly NewsImpact[] = ['LOW', 'MEDIUM', 'HIGH'];

export type RelevanceBasis =
  /** The provider tagged the instrument. */
  | 'PROVIDER_SYMBOL'
  /** A currency of the item is one the instrument reacts to. */
  | 'CURRENCY'
  /** The item has a currency and the instrument's currencies are not configured (fail-safe). */
  | 'CURRENCY_UNMAPPED'
  /** One of the instrument's news keywords appears in the item. */
  | 'KEYWORD'
  /** HIGH impact with no determinable relevance: affects every instrument (fail-safe). */
  | 'UNKNOWN_RELEVANCE';

export interface InstrumentNewsProfile {
  /** Currencies the instrument reacts to (the instrument's `eventCurrencies`); unset = all. */
  readonly eventCurrencies?: readonly string[] | undefined;
  /** Words that tie a headline to the instrument (config `news.instrumentKeywords`). */
  readonly keywords?: readonly string[] | undefined;
}

export interface ClassifiedNews {
  /** `${source}:${item.id}` — unique across sources. */
  readonly key: string;
  readonly source: string;
  readonly sourceKind: DataSourceKind;
  readonly receivedAt: string;
  readonly item: NewsItem;
  readonly category: NewsCategory;
  readonly impact: NewsImpact;
  /** Currencies from the provider's tags, its countries and country names in the text. */
  readonly currencies: string[];
  readonly affected: { readonly symbol: string; readonly basis: RelevanceBasis }[];
  /** The provider's sentiment only; null when it gave none. */
  readonly sentiment: {
    readonly label: SentimentLabel;
    readonly confidence: number;
    readonly source: 'PROVIDER';
  } | null;
  /** Why: rule ids that matched, `provider-impact:<level>`, `escalated`. */
  readonly basis: string[];
  readonly classifier: string;
}

function keywordPattern(words: readonly string[]): RegExp | null {
  const cleaned = words
    .map((k) => k.trim())
    .filter((k) => k.length > 0)
    .map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return cleaned.length ? new RegExp(`\\b(?:${cleaned.join('|')})\\b`, 'i') : null;
}

/** Classifies one item against the configured instruments. Pure and deterministic. */
export function classifyNews(input: {
  readonly item: NewsItem;
  readonly source: string;
  readonly sourceKind: DataSourceKind;
  readonly receivedAt: string;
  readonly instruments: ReadonlyMap<string, InstrumentNewsProfile>;
  readonly rules?: readonly Rule[];
}): ClassifiedNews {
  const { item } = input;
  const text = `${item.headline}\n${item.summary ?? ''}`;
  const rules = input.rules ?? DEFAULT_NEWS_RULES;
  const matched = rules.filter((r) => r.pattern.test(text));
  const basis = matched.map((r) => r.id);

  let level = -1;
  let category: NewsCategory = 'OTHER';
  for (const r of matched) {
    if (LEVEL[r.impact] > level) {
      level = LEVEL[r.impact];
      category = r.category;
    }
  }
  if (item.providerImpact) {
    basis.push(`provider-impact:${item.providerImpact}`);
    level = Math.max(level, LEVEL[item.providerImpact]);
  }
  if (level < 0) level = LEVEL.LOW; // no rule matched and no provider rating
  if (ESCALATION.test(text) && (matched.length > 0 || item.providerImpact)) {
    level = Math.min(LEVEL.HIGH, level + 1);
    basis.push('escalated');
  }
  const impact = BY_LEVEL[level]!;

  const currencies = new Set<string>(item.currencies ?? []);
  for (const c of item.countries ?? []) {
    const cur = COUNTRY_CURRENCY[c];
    if (cur) currencies.add(cur);
  }
  for (const t of TEXT_CURRENCIES) if (t.pattern.test(text)) currencies.add(t.currency);
  for (const r of matched) for (const c of r.currencies ?? []) currencies.add(c);

  const affected: ClassifiedNews['affected'] = [];
  for (const [symbol, profile] of input.instruments) {
    if (item.symbols?.includes(symbol)) {
      affected.push({ symbol, basis: 'PROVIDER_SYMBOL' });
      continue;
    }
    const kw = keywordPattern(profile.keywords ?? []);
    if (kw?.test(text)) {
      affected.push({ symbol, basis: 'KEYWORD' });
      continue;
    }
    if (currencies.size > 0) {
      if (profile.eventCurrencies === undefined) {
        affected.push({ symbol, basis: 'CURRENCY_UNMAPPED' });
        continue;
      }
      if (profile.eventCurrencies.some((c) => currencies.has(c))) {
        affected.push({ symbol, basis: 'CURRENCY' });
        continue;
      }
    }
  }
  const relevanceKnown =
    currencies.size > 0 || (item.symbols?.length ?? 0) > 0 || affected.length > 0;
  if (impact === 'HIGH' && !relevanceKnown) {
    for (const symbol of input.instruments.keys())
      affected.push({ symbol, basis: 'UNKNOWN_RELEVANCE' });
  }

  return {
    key: `${input.source}:${item.id}`,
    source: input.source,
    sourceKind: input.sourceKind,
    receivedAt: input.receivedAt,
    item,
    category,
    impact,
    currencies: [...currencies].sort(),
    affected: affected.sort((a, b) => a.symbol.localeCompare(b.symbol)),
    sentiment: item.providerSentiment ? { ...item.providerSentiment, source: 'PROVIDER' } : null,
    basis,
    classifier: CLASSIFIER_VERSION,
  };
}
