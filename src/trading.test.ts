import { expect, spyOn, test } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BinanceTestnet, decimal, parseRules, sizeOrder, TESTNET, units, type Account, type ExchangeOrder, type Intent, type Ticker } from "./binance";
import { acquireTradingLock, TestnetTrader, TradingStore, type TradingExchange } from "./trading";
import type { Evaluation, Predictor } from "./types";

const info = { symbols: [{ symbol: "BTCUSDT", baseAsset: "BTC", quoteAsset: "USDT", status: "TRADING", isSpotTradingAllowed: true,
  orderTypes: ["LIMIT_MAKER"], filters: [
    { filterType: "PRICE_FILTER", minPrice: "0.01", maxPrice: "1000000", tickSize: "0.01" },
    { filterType: "LOT_SIZE", minQty: "0.001", maxQty: "1000", stepSize: "0.001" },
    { filterType: "MIN_NOTIONAL", minNotional: "5" },
    { filterType: "NOTIONAL", minNotional: "10", maxNotional: "1000" },
  ] }] };
const rules = parseRules(info);
const book: Ticker = { symbol: "BTCUSDT", bidPrice: "100.009", askPrice: "100.031", bidQty: "7", askQty: "3" };
const account: Account = { canTrade: true, balances: [{ asset: "BTC", free: "0", locked: "0" }, { asset: "USDT", free: "1000", locked: "0" }] };
const evaluation: Evaluation = { model: "test", latencyMs: 0, prediction: { type: "choice", choice: "buy", probabilities: { buy: 0.8, sell: 0.1, hold: 0.1 }, confidence: 0.7 } };
const predict: Predictor = async () => evaluation;
const intent: Intent = { clientId: "jvf-test", side: "BUY", price: "100.00000000", quantity: "0.25000000", createdAt: 0 };
function order(i = intent, extra: Partial<ExchangeOrder> = {}): ExchangeOrder {
  return { symbol: "BTCUSDT", orderId: 42, clientOrderId: i.clientId, status: "NEW", side: i.side,
    price: i.price, origQty: i.quantity, executedQty: "0", cummulativeQuoteQty: "0", ...extra };
}

test("exact decimal sizing rounds maker prices outward and quantity down", () => {
  expect(decimal(units("0.1000000000"))).toBe("0.10000000");
  expect(() => units("0.000000001")).toThrow("precision");
  expect(() => units("1e-8")).toThrow();
  expect(sizeOrder("BUY", book, rules, account)).toEqual({ price: "100.00000000", quantity: "0.25000000" });
  const funded = { ...account, balances: [{ asset: "BTC", free: "0.1739", locked: "2" }] };
  expect(sizeOrder("SELL", book, rules, funded)).toEqual({ price: "100.04000000", quantity: "0.17300000" });
  expect(rules.minNotional).toBe(units("10"));
});

test("sizing enforces minimum after rounding, fee reserve, and locked-asset exposure", () => {
  const funded = (btc: string, cash: string, locked = "0"): Account => ({ canTrade: true, balances: [
    { asset: "BTC", free: btc, locked }, { asset: "USDT", free: cash, locked: "0" },
  ] });
  expect(() => sizeOrder("SELL", book, rules, funded("0.0999", "1000"))).toThrow("notional");
  expect(() => sizeOrder("BUY", book, rules, funded("0", "25.24999999"))).toThrow("fee reserve");
  expect(sizeOrder("BUY", book, rules, funded("0", "25.25")).quantity).toBe("0.25000000");
  expect(() => sizeOrder("BUY", book, rules, funded("0", "1000", "5"))).toThrow("exposure");
  expect(() => sizeOrder("BUY", { ...book, askPrice: "102" }, rules, account)).toThrow("Spread");
  expect(() => sizeOrder("BUY", book, rules, { ...account, canTrade: false })).toThrow("disabled");
});

test("signed requests target testnet, prohibit redirects and sign the exact encoded payload", async () => {
  let seen = false;
  const request = async (input: string, init: RequestInit) => {
    const url = new URL(String(input));
    expect(url.origin).toBe(TESTNET);
    expect(init?.redirect).toBe("error");
    expect(new Headers(init?.headers).get("X-MBX-APIKEY")).toBe("unit-test-key");
    const signature = url.searchParams.get("signature");
    url.searchParams.delete("signature");
    expect(url.searchParams.get("recvWindow")).toBe("5000");
    expect(Number(url.searchParams.get("timestamp"))).toBeGreaterThan(0);
    expect(signature).toBe(createHmac("sha256", "unit-test-secret").update(url.searchParams.toString()).digest("hex"));
    seen = true;
    return Response.json(account);
  };
  expect(await new BinanceTestnet("unit-test-key", "unit-test-secret", request).account()).toEqual(account);
  expect(seen).toBe(true);
});

