import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kraken, decimal, parseRules, sizeOrder, ORIGIN, sign, units, type Account, type ExchangeOrder, type Intent, type Ticker } from "./kraken";
import { acquireTradingLock, KrakenTrader, TradingStore, type TradingExchange } from "./trading";
import type { Evaluation, Predictor } from "./types";

const info = { XBTCHF: { altname: "XBTCHF", base: "XXBT", quote: "CHF", status: "online",
  lot_decimals: 3, lot_multiplier: 1, tick_size: "0.01", ordermin: "0.001", costmin: "5" } };
const rules = parseRules(info);
const book: Ticker = { symbol: "BTC/CHF", bidPrice: "100.009", askPrice: "100.031", bidQty: "7", askQty: "3" };
const account: Account = { canTrade: true, balances: [{ asset: "BTC", free: "0", locked: "0" }, { asset: "CHF", free: "50", locked: "0" }] };
const evaluation: Evaluation = { model: "test", latencyMs: 0, prediction: { type: "choice", choice: "buy", probabilities: { buy: 0.8, sell: 0.1, hold: 0.1 }, confidence: 0.7 } };
const predict: Predictor = async () => evaluation;
const intent: Intent = { clientId: "6d1b345e-2821-40e2-ad83-4ecb18a06876", side: "BUY", price: "100.00000000", quantity: "0.10000000", createdAt: 0 };
function order(i = intent, extra: Partial<ExchangeOrder> = {}): ExchangeOrder {
  return { symbol: "BTC/CHF", orderId: "O-42", clientOrderId: i.clientId, status: "open", side: i.side,
    price: i.price, origQty: i.quantity, executedQty: "0", cummulativeQuoteQty: "0", ...extra };
}

test("exact decimal sizing rounds maker prices outward and quantity down", () => {
  expect(decimal(units("0.1000000000"))).toBe("0.10000000");
  expect(() => units("0.000000001")).toThrow("precision");
  expect(() => units("1e-8")).toThrow();
  expect(sizeOrder("BUY", book, rules, account)).toEqual({ price: "100.00000000", quantity: "0.10000000" });
  const funded = { ...account, balances: [{ asset: "BTC", free: "0.0739", locked: "2" }] };
  expect(sizeOrder("SELL", book, rules, funded)).toEqual({ price: "100.04000000", quantity: "0.07300000" });
  expect(rules.minNotional).toBe(units("5"));
});

test("sizing enforces minimum after rounding, fee reserve, and locked-asset exposure", () => {
  const funded = (btc: string, cash: string, locked = "0"): Account => ({ canTrade: true, balances: [
    { asset: "BTC", free: btc, locked }, { asset: "CHF", free: cash, locked: "0" },
  ] });
  expect(() => sizeOrder("SELL", book, rules, funded("0.0499", "50"))).toThrow("notional");
  expect(() => sizeOrder("BUY", book, rules, funded("0", "10.09999999"))).toThrow("fee reserve");
  expect(sizeOrder("BUY", book, rules, funded("0", "10.10")).quantity).toBe("0.10000000");
  expect(() => sizeOrder("BUY", book, rules, funded("0", "1000", "5"))).toThrow("exposure");
  expect(() => sizeOrder("BUY", { ...book, askPrice: "102" }, rules, account)).toThrow("Spread");
  expect(() => sizeOrder("BUY", book, rules, { ...account, canTrade: false })).toThrow("disabled");
});

test("Kraken signature matches the official published test vector", () => {
  const secret = "kQH5HW/8p1uGOVjbgWA7FunAmGO8lsSUXNsu3eow76sz84Q18fWxnyRzBHCd3pd5nE9qa99HAZtuZuj6F1huXg==";
  expect(sign("/0/private/AddOrder", "1616492376594", "nonce=1616492376594&ordertype=limit&pair=XBTUSD&price=37500&type=buy&volume=1.25", secret))
    .toBe("4/dpxb3iT4tp/ZCVEwSnEsLxx0bqyhLpdfOpc6fn7OR8+UClSV5n9E6aSS8MPtnRfp32bAb0nmbRn6H8ndwLUQ==");
});

test("signed requests use Kraken POST bodies and subtract held balances", async () => {
  let seen = false;
  const request = async (input: string, init: RequestInit) => {
    const url = new URL(String(input));
    expect(url.origin).toBe(ORIGIN);
    expect(init?.redirect).toBe("error");
    expect(new Headers(init.headers).get("API-Key")).toBe("unit-test-key");
    expect(url.search).toBe("");
    expect(init.method).toBe("POST");
    expect(init.body).toBe("nonce=123");
    expect(new Headers(init.headers).get("API-Sign")).toBe(sign("/0/private/BalanceEx", "123", "nonce=123", "c2VjcmV0"));
    seen = true;
    return Response.json({ error: [], result: { XXBT: { balance: "0.1", hold_trade: "0.03" }, CHF: { balance: "50", hold_trade: "7" } } });
  };
  expect((await new Kraken("unit-test-key", "c2VjcmV0", () => "123", request).account()).balances).toEqual([
    { asset: "BTC", free: "0.07000000", locked: "0.03000000" }, { asset: "CHF", free: "43.00000000", locked: "7.00000000" },
  ]);
  expect(seen).toBe(true);
});

