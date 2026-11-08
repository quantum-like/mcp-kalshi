# @iqai/mcp-kalshi

## 0.1.11

### Patch Changes

- The host lock is a sibling directory outside the state path, so replacing
  that directory does not admit a second holder. The holder fails closed
  when the state inode changes. `releaseUnsent` frees a hold only when the
  reservation was never dispatched. Submitting, partial, and unknown
  commitments stay reserved. A fill must name the reserved YES/NO outcome.
  Load checks an external fingerprint and directory inode, and refuses a
  coherent fee rewrite, a snapshot rollback, or a market relabel that does
  not match that anchor. Rewriting the anchor as well is outside the claim.
  See `docs/olga/TRUST.md`. Orders stay disabled. This is not macOS
  acceptance.

## 0.1.10

### Patch Changes

- Bind every reservation and fill to a market ticker. A missing ticker or a
  different instrument cannot book or cover inventory. Exit holds must match
  identified sells. A sell's covered fee plus its extra fee must equal its
  own fee quote. Duplicate reservation ids are rejected. An unsent
  submitting order can be released by cancelling the resting size. The host
  lock is the state directory inode, so replacing the lock file path does
  not admit a second holder. Orders stay disabled.

## 0.1.9

### Patch Changes

- Replay saved fills against reservations. Duplicate fill ids, fills with
  no position, naked sells, and buy prices outside (0, 1) or above the
  reserved limit are rejected. A release cannot hide an open buy. Released
  history must stay finite. Partial sells keep the exit-fee hold consistent.
  External capital stays 5.000000. Orders stay disabled.

## 0.1.8

### Patch Changes

- Reject saved zero or negative contract counts and holds below the
  fee-inclusive quote. Realized profit changes only through an identified
  fill. A sell reuses the buy's exit-fee hold instead of reserving it twice.
  Partial fills release paid notional and entry fees from the original
  amounts. The clock watermark never moves backward. Host identity is read
  from the operating system, not from a caller string. Orders stay disabled.

## 0.1.7

### Patch Changes

- Correct the disabled Olga bankroll. External capital stays 5.000000.
  Realized profits can be reserved again. Losses and costs deduct. Unrealized
  profit and external top-ups are refused. Reservations include fees, and a
  saved negative or non-finite amount is rejected.
- Lock the host with Node's built-in SQLite exclusive lock, which the kernel
  releases on crash on Linux and macOS. Bind the owner to the confirmed Olga
  machine id. A text label is not accepted.
- Persist the clock after a successful WAIT. A missing or skewed exchange
  clock, or a stale feed, stops the tick. Orders stay disabled. No policy is
  sealed. a2 is unchanged.

## 0.1.6

### Patch Changes

- Add a disabled Olga-local a1 candidate. The launchd document is not loaded
  and its program is `/usr/bin/false`. Durable host, risk, policy, binding,
  and clock files fail closed. The $5 cap does not reset on profit or restart.
  Unknown policy decides WAIT. No order path and no a2 change.

## 0.1.5

### Patch Changes

- Make `node offline-accept.mjs` count both TAP (`# tests N`) and the Node
  spec reporter (`ℹ tests N`). Node 24's default spec summary was parsed as
  zero tests. The command still exits nonzero for zero tests, the wrong count,
  or a failing test. The a1 and a2 profiles are unchanged.

## 0.1.4

### Patch Changes

- Default the server to a disarmed read-only a1 profile. Mutation tools are not
  registered, and direct create, cancel, decrease, and batch calls throw before
  any SDK client is constructed. `KALSHI_MCP_PROFILE=a2` is the explicit opt-in
  that keeps the deployed 0.1.2 order behavior.
- Require a fresh per-market price grid for every a1 cent or dollar price.
  Off-grid and stale prices are rejected and are not rounded onto the grid.
- Recover unknown intents only by scanning complete order and fill reads.
  That recovery never submits again.
- Quarantine every dated record until an operator config names the source
  clock. The guard does not treat Los Angeles dates as the original holdout.

## 0.1.3

### Patch Changes

- Add disarmed a1 reads and strategy accounting beside the 0.1.2 order contract.
  Structured balance, position, order, fill, and settlement reads report cursors
  and UNKNOWN for missing fixed-point fields. Optional dollar prices require a
  fresh price grid. Optional clientOrderId is caller-stable. The $5 ledger
  stays disarmed, does not submit orders, and does not constrain other account
  callers or the SENATEAK holding.

## 0.1.2

### Patch Changes

- Pin kalshi-typescript to 3.35.0 and map order writes to the V2 event-order API.
  CREATE_ORDER translates YES/NO buy/sell cents onto the YES book, sends fixed-point
  counts and dollar prices, and does not retry. Cancel and decrease require a market
  ticker and use the V2 acknowledgement shape. Amend and batch create stay fail-closed.
  Read tools follow the SDK 3.35 fixed-point fields and the shifted getMarkets and
  getPositions argument lists. This fork is not published to npm.

## 0.1.1

### Patch Changes

- eed3c34: Fix lazy client initialization and upgrade fastmcp to 3.30.1
  - Use getter for KalshiClient to defer initialization until first API call
  - This allows the MCP server to start without requiring KALSHI_API_KEY
  - Upgrade fastmcp from 1.27.7 to 3.30.1 to fix completions compatibility

## 0.1.0

### Minor Changes

- 1bd6e8e: feat: initial release of Kalshi MCP server

  MCP server for interacting with Kalshi prediction markets including:

  - Market discovery and search
  - Market details and series information
  - Read-only access for market research
