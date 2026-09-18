import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, openSync, unlinkSync, writeSync } from "node:fs";
import { Kraken, SYMBOL, balance, decimal, isTerminal, SCALE, sizeOrder, units, type ExchangeOrder, type Intent, type Rules } from "./kraken";
import { FeatureEngine } from "./features";
import { predictionSchema, type Predictor } from "./types";

export function acquireTradingLock(path: string) {
  const fd = openSync(path, "wx", 0o600);
  writeSync(fd, `${process.pid}\n`);
  return () => { closeSync(fd); unlinkSync(path); };
}

/** A single durable intent blocks all later submissions until terminal exchange confirmation. */
export class TradingStore {
  private db: Database;
  constructor(path: string, apiKey: string) {
    this.db = new Database(path, { create: true, strict: true });
    chmodSync(path, 0o600);
    this.db.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id=1), account TEXT NOT NULL, pending TEXT, halted TEXT, high_water TEXT); CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY, time INTEGER, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS daily_orders (day TEXT PRIMARY KEY, count INTEGER NOT NULL)");
    this.db.exec("CREATE TABLE IF NOT EXISTS nonce (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)");
    const fingerprint = createHash("sha256").update(`kraken:BTC/CHF:${apiKey}`).digest("hex");
    this.db.query("INSERT OR IGNORE INTO state (id,account) VALUES (1,?)").run(fingerprint);
    const state = this.db.query("SELECT account FROM state WHERE id=1").get() as { account: string };
    if (state.account !== fingerprint) { this.db.close(); throw new Error("State belongs to another API key; do not reuse it"); }
  }
  pending(): { intent: Intent; order?: ExchangeOrder } | null {
    const row = this.db.query("SELECT pending FROM state WHERE id=1").get() as { pending: string | null };
    return row.pending ? JSON.parse(row.pending) : null;
  }
  nextNonce(): string {
    return this.db.transaction(() => {
      const row = this.db.query("SELECT value FROM nonce WHERE id=1").get() as { value: string } | null;
      const previous = BigInt(row?.value ?? "0");
      const now = BigInt(Date.now()) * 1_000n;
      const next = (now > previous ? now : previous + 1n).toString();
      this.db.query("INSERT INTO nonce (id,value) VALUES (1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value").run(next);
      return next;
    })();
  }
  save(intent: Intent, order?: ExchangeOrder) {
    this.db.query("UPDATE state SET pending=? WHERE id=1").run(JSON.stringify({ intent, order }));
  }
  begin(intent: Intent) {
    this.db.transaction(() => {
      if (this.pending() || this.halted()) throw new Error("Pending order or risk halt prevents submission");
      const day = new Date(Date.now()).toISOString().slice(0, 10);
      const row = this.db.query("SELECT count FROM daily_orders WHERE day=?").get(day) as { count: number } | null;
      if ((row?.count ?? 0) >= 10) throw new Error("10 submission attempts per UTC day limit");
      this.db.query("INSERT INTO daily_orders (day,count) VALUES (?,1) ON CONFLICT(day) DO UPDATE SET count=count+1").run(day);
      this.save(intent);
      this.audit({ type: "intent", intent });
    })();
  }
  complete(order: ExchangeOrder) {
    this.db.transaction(() => {
      this.audit({ type: "terminal-order", order });
      this.db.exec("UPDATE state SET pending=NULL WHERE id=1");
    })();
  }
  audit(record: unknown) { this.db.query("INSERT INTO audit (time,data) VALUES (?,?)").run(Date.now(), JSON.stringify(record)); }
  halt(reason: string) { this.db.query("UPDATE state SET halted=? WHERE id=1").run(reason); }
  halted(): string | null { return (this.db.query("SELECT halted FROM state WHERE id=1").get() as { halted: string | null }).halted; }
  resetRisk() {
    if (this.pending()) throw new Error("Cannot reset with an unresolved order");
    this.db.transaction(() => {
      this.audit({ type: "operator-risk-reset" });
      this.db.exec("UPDATE state SET halted=NULL, high_water=NULL WHERE id=1");
    })();
  }
  mark(equity: bigint) {
    const previous = (this.db.query("SELECT high_water FROM state WHERE id=1").get() as { high_water: string | null }).high_water;
    const high = previous === null || equity > BigInt(previous) ? equity : BigInt(previous);
    this.db.query("UPDATE state SET high_water=? WHERE id=1").run(high.toString());
    if (high - equity >= units("5")) this.halt("5 CHF account-pair drawdown limit");
    if (equity > units("50")) this.halt("BTC/CHF account allocation exceeds 50 CHF; use a dedicated small account");
  }
  close() { this.db.close(); }
}

export type TradingExchange = Pick<Kraken, "account" | "ticker" | "openOrders" | "place" | "query" | "cancel">;

export class KrakenTrader {
  private busy = false;
  private engine = new FeatureEngine();
  private firstObservation: number | undefined;
  private lastObservation: number | undefined;
  constructor(private exchange: TradingExchange, private store: TradingStore, private rules: Rules,
    private predict: Predictor, private killFile: string, private execute: boolean) {}

