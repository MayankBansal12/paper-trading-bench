# V11 simplification validation

Protocol: `v11-portfolio-journal-submit`, based on `7f077b6` / parent PR #3. Phase 5 remains deferred.

- TypeScript typecheck passes.
- Current offline suite: 200 tests passed, zero failed, 1,227 assertions. Retired protocol tests/source remain in the verified historical archive.
- The extracted accounting engine reproduces every value in all 64 archived v10 control days: 56 fills, no rejected orders, final equity $1,540.08.
- Regression checks cover future-price/action mutation, opening contributions/splits/dividends/holdings, ordered sell funding, fixed-share cash failures, bounded history/payloads, unlimited calls, original journal filters, forged/foreign/future evidence, exact provider context, unknown-tool denial, unavailable usage, partial submission, atomic publication and crash recovery.
- The official OpenCode client in the real sandbox completes a scripted final submission with exactly one local provider-fixture request and no extra inference. It preserves the literal preload through stdin. This fixture makes zero remote inference requests.
- Sandbox qualification and refreshed exact active zero-price model qualification pass.

Final full-period replay and the small free live smoke are recorded in the qualification evidence accompanying this PR. See `results/qualifications/v11-simplification-20260913/` for the final evidence index.
