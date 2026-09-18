import { createHash, createHmac } from "node:crypto";
import { z } from "zod";

export const ORIGIN = "https://api.kraken.com";
export const SYMBOL = "BTC/CHF";
export const PAIR = "XBTCHF";
export const SCALE = 100_000_000n;
export function units(value: string): bigint {
  if (!/^\d+(\.\d+)?$/.test(value)) throw new Error("Invalid nonnegative decimal");
  const [whole, raw = ""] = value.split(".");
  const fraction = raw.replace(/0+$/, "");
  if (fraction.length > 8) throw new Error("Unsupported precision (maximum 8 decimal places)");
  return BigInt(whole) * SCALE + BigInt(fraction.padEnd(8, "0"));
}
export function decimal(value: bigint): string {
  if (value < 0n) throw new Error("Negative execution amount");
  return `${value / SCALE}.${(value % SCALE).toString().padStart(8, "0")}`;
}
const amount = z.string().refine((s) => { try { units(s); return true; } catch { return false; } });
const positive = amount.refine((s) => units(s) > 0n);
export interface Account { canTrade: boolean; balances: { asset: string; free: string; locked: string }[] }
export function balance(account: Account, asset: string) {
  const b = account.balances.find((b) => b.asset === asset);
  return { free: units(b?.free ?? "0"), locked: units(b?.locked ?? "0") };
}
export const tickerSchema = z.object({ symbol: z.literal(SYMBOL), bidPrice: positive, askPrice: positive, bidQty: positive, askQty: positive })
  .refine((b) => units(b.bidPrice) < units(b.askPrice), "Crossed book");
export type Ticker = z.infer<typeof tickerSchema>;
export interface Intent { clientId: string; side: "BUY" | "SELL"; price: string; quantity: string; createdAt: number }
export interface Rules { tick: bigint; step: bigint; minQty: bigint; minNotional: bigint }
export interface ExchangeOrder {
  symbol: string; orderId: string; clientOrderId: string; status: "pending" | "open" | "closed" | "canceled" | "expired";
  side: "BUY" | "SELL"; price: string; origQty: string; executedQty: string; cummulativeQuoteQty: string;
}
export const isTerminal = (o: ExchangeOrder) => ["closed", "canceled", "expired"].includes(o.status);
const rawOrder = z.object({ cl_ord_id: z.string().nullable().optional(), status: z.enum(["pending", "open", "closed", "canceled", "expired"]),
  descr: z.object({ pair: z.string(), type: z.enum(["buy", "sell"]), ordertype: z.string(), price: amount, leverage: z.string() }),
  vol: positive, vol_exec: amount, cost: amount });