  async reconcile(cancel = false) {
    const pending = this.store.pending();
    if (!pending) return;
    const order = await this.exchange.query(pending.intent, pending.order?.orderId);
    this.checkOrder(pending.intent, order, pending.order);
    this.store.audit({ type: "order-update", order });
    this.store.save(pending.intent, order);
    if (isTerminal(order)) { this.store.complete(order); return; }
    if (cancel || Date.now() - pending.intent.createdAt >= 15_000) {
      // Never clear state based on a cancel request/ack: query the final status.
      await this.exchange.cancel(order.orderId);
      const final = await this.exchange.query(pending.intent, order.orderId);
      this.checkOrder(pending.intent, final, order);
      this.store.save(pending.intent, final);
      if (!isTerminal(final)) throw new Error("Cancellation not yet confirmed");
      this.store.complete(final);
    }
  }

  private checkOrder(intent: Intent, order: ExchangeOrder, previous?: ExchangeOrder) {
    if (order.symbol !== SYMBOL || order.clientOrderId !== intent.clientId || order.side !== intent.side || units(order.price) !== units(intent.price) || units(order.origQty) !== units(intent.quantity) ||
      units(order.executedQty) > units(order.origQty) || (previous && (order.orderId !== previous.orderId || units(order.executedQty) < units(previous.executedQty))) ||
      (!previous && order.clientOrderId !== intent.clientId)) throw new Error("Exchange order does not match durable intent");
  }

  async step() {
    if (this.busy) throw new Error("Trading cycle already running");
    this.busy = true;
    try {
      if (existsSync(this.killFile)) this.store.halt("manual kill switch");
      if (!this.execute && this.store.pending()) return { action: "hold", reason: "dry-run cannot reconcile/cancel an existing order" };
      await this.reconcile(Boolean(this.store.halted()));
      if (this.store.halted()) return { action: "hold", reason: this.store.halted() };
      // Refuse foreign/open orders rather than canceling somebody else's orders.
      const pending = this.store.pending();
      if ((await this.exchange.openOrders()).some((o) => o.orderId !== pending?.order?.orderId)) throw new Error("Untracked open orders; inspect account before trading");
      const snapshotStarted = Date.now();
      const account = await this.exchange.account();
      const book = await this.exchange.ticker();
      if (Date.now() - snapshotStarted > 1_000) throw new Error("Market snapshot request too slow");
      const btc = balance(account, "BTC"), chf = balance(account, "CHF");
      const equity = chf.free + chf.locked + (btc.free + btc.locked) * units(book.bidPrice) / SCALE;
      this.store.mark(equity);
      this.store.audit({ type: "balances", btc: { free: decimal(btc.free), locked: decimal(btc.locked) },
        chf: { free: decimal(chf.free), locked: decimal(chf.locked) }, equity: decimal(equity) });
      if (this.store.halted()) {
        if (this.execute) await this.reconcile(true);
        return { action: "hold", reason: this.store.halted() };
      }
      if (this.lastObservation !== undefined && (snapshotStarted - this.lastObservation > 25_000 || snapshotStarted < this.lastObservation)) {
        this.engine = new FeatureEngine();
        this.firstObservation = undefined;
      }
      this.lastObservation = snapshotStarted;
      this.firstObservation ??= snapshotStarted;
      const state = this.engine.book({ type: "book", market: SYMBOL, timestampMs: snapshotStarted,
        bid: Number(book.bidPrice), ask: Number(book.askPrice), bidSize: Number(book.bidQty), askSize: Number(book.askQty) });
      if (pending) return { action: "hold", reason: "order still active" };
      if (Date.now() - this.firstObservation < 60_000 || state.observations < 5) return { action: "hold", reason: "60-second warmup" };
      const evaluation = await this.predict(state);
      const p = predictionSchema.parse(evaluation.prediction);
      this.store.audit({ type: "prediction", state, evaluation });
      if (!Number.isFinite(evaluation.latencyMs) || evaluation.latencyMs < 0 || evaluation.latencyMs > 1_000 ||
        Date.now() - snapshotStarted > 1_000) return { action: "hold", reason: "stale decision" };
      if (p.choice === "hold" || p.probabilities[p.choice] < 0.65 || p.confidence < 0.55) return { action: "hold", reason: "model gate" };
      if (existsSync(this.killFile)) { this.store.halt("manual kill switch"); return { action: "hold", reason: "manual kill switch" }; }
      const side = p.choice === "buy" ? "BUY" : "SELL";
      let sized;
      try { sized = sizeOrder(side, book, this.rules, account); }
      catch { return { action: "hold", reason: "balance, spread, exposure, or exchange sizing gate" }; }
      const intent: Intent = { clientId: randomUUID(), side, ...sized, createdAt: Date.now() };
      if (!this.execute) { this.store.audit({ type: "dry-run", intent }); return { action: "dry-run", intent }; }
      // Persist BEFORE the network call. An exception leaves this intent unresolved.
      this.store.begin(intent);
      const order = await this.exchange.place(intent);
      this.checkOrder(intent, order);
      this.store.save(intent, order);
      this.store.audit({ type: "submitted", intent, order });
      return { action: "submitted", order };
    } catch {
      // Provider, filesystem, or transport failures must not cause another order.
      this.store.halt("execution or data failure; reconcile before restarting");
      throw new Error("Trading halted. Pending order may exist: run kraken reconcile --acknowledge-live and inspect the exchange.");
    } finally { this.busy = false; }
  }
}
