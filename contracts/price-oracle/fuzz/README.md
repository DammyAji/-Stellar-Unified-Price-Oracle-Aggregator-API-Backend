# Fuzz targets for the price oracle

This directory contains the [cargo-fuzz](https://github.com/rust-fuzz/cargo-fuzz)
harness for the price oracle contract. The targets are compiled and run with a
pinned nightly toolchain (see `rust-toolchain.toml` in this directory) so that
local runs and CI runs are reproducible.

## Running locally

```sh
# short smoke run (same budget as the PR job)
cargo +nightly fuzz run fuzz_get_price -- -max_total_time=60
cargo +nightly fuzz run fuzz_submit_price -- -max_total_time=60

# longer run (same budget as the scheduled job)
cargo +nightly fuzz run fuzz_get_price -- -max_total_time=900
cargo +nightly fuzz run fuzz_submit_price -- -max_total_time=900
```

## Targets

### `fuzz_get_price`

- **Entrypoint under test:** `PriceOracle::get_price` (read path).
- **Invariants asserted:**
  - `get_price` never panics for any asset name / caller combination.
  - A price that was successfully submitted is returned unchanged by a
    subsequent `get_price` for the same asset.
  - Reading an asset that was never submitted returns the documented
    "no price" result rather than panicking.
- **What a failure means:** a panic or an invariant violation on the read path.
  A crash here is a correctness bug in `get_price` (or in the storage it
  reads) and must be fixed before the target is allowed to pass again.

### `fuzz_submit_price`

- **Entrypoint under test:** `PriceOracle::submit_price` (write path).
- **Invariants asserted:**
  - `submit_price` never panics for any caller, asset name, price or decimal
    combination, including unauthorized callers, maximum prices, very long
    asset names and large decimal values.
  - An unauthorized submission is rejected and does not mutate stored state.
  - A successful submission is observable through `get_price`.
- **What a failure means:** a panic or an invariant violation on the write
  path. A crash here is a correctness or authorization bug in
  `submit_price` and must be fixed before the target is allowed to pass again.

## Corpus growth policy

- The seeds committed under `corpus/<target>/` are the starting point for every
  run and are checked into the repository.
- When a target finds a new input, the crashing input is committed as a
  regression seed under `corpus/<target>/` so that the same input is exercised
  on every subsequent run.
- The corpus is only ever grown; seeds are not deleted when a bug is fixed.

## Crash triage path

1. A crash fails the workflow (the fuzz job exits non-zero); it is never
   downgraded to a warning.
2. The crashing input is downloaded from the uploaded crash artifacts and
   committed as a regression seed under `corpus/<target>/`.
3. A regression test reproducing the crash is added to the relevant
   `src/*_test.rs` file so the failure is caught by `cargo test` as well.
4. The underlying bug is fixed and the target is re-run to confirm the crash
   no longer reproduces.

## Coverage signal

The fuzz job reports corpus size, edges covered and executions per second for
each target. A target that stops exploring (flat corpus, flat edge count) is
visible in the report even when it does not crash, so a silently-broken target
cannot hide behind a green job.

## Relationship to the deterministic checks

The SMT and TLA+ checks in this repository are deterministic and exhaustive
over their models. The fuzz targets are complementary: they explore concrete
inputs beyond the committed seeds and are not a substitute for the SMT/TLA+
proofs. When documenting verification, keep the two layers distinct — a green
fuzz run does not discharge an SMT/TLA+ obligation, and vice versa.
