import type { Book, Features, Trade } from "./types";

export class FeatureEngine {
  private books: Book[] = [];
  private trades: Trade[] = [];

  trade(trade: Trade) {
    this.trades.push(trade);
    this.prune(trade.timestampMs);
  }

  private prune(now: number) {
    this.books = this.books.filter((b) => b.timestampMs >= now - 60_000);
    this.trades = this.trades.filter((t) => t.timestampMs >= now - 60_000);
  }

  book(book: Book): Features {
    this.prune(book.timestampMs);
    this.books.push(book);
    const first = this.books[0];
    const mid = (book.bid + book.ask) / 2;
    const start = (first.bid + first.ask) / 2;
    let buys = 0;
    let sells = 0;
    let notional = 0;
    for (const trade of this.trades) {
      if (trade.side === "buy") buys += trade.size;
      else sells += trade.size;
      notional += trade.price * trade.size;
    }
    return {
      market: book.market,
      timestampMs: book.timestampMs,
      mid,
      spreadBps: (book.ask - book.bid) / mid * 10_000,
      returnBps: (mid / start - 1) * 10_000,
      bookImbalance: (book.bidSize - book.askSize) / (book.bidSize + book.askSize),
      flowImbalance: buys + sells === 0 ? 0 : (buys - sells) / (buys + sells),
      volumeDelta: buys - sells,
      vwap: buys + sells === 0 ? null : notional / (buys + sells),
      observations: this.books.length,
    };
  }
}
