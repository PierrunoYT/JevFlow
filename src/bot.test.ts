import { describe, expect, test } from "bun:test";
import { FeatureEngine } from "./features";
import { createJevPredictor, imbalanceBaseline } from "./jev";
import { PaperBroker } from "./paper";
import { replay } from "./replay";
import { eventSchema, predictionSchema, type Book, type Evaluation, type Predictor, type Trade } from "./types";

const book = (timestampMs = 0): Book => ({ type: "book", market: "TEST-USD", timestampMs,
  bid: 100, ask: 100.04, bidSize: 7, askSize: 3 });
const trade = (timestampMs = 1, overrides: Partial<Trade> = {}): Trade => ({
  type: "trade", market: "TEST-USD", timestampMs, price: 99.99, size: 0.3, side: "sell", ...overrides,
});
const warmup = () => Array.from({ length: 6 }, (_, i) => book(i * 1_000));
const prediction: Evaluation = { model: "test", latencyMs: 0, prediction: {
  type: "choice", choice: "buy", probabilities: { buy: 0.8, sell: 0.15, hold: 0.05 }, confidence: 0.7,
} };

describe("features and input contracts", () => {
  test("computes asymmetric book/flow imbalances and time-window returns", () => {
    const engine = new FeatureEngine();
    engine.book(book());
    engine.trade(trade(1, { side: "buy", size: 7, price: 102 }));
    engine.trade(trade(2, { size: 1, price: 98 }));
    const state = engine.book({ ...book(1_000), bid: 101, ask: 101.04 });
    expect(state.bookImbalance).toBeCloseTo(0.4);
    expect(state.flowImbalance).toBeCloseTo(0.75);
    expect(state.volumeDelta).toBe(6);
    expect(state.vwap).toBe(101.5);
    expect(state.returnBps).toBeCloseTo(99.9800039992);
    expect(state.spreadBps).toBeCloseTo(3.959611958);
    const later = engine.book(book(61_001));
    expect(later.flowImbalance).toBe(0);
    expect(later.volumeDelta).toBe(0);
    expect(later.vwap).toBeNull();
    expect(later.returnBps).toBe(0);
    expect(later.observations).toBe(1);
  });

  test("rejects crossed books, invalid distributions, and inconsistent choices", () => {
    expect(eventSchema.safeParse({ ...book(), ask: 99 }).success).toBe(false);
    expect(eventSchema.safeParse(trade(1, { size: -1 })).success).toBe(false);
    expect(predictionSchema.safeParse({ ...prediction.prediction, probabilities: { buy: 0.8, sell: 0.4, hold: 0 } }).success).toBe(false);
    expect(predictionSchema.safeParse({ ...prediction.prediction, choice: "sell" }).success).toBe(false);
  });
});

describe("paper execution", () => {
  test("fills only later, opposite-side trade-throughs and caps partial fills by volume", () => {
    const broker = new PaperBroker();
    expect(broker.place("buy", book(), 100)).toBe("order placed");
    expect(broker.trade(trade(100))).toBeNull();
    expect(broker.trade(trade(101, { price: 100 }))).toBeNull();
    expect(broker.trade(trade(101, { side: "buy" }))).toBeNull();
    expect(broker.trade(trade(101))?.size).toBe(0.3);
    expect(broker.cash).toBeCloseTo(9969.97);
    expect(broker.position).toBeCloseTo(0.3);
    expect(broker.order?.remaining).toBeCloseTo(0.7);
    expect(broker.trade(trade(102, { size: 5 }))?.size).toBeCloseTo(0.7);
    expect(broker.cash).toBeCloseTo(9899.9);
    expect(broker.fees).toBeCloseTo(0.1);
    expect(broker.order).toBeNull();
  });

  test("sell accounting deducts fees and inventory without shorting", () => {
    const broker = new PaperBroker();
    expect(broker.place("sell", book())).toBe("insufficient inventory");
    broker.position = 2;
    broker.place("sell", book());
    expect(broker.trade(trade(1, { price: 100.05, side: "buy", size: 0.5 }))?.size).toBe(0.5);
    expect(broker.cash).toBeCloseTo(10049.96998);
    expect(broker.position).toBe(1.5);
    expect(broker.fees).toBeCloseTo(0.05002);
  });

  test("expiry boundary is exclusive and no duplicate orders are allowed", () => {
    const broker = new PaperBroker();
    broker.place("buy", book());
    expect(broker.place("buy", book(1))).toBe("previous order still open");
    expect(broker.trade(trade(14_999))?.size).toBe(0.3);
    expect(broker.trade(trade(15_000))).toBeNull();
    expect(broker.order).toBeNull();
  });

  test("cash, exposure, spread and latched drawdown prevent orders", () => {
    const broker = new PaperBroker();
    broker.cash = 100;
    expect(broker.place("buy", book())).toBe("insufficient cash");
    broker.cash = 10_000;
    broker.position = 5;
    expect(broker.place("buy", book())).toBe("exposure limit");
    expect(broker.place("buy", { ...book(), ask: 101 })).toBe("spread too wide");
    broker.position = 1;
    broker.cash = 9_900;
    broker.mark(75.01);
    expect(broker.halted).toBe(false);
    broker.mark(75);
    expect(broker.halted).toBe(true);
    broker.mark(110);
    expect(broker.place("sell", book())).toBe("risk halt latched");
  });
});

