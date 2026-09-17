"""Offline supervisor gates; never invokes a provider or publishes."""
import importlib.util
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('muse_supervisor', Path(__file__).parents[1] / 'scripts/muse-supervisor.py')
supervisor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(supervisor)

class SupervisorTests(unittest.TestCase):
    def test_smoke_requires_valid_replayed_days_and_usage(self):
        valid = {'validDays': 3, 'totalDays': 3, 'usageUnavailableAttempts': 0}
        self.assertTrue(supervisor.smoke_complete(0, 0, valid))
        for patch_value in [{'validDays': 0}, {'validDays': 2}, {'totalDays': 4}, {'usageUnavailableAttempts': 1}]:
            self.assertFalse(supervisor.smoke_complete(0, 0, valid | patch_value))
        self.assertFalse(supervisor.smoke_complete(1, 0, valid))
        self.assertFalse(supervisor.smoke_complete(0, 1, valid))

    def test_paused_smoke_publishes_once_without_annual(self):
        with tempfile.TemporaryDirectory() as d:
            cfg = {'source': d, 'artifacts': d, 'smokeId': 'smoke', 'dataset': '/frozen', 'evalId': 'fresh'}
            state = {'phase': 'smoke', 'launches': 1, 'status': 'running'}
            paused = {'validDays': 0, 'totalDays': 3, 'availability': {'notBefore': '2026-09-18T01:05:00Z'}}
            with patch.object(supervisor, 'assert_pins'), patch.object(supervisor, 'cli', side_effect=[(1, paused), (0, paused)]) as cli, patch.object(supervisor, 'publish') as publish, patch.object(supervisor, 'runs', return_value=[]):
                supervisor.checkpoint(cfg, state)
                self.assertEqual(state['status'], 'waiting')
                self.assertEqual(state['phase'], 'smoke')
                self.assertEqual(state['notBefore'], '2026-09-18T01:05:00Z')
                self.assertEqual(cli.call_count, 2)
                publish.assert_called_once()

    def test_nonquota_failure_blocks_and_publishes(self):
        with tempfile.TemporaryDirectory() as d:
            cfg = {'source': d, 'artifacts': d, 'smokeId': 'smoke', 'dataset': '/frozen', 'evalId': 'fresh'}
            state = {'phase': 'smoke', 'launches': 1, 'status': 'running'}
            failed = {'validDays': 0, 'totalDays': 3, 'invalidDays': 3}
            with patch.object(supervisor, 'assert_pins'), patch.object(supervisor, 'cli', side_effect=[(1, failed), (0, failed)]), patch.object(supervisor, 'publish') as publish, patch.object(supervisor, 'runs', return_value=[]):
                supervisor.checkpoint(cfg, state)
                self.assertEqual(state['status'], 'blocked')
                publish.assert_called_once()

    def test_paid_route_rejected_before_source_access(self):
        with self.assertRaisesRegex(RuntimeError, 'exact free Zen'):
            supervisor.assert_pins({'model': 'opencode-go/glm-5.3-flash'})

if __name__ == '__main__':
    unittest.main()