test("rate-limit cooldown blocks further network calls and never prints provider bodies", async () => {
  let calls = 0;
  const request = async () => { calls++; return Response.json({ code: -1003, msg: "sensitive-provider-text" }, { status: 429, headers: { "Retry-After": "60" } }); };
  const exchange = new BinanceTestnet("key", "secret", request);
  await expect(exchange.account()).rejects.toThrow("HTTP 429 code -1003");
  await expect(exchange.account()).rejects.toThrow("cooldown");
  expect(calls).toBe(1);
});

test("order transport failure is not retried", async () => {
  let calls = 0;
  const request = async () => { calls++; throw new Error("secret-in-url"); };
  await expect(new BinanceTestnet("key", "secret", request).place(intent)).rejects.toThrow("UNKNOWN");
  expect(calls).toBe(1);
});

async function fixture(run: (h: {
  store: TradingStore; exchange: TradingExchange; kill: string; path: string;
  clock: (now: number) => void; trader: (execute?: boolean, predictor?: Predictor) => TestnetTrader;
  warmup: (trader: TestnetTrader) => Promise<void>;
}) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), "jevflow-trading-"));
  const path = join(directory, "state.sqlite");
  const kill = join(directory, "STOP");
  let now = 100_000;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  const store = new TradingStore(path, "unit-test-key");
  const exchange: TradingExchange = {
    account: async () => structuredClone(account), ticker: async () => book, openOrders: async () => [],
    place: async (i) => order(i), query: async (i) => order(i), cancel: async () => {},
  };
  try {
    await run({ store, path, kill, exchange, clock: (value) => { now = value; },
      trader: (execute = true, predictor = predict) => new TestnetTrader(exchange, store, rules, predictor, kill, execute),
      warmup: async (trader) => { for (let i = 0; i < 12; i++) { now = 100_000 + i * 5_000; await trader.step(); } now = 160_000; },
    });
  } finally { store.close(); clock.mockRestore(); rmSync(directory, { recursive: true, force: true }); }
}

test("successful submission rests until the expiry boundary and then confirms cancellation", async () => {
  await fixture(async (h) => {
    let submissions = 0;
    let canceled = false;
    h.exchange.place = async (i) => { submissions++; return order(i); };
    h.exchange.query = async (i) => order(i, { status: canceled ? "CANCELED" : "NEW" });
    h.exchange.cancel = async () => { canceled = true; };
    const trader = h.trader();
    await h.warmup(trader);
    expect((await trader.step()).action).toBe("submitted");
    expect(h.store.pending()?.order?.orderId).toBe(42);
    h.clock(174_999);
    await trader.reconcile();
    expect(canceled).toBe(false);
    expect(h.store.pending()).not.toBeNull();
    h.clock(175_000);
    await trader.reconcile();
    expect(canceled).toBe(true);
    expect(h.store.pending()).toBeNull();
    expect(submissions).toBe(1);
  });
});

test("overlapping cycles cannot create duplicate submissions", async () => {
  await fixture(async (h) => {
    let release!: (value: Evaluation) => void;
    let started!: () => void;
    const waiting = new Promise<void>((resolve) => { started = resolve; });
    const trader = h.trader(true, () => { started(); return new Promise((resolve) => { release = resolve; }); });
    await h.warmup(trader);
    const first = trader.step();
    await waiting;
    await expect(trader.step()).rejects.toThrow("already running");
    expect(h.store.pending()).toBeNull();
    release(evaluation);
    expect((await first).action).toBe("submitted");
    expect(h.store.halted()).toBeNull();
  });
});

test("lost acknowledgement persists intent before POST and restart reconciles without another POST", async () => {
  await fixture(async (h) => {
    let submissions = 0;
    h.exchange.place = async (i) => {
      submissions++;
      expect(h.store.pending()?.intent).toEqual(i);
      throw new Error("timeout after acceptance");
    };
    const trader = h.trader();
    await h.warmup(trader);
    await expect(trader.step()).rejects.toThrow("halted");
    expect(h.store.halted()).toBeTruthy();
    const reopened = new TradingStore(h.path, "unit-test-key");
    try {
      expect(reopened.pending()).toEqual(h.store.pending());
      let status: ExchangeOrder["status"] = "PARTIALLY_FILLED";
      h.exchange.query = async (i) => order(i, { status, executedQty: "0.1", cummulativeQuoteQty: "10" });
      h.exchange.cancel = async () => { status = "CANCELED"; };
      const restart = new TestnetTrader(h.exchange, reopened, rules, predict, h.kill, true);
      await restart.reconcile(true);
      expect(reopened.pending()).toBeNull();
      expect((await restart.step()).action).toBe("hold");
      expect(submissions).toBe(1);
    } finally { reopened.close(); }
  });
});

test("not-found query is uncertainty, not permission to resubmit or reset", async () => {
  await fixture(async (h) => {
    h.store.begin(intent);
    h.exchange.query = async () => { throw new Error("order not found"); };
    await expect(h.trader().step()).rejects.toThrow("halted");
    expect(h.store.pending()?.intent.clientId).toBe(intent.clientId);
    expect(() => h.store.resetRisk()).toThrow("unresolved");
  });
});