describe("replay", () => {
  test("produces deterministic accounting and labels only future observations", async () => {
    const records: Record<string, unknown>[] = [];
    const events = [...warmup(), trade(5_200, { size: 0.3 }), trade(5_300, { size: 3 }), book(65_000)];
    const run = await replay(events, imbalanceBaseline, (r) => records.push(r));
    expect(run.fills).toBe(2);
    expect(run.netPnl).toBeCloseTo(-0.08);
    expect(run.position).toBeCloseTo(1);
    const outcome = records.find((r) => r.type === "outcome" && r.decisionId === 2);
    expect(outcome).toMatchObject({ timestampMs: 65_000, horizonDelayMs: 0 });
    expect(outcome?.futureMid).toBeCloseTo(100.02);
    expect(await replay(events, imbalanceBaseline, () => {})).toEqual(run);
  });

  test("inference latency prevents early fills and stale books cancel orders", async () => {
    const predict: Predictor = async () => ({ ...prediction, latencyMs: 500 });
    const early = await replay([...warmup(), trade(5_200), trade(5_501)], predict, () => {});
    expect(early.fills).toBe(1);
    expect(early.position).toBeCloseTo(0.3);
    const stale = await replay([...warmup(), trade(6_001)], predict, () => {});
    expect(stale.fills).toBe(0);
  });

  test("a later provider failure cancels an existing unfilled order", async () => {
    let calls = 0;
    const predict: Predictor = async () => {
      if (++calls > 1) throw new Error("unavailable");
      return prediction;
    };
    const records: Record<string, unknown>[] = [];
    const events = [...warmup(), ...[6, 7, 8, 9, 10].map((s) => book(s * 1_000)), trade(10_100)];
    const result = await replay(events, predict, (r) => records.push(r));
    expect(result.fills).toBe(0);
    expect(records.find((r) => r.type === "cancelled")).toMatchObject({ reason: "prediction failed or invalid response" });
  });

  test.each([
    ["provider failure", async () => { throw new Error("private provider response"); }],
    ["late response", async () => ({ ...prediction, latencyMs: 1_001 })],
    ["low confidence", async () => ({ ...prediction, prediction: { ...prediction.prediction, confidence: 0.54 } })],
    ["low probability", async () => ({ ...prediction, prediction: { ...prediction.prediction, probabilities: { buy: 0.64, sell: 0.26, hold: 0.1 } } })],
    ["invalid response", async () => ({ ...prediction, prediction: { ...prediction.prediction, confidence: NaN } })],
  ] satisfies [string, Predictor][]) ("fails closed on %s", async (_, predict) => {
    const records: Record<string, unknown>[] = [];
    const result = await replay([...warmup(), trade(5_200)], predict, (r) => records.push(r));
    expect(result.fills).toBe(0);
    expect(records.filter((r) => r.type === "decision").every((r) => r.action === "hold")).toBe(true);
    expect(JSON.stringify(records)).not.toContain("private provider response");
  });

  test("risk-blocked sell remains hold and retains the original probabilities", async () => {
    const records: Record<string, unknown>[] = [];
    const sell: Predictor = async () => ({ ...prediction, prediction: {
      ...prediction.prediction, choice: "sell", probabilities: { buy: 0.1, sell: 0.8, hold: 0.1 },
    } });
    await replay(warmup(), sell, (r) => records.push(r));
    expect(records.find((r) => r.type === "decision" && r.id === 2)).toMatchObject({
      proposedAction: "sell", action: "hold", riskReason: "insufficient inventory",
      evaluation: { prediction: { choice: "sell", probabilities: { sell: 0.8 } } },
    });
  });

  test("rejects out-of-order and mixed-market data", async () => {
    await expect(replay([book(1), book(0)], imbalanceBaseline, () => {})).rejects.toThrow("chronological");
    await expect(replay([book(), { ...book(1), market: "OTHER" }], imbalanceBaseline, () => {})).rejects.toThrow("single market");
  });
});

test("Jev HTTP contract pins the model and keeps credentials out of state", async () => {
  let body: Record<string, any> = {};
  const request = (async (_url: unknown, init: RequestInit) => {
    body = JSON.parse(init.body as string);
    expect(init.signal).toBeInstanceOf(AbortSignal);
    return Response.json({ model: "jev-1.13.0", answers: { direction: prediction.prediction } });
  }) as typeof fetch;
  const result = await createJevPredictor("test-only-key", request)(new FeatureEngine().book(book()));
  expect(result.prediction).toEqual(prediction.prediction);
  expect(body.model).toBe("jev-1.13.0");
  expect(body.questions.direction.criteria).toHaveProperty("hold");
  expect(JSON.stringify(body)).not.toContain("test-only-key");
});
