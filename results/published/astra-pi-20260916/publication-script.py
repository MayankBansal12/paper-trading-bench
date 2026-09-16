#!/usr/bin/env python3
"""Publish immutable Astra qualification bundles and the eventual annual outcome."""
import datetime, hashlib, json, pathlib, shutil, subprocess, sys, tarfile
ROOT = pathlib.Path('/home/ai/code/paper-trading-bench')
ART = ROOT / 'results/archives/astra-pi-20260916'
SOURCE = pathlib.Path('/tmp/paper-trading-astra-94d8edd')
OLD = pathlib.Path('/tmp/paper-trading-astra-f118891')
PUBLICATION = pathlib.Path('/tmp/paper-trading-astra-results-20260916')
EVAL = 'astra-pi-v12-20260916'
REL = pathlib.Path('results/published/astra-pi-20260916')
OUT = PUBLICATION / REL
PHASE = sys.argv[1]
assert PHASE in ['initial', 'final']

def run(args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)

def read(path):
    return json.loads(path.read_text())

def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + '\n')

def sha(path):
    h = hashlib.sha256()
    with path.open('rb') as f:
        for block in iter(lambda: f.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()

def revision(path):
    return subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=path, text=True).strip()

assert subprocess.check_output(['git', 'branch', '--show-current'], cwd=PUBLICATION, text=True).strip() == 'results/astra-pi-20260916'
assert not subprocess.check_output(['git', 'status', '--porcelain'], cwd=PUBLICATION, text=True).strip(), 'Publication worktree has unexpected edits'
OUT.mkdir(parents=True, exist_ok=True)
stage = ART / ('bundle-' + PHASE)
assert not stage.exists(), 'Never overwrite an existing audit snapshot'
stage.mkdir()
for name in ['source-f118891.tar', 'source-94d8edd.tar', 'smoke-original-verification.json', 'smoke-r2-verification.json', 'smoke-r2-review-summary.json', 'synthetic-qualification.json', 'synthetic-qualification-final.json', 'annual-preflight.json', 'test-history.txt']:
    p = ART / name
    if p.exists():
        shutil.copy2(p, stage / name)
for base, name in [(OLD, 'astra-pi-smoke-20260916'), (SOURCE, 'astra-pi-smoke-r2-20260916')]:
    shutil.copytree(base / 'results/studies' / name, stage / 'results/studies' / name)
shutil.copytree(ROOT / 'datasets/historical/nasdaq100_2025q2-2026q1_v1', stage / 'dataset/nasdaq100_2025q2-2026q1_v1')
shutil.copy2(ART / 'publish-results.py', stage / 'publish-results.py')
shutil.copy2(ART / 'annual-driver.sh', stage / 'annual-driver.sh')
shutil.copy2(ART / 'publish-results.py', OUT / 'publication-script.py')
report = None
if PHASE == 'final':
    for path in (SOURCE / 'results/studies').glob(EVAL + '-*'):
        shutil.copytree(path, stage / 'results/studies' / path.name)
    shutil.copytree(SOURCE / 'results/evaluations' / EVAL, stage / 'results/evaluations' / EVAL)
    for name in ['annual-run.log', 'annual-exit-code', 'annual-verification.json', 'annual-verification.stderr', 'annual-verification-exit-code']:
        p = ART / name
        if p.exists():
            shutil.copy2(p, stage / name)
    try:
        report = read(ART / 'annual-verification.json')
        write(OUT / 'annual-summary.json', report)
    except (ValueError, OSError):
        report = None
    write(OUT / 'annual-execution.json', {
        'runExitCode': (ART / 'annual-exit-code').read_text().strip(),
        'verificationExitCode': (ART / 'annual-verification-exit-code').read_text().strip(),
        'replayProducedReport': report is not None,
        'verificationError': (ART / 'annual-verification.stderr').read_text(),
    })
files = sorted(p for p in stage.rglob('*') if p.is_file())
(stage / 'CONTENTS.sha256').write_text(''.join(f'{sha(p)}  {p.relative_to(stage)}\n' for p in files))
archive = ART / f'astra-pi-{PHASE}-audit.tar.gz'
assert not archive.exists()
with tarfile.open(archive, 'w:gz') as tar:
    tar.add(stage, arcname='audit')
