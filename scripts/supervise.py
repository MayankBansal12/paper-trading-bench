#!/usr/bin/env python3
"""Run one pinned model: three-day smoke, annual, then verification. No publication."""
import argparse
import datetime as dt
import fcntl
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import time

TERMINAL = {'completed', 'blocked'}

def load(path):
    return json.loads(Path(path).read_text())

def save(path, data):
    tmp = path.with_suffix('.tmp')
    with tmp.open('w') as f:
        json.dump(data, f, indent=2)
        f.write('\n')
        f.flush()
        os.fsync(f.fileno())
    tmp.replace(path)

def classify(report, code, text=''):
    summaries = [q.get('summary') or {} for q in report.get('quarters', [])] if 'quarters' in report else [report]
    pauses = [s['availability']['notBefore'] for s in summaries if s.get('availability')]
    if pauses:
        return 'quota', max(pauses)
    if 'BENCH_AUTH_PAUSE' in text:
        return 'auth', None
    if 'BENCH_STORAGE_PAUSE' in text:
        return 'storage', None
    if code == 0 and report.get('status') == 'completed':
        return 'completed', None
    return 'blocked', None

def parse_report(text):
    # Bun's CLI prints a single JSON report. Any diagnostic lines stay in stderr.
    try:
        value = json.loads(text)
        return value if isinstance(value, dict) else {}
    except ValueError:
        return {}

def command(model, ident, data, smoke=False, resume=False, verify=False):
    if smoke:
        if resume or verify:
            return ['bun', 'src/index.ts', 'verify' if verify else 'resume', '--dir', f'results/studies/{ident}-smoke']
        return ['bun', 'src/index.ts', 'run', '--run-id', ident + '-smoke', '--model', model,
                '--data-dir', data, '--start', '2025-04-01', '--end', '2025-04-03', '--smoke=true', '--pause-on-quota=true']
    return ['bun', 'src/index.ts', 'eval', '--eval-id', ident, '--models', model, '--data-dir', data,
            '--concurrency=1', '--pause-on-quota=true'] + (['--verify=true'] if verify else ['--resume=true'] if resume else [])

def run(args, root, log):
    process = subprocess.run(args, cwd=root, capture_output=True, text=True)
    with log.open('a') as f:
        f.write(process.stdout + process.stderr)
    return process.returncode, parse_report(process.stdout), process.stdout + process.stderr

def check_source(root, revision):
    current = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip()
    dirty = subprocess.check_output(['git', 'status', '--porcelain'], cwd=root, text=True).strip()
    if current != revision or dirty:
        raise RuntimeError('Pinned source changed or is not clean')

def wait_seconds(not_before, now):
    return max(0, dt.datetime.fromisoformat(not_before.replace('Z', '+00:00')).timestamp() - now)

def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--model', required=True)
    parser.add_argument('--id', required=True)
    parser.add_argument('--data-dir', required=True)
    parser.add_argument('--preflight', action='store_true', help='Validate the annual dataset without model inference')
    args = parser.parse_args(argv)
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,90}', args.id):
        parser.error('id must contain 1–90 letters, digits, underscores or hyphens')
    root = Path(__file__).resolve().parent.parent
    data = str(Path(args.data_dir).resolve())
    revision = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip()
    check_source(root, revision)
    if args.preflight:
        return subprocess.call(command(args.model, args.id, data) + ['--preflight=true'], cwd=root)
    out = root / 'results' / 'supervision' / args.id
    out.mkdir(parents=True, exist_ok=True)
    path = out / 'state.json'
    config = {'model': args.model, 'id': args.id, 'data': data, 'revision': revision}
    with (out / 'lock').open('w') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError('Another supervisor owns this evaluation')
        state = load(path) if path.exists() else {'config': config, 'phase': 'smoke', 'status': 'ready', 'launches': 0}
        if state['config'] != config:
            raise RuntimeError('Supervisor configuration changed; use the recorded source and flags')
        if state['status'] in TERMINAL:
            print(json.dumps(state))
            return 0 if state['status'] == 'completed' else 2
        os.environ.setdefault('BENCH_MIN_FREE_BYTES', str(4 * 1024**3))
        os.environ.setdefault('BENCH_STORAGE_ROOT', str(root / 'results'))
        os.environ.setdefault('BENCH_MAX_STORAGE_BYTES', str(6 * 1024**3))
        os.environ['BENCH_DATASET'] = data
        while True:
            check_source(root, revision)
            if state.get('notBefore'):
                left = wait_seconds(state['notBefore'], time.time())
                if left > 0:
                    time.sleep(min(left, 60))
                    continue
                state.pop('notBefore', None)
            if shutil.disk_usage(root).free < int(os.environ['BENCH_MIN_FREE_BYTES']):
                state.update(status='storage', error='Free-space reserve reached')
                save(path, state)
                time.sleep(60)
                continue
            smoke = state['phase'] == 'smoke'
            manifest = root / ('results/studies/' + args.id + '-smoke/manifest.json' if smoke else 'results/evaluations/' + args.id + '/manifest.json')
            state.update(status='running', launches=state['launches'] + 1)
            state.pop('error', None)
            save(path, state)
            code, report, text = run(command(args.model, args.id, data, smoke, manifest.exists()), root, out / 'run.log')
            status, not_before = classify(report, code, text)
            state.update(status='verifying' if status == 'completed' else status, report=report)
            if not_before:
                state['notBefore'] = not_before
            save(path, state)
            print(json.dumps({'phase': state['phase'], 'status': status, 'notBefore': not_before}), flush=True)
            if status in {'quota', 'auth', 'storage'}:
                if status != 'quota':
                    time.sleep(60)
                continue
            if status == 'completed':
                code, verified, text = run(command(args.model, args.id, data, smoke, verify=True), root, out / 'verify.log')
                valid_smoke = not smoke or (verified.get('validDays') == 3 and verified.get('invalidDays') == 0)
                if code or verified.get('status') != 'completed' or not valid_smoke:
                    status = 'blocked'
                    state['error'] = 'Final verification or smoke coverage failed'
                else:
                    jobs = [{'runId': args.id + '-smoke'}] if smoke else verified['quarters']
                    for job in jobs:
                        code, _, _ = run(['bun', 'src/index.ts', 'review', '--dir', 'results/studies/' + job['runId'], '--analysis=true'], root, out / 'review.log')
                        if code:
                            status = 'blocked'
                            state['error'] = 'Final review failed'
                            break
                    if status == 'completed' and smoke:
                        state.update(phase='annual', status='ready', report=verified)
                        save(path, state)
                        continue
                    state['report'] = verified
            state['status'] = status
            save(path, state)
            return 0 if status == 'completed' else 2

if __name__ == '__main__':
    raise SystemExit(main())
