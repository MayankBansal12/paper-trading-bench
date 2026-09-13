# Simplification qualification evidence

The [evidence index](evidence.json) records checks, limitations, source revisions and archive SHA-256s. The [live journal review](live-review.md) preserves the model's original committed notes alongside evaluator-only fills and gaps.

- `source-9254544.tar.gz`: final implementation, tests, fixtures, lockfile and disabled-build policy.
- `source-c94d997.tar.gz`: exact live-smoke source, before the final failed-attempt counter fix.
- `control-final.tar.gz`: final 64-day control, including its manifest, hash-chained events, atomic day commits and derived reports.
- `live-smoke-c94d997.tar.gz`: complete live run, including both committed days and the failed contribution-boundary attempt. Raw provider requests/responses, prompts, tool bindings/calls/results and journals are preserved in `events.jsonl`.
- `adapter-fixtures.tar.gz`: retained development and final scripted-provider fixtures through the real official client and sandbox, including failures. These fixtures performed no remote inference.
- `offline-tests-final.log` and `archived-tests-final-policy.log`: final current and original-suite output. Earlier diagnostic logs remain for provenance.
- `control-final-replay.json`, `live-replay.json`, `sandbox-final.json`, `model-preflight.json`: independent replay and qualification evidence.
- `dataset-gap-summary.json`: reproducible aggregate from the full rows in the final control archive, explicitly labeled stored-dataset security-days.

To replay, unpack the matching source into a separate directory, install its frozen lockfile, then unpack the corresponding run archive under `results/studies/`. The hash-verified dataset must be available at the manifest's recorded `dataDir`; it is an ignored local input and is not redistributed here. Run `bun src/index.ts verify --dir results/studies/<run-id>`. Offline replay requires neither model credentials nor installed OpenCode. Do not edit a manifest or use a different engine to resume an old cohort.

The live smoke committed July 30 and July 31. August 3 hit the 300-second watchdog before submission; it executed nothing. The final implementation's failure-counter fix was subsequently verified with scripted real-sandbox success and timeout cases. No further live inference was performed. Missing token metadata is unknown, never zero; no cost-efficiency or financial-superiority conclusion is drawn.
