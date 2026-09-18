import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { Kraken, balance, decimal, ORIGIN, sizeOrder } from "./kraken";
import { createJevPredictor } from "./jev";
import { acquireTradingLock, KrakenTrader, TradingStore } from "./trading";
import type { Predictor } from "./types";

const STATE = "data/kraken.sqlite", LOCK = "data/kraken.lock", KILL = "data/kraken.STOP";
const hold: Predictor = async () => ({ model: "always-hold", latencyMs: 0,
  prediction: { type: "choice", choice: "hold", probabilities: { buy: 0, sell: 0, hold: 1 }, confidence: 1 } });

async function main() {
  const args = process.argv.slice(2);
  const command = args.shift() ?? "check";
  const execute = args.includes("--execute-live"), acknowledge = args.includes("--acknowledge-live");
  const jev = args.includes("--jev"), reset = args.includes("--acknowledge-risk-reset");
  if (!["check", "status", "run", "validate", "reconcile", "reset-risk", "stop"].includes(command) ||
    args.some((arg) => !["--execute-live", "--acknowledge-live", "--jev", "--acknowledge-risk-reset"].includes(arg)) ||
    ((execute || jev) && command !== "run") || (reset && command !== "reset-risk") ||
    (acknowledge && !["run", "reconcile"].includes(command))) throw new Error("Usage: bun run kraken check|status|stop|validate|reconcile --acknowledge-live|reset-risk --acknowledge-risk-reset|run [--jev] [--execute-live --acknowledge-live]");
  if (execute && (!jev || !acknowledge || process.env.KRAKEN_ENABLE_LIVE !== "I_ACCEPT_REAL_MONEY_RISK")) {
    throw new Error("Live trading requires --jev --execute-live --acknowledge-live and KRAKEN_ENABLE_LIVE=I_ACCEPT_REAL_MONEY_RISK");
  }
  if (command === "reconcile" && !acknowledge) throw new Error("Reconciliation may cancel real orders: pass --acknowledge-live");
  if (command === "reset-risk" && !reset) throw new Error("Risk reset requires --acknowledge-risk-reset after exchange inspection");
  if (command === "stop") {
    mkdirSync("data", { recursive: true });
    writeFileSync(KILL, "Manual stop requested\n", { mode: 0o600 });
    console.log("Stop requested. Verify cancellation on Kraken; a stop file is not cancellation confirmation.");
    return;
  }
  if (command === "check") {
    const exchange = new Kraken();
    const rules = await exchange.rules(), book = await exchange.ticker();
    console.log(JSON.stringify({ environment: ORIGIN, market: "BTC/CHF", book,
      rules: Object.fromEntries(Object.entries(rules).map(([k, v]) => [k, decimal(v)])),
      maxOrderCHF: 10, readyForRealMoney: false }, null, 2));
    return;
  }
  const key = process.env.KRAKEN_API_KEY ?? "", secret = process.env.KRAKEN_API_SECRET ?? "";
  if (!key || !secret) throw new Error("Set KRAKEN_API_KEY and KRAKEN_API_SECRET via secrets; never paste them into chat");
  mkdirSync("data", { recursive: true });
  // Even status/validate use the same lock and durable nonce as the trader.
  const release = acquireTradingLock(LOCK);
  let store: TradingStore | undefined;
  try {
    store = new TradingStore(STATE, key);
    const exchange = new Kraken(key, secret, () => store!.nextNonce(), fetch, execute || command === "reconcile");
    if (command === "status") {
      const account = await exchange.account();
      console.log(JSON.stringify({ environment: ORIGIN, balances: ["BTC", "CHF"].map((asset) => {
        const b = balance(account, asset); return { asset, free: decimal(b.free), locked: decimal(b.locked) };
      }), pending: store.pending(), halted: store.halted(), openOrders: await exchange.openOrders() }, null, 2));
      return;
    }
    if (command === "reset-risk") {
      if (existsSync(KILL)) throw new Error("Remove the stop file only after reviewing the account");
      if ((await exchange.openOrders()).length) throw new Error("Open orders prevent risk reset");
      store.resetRisk();
      console.log("Risk halt and high-water mark reset; audit, daily counts, and nonce retained.");
      return;
    }
    const trader = new KrakenTrader(exchange, store, await exchange.rules(), jev ? createJevPredictor(process.env.TYPESAFE_API_KEY ?? "") : hold, KILL, execute);
    if (command === "reconcile") {
      await trader.reconcile(true);
      console.log(JSON.stringify({ pending: store.pending(), halted: store.halted(), openOrders: await exchange.openOrders() }, null, 2));
      return;
    }
    if (store.halted() || existsSync(KILL)) throw new Error("Persisted halt/stop: inspect account, reconcile, then explicitly reset risk");
    if (command === "validate") {
      if (store.pending() || (await exchange.openOrders()).length) throw new Error("Resolve existing orders before validation");
      const account = await exchange.account(), book = await exchange.ticker();
      const intent = { clientId: randomUUID(), side: "BUY" as const,
        ...sizeOrder("BUY", book, await exchange.rules(), account), createdAt: Date.now() };
      await exchange.validate(intent);
      store.audit({ type: "validated-only", intent });
      console.log("Kraken accepted validate=true. No order placed; fills and cancellation are NOT verified.");
      return;
    }
    if (!execute && store.pending()) throw new Error("Pending order: reconcile before dry-run");
    if (execute) await trader.reconcile(true);
    let stopped = false;
    let wake: (() => void) | undefined;
    const stop = () => { stopped = true; writeFileSync(KILL, "Shutdown requested\n", { mode: 0o600 }); wake?.(); };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    console.log(`${execute ? "REAL MONEY: exchange submissions enabled" : "Dry-run: no exchange writes"}. ${jev ? "Jev calls are billable" : "Always-hold observer"}.`);
    try {
      while (!stopped) {
        console.log(JSON.stringify(await trader.step()));
        if (store.halted() || existsSync(KILL)) break;
        await new Promise<void>((resolve) => {
          // Two private reads per idle cycle; leave headroom for order queries.
          const timer = setTimeout(resolve, 10_000);
          wake = () => { clearTimeout(timer); resolve(); };
        });
        wake = undefined;
      }
    } finally {
      try { if (execute) await trader.reconcile(true); }
      finally { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); }
    }
  } finally { store?.close(); release(); }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error && error.name !== "ZodError" ? error.message : "Invalid Kraken response; stopped safely");
  process.exitCode = 1;
});