function orders(value: unknown): ExchangeOrder[] {
  return Object.entries(z.record(z.string(), rawOrder).parse(value)).map(([orderId, o]) => ({
    symbol: [PAIR, "XBT/CHF", "XXBTZCHF", SYMBOL].includes(o.descr.pair) ? SYMBOL : o.descr.pair,
    orderId, clientOrderId: o.cl_ord_id ?? "", status: o.status,
    side: o.descr.type === "buy" ? "BUY" : "SELL", price: o.descr.price,
    origQty: o.vol, executedQty: o.vol_exec, cummulativeQuoteQty: o.cost,
  }));
}
export function parseRules(value: unknown): Rules {
  const pairs = z.record(z.string(), z.object({ altname: z.string(), base: z.string(), quote: z.string(),
    status: z.string(), lot_decimals: z.number().int().min(0).max(8), lot_multiplier: z.literal(1),
    tick_size: positive, ordermin: positive, costmin: positive })).parse(value);
  const pair = Object.values(pairs).find((p) => p.altname === PAIR);
  if (!pair || pair.base !== "XXBT" || pair.quote !== "CHF" || pair.status !== "online") throw new Error("BTC/CHF spot market unavailable");
  return { tick: units(pair.tick_size), step: 10n ** BigInt(8 - pair.lot_decimals), minQty: units(pair.ordermin), minNotional: units(pair.costmin) };
}
export function sizeOrder(side: "BUY" | "SELL", book: Ticker, rules: Rules, account: Account) {
  if (!account.canTrade) throw new Error("Account trading disabled");
  const bid = units(book.bidPrice), ask = units(book.askPrice);
  if ((ask - bid) * 20_000n > (ask + bid) * 10n) throw new Error("Spread exceeds 10 bps");
  const price = side === "BUY" ? bid / rules.tick * rules.tick : (ask + rules.tick - 1n) / rules.tick * rules.tick;
  if (!price) throw new Error("Invalid rounded price");
  const btc = balance(account, "BTC"), chf = balance(account, "CHF");
  const budget = units("10");
  const available = side === "BUY" ? budget * SCALE / price : (btc.free < budget * SCALE / price ? btc.free : budget * SCALE / price);
  const quantity = available / rules.step * rules.step;
  const notional = price * quantity;
  if (quantity < rules.minQty || notional < rules.minNotional * SCALE) throw new Error("Rounded order below lot/notional minimum");
  if (side === "BUY") {
    if (notional * 101n > chf.free * SCALE * 100n) throw new Error("Insufficient free CHF including fee reserve");
    if ((btc.free + btc.locked + quantity) * ask > units("50") * SCALE) throw new Error("BTC exposure would exceed 50 CHF");
  }
  return { price: decimal(price), quantity: decimal(quantity) };
}

export function sign(path: string, nonce: string, body: string, secret: string) {
  return createHmac("sha512", Buffer.from(secret, "base64"))
    .update(Buffer.concat([Buffer.from(path), createHash("sha256").update(nonce + body).digest()])).digest("base64");
}

export class Kraken {
  private blockedUntil = 0;
  constructor(private key = "", private secret = "", private nonce?: () => string,
    private request: (url: string, init: RequestInit) => Promise<Response> = fetch,
    private allowOrders = false) {}

