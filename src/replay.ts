import { FeatureEngine } from "./features";
import { TIMEOUT_MS } from "./jev";
import { limits, PaperBroker } from "./paper";
import { eventSchema, predictionSchema, type Book, type Predictor } from "./types";

export type Audit = (record: Record<string, unknown>) => void;

export async function replay(events: Iterable<unknown> | AsyncIterable<unknown>, predict: Predictor, audit: Audit) {
  const features = new FeatureEngine();
  const broker = new PaperBroker();
  let market: string | undefined;
  let previousTime = -1;
  let nextDecision = 0;
  let book: Book | undefined;
  let decisions = 0;
  let pending: { id: number; timestampMs: number; mid: number }[] = [];
  for await (const raw of events) {
    const event = eventSchema.parse(raw);
    if (market && market !== event.market) throw new Error("Replay requires a single market");
    if (event.timestampMs < previousTime) throw new Error("Events must be chronological");
    market = event.market;
    previousTime = event.timestampMs;
    audit({ type: "market", event });
    if (book && event.timestampMs - book.timestampMs > 1_000 && broker.order) {
      audit({ type: "cancelled", reason: "stale book", order: broker.order });
      broker.order = null;
    }
    const expired = broker.expire(event.timestampMs);
    if (expired) audit({ type: "expired", order: expired, timestampMs: event.timestampMs });
    if (event.type === "trade") {
      features.trade(event);
      // No fills on a stale book; cancel any resting order instead.
      if (!book || event.timestampMs - book.timestampMs > 1_000) {
        if (broker.order) audit({ type: "cancelled", reason: "stale book", order: broker.order });
        broker.order = null;
        continue;
      }
      const fill = broker.trade(event);
      if (fill) {
        broker.mark((book.bid + book.ask) / 2);
        audit({ type: "fill", ...fill, cash: broker.cash, position: broker.position });
      }
      continue;
    }
    book = event;
    const state = features.book(book);
    broker.mark(state.mid);
    for (const decision of pending.filter((p) => event.timestampMs >= p.timestampMs + 60_000)) {
      audit({ type: "outcome", decisionId: decision.id, timestampMs: event.timestampMs,
        horizonDelayMs: event.timestampMs - decision.timestampMs - 60_000,
        futureMid: state.mid, returnBps: (state.mid / decision.mid - 1) * 10_000 });
    }
    pending = pending.filter((p) => event.timestampMs < p.timestampMs + 60_000);
    if (event.timestampMs < nextDecision) continue;
    nextDecision = event.timestampMs + 5_000;
    decisions++;
    let action: "buy" | "sell" | "hold" = "hold";
    let reason = "warming up";
    let evaluation;
    if (state.observations >= 5) {
      try {
        evaluation = await predict(state);
        const p = predictionSchema.parse(evaluation.prediction);
        if (!Number.isFinite(evaluation.latencyMs) || evaluation.latencyMs < 0 || evaluation.latencyMs > TIMEOUT_MS) reason = "decision arrived too late";
        else if (p.choice === "hold") reason = "model hold";
        else if (p.probabilities[p.choice] < 0.65 || p.confidence < 0.55) reason = "below probability/confidence threshold";
        else { action = p.choice; reason = "model gates passed"; }
      } catch {
        // Do not persist provider error bodies, which may contain sensitive data.
        reason = "prediction failed or invalid response";
      }
    }
    if (action === "hold" && broker.order) {
      audit({ type: "cancelled", reason, order: broker.order });
      broker.order = null;
    }
    const riskReason = broker.place(action, book, evaluation?.latencyMs ?? 0);
    audit({ type: "decision", id: decisions, state, evaluation: evaluation ?? null,
      proposedAction: action, action: riskReason === "order placed" ? action : "hold",
      reason, riskReason, order: broker.order ? { ...broker.order } : null });
    pending.push({ id: decisions, timestampMs: event.timestampMs, mid: state.mid });
  }
  if (!book) throw new Error("Replay requires at least one book event");
  if (broker.order) audit({ type: "cancelled", reason: "end of replay", order: broker.order });
  broker.order = null;
  const summary = { market, decisions, fills: broker.fills, cash: broker.cash, position: broker.position,
    equity: broker.equity((book.bid + book.ask) / 2),
    netPnl: broker.equity((book.bid + book.ask) / 2) - limits.initialCash,
    fees: broker.fees, maxDrawdown: broker.maxDrawdown, halted: broker.halted,
    unlabelledDecisions: pending.length };
  audit({ type: "summary", ...summary });
  return summary;
}
