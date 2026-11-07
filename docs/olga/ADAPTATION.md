# Adaptation that this build actually implements

This build does not trade and it does not claim profitability.

External capital introduced stays `5.000000`. Realized profits can be used again. Realized losses and costs reduce what can be reserved. Unrealized profit cannot. No selector has passed FIT, then PREREG, then VALIDATE, then a forward paper period.

## Implemented

- A durable policy file whose seeded id is `unvalidated`.
- FIT, PREREG, and VALIDATE gates, plus matched-history, source-date, read-parity, and account-binding gates. Initialization writes every gate `false`. Nothing in this build sets a gate to `true`.
- `SEALED_POLICY_IDS` is empty. An unknown policy id, or a file whose gates were edited to `true`, still decides `WAIT`.
- `liveLearning` must stay `false`. Any other adaptation value is refused.
- The policy file cannot carry a risk cap. The $5 total stays in the risk file.

## Not implemented

- No model, no parameter update, and no learning from fills or settlements.
- No FIT, PREREG, or VALIDATE procedure. Those names are closed gates, not a passed study.
- No qualified policy library and no sealed policy id.
- No order, cancel, or resize path from the Olga tick.

`WAIT` means the candidate refuses to invent a strategy. It is not a forecast and it is not evidence that a later policy would make money.
