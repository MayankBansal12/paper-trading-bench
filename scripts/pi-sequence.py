#!/usr/bin/env python3
"""Exact-time orchestration around separately pinned, immutable cohort workers."""
import argparse
import datetime as dt
import fcntl
import json
import os
from pathlib import Path
import subprocess
import time


def read(path):
    return json.loads(Path(path).read_text())


def write(path, data):
    path = Path(path)
    pending = path.with_suffix('.pending')
    pending.write_text(json.dumps(data, indent=2) + '\n')
    os.replace(pending, path)


def command(args, **kwargs):
    return subprocess.run(args, check=True, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, **kwargs)


def bb(cfg, *args):
    return command([cfg['bbCli'], 'automation', *args, '--project', cfg['projectId']])


def arm(cfg, when):
    # Update the same durable automation; do not create a new task every reset.
    if dt.datetime.fromisoformat(when.replace('Z', '+00:00')).timestamp() <= time.time():
        when = (dt.datetime.now(dt.timezone.utc) + dt.timedelta(seconds=30)).isoformat()
    bb(cfg, 'update', cfg['automationId'], '--at', when)
    bb(cfg, 'resume', cfg['automationId'])
    write(cfg['receipt'], {'status': 'waiting', 'nextWake': when, 'automationId': cfg['automationId']})


def selected(cfg):
    for path in cfg['cohorts']:
        cohort = read(path)
        state_path = Path(cohort['artifacts']) / 'state.json'
        state = read(state_path)
        if state['status'] != 'completed':
            return path, cohort, state_path, state
    return None


def verify_source(source, revision):
    if command(['git', 'rev-parse', 'HEAD'], cwd=source).stdout.strip() != revision:
        raise RuntimeError('Pinned source revision changed')
    if command(['git', 'status', '--porcelain'], cwd=source).stdout.strip():
        raise RuntimeError('Pinned source is dirty')


def finish(cfg, status, error=None):
    bb(cfg, 'pause', cfg['automationId'])
    write(cfg['receipt'], {'status': status, 'error': error, 'automationId': cfg['automationId']})


def watch(cfg):
    verify_source(cfg['source'], cfg['revision'])
    while True:
        item = selected(cfg)
        if item is None:
            finish(cfg, 'completed')
            return
        path, cohort, state_path, state = item
        if state['status'] == 'blocked':
            finish(cfg, 'blocked', state.get('error'))
            return
        when = state.get('notBefore')
        if when and dt.datetime.fromisoformat(when.replace('Z', '+00:00')).timestamp() > time.time():
            arm(cfg, when)
            return
        verify_source(cohort['source'], cohort['revision'])
        # Refuse to compete with the prior independent worker during migration.
        active = subprocess.run(['systemctl', 'is-active', cohort['unit']], capture_output=True)
        if active.returncode == 0:
            raise RuntimeError('An independent cohort worker is still active')
        state.update(status='running', notBefore=None, launches=state.get('launches', 0) + 1)
        write(state_path, state)
        log = Path(cohort['artifacts']) / f"sequence-worker-{state['launches']:03d}.log"
        with log.open('a') as output:
            result = subprocess.run(['/usr/bin/python3', str(Path(cohort['source']) / 'scripts/astra-recovery.py'),
                                     'work', '--config', str(path)], stdout=output, stderr=output)
        state = read(state_path)
        if result.returncode or state['status'] == 'blocked':
            finish(cfg, 'blocked', state.get('error') or f'Worker exited {result.returncode}')
            return
        if state['status'] == 'waiting' and state.get('notBefore'):
            arm(cfg, state['notBefore'])
            return
        if state['status'] != 'completed':
            raise RuntimeError('Worker exited without a settled checkpoint')
        # Only verified, published completion advances the queue to Sol.


def tick(cfg, config_path):
    item = selected(cfg)
    if item is None:
        finish(cfg, 'completed')
        return
    state = item[3]
    if state['status'] == 'blocked':
        finish(cfg, 'blocked', state.get('error'))
        return
    when = state.get('notBefore')
    if when and dt.datetime.fromisoformat(when.replace('Z', '+00:00')).timestamp() > time.time():
        return
    active = subprocess.run(['systemctl', 'is-active', cfg['unit']], capture_output=True)
    if active.returncode == 0:
        return
    verify_source(cfg['source'], cfg['revision'])
    env = ['--setenv=HOME=/home/ai', '--setenv=PATH=' + cfg['runtimePath']]
    if cfg.get('serverUrl'):
        env.append('--setenv=BB_SERVER_URL=' + cfg['serverUrl'])
    command(['sudo', '-n', 'systemd-run', '--collect', '--unit=' + cfg['unit'], '--uid=ai', '--gid=ai',
             '--property=WorkingDirectory=' + cfg['source'],
             '--property=StandardOutput=append:' + cfg['log'], '--property=StandardError=append:' + cfg['log'],
             *env, '/usr/bin/python3', str(Path(cfg['source']) / 'scripts/pi-sequence.py'),
             'watch', '--config', str(config_path)])
    print(json.dumps({'status': 'launched', 'cohort': item[1]['evalId']}))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('mode', nargs='?', default='tick', choices=['tick', 'watch'])
    parser.add_argument('--config', default=os.environ.get('BENCH_SEQUENCE_CONFIG'))
    args = parser.parse_args()
    cfg = read(args.config)
    with open(cfg['receipt'] + '.' + args.mode + '.lock', 'w') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        try:
            if args.mode == 'watch':
                watch(cfg)
            else:
                tick(cfg, args.config)
        except Exception as error:
            finish(cfg, 'blocked', str(error))
            raise


if __name__ == '__main__':
    main()
