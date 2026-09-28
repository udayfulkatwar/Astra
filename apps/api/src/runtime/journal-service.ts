/**
 * Trade journal (Phase 8): tracks the excursions of open positions from every quote and, when the
 * broker reports a close, records one append-only journal entry linking the decision, the order,
 * the fill, the exit and the observed excursions (@astra/journal). A failure to journal never
 * disturbs account sync or trading; it is logged and raised as an event.
 */
import type { CalendarService } from '@astra/calendar';
import type { AstraConfig } from '@astra/config';
import { errorMessage, tradingDayWindow, type Clock, type Quote } from '@astra/core';
import type {
  ClosedTradeRecord,
  DecisionRepository,
  ExecutionRepository,
  JournalRepository,
} from '@astra/db';
import {
  ExcursionTracker,
  buildJournalEntry,
  tradeContext,
  type JournalEntry,
} from '@astra/journal';
import type { AccountMonitorView } from '@astra/risk';
import type { Logger } from 'pino';
import type { EventBus } from './event-bus';

export class JournalService {
  private readonly tracker = new ExcursionTracker();

  constructor(
    private readonly deps: {
      config: AstraConfig;
      clock: Clock;
      repo: JournalRepository;
      orders: ExecutionRepository;
      decisions: DecisionRepository;
      calendar: CalendarService;
      events: EventBus;
      log: Logger;
      /** Called once per newly journaled trade (e.g. automatic AI review); must not reject. */
      onJournaled?: (entry: JournalEntry) => Promise<void>;
    },
  ) {}

  onQuote(quote: Quote): void {
    this.tracker.onQuote(quote);
  }

  /** Registers the open positions of the latest monitor pass (and forgets vanished ones). */
  syncOpen(views: readonly AccountMonitorView[]): void {
    const open = views.flatMap((v) =>
      v.positions.map((p) => ({
        accountId: v.accountId,
        positionId: p.positionId,
        symbol: p.symbol,
        direction: p.direction,
        entryPrice: p.entryPrice,
        openedAt: p.openedAt,
      })),
    );
    // Accounts that could not be evaluated keep their tracked positions (not known to be closed).
    const known = new Set(views.filter((v) => v.status === 'OK').map((v) => v.accountId));
    this.tracker.sync(open, this.deps.clock.now());
    this.tracker.prune(open, (accountId) => !known.has(accountId));
  }

  async recordClosed(accountId: string, t: ClosedTradeRecord): Promise<void> {
    try {
      const order = t.clientOrderId
        ? await this.deps.orders.orderByClientId(t.clientOrderId)
        : null;
      const detail = order ? await this.deps.decisions.get(order.decisionId) : null;
      const { config } = this.deps;
      const account = config.accounts.get(accountId);
      const profile = account && config.profiles.get(account.propFirmProfileId);
      const context = profile
        ? tradeContext({
            signal: detail?.inputs.candidate.signal ?? null,
            symbol: t.symbol,
            eventCurrencies: config.instruments.get(t.symbol)?.eventCurrencies,
            entryAt: t.openedAt,
            exitAt: t.closedAt,
            day: tradingDayWindow(new Date(t.openedAt), profile.tradingDayReset),
            // The calendar the decision saw, then the one known now.
            calendars: [detail?.inputs.calendar ?? null, this.deps.calendar.current()],
          })
        : undefined;
      const entry = buildJournalEntry({
        trade: {
          positionId: t.id,
          accountId,
          clientOrderId: t.clientOrderId,
          symbol: t.symbol,
          direction: t.direction,
          quantity: t.quantity,
          entryPrice: t.entryPrice,
          exitPrice: t.exitPrice,
          exitReason: t.exitReason,
          realizedPnl: t.realizedPnl,
          openedAt: t.openedAt,
          closedAt: t.closedAt,
        },
        order: order
          ? {
              decisionId: order.decisionId,
              strategyId: order.strategyId,
              signalId: order.signalId,
              mode: order.mode,
              plannedEntry: order.plannedEntry,
              stopLoss: order.stopLoss,
              takeProfit: order.takeProfit,
              quantity: order.quantity,
            }
          : null,
        decision: detail
          ? {
              decidedAt: detail.decision.decidedAt,
              configHash: detail.decision.configHash,
              plannedRisk: detail.decision.sizing?.dollarRisk ?? null,
            }
          : null,
        spec: this.deps.config.instruments.get(t.symbol),
        excursion: this.tracker.take(t.id),
        context,
      });
      const isNew = await this.deps.repo.record(entry, this.deps.clock.now().toISOString());
      if (!isNew) return;
      const r = entry.result;
      await this.deps.events.emit({
        level: 'INFO',
        component: 'journal',
        type: 'TRADE_JOURNALED',
        message: `${entry.symbol} ${entry.direction} ${entry.quantity}: ${r.outcome} ${r.netPnl ?? r.grossPnl}${r.rMultiple === null ? '' : ` (${r.rMultiple} R)`} — exit ${entry.exit.reason}`,
        accountId,
        data: { tradeId: entry.tradeId, outcome: r.outcome, rMultiple: r.rMultiple },
      });
      // Not awaited: a slow follow-up (an AI call) never holds up account sync.
      if (this.deps.onJournaled) void this.deps.onJournaled(entry);
    } catch (err) {
      this.deps.log.error({ err: errorMessage(err), trade: t.id }, 'trade journal entry failed');
      await this.deps.events.emit({
        level: 'ERROR',
        component: 'journal',
        type: 'JOURNAL_FAILED',
        message: `could not journal trade ${t.id}: ${errorMessage(err)}`,
        accountId,
      });
    }
  }
}
