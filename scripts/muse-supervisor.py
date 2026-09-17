#!/usr/bin/env python3
"""Durable exact-route OpenCode Muse supervisor; all inference uses the bench CLI.

A settled checkpoint is replayed and published before any next launch. Quota waits
sleep until the recorded notBefore time. Attempts and manifests are never edited.
"""
import argparse
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tarfile
import time

MODEL = 'opencode/muse-spark-1.3-contributor-free'

def read(path):
    return json.loads(Path(path).read_text())

def write(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    pending = path.with_suffix('.pending')
    pending.write_text(json.dumps(value, indent=2) + '\n')
    pending.replace(path)

def now():
    return dt.datetime.now(dt.timezone.utc).isoformat()

def digest(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()

def command(args, cwd=None):
    return subprocess.run(args, cwd=cwd, check=True, text=True, capture_output=True).stdout.strip()

def assert_pins(cfg):
    if cfg['model'] != MODEL:
        raise RuntimeError('Only the exact free Zen route is authorized')
    if command(['git', 'rev-parse', 'HEAD'], cfg['source']) != cfg['revision']:
        raise RuntimeError('Pinned source revision changed')
    if command(['git', 'status', '--porcelain'], cfg['source']):
        raise RuntimeError('Pinned source is dirty')
    for path, expected in cfg['runtimeFiles'].items():
        if digest(path) != expected:
            raise RuntimeError('Pinned runtime file changed: ' + path)

def runs(cfg):
    return sorted(p for p in (Path(cfg['source']) / 'results/studies').glob('*')
                  if p.name == cfg['smokeId'] or p.name.startswith(cfg['evalId'] + '-'))

def cli(cfg, args, label):
    out = Path(cfg['artifacts']) / (label + '.json')
    err = out.with_suffix('.stderr')
    with out.open('x') as stdout, err.open('x') as stderr:
        code = subprocess.run([cfg['bun'], '--env-file=' + cfg['credentialEnvFile'], 'src/index.ts', *args],
                              cwd=cfg['source'], stdout=stdout, stderr=stderr).returncode
    try:
        report = read(out)
    except (OSError, ValueError):
        report = None
    return code, report

def eval_args(cfg):
    return ['eval', '--eval-id', cfg['evalId'], '--models', MODEL, '--data-dir', cfg['dataset'],
            '--concurrency=1', '--pause-on-quota=true']

def publish(cfg, state, report, receipt, label):
    art, source, pub = map(Path, [cfg['artifacts'], cfg['source'], cfg['publication']])
    if command(['git', 'branch', '--show-current'], pub) != cfg['publicationBranch']:
        raise RuntimeError('Publication branch changed')
    if command(['git', 'status', '--porcelain'], pub):
        raise RuntimeError('Publication checkout is dirty')
    records = []
    for run in runs(cfg):
        manifest = read(run / 'manifest.json')
        attempts = []
        for line in (run / 'events.jsonl').read_text().splitlines():
            e = json.loads(line)
            if e['kind'] == 'result':
                p = e['payload']
                attempts.append({'scope': e['scope'], 'outcome': p['outcome'], 'reason': p.get('reason'),
                                 'usage': p['decision']['usage'], 'hash': e['hash']})
        records.append({'runId': run.name, 'manifestSha256': digest(run / 'manifest.json'),
                        'repositoryRevision': manifest['repositoryRevision'],
                        'implementationHash': manifest['implementation']['hash'],
                        'runtime': read(run / 'runtime.json') if (run / 'runtime.json').exists() else None,
                        'attempts': attempts})
        # The shared viewer reads these fresh run IDs; historical studies stay archived.
        link = Path(cfg['viewerStudies']) / run.name
        if link.is_symlink():
            if link.resolve() != run.resolve():
                raise RuntimeError('Viewer link targets another run')
        elif link.exists():
            raise RuntimeError('Viewer run already exists')
        else:
            link.symlink_to(run, target_is_directory=True)
    write(art / (label + '-receipt.json'), receipt)
    source_tar = art / 'source.tar'
    if not source_tar.exists():
        command(['git', 'archive', cfg['revision'], '-o', str(source_tar)], source)
    bundle_path = art / ('audit-' + label + '.tar.gz')
    with tarfile.open(bundle_path, 'x:gz') as bundle:
        bundle.add(source_tar, arcname='source.tar')
        for run in runs(cfg):
            bundle.add(run, arcname='results/studies/' + run.name)
        evaluation = source / 'results/evaluations' / cfg['evalId']
        if evaluation.exists():
            bundle.add(evaluation, arcname='results/evaluations/' + cfg['evalId'])
        bundle.add(source / 'results/qualifications', arcname='qualifications')
        bundle.add(art / 'preflight', arcname='preflight')
        for pattern in ['*.json', '*.stderr']:
            for p in art.glob(pattern):
                bundle.add(p, arcname='execution/' + p.name)
    rel = Path('results/published') / cfg['evalId']
    target = pub / rel
    target.mkdir(parents=True, exist_ok=True)
    old = read(target / 'provenance.json') if (target / 'provenance.json').exists() else {'checkpoints': []}
    old.update(model=MODEL, sourceRevision=cfg['revision'], sourceCheckout=cfg['source'],
               implementationPR=cfg['implementationPR'], datasetPath=cfg['dataset'], datasetHash=cfg['datasetHash'],
               runtimeFiles=cfg['runtimeFiles'], clientVersion='1.18.30', reasoning='official client default',
               pricing={'input': 0, 'output': 0, 'cacheRead': 0, 'cacheWrite': 0},
               availabilityPolicy='zen-rate-limit-pause-v1', concurrency=1, plannedSessions=251,
               state=state, runs=records, historicalArchive=read(art / 'historical-receipt.json'))
    old['checkpoints'].append({'label': label, 'auditBundle': str(bundle_path), 'sha256': digest(bundle_path),
                               'bytes': bundle_path.stat().st_size, 'receipt': receipt})
    write(target / 'provenance.json', old)
    write(target / (label + '-summary.json'), report)
    text = (f"# Fresh Muse Spark 1.3 via OpenCode Zen\n\nState: **{state['status']}**; phase: **{state['phase']}**.\n\n"
            f"Source: `{cfg['revision']}`. Exact route: `{MODEL}`. OpenCode 1.18.30, Bun 1.3.14, "
            "official default reasoning. Refreshed active/free catalog evidence pins all prices to zero; "
            "catalog success alone does not qualify a live model.\n\n"
            "The three-day April 1–3 smoke must have three valid decisions, complete measured usage and "
            "successful replay before the serial annual run begins. Four independent quarters cover "
            "62/64/64/61 sessions, each with fresh memory and $150,000 funding. No annual score is available "
            "until all four quarters complete and verify.\n\n"
            "A Muse HTTP 429 stops upstream calls immediately. The recorded Retry-After or explicit reset "
            "sets the next launch, plus five minutes; absent a reset, the frozen fallback is six hours plus "
            "five minutes. The failed attempt remains counted; every day still permits only two attempts.\n\n"
            f"Next permitted attempt: `{state.get('notBefore')}`. Blocker: `{state.get('error')}`.\n\n"
            "Historical Muse 1.3 is retired and separately checksummed. It is never combined with this cohort. "
            "[Provenance, every attempt, measured usage, replay receipts and audit checksums](provenance.json). "
            "Raw logs remain in local audit bundles on afdasf. Those bundles and pinned binaries require "
            "retention; Git contains compact evidence only.\n\n"
            "Checks: typecheck; full Bun suite; targeted quota/gateway tests; Python supervisor tests; "
            "four-quarter dataset preflight; exact-route catalog refresh; sandbox qualification. "
            "Checkpoint replay exit codes and failures are recorded in each receipt.\n")
    (target / 'README.md').write_text(text)
    command(['git', 'add', str(rel)], pub)
    command(['git', 'commit', '-m', 'Record fresh Muse checkpoint ' + label], pub)
    command(['git', 'push', '-u', 'origin', cfg['publicationBranch']], pub)
    existing = json.loads(command(['gh', 'pr', 'list', '--head', cfg['publicationBranch'], '--state', 'open', '--json', 'url'], pub))
    body = art / 'results-pr-body.md'
    body.write_text(text)
    if existing:
        url = existing[0]['url']
        command(['gh', 'pr', 'edit', url, '--body-file', str(body)], pub)
    else:
        url = command(['gh', 'pr', 'create', '--base', cfg['baseBranch'], '--head', cfg['publicationBranch'],
                       '--title', 'Track fresh free Muse 1.3 OpenCode benchmark', '--body-file', str(body)], pub)
    (art / 'results-pr-url').write_text(url + '\n')
    message = (f"Fresh Muse 1.3 checkpoint {label}: {state['status']}, phase {state['phase']}. "
               f"Next allowed attempt: {state.get('notBefore')}. Blocker: {state.get('error')}. Results: {url}")
    command([cfg['bbCli'], 'thread', 'tell', cfg['reportThread'], message])
    return url

def smoke_complete(code, verify_code, report):
    return code == verify_code == 0 and report and report.get('validDays') == report.get('totalDays') == 3 and report.get('usageUnavailableAttempts') == 0

def checkpoint(cfg, state):
    assert_pins(cfg)
    phase = state['phase']
    label = f"{state['launches']:03d}-{phase}"
    if phase == 'smoke':
        directory = 'results/studies/' + cfg['smokeId']
        args = (['resume', '--dir', directory] if (Path(cfg['source']) / directory / 'manifest.json').exists()
                else ['run', '--run-id', cfg['smokeId'], '--smoke=true', '--model', MODEL,
                      '--data-dir', cfg['dataset'], '--start', '2025-04-01', '--end', '2025-04-03', '--pause-on-quota=true'])
        verify_args = ['verify', '--dir', directory]
    else:
        args = eval_args(cfg)
        if (Path(cfg['source']) / 'results/evaluations' / cfg['evalId'] / 'manifest.json').exists():
            args += ['--resume=true']
        verify_args = eval_args(cfg) + ['--verify=true']
    code, result = cli(cfg, args, label + '-run')
    verified_code, verified = cli(cfg, verify_args, label + '-verify')
    receipt = {'runCommand': args, 'runExitCode': code, 'verifyCommand': verify_args,
               'verifyExitCode': verified_code, 'finishedAt': now(), 'reviews': []}
    summaries = ([verified] if phase == 'smoke' else [q.get('summary') or {} for q in (verified or {}).get('quarters', [])])
    integrity = verified is not None and (verified_code == 0 if phase == 'smoke'
                else verified_code in [0, 1] and not any(q.get('error') for q in verified.get('quarters', [])))
    complete = smoke_complete(code, verified_code, verified) if phase == 'smoke' else integrity and code == verified_code == 0 and verified.get('status') == 'completed'
    pauses = [s['availability']['notBefore'] for s in summaries if s and s.get('availability')]
    state.update(updatedAt=now(), notBefore=None, error=None)
    if not integrity:
        state.update(status='blocked', error='Execution/replay failed; retained output must be inspected.')
    elif pauses:
        state.update(status='waiting', notBefore=max(pauses))
    elif complete:
        state.update(status='smoke-qualified' if phase == 'smoke' else 'completed')
    else:
        state.update(status='blocked', error='Live qualification or annual coverage incomplete; attempts preserved.')
    # Reviews are evaluator-only and are retained even for failed/paused checkpoints.
    if integrity:
        for run in runs(cfg):
            if (phase == 'smoke') == (run.name == cfg['smokeId']):
                rc, _ = cli(cfg, ['review', '--dir', str(run), '--analysis=true'], label + '-review-' + run.name[-10:])
                receipt['reviews'].append({'runId': run.name, 'exitCode': rc})
                if rc:
                    state.update(status='blocked', error='Checkpoint review failed')
    write(Path(cfg['artifacts']) / 'state.json', state)
    publish(cfg, state, verified or result, receipt, label)
    if state['status'] == 'smoke-qualified':
        state.update(phase='annual', status='ready')
    write(Path(cfg['artifacts']) / 'state.json', state)

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', required=True)
    cfg = read(parser.parse_args().config)
    os.environ['PATH'] = cfg['runtimePath']
    state_path = Path(cfg['artifacts']) / 'state.json'
    with (Path(cfg['artifacts']) / 'supervisor.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        state = read(state_path)
        while state['status'] not in ['completed', 'blocked']:
            when = state.get('notBefore')
            if when:
                delay = dt.datetime.fromisoformat(when.replace('Z', '+00:00')).timestamp() - time.time()
                if delay > 0:
                    time.sleep(delay)  # One durable wait until the recorded reset; no polling.
            state.update(status='running', launches=state.get('launches', 0) + 1, updatedAt=now())
            write(state_path, state)
            try:
                checkpoint(cfg, state)
            except Exception as error:
                state.update(status='blocked', error=type(error).__name__ + ': ' + str(error), updatedAt=now())
                write(state_path, state)
                # Never start another attempt after publication or infrastructure failure.
                command([cfg['bbCli'], 'thread', 'tell', cfg['reportThread'],
                         'Fresh Muse supervisor blocked; raw evidence retained at ' + cfg['artifacts'] + '. ' + state['error']])
                raise

if __name__ == '__main__':
    main()