test("rate-limit cooldown blocks further network calls and never prints provider bodies", async () => {
  let calls = 0;
  const request = async () => { calls++; return Response.json({ code: -1003, msg: "sensitive-provider-text" }, { status: 429, headers: { "Retry-After": "60" } }); };
  const exchange = new Kraken("key", "c2VjcmV0", () => "123", request);
  await expect(exchange.account()).rejects.toThrow("HTTP 429");
  await expect(exchange.account()).rejects.toThrow("cooldown");
  expect(calls).toBe(1);
});

test("order transport failure is not retried", async () => {
  let calls = 0;
  const request = async () => { calls++; throw new Error("secret-in-url"); };
  await expect(new Kraken("key", "c2VjcmV0", () => "123", request, true).place(intent)).rejects.toThrow("UNKNOWN");
  expect(calls).toBe(1);
});

test("validation cannot place an order and live writes require adapter opt-in", async () => {
  const calls: URLSearchParams[] = [];
  const exchange = new Kraken("key", "c2VjcmV0", () => "123", async (url, init) => {
    expect(url).toBe(`${ORIGIN}/0/private/AddOrder`);
    calls.push(new URLSearchParams(String(init.body)));
    return Response.json({ error: [], result: { descr: { order: "validated" } } });
  });
  await expect(exchange.place(intent)).rejects.toThrow("disabled");
  await expect(exchange.cancel("O-42")).rejects.toThrow("disabled");
  expect(calls).toHaveLength(0);
  await exchange.validate(intent);
  expect(Object.fromEntries(calls[0])).toMatchObject({ pair: "XBTCHF", type: "buy", ordertype: "limit",
    price: "100.00000000", volume: "0.10000000", cl_ord_id: intent.clientId, oflags: "post,fciq",
    timeinforce: "GTD", expiretm: "+15", leverage: "none", validate: "true" });
  expect(calls).toHaveLength(1);
});

const raw = { cl_ord_id: intent.clientId, status: "open", descr: { pair: "XBTCHF", type: "buy", ordertype: "limit", price: "100", leverage: "none" },
  vol: "0.1", vol_exec: "0.04", cost: "4" };
test("live placement queries the returned transaction and cancellation uses that transaction", async () => {
  const paths: string[] = [];
  const exchange = new Kraken("key", "c2VjcmV0", () => "123", async (url, init) => {
    const path = new URL(url).pathname; paths.push(path);
    const p = new URLSearchParams(String(init.body));
    if (path.endsWith("AddOrder")) {
      expect(p.has("validate")).toBe(false);
      expect(p.get("expiretm")).toBe("+15");
      expect(p.get("oflags")).toBe("post,fciq");
      return Response.json({ error: [], result: { txid: ["O-42"] } });
    }
    expect(p.get("txid")).toBe("O-42");
    return Response.json({ error: [], result: path.endsWith("QueryOrders") ? { "O-42": raw } : { count: 1 } });
  }, true);
  expect(await exchange.place(intent)).toEqual(order(intent, { price: "100", origQty: "0.1", executedQty: "0.04", cummulativeQuoteQty: "4" }));
  await exchange.cancel("O-42");
  expect(paths).toEqual(["/0/private/AddOrder", "/0/private/QueryOrders", "/0/private/CancelOrder"]);
});

test("lost acknowledgement recovery searches closed pages by UUID and never treats absence as rejection", async () => {
  let found = true;
  const offsets: string[] = [];
  const exchange = new Kraken("key", "c2VjcmV0", () => "123", async (url, init) => {
    if (url.endsWith("OpenOrders")) return Response.json({ error: [], result: { open: {} } });
    expect(url.endsWith("ClosedOrders")).toBe(true);
    const offset = new URLSearchParams(String(init.body)).get("ofs")!; offsets.push(offset);
    return Response.json({ error: [], result: { count: 51, closed: offset === "50" && found ? { "O-42": { ...raw, status: "canceled" } } : {} } });
  });
  expect((await exchange.query(intent)).status).toBe("canceled");
  expect(offsets).toEqual(["0", "50"]);
  found = false;
  await expect(exchange.query(intent)).rejects.toThrow("UNKNOWN");
});