test("cancel-fill race uses authoritative cumulative fills and requires terminal confirmation", async () => {
  await fixture(async (h) => {
    h.store.begin(intent);
    let canceled = false;
    h.exchange.query = async (i) => order(i, canceled
      ? { status: "FILLED", executedQty: "0.25", cummulativeQuoteQty: "25" }
      : { status: "PARTIALLY_FILLED", executedQty: "0.1", cummulativeQuoteQty: "10" });
    h.exchange.cancel = async () => { canceled = true; };
    await h.trader().reconcile(true);
    expect(h.store.pending()).toBeNull();
    h.store.begin({ ...intent, clientId: "second" });
    h.exchange.query = async (i) => order(i);
    await expect(h.trader().reconcile(true)).rejects.toThrow("not yet confirmed");
    expect(h.store.pending()).not.toBeNull();
  });
});

test("unexpected order identity or decreasing filled quantity cannot clear intent", async () => {
  await fixture(async (h) => {
    h.store.begin(intent);
    h.store.save(intent, order(intent, { executedQty: "0.1" }));
    h.exchange.query = async (i) => order(i, { status: "CANCELED", executedQty: "0.09" });
    await expect(h.trader().reconcile()).rejects.toThrow("does not match");
    expect(h.store.pending()).not.toBeNull();
  });
});

test("dry-run never submits or cancels, including when pending state exists", async () => {
  await fixture(async (h) => {
    h.exchange.place = async () => { throw new Error("must not POST"); };
    h.exchange.cancel = async () => { throw new Error("must not DELETE"); };
    const trader = h.trader(false);
    await h.warmup(trader);
    expect((await trader.step()).action).toBe("dry-run");
    expect(h.store.pending()).toBeNull();
    h.store.begin(intent);
    expect((await trader.step()).reason).toContain("dry-run cannot");
  });
});

test("kill switch cancels only the tracked order and permanently latches", async () => {
  await fixture(async (h) => {
    h.store.begin(intent);
    writeFileSync(h.kill, "stop");
    let canceled = false;
    h.exchange.query = async (i) => order(i, { status: canceled ? "CANCELED" : "NEW" });
    h.exchange.cancel = async (id) => { expect(id).toBe(42); canceled = true; };
    expect((await h.trader().step()).action).toBe("hold");
    expect(canceled).toBe(true);
    expect(h.store.pending()).toBeNull();
    expect(h.store.halted()).toBe("manual kill switch");
  });
});

test("kill arriving during prediction is checked before intent and submission", async () => {
  await fixture(async (h) => {
    const trader = h.trader(true, async () => { writeFileSync(h.kill, "stop"); return evaluation; });
    await h.warmup(trader);
    expect((await trader.step()).reason).toBe("manual kill switch");
    expect(h.store.pending()).toBeNull();
  });
});

test("stale inference cannot submit and missing observation intervals restart warmup", async () => {
  await fixture(async (h) => {
    const trader = h.trader(true, async () => { h.clock(161_001); return evaluation; });
    await h.warmup(trader);
    expect((await trader.step()).reason).toBe("stale decision");
    h.clock(180_000);
    expect((await trader.step()).reason).toContain("warmup");
    expect(h.store.pending()).toBeNull();
  });
});

test("foreign orders are never canceled and prevent new orders", async () => {
  await fixture(async (h) => {
    let canceled = false;
    h.exchange.openOrders = async () => [order()];
    h.exchange.cancel = async () => { canceled = true; };
    await expect(h.trader().step()).rejects.toThrow("halted");
    expect(canceled).toBe(false);
    expect(h.store.pending()).toBeNull();
  });
});

test("drawdown survives restart, respects exact boundary, and reset preserves daily attempt cap", async () => {
  await fixture(async (h) => {
    h.store.mark(units("1000"));
    h.store.mark(units("975.00000001"));
    expect(h.store.halted()).toBeNull();
    const reopened = new TradingStore(h.path, "unit-test-key");
    try { reopened.mark(units("975")); expect(reopened.halted()).toContain("drawdown"); }
    finally { reopened.close(); }
    h.store.resetRisk();
    for (let i = 0; i < 100; i++) { h.store.begin({ ...intent, clientId: `attempt-${i}` }); h.store.complete(order(intent, { status: "CANCELED" })); }
    h.store.resetRisk();
    expect(() => h.store.begin(intent)).toThrow("100 submission");
    expect(h.store.pending()).toBeNull();
  });
});

test("state refuses another account and local lock refuses overlapping processes", async () => {
  await fixture(async (h) => {
    expect(() => new TradingStore(h.path, "another-key")).toThrow("another API key");
    const release = acquireTradingLock(`${h.path}.lock`);
    try { expect(() => acquireTradingLock(`${h.path}.lock`)).toThrow(); }
    finally { release(); }
  });
});