checksum = sha(archive)
(OUT / f'{PHASE}-audit-bundle.sha256').write_text(f'{checksum}  {archive}\n')
write(OUT / 'original-smoke-summary.json', read(ART / 'smoke-original-verification.json'))
write(OUT / 'smoke-summary.json', read(ART / 'smoke-r2-verification.json'))
oldmanifest = read(OLD / 'results/studies/astra-pi-smoke-20260916/manifest.json')
manifest = read(SOURCE / 'results/studies/astra-pi-smoke-r2-20260916/manifest.json')
provenance_path = OUT / 'provenance.json'
provenance = read(provenance_path) if provenance_path.exists() else {
    'model': 'pi/openai-codex/gpt-6-astra', 'client': 'Pi 0.85.1', 'reasoning': 'medium',
    'sourceRevision': revision(SOURCE), 'originalSmokeRevision': revision(OLD),
    'implementationHash': manifest['implementation']['hash'],
    'originalSmokeImplementationHash': oldmanifest['implementation']['hash'],
    'datasetHash': manifest['config']['datasetHash'], 'datasetPath': manifest['config']['dataDir'],
    'runtime': read(SOURCE / 'results/studies/astra-pi-smoke-r2-20260916/runtime.json'),
    'evalId': EVAL, 'concurrency': 2, 'plannedSessions': 251,
    'originalSmoke': {'runId': 'astra-pi-smoke-20260916', 'outcome': 'stopped after adapter audit failure', 'interruptedAttemptRetained': True, 'replay': 'original-source integrity replay passed; incomplete coverage'},
    'qualifiedSmoke': {'runId': 'astra-pi-smoke-r2-20260916', 'validDays': 3, 'invalidDays': 0, 'retriedDays': 0, 'replay': 'passed'},
    'subscriptionCost': None, 'costNote': 'Unavailable; catalog estimates are not proven subscription charges.',
    'sourceCheckout': str(SOURCE), 'evaluationArtifactPath': str(SOURCE / 'results/evaluations' / EVAL),
    'resultsLocation': str(SOURCE / 'results/studies'), 'service': 'astra-pi-annual-20260916.service',
    'checks': {'typecheck': 'passed', 'fullSuite': {'passed': 318, 'failed': 0}, 'piFocusedTests': {'passed': 5, 'failed': 0}, 'syntheticPiScenarios': ['success', 'schema correction', 'quota refusal', 'watchdog', 'tamper rejection']},
    'auditBundles': [],
}
provenance['status'] = ('running' if PHASE == 'initial' else (report['status'] if report else 'verification failed'))
provenance['updatedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
provenance['auditBundles'].append({'phase': PHASE, 'path': str(archive), 'sha256': checksum, 'bytes': archive.stat().st_size, 'scope': 'Both preserved smoke attempts, source snapshots and frozen dataset' + ('; all annual quarter artifacts and verification reports' if PHASE == 'final' else '; annual run is still live and excluded from this bundle')})
write(provenance_path, provenance)
status_text = 'The annual evaluation is running under a supervised machine service. Two quarters run concurrently; the other two are queued. Its annual score is unavailable until all four quarters finish and replay.'
if PHASE == 'final':
    if report:
        model = report['models'][0]
        status_text = f"Annual outcome: **{report['status']}**. Valid days: **{model['validDays']}/251**; invalid days: {model['invalidDays']}; retried days: {model['retriedDays']}; completed quarters: {model['completedQuarters']}/4."
        if model.get('year'):
            year = model['year']
            status_text += f" Sum of independent quarter profits: **${year['netProfit']:,.2f}**. Mean quarterly TWR: **{year['meanQuarterTimeWeightedReturnPct']:.2f}%**."
        else:
            status_text += ' The annual score remains unavailable.'
    else:
        status_text = 'The annual process ended, but integrity verification did not produce a valid report. No verified annual score is claimed. See annual-execution.json and the preserved final bundle.'
body = f'''# Pi / GPT-6 Astra results — September 16, 2026

{status_text}

## Qualified live smoke

April 1–3, 2025: **3/3 valid decisions**, zero retries, zero invalid days, five fills and no rejected orders. Starting capital was $50,000; closing equity was **$50,372.93**, a **$372.93 (0.746%)** gain. The account retained $25,000 cash and held TMUS, ORLY, EXC, CCEP and ROP. Replay passed using the exact recorded source. This three-day smoke qualifies the adapter; it is not a scored annual comparison.

## Preserved failed smoke

The first smoke at `f118891` exposed an adapter audit bug: Codex streamed completed function-call items but omitted them from the terminal response's output array. The original validator rejected real Pi submissions. We stopped that run, retained all four attempts (three failed and one interrupted), and replayed it using its original source. Coverage is zero valid days, one committed invalid day, one partially attempted day and one unattempted day. No old manifest, event hash or day commit was rewritten. The fix at `94d8edd` started a separately named smoke and a fresh annual cohort.

## Conditions and evidence

- Exact route: `pi/openai-codex/gpt-6-astra`; Pi 0.85.1, Node 22.23.1, medium reasoning, host Codex OAuth, SSE.
- Four independent quarters: April 2025–March 2026, 62/64/64/61 sessions. Each starts with $50,000 and receives two further $50,000 deposits. Concurrency: 2.
- The existing v12 four-tool environment, prior-close cutoff, journal rules and accounting are retained. Pi uses a different agent client and prompt wrapper from OpenCode, so comparisons must identify the adapter.
- Subscription cost is unavailable. Measured token counts remain recorded. These results do not establish historical Nasdaq-100 membership eligibility.
- [Provenance and bundle locations](provenance.json), [qualified smoke summary](smoke-summary.json), [original failed smoke summary](original-smoke-summary.json).
- Audit bundles are local on host `afdasf`, with committed SHA-256 receipts. They contain raw logs, the frozen dataset and pinned source snapshots; those raw files are not in Git. This is not an off-host backup.
- The supervised annual driver verifies the run, generates per-quarter reviews, creates a separate final audit bundle and updates this results PR when the process finishes. Its [publication script](publication-script.py) is retained for review.

## Checks

Typecheck passed; final full suite **318 passed, 0 failed**. Pi-focused gateway/accounting tests: **5 passed**. The real Pi CLI passed synthetic success, schema correction, quota refusal, watchdog and tamper-rejection checks without inference. Both live-smoke artifacts replayed with their own source; only the second passed live qualification.

Two earlier test invocations were unsuccessful: one detected source changing during replay; another accidentally discovered duplicate tests in a nested checkout and hit fixture-path failures. The checkout was moved outside the repository and the final suite ran against stable source. The original live smoke remains failed/incomplete evidence, not a successful run.
'''
if PHASE == 'final':
    body += '\n[Annual verification report](annual-summary.json) and [execution/replay outcomes](annual-execution.json).\n'
(OUT / 'README.md').write_text(body)
run(['git', 'add', str(REL)], cwd=PUBLICATION)
run(['git', 'commit', '-m', 'Publish Astra ' + PHASE + ' run evidence and audit checksums'], cwd=PUBLICATION)
run(['git', 'push', '-u', 'origin', 'results/astra-pi-20260916'], cwd=PUBLICATION)
prbody = ART / ('results-pr-' + PHASE + '.md')
prbody.write_text(status_text + '\n\nPublishes the 3/3 valid Pi/Astra smoke ($50,372.93 closing equity), preserves the initial adapter-failed smoke and all attempts, and records pinned source/runtime/dataset identities and local audit-bundle checksums. The annual cohort uses two concurrent independent quarters. No annual score is claimed while incomplete.\n\nChecks: typecheck; 318 full-suite tests; 5 focused Pi tests; real-CLI synthetic transport/security/failure qualification; original-source replay of both smoke artifacts. Earlier failed test invocations and the failed first smoke are disclosed in the report.\n\nStacked on implementation PR #13; no merge is performed.\n')
if PHASE == 'initial':
    url = subprocess.check_output(['gh', 'pr', 'create', '--base', 'bench/pi-astra-evaluation', '--head', 'results/astra-pi-20260916', '--title', 'Publish Pi GPT-6 Astra qualification and evaluation evidence', '--body-file', str(prbody)], cwd=PUBLICATION, text=True).strip()
    (ART / 'results-pr-url').write_text(url + '\n')
    print(url)
else:
    url = (ART / 'results-pr-url').read_text().strip()
    run(['gh', 'pr', 'edit', url, '--body-file', str(prbody)], cwd=PUBLICATION)
    print(url)
