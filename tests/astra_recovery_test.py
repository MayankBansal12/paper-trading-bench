import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("recovery", Path(__file__).resolve().parents[1] / "scripts/astra-recovery.py")
recovery = importlib.util.module_from_spec(spec)
spec.loader.exec_module(recovery)


class WatchdogTests(unittest.TestCase):
    def test_future_quota_reset_is_silent_and_launches_nothing(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory) / "state.json"
            state.write_text(json.dumps({"status": "waiting", "phase": "annual", "notBefore": "2099-01-01T00:00:00+00:00"}))
            with patch.object(recovery, "command") as command, patch("builtins.print") as output:
                recovery.tick({}, state, Path(directory) / "config.json")
                command.assert_not_called()
                output.assert_not_called()

    def test_active_worker_is_not_duplicated(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory) / "state.json"
            state.write_text(json.dumps({"status": "running", "phase": "annual"}))
            with patch.object(recovery, "command") as command, patch.object(recovery, "assert_source") as source:
                command.return_value.returncode = 0
                recovery.tick({"unit": "fixture.service"}, state, Path(directory) / "config.json")
                self.assertEqual(command.call_count, 1)
                source.assert_not_called()

    def test_completed_and_blocked_automations_pause(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory) / "state.json"
            for status in ["completed", "blocked"]:
                state.write_text(json.dumps({"status": status, "phase": "annual"}))
                with patch.dict("os.environ", {"BB_AUTOMATION_ID": "auto-test", "BB_PROJECT_ID": "project-test"}), patch.object(recovery, "command") as command, patch("builtins.print"):
                    recovery.tick({"artifacts": directory}, state, Path(directory) / "config.json")
                    args = command.call_args.args[0]
                    self.assertEqual(args[-4:], ["pause", "auto-test", "--project", "project-test"])

    def test_waits_for_latest_quarter_reset(self):
        report = {"quarters": [{"summary": {"availability": {"notBefore": "2026-09-16T18:05:00Z"}}}, {"summary": {"availability": {"notBefore": "2026-09-16T19:05:00Z"}}}]}
        self.assertEqual(recovery.pause_until(report, "annual"), "2026-09-16T19:05:00Z")


    def test_worker_publishes_quota_pause_without_starting_annual(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory) / "state.json"
            recovery.write(state, {"status": "running", "phase": "smoke", "launches": 1})
            cfg = {"source": directory, "artifacts": directory, "smokeId": "smoke", "dataset": directory}
            report = {"availability": {"notBefore": "2099-01-01T00:00:00Z"}}
            with patch.object(recovery, "assert_source"), patch.object(recovery, "stale_locks"), patch.object(recovery, "cli", return_value=(0, report)) as cli, patch.object(recovery, "publish") as publish:
                recovery.worker(cfg, state)
                self.assertEqual(cli.call_count, 2)
                publish.assert_called_once()
                saved = recovery.read(state)
                self.assertEqual(saved["status"], "waiting")
                self.assertEqual(saved["phase"], "smoke")
                self.assertEqual(saved["notBefore"], "2099-01-01T00:00:00Z")

    def test_worker_requires_verified_completion_and_publication(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory) / "state.json"
            recovery.write(state, {"status": "running", "phase": "smoke", "launches": 1})
            cfg = {"source": directory, "artifacts": directory, "smokeId": "smoke", "evalId": "annual", "dataset": directory}
            smoke = {"validDays": 3, "totalDays": 3}
            annual = {"status": "completed", "quarters": []}
            with patch.object(recovery, "assert_source"), patch.object(recovery, "stale_locks"), patch.object(recovery, "matching_runs", return_value=[]), patch.object(recovery, "cli", side_effect=[(0, smoke), (0, smoke), (0, annual), (0, annual)]), patch.object(recovery, "publish") as publish:
                recovery.worker(cfg, state)
                self.assertEqual(publish.call_count, 2)
                self.assertEqual(recovery.read(state)["status"], "completed")
                self.assertEqual(recovery.read(state)["phase"], "annual")


if __name__ == "__main__":
    unittest.main()
