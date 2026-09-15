# Agent workflow

All agent changes to this repository must be delivered through pull requests.

- Work on a dedicated branch based on the intended target branch. Commit and push
  that branch, then open a PR. Do not commit or push directly to `main`, or merge
  a PR unless the user explicitly asks.
- Include a plain-language summary and the checks actually run in the PR and the
  final response. Keep failures and external blockers visible.
- Every benchmark agent run, including smoke tests and interrupted or failed runs,
  must have its outcome and provenance recorded in a results PR. Keep raw logs,
  datasets and credentials out of Git; include compact evidence, source/runtime/
  dataset identities, coverage, replay results and the audit-bundle checksum and
  location. A successful catalog check alone does not prove a working live model.
- Run evaluations from a clean, pinned source revision. Replay or resume existing
  runs with their recorded implementation; changes to the runtime require a new
  cohort. Preserve all attempts and invalid days. Never rewrite manifests or
  hashes to make old results pass verification under new code.

See [the evaluation runbook](docs/EVAL_RUNBOOK.md) for execution and publication.
