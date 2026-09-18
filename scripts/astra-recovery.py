#!/usr/bin/env python3
"""BB's silent quota watchdog and supervised, pinned Astra evaluation worker.

All model calls go through the benchmark CLI. This script never alters manifests,
event chains, attempt allowances, or invalid-day commits.
"""
import argparse
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import time

MODEL = "pi/openai-codex/gpt-6-astra"


def read(path):
    return json.loads(Path(path).read_text())


def write(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    pending = path.with_suffix(path.suffix + ".pending")
    pending.write_text(json.dumps(data, indent=2) + "\n")
    os.replace(pending, path)


def now():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def digest(path):
    h = hashlib.sha256()
    with Path(path).open("rb") as f:
        for part in iter(lambda: f.read(1024 * 1024), b""):
            h.update(part)
    return h.hexdigest()


def command(args, cwd=None, check=True):
    return subprocess.run(args, cwd=cwd, check=check, text=True,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE)


def assert_source(cfg):
    source = Path(cfg["source"])
    if command(["git", "rev-parse", "HEAD"], cwd=source).stdout.strip() != cfg["revision"]:
        raise RuntimeError("Pinned source revision changed")
    if command(["git", "status", "--porcelain"], cwd=source).stdout.strip():
        raise RuntimeError("Pinned source tree is dirty")


def matching_runs(cfg):
    root = Path(cfg["source"]) / "results/studies"
    return sorted(p for p in root.glob("*") if p.is_dir() and
                  (p.name == cfg["smokeId"] or p.name.startswith(cfg["evalId"] + "-")))


def stale_locks(cfg):
    """Remove only locks whose recorded PID no longer exists, preserving receipts."""
    paths = matching_runs(cfg) + [Path(cfg["source"]) / "results/evaluations" / cfg["evalId"]]
    for directory in paths:
        lock = directory / ".lock"
        if not lock.exists():
            continue
        if lock.is_symlink():
            raise RuntimeError("Unexpected lock symlink")
        pid = int(lock.read_text().split()[0].split("=", 1)[1])
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            dest = Path(cfg["artifacts"]) / "stale-locks" / f"{directory.name}-{time.time_ns()}.txt"
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(lock, dest)
            lock.unlink()
        else:
            raise RuntimeError(f"Run still locked by live PID {pid}; refusing another writer")


def cli(cfg, args, label):
    art = Path(cfg["artifacts"])
    out, err = art / (label + ".json"), art / (label + ".stderr")
    with out.open("w") as stdout, err.open("w") as stderr:
        result = subprocess.run([cfg["bun"], "src/index.ts", *args], cwd=cfg["source"],
                                stdout=stdout, stderr=stderr)
    try:
        report = read(out)
    except (OSError, ValueError):
        report = None
    return result.returncode, report


def eval_args(cfg):
    return ["eval", "--eval-id", cfg["evalId"], "--models", cfg.get("model", MODEL),
            "--concurrency=1", "--pause-on-quota=true", "--data-dir", cfg["dataset"]]


def pause_until(report, phase):
    summaries = ([report] if phase == "smoke" else
                 [q.get("summary") or {} for q in report.get("quarters", [])])
    values = [s["availability"]["notBefore"] for s in summaries if s.get("availability")]
    return max(values) if values else None


def publish(cfg, state, report=None, label="initial"):
    """Snapshot only settled runs; each checkpoint has its own immutable archive."""
    source, publication, art = map(Path, [cfg["source"], cfg["publication"], cfg["artifacts"]])
    branch = command(["git", "branch", "--show-current"], cwd=publication).stdout.strip()
    if branch != cfg["publicationBranch"]:
        raise RuntimeError("Publication branch changed")
    if command(["git", "status", "--porcelain"], cwd=publication).stdout.strip():
        raise RuntimeError("Unexpected edits in publication checkout")
    rel = Path("results/published") / cfg["evalId"]
    out = publication / rel
    out.mkdir(parents=True, exist_ok=True)
    archive = art / f"audit-{label}.tar.gz"
    if archive.exists():
        raise RuntimeError("Refusing to overwrite an audit checkpoint")
    source_tar = art / ("source-" + cfg["revision"][:12] + ".tar")
    if not source_tar.exists():
        command(["git", "archive", cfg["revision"], "-o", str(source_tar)], cwd=source)
    with tarfile.open(archive, "w:gz") as bundle:
        bundle.add(source_tar, arcname="source.tar")
        if cfg.get("continuation"):
            if (art / "source.tar").exists():
                bundle.add(art / "source.tar", arcname="previous-source.tar")
            bundle.add(cfg["continuation"]["proofDirectory"], arcname="continuation-proof")
        bundle.add(cfg["dataset"], arcname="dataset/" + Path(cfg["dataset"]).name)
        for p in matching_runs(cfg):
            bundle.add(p, arcname="results/studies/" + p.name)
        evaluation = source / "results/evaluations" / cfg["evalId"]
        if evaluation.exists():
            bundle.add(evaluation, arcname="results/evaluations/" + cfg["evalId"])
        for pattern in ["*.json", "*.stderr", "*.txt"]:
            for p in art.glob(pattern):
                bundle.add(p, arcname="execution/" + p.name)
    previous = read(out / "provenance.json") if (out / "provenance.json").exists() else {
        "model": cfg.get("model", MODEL), "sourceRevision": cfg["revision"], "sourceCheckout": str(source),
        "datasetPath": cfg["dataset"], "datasetHash": cfg["datasetHash"],
        "availabilityPolicy": "quota-pause-v1", "concurrency": 1,
        "plannedSessions": 251, "reasoning": "medium", "subscriptionCost": None,
        "originalCohort": cfg.get("originalCohort", "astra-pi-v12-20260916"), "originalResultsPR": cfg["originalResultsPR"],
        "auditBundles": [],
    }
    previous.update(status=state["status"], phase=state["phase"], updatedAt=now(),
                    notBefore=state.get("notBefore"), error=state.get("error"))
    previous["auditBundles"].append({"label": label, "path": str(archive),
                                     "sha256": digest(archive), "bytes": archive.stat().st_size})
    for p in matching_runs(cfg):
        manifest = p / "manifest.json"
        if manifest.exists():
            previous.setdefault("runs", {})[p.name] = {
                "sourceRevision": read(manifest)["repositoryRevision"],
                "implementationHash": read(manifest)["implementation"]["hash"],
                "manifestSha256": digest(manifest),
                "runtime": read(p / "runtime.json") if (p / "runtime.json").exists() else None,
                "continuation": read(p / "manual-quota-reset.json") if (p / "manual-quota-reset.json").exists() else None,
            }
    write(out / "provenance.json", previous)
    if report is not None:
        write(out / f"{label}-summary.json", report)
    display = cfg.get("displayName", "Astra")
    if cfg.get("continuation"):
        previous["continuation"] = cfg["continuation"]
        write(out / "provenance.json", previous)
    description = f"State: **{state['status']}**, phase: **{state['phase']}**."
    if state.get("notBefore"):
        description += f" Next model attempt no earlier than **{state['notBefore']}**."
    if state.get("error"):
        description += "\n\nRequires attention: " + state["error"]
    if report and report.get("models"):
        model = report["models"][0]
        description += (f"\n\nRecorded valid days: **{model['validDays']}/251**; "
                        f"invalid days: {model['invalidDays']}; retried days: {model['retriedDays']}; "
                        f"complete quarters: {model['completedQuarters']}/4.")
        if model.get("year"):
            year = model["year"]
            description += (f" Independent quarter profits sum to **${year['netProfit']:,.2f}**; "
                            f"mean quarterly TWR **{year['meanQuarterTimeWeightedReturnPct']:.2f}%**.")
        else:
            description += " No annual score is available yet."
    if cfg.get("continuation"):
        description += "\n\nThis is a user-authorized scheduling-only continuation after an external quota reset. Original manifests, completed days and failed attempts are unchanged. The continuation receipt pins the old/new source identities; prior quota failures alone may bypass their obsolete wait. Trading, prompts, data, accounting and retry limits are byte-identical."
    text = f"""# Quota-aware {display} evaluation

{description}

{"This is a **scheduling-only continuation of the same cohort**." if cfg.get("continuation") else "This is a **new cohort**."} Earlier cohorts and their attempts remain
unchanged in [the prior results PR]({cfg['originalResultsPR']}).

The pinned `quota-pause-v1` scheduling policy pauses the entire serial queue after
an explicit provider usage-limit response. It waits for the recorded reset plus
five minutes, or six hours plus five minutes if no reset is supplied. The failed
attempt remains counted; no manifest, chain, invalid day, or retry allowance is
rewritten. Each day still allows at most two attempts.

The exact-time BB coordinator avoids duplicate workers, resumes the same pinned
cohort at its recorded quota reset plus buffer, verifies every settled checkpoint, and publishes
evidence. It pauses itself after verified completion or an unexpected blocker.
The live model smoke must pass before the annual run starts. The annual dataset is
April 2025–March 2026, in four independent accounts (62/64/64/61 sessions), with one
quarter active at a time. Pi 0.85.1 and medium reasoning remain pinned.

[Provenance and all audit-bundle checksums](provenance.json). Raw logs, datasets and
source snapshots are in immutable local audit archives on `afdasf`, not in Git.
Local archives are not an off-host backup. Subscription charges are unavailable.
Every checkpoint summary is labelled separately; a paused or failed run is not a
complete annual result. A successful integrity replay does not establish live
provider availability or historical Nasdaq-100 membership eligibility.

Implementation checks: see the linked implementation PR and committed tests.
The quota-pause tests cover provider reset parsing, no inference during cooldown,
retained attempts across resume, and refusal to grant a third attempt. Live replay
outcomes are captured in the checkpoint summaries and archived execution receipts.
"""
    (out / "README.md").write_text(text)
    command(["git", "add", str(rel)], cwd=publication)
    command(["git", "commit", "-m", "Record " + display + " checkpoint " + label], cwd=publication)
    command(["git", "push", "-u", "origin", cfg["publicationBranch"]], cwd=publication)
    prs = json.loads(command(["gh", "pr", "list", "--head", cfg["publicationBranch"],
                               "--state", "open", "--json", "url"], cwd=publication).stdout)
    body = art / "results-pr-body.md"
    body.write_text(description + "\n\nPreserves the old stopped cohort and publishes the fresh quota-aware cohort's pinned provenance, checkpoint summaries and local audit-bundle checksums. No retry allowances are reset. Each settled checkpoint is replayed; completion is claimed only after all four quarters finish and verify.\n")
    if prs:
        url = prs[0]["url"]
        command(["gh", "pr", "edit", url, "--body-file", str(body)], cwd=publication)
    else:
        url = command(["gh", "pr", "create", "--base", cfg["baseBranch"], "--head", cfg["publicationBranch"],
                       "--title", "Track " + display + " evaluation through verified completion",
                       "--body-file", str(body)], cwd=publication).stdout.strip()
    (art / "results-pr-url").write_text(url + "\n")
    return url


def worker(cfg, state_path):
    state = read(state_path)
    assert_source(cfg)
    stale_locks(cfg)
    source = Path(cfg["source"])
    for _ in range(2):  # A successful smoke can proceed directly to the annual phase.
        phase = state["phase"]
        if phase not in ["smoke", "annual"]:
            raise RuntimeError("Unexpected worker phase")
        label = f"{state['launches']:03d}-{phase}"
        if phase == "smoke":
            directory = "results/studies/" + cfg["smokeId"]
            if (source / directory / "manifest.json").exists():
                args = ["resume", "--dir", directory]
            else:
                args = ["run", "--run-id", cfg["smokeId"], "--smoke=true", "--model", cfg.get("model", MODEL),
                        "--pause-on-quota=true", "--data-dir", cfg["dataset"], "--start", "2025-04-01",
                        "--end", "2025-04-03", "--timeout-ms=300000"]
            verify_args = ["verify", "--dir", directory]
        else:
            args = eval_args(cfg)
            if (source / "results/evaluations" / cfg["evalId"] / "manifest.json").exists():
                args += ["--resume=true"]
            verify_args = eval_args(cfg) + ["--verify=true"]
        code, report = cli(cfg, args, label + "-run")
        verify_code, verified = cli(cfg, verify_args, label + "-verify")
        write(Path(cfg["artifacts"]) / (label + "-execution.json"),
              {"runExitCode": code, "verifyExitCode": verify_code, "finishedAt": now()})
        if report is None or verified is None or verify_code not in [0, 1]:
            raise RuntimeError("Execution or replay did not produce a valid report")
        if phase == "smoke" and verify_code != 0:
            raise RuntimeError("Smoke integrity replay failed")
        if phase == "annual" and any(q.get("error") for q in verified.get("quarters", [])):
            raise RuntimeError("Quarter integrity replay failed")
        pause = pause_until(verified, phase)
        if pause:
            state.update(status="waiting", notBefore=pause, updatedAt=now())
            publish(cfg, state, verified, label)
            write(state_path, state)
            return
        complete = (verified.get("validDays") == verified.get("totalDays") == 3 and code == 0
                    if phase == "smoke" else verified.get("status") == "completed" and code == verify_code == 0)
        if not complete:
            state.update(status="blocked", error="Run stopped without a recoverable quota pause; evidence retained.", updatedAt=now())
            publish(cfg, state, verified, label)
            write(state_path, state)
            return
        for path in matching_runs(cfg):
            if (phase == "smoke") == (path.name == cfg["smokeId"]):
                review_code, _ = cli(cfg, ["review", "--dir", str(path), "--analysis=true"], label + "-review-" + path.name[-7:])
                if review_code != 0:
                    raise RuntimeError("Completed run review failed")
        if phase == "smoke":
            state.update(status="smoke-qualified", notBefore=None, updatedAt=now())
            publish(cfg, state, verified, label)
            state.update(phase="annual", status="running")
            write(state_path, state)
        else:
            state.update(status="completed", notBefore=None, updatedAt=now())
            publish(cfg, state, verified, label)
            write(state_path, state)
            return


def tick(cfg, state_path, config_path):
    state = read(state_path)
    if state["status"] in ["completed", "blocked"]:
        aid = os.environ.get("BB_AUTOMATION_ID")
        project = os.environ.get("BB_PROJECT_ID")
        if aid and project:
            command([os.environ.get("BB_CLI", "bb"), "automation", "pause", aid, "--project", project])
        print(json.dumps({"status": state["status"], "error": state.get("error"), "results": str(Path(cfg["artifacts"]) / "results-pr-url")}))
        return
    if state.get("notBefore") and dt.datetime.fromisoformat(state["notBefore"].replace("Z", "+00:00")).timestamp() > time.time():
        return
    active = command(["systemctl", "is-active", cfg["unit"]], check=False)
    if active.returncode == 0:
        return
    assert_source(cfg)
    state.update(status="running", notBefore=None, launches=state.get("launches", 0) + 1, updatedAt=now())
    write(state_path, state)
    log = Path(cfg["artifacts"]) / f"worker-{state['launches']:03d}.log"
    command(["sudo", "-n", "systemd-run", "--collect", "--unit=" + cfg["unit"], "--uid=ai", "--gid=ai",
             "--property=WorkingDirectory=" + cfg["source"], "--property=StandardOutput=append:" + str(log),
             "--property=StandardError=append:" + str(log), "--setenv=HOME=/home/ai", "--setenv=PATH=" + cfg["runtimePath"],
             "/usr/bin/python3", str(Path(cfg["source"]) / "scripts/astra-recovery.py"), "work", "--config", str(config_path)])
    print(json.dumps({"status": "launched", "phase": state["phase"], "launch": state["launches"]}))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", nargs="?", default="tick", choices=["tick", "work", "publish"])
    parser.add_argument("--config", default=os.environ.get("BENCH_RECOVERY_CONFIG"))
    args = parser.parse_args()
    if not args.config:
        raise RuntimeError("BENCH_RECOVERY_CONFIG or --config is required")
    config_path = Path(args.config)
    cfg = read(config_path)
    art = Path(cfg["artifacts"])
    art.mkdir(parents=True, exist_ok=True)
    state_path = art / "state.json"
    # Tick and worker have independent locks; BB ticks may inspect a running worker.
    with (art / (args.mode + ".lock")).open("w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        try:
            if args.mode == "tick":
                tick(cfg, state_path, config_path)
            elif args.mode == "work":
                worker(cfg, state_path)
            else:
                print(publish(cfg, read(state_path)))
        except Exception as error:
            state = read(state_path)
            state.update(status="blocked", error=str(error), updatedAt=now())
            write(state_path, state)
            # Preserve even unexpected live failures in a results checkpoint when
            # publication remains available. Never hide the original exception.
            if args.mode == "work":
                try:
                    publish(cfg, state, label="blocked-" + str(time.time_ns()))
                except Exception as publication_error:
                    write(art / "publication-error.json", {"error": str(publication_error), "at": now()})
            # A subsequent tick reports and pauses instead of consuming more quota.
            raise


if __name__ == "__main__":
    main()
