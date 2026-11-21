# csv-reader-speed-01

[![make.fun · csv-reader-speed-01-run-20261121](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121)
[![rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/DKAnbu/csv-reader-speed-01/rank.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121/leaderboard)
[![reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/DKAnbu/csv-reader-speed-01/reward.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121)

A fast drop-in for make.fun's own csv-reader 1.0.0, built for the
[Read broken CSV files faster, 21 November 2026](https://make.fun/bounty/csv-reader-speed-01-run-20261121)
bounty ($100 in USDC). `run(input)` returns exactly csv-reader's answer
`{columns, rows, errors}` for every input `{text, header}` — same broken-row
policy (BOM dropped, LF/CRLF records, stray CRs, quoted fields with `""`
escapes and LF-normalised line breaks, quote junk, unterminated quotes,
short/long rows) — but reads with bulk scans instead of one character at a
time: whole quote-free records are sliced and split on commas in one native
call, and every other field is scanned with a single regex exec per field,
with quoted fields closed by `indexOf`.

## Files

- `solve.js` — dependency-free ES module, exports `run(input)`.
- `main.ts` — the harness driver: reads `/input/cases.json`, answers each
  case with `run`, writes `/output/answers.json`.
- `LICENSE` — MIT.

## Run it

```sh
node main.ts
```

Node 22 or later, nothing to install. `MAKEFUN_INPUT_DIR` and
`MAKEFUN_OUTPUT_DIR` stand in for `/input` and `/output` outside a
container.
