import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { BinanceTestnet, balance, decimal, TESTNET } from "./binance";
import { createJevPredictor } from "./jev";
import { acquireTradingLock, TestnetTrader, TradingStore } from "./trading";
import type { Predictor } from "./types";

const STATE = "data/testnet.sqlite";
const LOCK = "data/testnet.lock";
const KILL = "data/testnet.STOP";
const hold: Predictor = async () => ({ model: "always-hold", latencyMs: 0,
  prediction: { type: "choice", choice: "hold", probabilities: { buy: 0, sell: 0, hold: 1 }, confidence: 1 } });

async function main() {
  const args = process.argv.slice(2);
  const command = args.shift() ?? "check";
  const execute = args.includes("--execute-testnet");
  const jev = args.includes("--jev");
  const reset = args.includes("--acknowledge-risk-reset");
  if (!['check', 'status', 'run', 'reconcile', 'reset-risk', 'stop'].includes(command) ||
    args.some((arg) => !['--execute-testnet', '--jev', '--acknowledge-risk-reset'].includes(arg)) ||
    ((execute || jev) && command !== "run") || (reset && command !== "reset-risk")) throw new Error("Usage: bun run testnet check|status|stop|reconcile|reset-risk --acknowledge-risk-reset|run [--jev] [--execute-testnet]");
  if (execute && !jev) throw new Error("Testnet submission requires --jev; the synthetic baseline cannot place exchange orders");
  if (command === "reset-risk" && !reset) throw new Error("Risk reset requires --acknowledge-risk-reset after exchange inspection");
  if (command === "stop") {
    mkdirSync("data", { recursive: true });
    writeFileSync(KILL, "Manual stop requested\n", { mode: 0o600 });
    console.log("Stop file created. The running process will cancel its tracked order if reachable; verify with testnet reconcile.");
    return;
  }
  const key = process.env.BINANCE_TESTNET_API_KEY ?? "";
  const secret = process.env.BINANCE_TESTNET_API_SECRET ?? "";
  if (command !== "check" && (!key || !secret)) throw new Error("Set BINANCE_TESTNET_API_KEY and BINANCE_TESTNET_API_SECRET via secrets; Testnet only");
  const exchange = new BinanceTestnet(key, secret);
  await exchange.syncTime();
  if (command === "check") {
    const rules = await exchange.rules();
    const book = await exchange.ticker();
    console.log(JSON.stringify({ environment: TESTNET, book,
      rules: Object.fromEntries(Object.entries(rules).map(([k, v]) => [k, decimal(v)])),
      readyForRealMoney: false }, null, 2));
    return;
  }
  if (command === "status") {
    const account = await exchange.account();
    console.log(JSON.stringify({ environment: TESTNET, canTrade: account.canTrade,
      balances: ["BTC", "USDT"].map((asset) => { const b = balance(account, asset); return { asset, free: decimal(b.free), locked: decimal(b.locked) }; }),
      openOrders: await exchange.openOrders() }, null, 2));
    return;
  }
  mkdirSync("data", { recursive: true });
  const release = acquireTradingLock(LOCK);
  let store: TradingStore | undefined;
  try {
    store = new TradingStore(STATE, key);
    if (command === "reset-risk") {
      if (existsSync(KILL)) throw new Error("Remove the stop file only after reviewing the account");
      if ((await exchange.openOrders()).length) throw new Error("Open orders prevent risk reset");
      store.resetRisk();
      console.log("Risk halt and high-water mark reset; audit history retained.");
      return;
    }
    const predict = jev ? createJevPredictor(process.env.TYPESAFE_API_KEY ?? "") : hold;
    const trader = new TestnetTrader(exchange, store, await exchange.rules(), predict, KILL, execute);
    if (command === "reconcile") {
      await trader.reconcile(true);
      console.log(JSON.stringify({ pending: store.pending(), halted: store.halted(), openOrders: await exchange.openOrders() }, null, 2));
      return;
    }
    if (store.halted()) throw new Error("Persisted halt: inspect account, reconcile, then explicitly reset risk");
    if (!execute && store.pending()) throw new Error("Pending order: run testnet reconcile before dry-run");
    // On restart resolve/cancel old intent before any new prediction.
    if (execute) await trader.reconcile(true);
    let stopped = false;
    let wake: (() => void) | undefined;
    const stop = () => { stopped = true; writeFileSync(KILL, "Shutdown requested\n", { mode: 0o600 }); wake?.(); };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    console.log(`TESTNET ONLY. ${execute ? "Exchange submissions enabled" : "Dry-run: no new orders"}. ${jev ? "Jev calls are billable" : "Always-hold observer"}.`);
    try {
      while (!stopped) {
        const result = await trader.step();
        console.log(JSON.stringify(result));
        if (store.halted() || existsSync(KILL)) break;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 5_000);
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
  // Schema errors can include remote payloads; do not print those or request URLs.
  console.error(error instanceof Error && error.name !== "ZodError" ? error.message : "Invalid exchange response; stopped safely");
  process.exitCode = 1;
});
