# Integration status

This is the implemented boundary. It is not a certificate for the Nov 7 windows and not a fresh BRTI claim. The completed-hour history route is not a live feed: an empty HTTP 200 body is the current hour.

The real tape schema is not in this workspace. The tested adapter accepts only `brti-recertify-input-1`:

| Field | Required type | Meaning |
| --- | --- | --- |
| `hourIso` | hour-aligned UTC string | Completed hour start |
| `closedAtMs` | finite Unix milliseconds | Window close |
| `brti` | `{time, value}[]` | Raw completed-hour rows |
| `quotes` | `{timeMs, bid, ask}[]` | Bid and ask are positive decimal strings or the side is missing |
| `trades` | `{tradeId, manifestId, timeMs}[]` | Unique trade ids |
| `manifests` | `{manifestId, tradeIds}[]` | Each listed trade must be on the tape, and each tape trade must be listed |
| `revisions` | `{tradeId, revisedAtMs}[]` | A time after `closedAtMs` is late |
| `outcome` | `{result: "yes" or "no", joinedAtMs}` or `null` | A join after close is late; `null` is missing |

Anything else, including an operator count summary, is rejected. Counts such as 524455 trades are not rows.

## What runs

| Piece | State | Test id |
| --- | --- | --- |
| Completed-hour raw BRTI grid, 18000 rows, 200 ms, edges | Implemented in `certifyRows`, called by `recertify` | `synthetic complete window passes data gates and stays uncertified` |
| Empty HTTP 200 current hour is not a live feed | Implemented in `assessHistoryResponse` | `empty current hour is not a live feed and gaps stay uncertified` |
| Quote bid and ask coverage | Implemented in `recertify` | `missing bid or ask fails closed` |
| Trade and manifest completeness | Implemented in `recertify` | `incomplete trade tape fails closed` |
| Late revision | Implemented in `recertify` | `late revision fails closed` |
| Outcome join and late outcome | Implemented in `recertify` | `late outcome fails closed` |
| Export record | Implemented as `exportRecertification`; it does not write `CERTIFIED.json` | `synthetic complete window passes data gates and stays uncertified` |
| Missing stored sidecar | Implemented; `integrity_incident` before HTTP | `a missing deduped hash is an integrity incident before HTTP and bytes stay` |
| Nov 7 and quote-coverage observations | Recorded and refused as tapes | `operator Nov 7 summary is not recertified as a tape` |

A synthetic fixture whose data gates pass is still `NOT_CERTIFIED`. Provisional Coinbase and return thresholds are not a certificate.

## What is not implemented

The real Nov 7 files are absent, so there is no loader for their schema, no export of those windows, and no claim they are complete. Startup gaps, a 4 second internal gap, 303 snapshots missing bid or ask, and quote-timing candidates stay uncertified observations. FIT, PREREG, VALIDATE, and paper are not this pipeline.
