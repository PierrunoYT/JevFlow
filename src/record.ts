import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { recordMarket } from "./recorder";

async function main() {
  const args = process.argv.slice(2);
  const symbol = args[0] && !args[0].startsWith("--") ? args.shift()! : "BTC/CHF";
  let seconds = 60;
  let directory = `data/recording-${Date.now()}`;
  while (args.length) {
    const flag = args.shift();
    const value = args.shift();
    if (flag === "--seconds" && value) seconds = Number(value);
    else if (flag === "--out" && value) directory = value;
    else throw new Error("Usage: bun run record [BTC/CHF] [--seconds 60] [--out NEW_DIRECTORY]");
  }
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    mkdirSync(dirname(directory), { recursive: true });
    const summary = await recordMarket({ symbol, directory, durationMs: seconds * 1_000, signal: controller.signal });
    console.log(JSON.stringify({ ...summary, directory }, null, 2));
    if (!summary.events) throw new Error("No usable events recorded; inspect raw.jsonl for connection failures");
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Recording failed");
  process.exitCode = 1;
});
