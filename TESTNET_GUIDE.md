# Binance Spot Testnet operator guide

This is an experimental execution foundation, **not a real-money-ready strategy**.
Only BTCUSDT at `https://testnet.binance.vision` is supported. The origin is fixed
in code; there is no production flag. Testnet uses virtual assets with no monetary
value. Never send real money to a Testnet address or give this bot production keys.

## Account and first checks

1. Use the official [Binance Spot Testnet](https://testnet.binance.vision/) where
   legally available. Follow its account/key instructions and use its virtual
   balances; do not deposit real funds. Testnet may periodically reset balances
   and orders.
2. Create Testnet HMAC credentials with account-read and spot-trading access.
   Use a dedicated account, not one shared with another bot or manual trader.
3. Copy `.env.example` to ignored `.env`, or configure secrets through your
   environment. Set `BINANCE_TESTNET_API_KEY` and `BINANCE_TESTNET_API_SECRET`.
   Never paste keys into chat, logs, command arguments, or tracked files.
4. Run from the repository root:

```bash
bun install --frozen-lockfile
bun test
bun run typecheck
bun run testnet check
bun run testnet status
bun run testnet run
```

`check` uses only public endpoints. `status` reads BTC/USDT balances and BTCUSDT
open orders without placing or canceling anything. `run` defaults to an always-hold
observer: authenticated reads and local risk/audit updates, but no model calls or
exchange writes. Ctrl+C requests shutdown and creates a persistent stop file.

**Verification limitation:** this orb's public Testnet check returned HTTP 451.
No authenticated exchange lifecycle or real Jev call has been verified here.
Do not bypass exchange restrictions; use an eligible environment and account.
Mock tests do not establish live API compatibility or strategy profitability.

## Explicit model and execution opt-ins

Set `TYPESAFE_API_KEY` before opting into billable Jev requests:

```bash
# Jev predictions and proposed orders, but no exchange submissions/cancellations:
bun run testnet run --jev

# Virtual Testnet orders only; run after dry-run inspection and risk-reset checks:
bun run testnet run --jev --execute-testnet
```

Execution requires both flags. The uncalibrated demo baseline cannot submit
exchange orders. Existing unresolved orders block dry-run; use `reconcile` first.
There is no forced test-order command: a valid model decision and all gates are
required. No order is guaranteed to occur or fill.

## Execution safeguards and their limits

- One durable intent at a time; recorded in SQLite **before** POST. No automatic
  submission retries. Missing acknowledgements, malformed responses, and errors
  halt new submissions while preserving the pending intent.
- Long-only LIMIT_MAKER orders, up to 25 USDT each, 500 USDT maximum proposed BTC
  exposure including locked BTC, and at most 100 submission attempts per UTC day.
  Existing Testnet faucet BTC can already exceed the buy exposure cap. Selling
  requires free BTC; no shorting or leverage is supported.
- Exact eight-decimal integer sizing: prices round outward to ticks, quantities
  round down to lot steps, and min/max notional is checked after rounding. Buys
  reserve 1% for fees. The exchange still enforces dynamic filters; these checks
  do not guarantee acceptance. Filters are loaded at startup.
- A 25 USDT drop from persisted peak BTC/USDT account equity latches a halt.
  Equity includes free and locked BTC valued at bid plus USDT. This is **not
  isolated strategy P&L**: existing holdings, deposits, withdrawals, and Testnet
  resets affect it. Other assets and detailed fee accounting are not included.
  The limit cannot guarantee maximum loss and does not liquidate inventory.
- Cycles wait five seconds between iterations. REST account/book requests plus
  prediction must finish within one second. Warmup requires 60 seconds and ten
  book observations, restarting after observation gaps over ten seconds.
  This runner uses REST book-only features, not the public recorder's trade feed;
  VWAP is null and trade flow is unavailable. No exchange book timestamp is
  supplied by this endpoint, so the age check measures request/decision latency.
- Probability ≥ 0.65 and confidence ≥ 0.55 are unvalidated gates. No fresh model
  decision is requested while an order rests. Orders are canceled when observed
  at least 15 seconds old, on a risk halt, or during shutdown. Polling, network
  delays, and outages can leave them active longer; this is not server-side expiry.
- Reconciliation checks identity and cumulative fills, queries by exchange order
  ID once known, and requires terminal confirmation after cancellation. It never
  cancels untracked orders. Foreign BTCUSDT orders block new submissions.
- Requests have a five-second timeout, prohibit redirects, and sign encoded
  parameters with HMAC. Rate-limit responses trigger in-process cooldown. Restarting
  does not preserve cooldown, so respect exchange Retry-After instructions.

## Stop and recover

```bash
bun run testnet stop
```

This writes `data/testnet.STOP` without needing credentials or network access.
The running loop checks it and attempts to cancel its tracked order. SIGINT and
SIGTERM also create the file and attempt cleanup. **Neither a stop request nor
process exit proves the exchange canceled an order.** If the bot is unreachable,
inspect and cancel orders through the official exchange interface.

Once the original process has exited:

```bash
bun run testnet status
bun run testnet reconcile
```

`reconcile` is an exchange-write command: it queries and, if still active,
cancels the tracked order, then checks terminal status. It preserves the halt.
If the exchange cannot confirm the order, leave the bot stopped. Even an
order-not-found response does not clear the intent: an earlier submission may
have succeeded. Explicit submission rejections are also retained conservatively.
There is currently no automatic or CLI “forget unknown order” recovery. Retain
the database and investigate exchange history; do not delete state to resume.
Testnet resets and API-key rotation can require manual, reviewed state recovery.

After confirming no open or unresolved orders and reviewing the cause of the
halt, remove `data/testnet.STOP` manually and explicitly reset risk:

```bash
bun run testnet reset-risk --acknowledge-risk-reset
```

Reset refuses a stop file, unresolved intent, or open BTCUSDT orders. It clears
the halt and equity high-water mark, but preserves the audit and daily attempt
counts. Restarting alone does not clear a halt. Resetting is an operator decision,
not routine automatic recovery from a loss.

## Local state and operation

- `data/testnet.sqlite`: durable intent, API-key fingerprint, risk high-water mark,
  halt, daily counts, and audit records. Uses FULL SQLite synchronous writes.
  Back up the database with the process stopped; never commit it. Audit records
  include balances, model evaluations, and orders, not credentials. They are
  private financial data and currently grow without automatic retention.
- `data/testnet.lock`: exclusive local process lock. A crash can leave it behind.
  Remove only after verifying no trader is running and inspecting exchange orders.
- `data/testnet.STOP`: persistent manual/shutdown stop request.

Only one checkout/process may use the account. The lock does not coordinate
different directories, machines, or other exchange clients. Keep the working
directory and state files stable between runs. The database is bound to the API
key fingerprint; changing keys is not treated as a new empty account.

For an unattended observer in an Amp orb, use a supervised service rather than
shell backgrounding:

```bash
amp orb service start jevflow-testnet --command 'bun run testnet run'
amp orb service logs jevflow-testnet
# Request the bot stop, stop the supervisor, then inspect/reconcile the exchange:
bun run testnet stop
amp orb service stop jevflow-testnet
```

Do not enable unattended exchange execution until supervised placement, partial
fill, cancellation, restart recovery, and kill-switch checks succeed on the
actual Testnet. Production trading additionally needs real-market evaluation
including fees and slippage, calibrated gates, reliable monitoring, authenticated
execution validation, and a separately reviewed production adapter.