test("HTTP 200 API errors fail closed, and credit cannot become trading cash", async () => {
  const failed = new Kraken("key", "c2VjcmV0", () => "123", async () => Response.json({ error: ["EAPI:Invalid key sensitive-detail"] }));
  await expect(failed.account()).rejects.toThrow("Kraken rejected request");
  const credit = new Kraken("key", "c2VjcmV0", () => "123", async () => Response.json({ error: [], result: {
    CHF: { balance: "10", hold_trade: "0", credit: "100", credit_used: "0" },
  } }));
  await expect(credit.account()).rejects.toThrow("Credit accounts");
  expect(() => sizeOrder("BUY", book, { ...rules, minQty: units("0.101") }, account)).toThrow("minimum");
});

test("CLI rejects incomplete live authorization, old flags, and unacknowledged cancellation", () => {
  const cases = [
    ["run", "--execute-live"],
    ["run", "--jev", "--execute-live", "--acknowledge-live"],
    ["run", "--execute-testnet"],
    ["reconcile"],
    ["reset-risk"],
  ];
  for (const args of cases) {
    const result = Bun.spawnSync([process.execPath, "src/trade.ts", ...args], {
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, KRAKEN_ENABLE_LIVE: "", KRAKEN_API_KEY: "", KRAKEN_API_SECRET: "", TYPESAFE_API_KEY: "" },
      stdout: "pipe", stderr: "pipe",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toMatch(/requires|Usage|pass --acknowledge-live/);
  }
});

async function fixture(run: (h: {
  store: TradingStore; exchange: TradingExchange; kill: string; path: string;
  clock: (now: number) => void; trader: (execute?: boolean, predictor?: Predictor) => KrakenTrader;
  warmup: (trader: KrakenTrader) => Promise<void>;
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
      trader: (execute = true, predictor = predict) => new KrakenTrader(exchange, store, rules, predictor, kill, execute),
      warmup: async (trader) => { for (let i = 0; i < 12; i++) { now = 100_000 + i * 5_000; await trader.step(); } now = 160_000; },
    });
  } finally { store.close(); clock.mockRestore(); rmSync(directory, { recursive: true, force: true }); }
}

test("successful submission rests until the expiry boundary and then confirms cancellation", async () => {
  await fixture(async (h) => {
    let submissions = 0;
    let canceled = false;
    h.exchange.place = async (i) => { submissions++; return order(i); };
    h.exchange.query = async (i) => order(i, { status: canceled ? "canceled" : "open" });
    h.exchange.cancel = async () => { canceled = true; };
    const trader = h.trader();
    await h.warmup(trader);
    expect((await trader.step()).action).toBe("submitted");
    expect(h.store.pending()?.order?.orderId).toBe("O-42");
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

test("realistic ten-second polling warms up without resetting on normal request latency", async () => {
  await fixture(async (h) => {
    const trader = h.trader(false);
    for (let i = 0; i < 6; i++) {
      h.clock(100_000 + i * 10_500);
      expect((await trader.step()).reason).toBe("60-second warmup");
    }
    h.clock(163_000);
    expect((await trader.step()).action).toBe("dry-run");
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
      let status: ExchangeOrder["status"] = "open";
      h.exchange.query = async (i) => order(i, { status, executedQty: "0.04", cummulativeQuoteQty: "4" });
      h.exchange.cancel = async () => { status = "canceled"; };
      const restart = new KrakenTrader(h.exchange, reopened, rules, predict, h.kill, true);
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
      ? { status: "closed", executedQty: "0.1", cummulativeQuoteQty: "10" }
      : { status: "open", executedQty: "0.04", cummulativeQuoteQty: "4" });
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
    h.exchange.query = async (i) => order(i, { status: "canceled", executedQty: "0.09" });
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
    h.exchange.query = async (i) => order(i, { status: canceled ? "canceled" : "open" });
    h.exchange.cancel = async (id) => { expect(id).toBe("O-42"); canceled = true; };
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
    h.clock(190_000);
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
    h.store.mark(units("50"));
    h.store.mark(units("45.00000001"));
    expect(h.store.halted()).toBeNull();
    const reopened = new TradingStore(h.path, "unit-test-key");
    try { reopened.mark(units("45")); expect(reopened.halted()).toContain("drawdown"); }
    finally { reopened.close(); }
    h.store.resetRisk();
    for (let i = 0; i < 10; i++) { h.store.begin({ ...intent, clientId: `attempt-${i}` }); h.store.complete(order(intent, { status: "canceled" })); }
    h.store.resetRisk();
    expect(() => h.store.begin(intent)).toThrow("10 submission");
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

test("nonce survives restart and backward clocks; allocation cap latches above its exact boundary", async () => {
  await fixture(async (h) => {
    const first = BigInt(h.store.nextNonce());
    expect(BigInt(h.store.nextNonce())).toBe(first + 1n);
    h.clock(1);
    const reopened = new TradingStore(h.path, "unit-test-key");
    try { expect(BigInt(reopened.nextNonce())).toBe(first + 2n); }
    finally { reopened.close(); }
    h.store.mark(units("50"));
    expect(h.store.halted()).toBeNull();
    h.store.mark(units("50.00000001"));
    expect(h.store.halted()).toContain("allocation");
  });
});
