# Results

[Open the viewer](https://mayankbansal12.github.io/paper-trading-bench/) ·
[Read the study](https://mayankbansal12.github.io/paper-trading-bench/study.html)

`current/` is the selected twelve-model snapshot: 3,012 sessions, 3,007 valid decisions,
3,088 attempts and 3,512 fills across 48 independent quarterly accounts.

Sol 6.1 and Sonnet 5.5 were imported on October 7 with all sessions and attempts.
The [verification record](qualifications/2026-10-models.json) includes their smoke
outcomes, exact identities, original archive checksums and retained replay/review
log hashes. The import independently checked original event/day chains, actual
journal context, accepted model/effort and accounting; it made no model calls or
fresh runtime replay. The original ten models' session and attempt files are unchanged.

- `manifest.json`: selection, coverage and compact file checksums.
- `provenance.json`: exact source, runtime, dataset and original event/day anchors.
- Model directories: one session JSONL per quarter and one attempts JSONL per model.
- `metrics.json`: reproducible accounting, risk, activity and tool statistics.
- `rule-review.json`: 30 editorial examples; not a population compliance rate.
- `memory-audit.json`: observed opening-context coverage versus protocol-derived counts.
- `price-opportunities.json`: price-response counts and their covered denominators.

```sh
pnpm results:check    # File hashes, recalculation and independent Decimal accounting
pnpm viewer:build
pnpm viewer          # http://127.0.0.1:4173
```

The model directories contain compact extracts, not raw provider streams. Session
records retain opening/closing portfolios, deposits, corporate actions, ordered
fills/rejections, original journals, tool calls/receipt summaries and usage.
Attempt records include unsuccessful attempts. Original hash fields refer to the
archived records; the manifest hashes these published, path-normalized extracts.

[Methodology](../docs/METHODOLOGY.md) explains accounting and comparison limits.
Selection exceptions are explicit in the manifest: Opus 5 uses the newer Q2 repeat
chosen after both outcomes were known; Opus 5.5 includes seven supplemental dates.
Luna 6 replaces Luna 5.6. Terra is excluded.

Raw logs and datasets stay outside Git. [Archive locations and checksums](archives.json)
and the [historical index](history.json) retain earlier results and source pins.
The repository is private; its release assets require repository access. The
static viewer publishes only compact evidence. An archived source bundle enables
historical replay; current source is for newly qualified cohorts.

The two new source revisions are retained as small [Git bundles](sources/), each
requiring base `5c4d027`. After fetching that base, use `git bundle verify <bundle>`
and `git fetch <bundle> HEAD`, then create a separate checkout at the recorded
revision. These are historical source identities, not permission to resume a
cohort under changed code. Full run archives remain on RedmiBook in each cohort's
`archives/` directory; their names, sizes and freshly checked SHA-256 values are
in the verification record. No raw provider streams are published.
