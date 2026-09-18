import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BinanceNormalizer, recordMarket } from "./recorder";
import { replay } from "./replay";
import { imbalanceBaseline } from "./jev";

const book = (lastUpdateId = 100) => ({ stream: "btcusdt@depth5@100ms", data: {
  lastUpdateId, bids: [["100", "7"], ["99", "2"]], asks: [["100.04", "3"], ["102", "4"]],
} });
const trade = (t = 40, m = true) => ({ stream: "btcusdt@trade", data: {
  e: "trade", s: "BTCUSDT", t, p: "99.99", q: "0.3", T: 1_000, m,
} });

test("normalizes maker flag to aggressor side and retains receive ordering", () => {
  const feed = new BinanceNormalizer("BTCUSDT");
  expect(feed.accept(trade(), 1_000).event).toBeNull();
  expect(feed.accept(book(), 1_001).event).toEqual({ type: "book", market: "BTCUSDT",
    timestampMs: 1_001, bid: 100, ask: 100.04, bidSize: 7, askSize: 3 });
  expect(feed.accept(trade(41), 1_002).event).toMatchObject({ type: "trade", side: "sell", size: 0.3, timestampMs: 1_002 });
  expect(feed.accept(trade(42, false), 1_003).event).toMatchObject({ side: "buy" });
  expect(feed.accept(trade(42, false), 1_004)).toEqual({ event: null, status: "duplicate trade" });
});

test("full snapshots permit skipped/equal book IDs but reject regressions", () => {
  const feed = new BinanceNormalizer("BTCUSDT");
  feed.accept(book(), 0);
  expect(feed.accept(book(150), 100).event?.type).toBe("book");
  expect(feed.accept(book(150), 200).event?.type).toBe("book");
  expect(() => feed.accept(book(149), 300)).toThrow("regressed");
});

test("trade gaps and regressions end a segment instead of silently losing volume", () => {
  for (const next of [39, 42]) {
    const feed = new BinanceNormalizer("BTCUSDT");
    feed.accept(book(), 0);
    feed.accept(trade(), 1);
    expect(() => feed.accept(trade(next), 2)).toThrow("gap or regression");
  }
});

test("rejects stale books, time regression, crossed and unordered snapshots", () => {
  for (const next of [book(101), trade()]) {
    const feed = new BinanceNormalizer("BTCUSDT");
    feed.accept(book(), 10);
    expect(() => feed.accept(next, 1_011)).toThrow();
  }
  const feed = new BinanceNormalizer("BTCUSDT");
  feed.accept(book(), 10);
  expect(() => feed.accept(trade(), 9)).toThrow("clock");
  const crossed = book();
  crossed.data.asks[0][0] = "99.5";
  expect(() => new BinanceNormalizer("BTCUSDT").accept(crossed, 0)).toThrow();
  const unordered = book();
  unordered.data.bids.reverse();
  expect(() => new BinanceNormalizer("BTCUSDT").accept(unordered, 0)).toThrow("ordered");
});

test("rejects wrong symbol, malformed decimals, and unsafe IDs", () => {
  const wrong = trade();
  wrong.data.s = "ETHUSDT";
  expect(() => new BinanceNormalizer("BTCUSDT").accept(wrong, 0)).toThrow("symbol");
  const invalid = trade();
  invalid.data.p = "Infinity";
  expect(() => new BinanceNormalizer("BTCUSDT").accept(invalid, 0)).toThrow();
  expect(() => new BinanceNormalizer("BTCUSDT").accept(book(Number.MAX_SAFE_INTEGER + 1), 0)).toThrow();
});

test("WebSocket gap recovery writes separate replayable segments and preserves raw evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "jevflow-recorder-"));
  const directory = join(root, "session");
  let connections = 0;
  const server = Bun.serve({
    port: 0,
    fetch(request, server) {
      if (server.upgrade(request)) return;
      return new Response("websocket required", { status: 400 });
    },
    websocket: {
      open(socket) {
        connections++;
        socket.send(JSON.stringify(book()));
        socket.send(JSON.stringify(trade()));
        socket.send(JSON.stringify(trade()));
        if (connections === 1) socket.send(JSON.stringify(trade(42))); // missing 41
      },
      message() {},
    },
  });
  try {
    const summary = await recordMarket({ symbol: "BTCUSDT", directory, durationMs: 1_500,
      connect: () => new WebSocket(`ws://127.0.0.1:${server.port}`) });
    expect(summary).toMatchObject({ segments: 2, events: 4, duplicates: 2, interruptions: 1 });
    const raw = readFileSync(join(directory, "raw.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(raw.filter((r) => r.type === "message")).toHaveLength(7);
    expect(raw.find((r) => r.type === "segment-end").reason).toContain("sequence gap");
    for (const name of ["events-0001.jsonl", "events-0002.jsonl"]) {
      const events = readFileSync(join(directory, name), "utf8").trim().split("\n").map((line) => JSON.parse(line));
      expect(events).toHaveLength(2);
      expect((await replay(events, imbalanceBaseline, () => {})).market).toBe("BTCUSDT");
    }
    await expect(recordMarket({ symbol: "BTCUSDT", directory, durationMs: 1 })).rejects.toThrow();
  } finally {
    await server.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
});

test("abort stops recording without waiting for duration", async () => {
  const root = mkdtempSync(join(tmpdir(), "jevflow-abort-"));
  const controller = new AbortController();
  controller.abort();
  try {
    const result = await recordMarket({ symbol: "BTCUSDT", directory: join(root, "session"), durationMs: 60_000,
      signal: controller.signal, connect: () => { throw new Error("Must not connect"); } });
    expect(result.segments).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