  private async call(endpoint: string, values: Record<string, string> = {}, privateCall = false): Promise<unknown> {
    if (Date.now() < this.blockedUntil) throw new Error("Exchange rate-limit cooldown active");
    const path = `/0/${privateCall ? "private" : "public"}/${endpoint}`;
    const headers: Record<string, string> = {};
    let params = new URLSearchParams(values);
    if (privateCall) {
      if (!this.key || !this.secret || !this.nonce) throw new Error("Kraken credentials and persistent nonce are required");
      const nonce = this.nonce();
      params = new URLSearchParams({ nonce, ...values });
      headers["API-Key"] = this.key;
      headers["API-Sign"] = sign(path, nonce, params.toString(), this.secret);
      headers["Content-Type"] = "application/x-www-form-urlencoded";
    }
    let response: Response;
    try {
      response = await this.request(`${ORIGIN}${path}${privateCall ? "" : `?${params}`}`, {
        method: privateCall ? "POST" : "GET", headers, body: privateCall ? params.toString() : undefined,
        redirect: "error", signal: AbortSignal.timeout(5_000),
      });
    } catch { throw new Error("Kraken transport failure; any submitted order has UNKNOWN status"); }
    if (response.status === 429) {
      const seconds = Number(response.headers.get("Retry-After"));
      this.blockedUntil = Date.now() + (Number.isFinite(seconds) && seconds > 0 ? seconds : 60) * 1_000;
    }
    if (!response.ok) throw new Error(`Kraken HTTP ${response.status}`);
    const result = z.object({ error: z.array(z.string()), result: z.unknown().optional() }).parse(await response.json());
    if (result.error.length) {
      if (result.error.some((e) => /rate limit|throttled/i.test(e))) this.blockedUntil = Date.now() + 60_000;
      // Do not expose arbitrary remote messages or accidentally log request details.
      throw new Error("Kraken rejected request; inspect permissions, funds, limits, and order status");
    }
    return result.result;
  }
  async rules() { return parseRules(await this.call("AssetPairs", { pair: PAIR, country_code: "CH" })); }
  async ticker(): Promise<Ticker> {
    const level = z.tuple([positive, positive, z.number().finite().nonnegative()]);
    const data = z.record(z.string(), z.object({ bids: z.array(level).min(1), asks: z.array(level).min(1) })).parse(await this.call("Depth", { pair: PAIR, count: "1" }));
    const entries = Object.entries(data);
    if (entries.length !== 1 || !["XXBTZCHF", PAIR].includes(entries[0][0])) throw new Error("Unexpected depth market");
    const b = entries[0][1];
    return tickerSchema.parse({ symbol: SYMBOL, bidPrice: b.bids[0][0], bidQty: b.bids[0][1], askPrice: b.asks[0][0], askQty: b.asks[0][1] });
  }
  async account(): Promise<Account> {
    const data = z.record(z.string(), z.object({ balance: amount, hold_trade: amount, credit: amount.optional(), credit_used: amount.optional() }))
      .parse(await this.call("BalanceEx", {}, true));
    if (Object.values(data).some((b) => units(b.credit ?? "0") || units(b.credit_used ?? "0"))) throw new Error("Credit accounts are not supported");
    return { canTrade: true, balances: [["XXBT", "BTC"], ["CHF", "CHF"]].map(([key, asset]) => {
      const b = data[key];
      const total = units(b?.balance ?? "0"), held = units(b?.hold_trade ?? "0");
      if (held > total) throw new Error("Held funds exceed cash balance");
      return { asset, free: decimal(total - held), locked: decimal(held) };
    }) };
  }
  async openOrders() {
    const data = z.object({ open: z.unknown() }).parse(await this.call("OpenOrders", {}, true));
    return orders(data.open); // All markets: refuse shared-account interference.
  }
  async place(intent: Intent) {
    if (!this.allowOrders) throw new Error("Live exchange writes are disabled");
    const result = z.object({ txid: z.array(z.string().min(1)).length(1) }).parse(await this.call("AddOrder", this.orderParams(intent), true));
    return this.query(intent, result.txid[0]);
  }
  private orderParams(i: Intent) {
    return { pair: PAIR, type: i.side.toLowerCase(), ordertype: "limit", price: i.price, volume: i.quantity,
      cl_ord_id: i.clientId, oflags: "post,fciq", timeinforce: "GTD", expiretm: "+15", leverage: "none" };
  }
  async validate(intent: Intent) {
    z.object({ descr: z.object({ order: z.string() }) }).parse(
      await this.call("AddOrder", { ...this.orderParams(intent), validate: "true" }, true));
  }
  async query(intent: Intent, orderId?: string): Promise<ExchangeOrder> {
    if (orderId) {
      const found = orders(await this.call("QueryOrders", { txid: orderId }, true));
      if (found.length !== 1 || found[0].orderId !== orderId) throw new Error("Unconfirmed exchange order");
      return found[0];
    }
    const open = (await this.openOrders()).filter((o) => o.clientOrderId === intent.clientId);
    if (open.length === 1) return open[0];
    if (open.length > 1) throw new Error("Ambiguous order identity");
    // Lost AddOrder acknowledgement: find by durable UUID in bounded closed history.
    // Absence never permits resubmission, including after this bounded scan.
    for (let offset = 0; offset < 1_000; offset += 50) {
      const page = z.object({ closed: z.unknown(), count: z.number().int().nonnegative() }).parse(await this.call("ClosedOrders", { ofs: String(offset) }, true));
      const found = orders(page.closed).filter((o) => o.clientOrderId === intent.clientId);
      if (found.length === 1) return found[0];
      if (found.length > 1) throw new Error("Ambiguous order identity");
      if (offset + 50 >= page.count) break;
    }
    throw new Error("Order status UNKNOWN; inspect exchange history, do not resubmit");
  }
  async cancel(orderId: string) {
    if (!this.allowOrders) throw new Error("Live exchange writes are disabled");
    await this.call("CancelOrder", { txid: orderId }, true);
  }
}
