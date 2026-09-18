import { createReadStream, closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { createJevPredictor, imbalanceBaseline } from "./jev";
import { replay } from "./replay";
import type { MarketEvent } from "./types";

function* demo(): Generator<MarketEvent> {
  for (let i = 0; i < 240; i++) {
    const timestampMs = 1_800_000_000_000 + i * 1_000;
    const rising = Math.floor(i / 30) % 2 === 0;
    const mid = 100 + Math.sin(i / 15) * 0.1;
    yield { type: "book", market: "DEMO-USD", timestampMs, bid: mid - 0.02, ask: mid + 0.02,
      bidSize: rising ? 8 : 2, askSize: rising ? 2 : 8 };
    yield { type: "trade", market: "DEMO-USD", timestampMs: timestampMs + 200,
      price: mid + (rising ? -0.03 : 0.03), size: 0.4, side: rising ? "sell" : "buy" };
  }
}

async function* readEvents(path: string) {
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  let lineNumber = 0;
  for await (const line of lines) {
    lineNumber++;
    if (!line.trim()) continue;
    try { yield JSON.parse(line); }
    catch { throw new Error(`Invalid JSON at line ${lineNumber}`); }
  }
}

async function main() {
  const args = process.argv.slice(2);
  const mode = args.shift();
  const input = mode === "replay" ? args.shift() : undefined;
  let useJev = false;
  let output = `data/run-${Date.now()}.jsonl`;
  while (args.length) {
    const arg = args.shift();
    if (arg === "--jev") useJev = true;
    else if (arg === "--out" && args[0]) output = args.shift()!;
    else throw new Error(`Unknown or incomplete option: ${arg}`);
  }
  if ((mode !== "demo" && mode !== "replay") || (mode === "replay" && !input)) {
    throw new Error("Usage: bun src/index.ts demo [--out PATH] | replay INPUT.jsonl [--jev] [--out PATH]");
  }
  if (mode === "demo" && useJev) throw new Error("Use recorded events with --jev; demo is offline only");
  if (input && resolve(input) === resolve(output)) throw new Error("Input and audit output must differ");
  const predict = useJev ? createJevPredictor(process.env.TYPESAFE_API_KEY ?? "") : imbalanceBaseline;
  if (useJev) console.error("Querying Jev for historical snapshots. API usage is billable; no orders leave this process.");
  mkdirSync(dirname(output), { recursive: true });
  const fd = openSync(output, "wx", 0o600);
  try {
    writeSync(fd, JSON.stringify({ type: "run", mode, predictor: useJev ? "jev-1.13.0" : "uncalibrated-imbalance-baseline" }) + "\n");
    const summary = await replay(input ? readEvents(input) : demo(), predict,
      (record) => { writeSync(fd, JSON.stringify(record) + "\n"); });
    console.log(JSON.stringify({ ...summary, auditFile: output }, null, 2));
  } finally { closeSync(fd); }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Run failed");
  process.exitCode = 1;
});
