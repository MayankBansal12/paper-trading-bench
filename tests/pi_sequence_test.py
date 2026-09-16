import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('sequence', Path(__file__).resolve().parents[1] / 'scripts/pi-sequence.py')
s = importlib.util.module_from_spec(spec)
spec.loader.exec_module(s)


class SequenceTests(unittest.TestCase):
    def fixture(self, directory, astra='waiting'):
        root = Path(directory)
        paths = []
        for name, status in [('astra', astra), ('sol', 'queued')]:
            art = root / name
            art.mkdir()
            s.write(art / 'state.json', {'status': status, 'phase': 'annual', 'notBefore': '2099-01-01T00:00:00Z' if status == 'waiting' else None})
            p = art / 'config.json'
            s.write(p, {'source': str(root / (name + '-source')), 'revision': name, 'artifacts': str(art), 'unit': name, 'evalId': name})
            paths.append(str(p))
        return {'source': str(root), 'revision': 'controller', 'cohorts': paths, 'receipt': str(root / 'receipt.json'), 'automationId': 'auto-fixture'}

    def test_arm_uses_exact_timestamp_then_enables_same_automation(self):
        with tempfile.TemporaryDirectory() as d, patch.object(s, 'bb') as bb:
            cfg = self.fixture(d)
            s.arm(cfg, '2099-01-01T23:35:16Z')
            self.assertEqual(bb.call_args_list[0].args[1:], ('update', 'auto-fixture', '--at', '2099-01-01T23:35:16Z'))
            self.assertEqual(bb.call_args_list[1].args[1:], ('resume', 'auto-fixture'))

    def test_waiting_astra_rearms_without_touching_sol(self):
        with tempfile.TemporaryDirectory() as d, patch.object(s, 'verify_source'), patch.object(s, 'arm') as arm, patch.object(s.subprocess, 'run') as run:
            cfg = self.fixture(d)
            s.watch(cfg)
            run.assert_not_called()
            arm.assert_called_once_with(cfg, '2099-01-01T00:00:00Z')

    def test_completed_astra_advances_to_sol_and_rearms_on_its_quota(self):
        with tempfile.TemporaryDirectory() as d, patch.object(s, 'verify_source'), patch.object(s, 'arm') as arm:
            cfg = self.fixture(d, 'completed')
            calls = []
            def run(args, **kwargs):
                from types import SimpleNamespace
                calls.append(args)
                if args[0] == 'systemctl':
                    return SimpleNamespace(returncode=3)
                self.assertIn('sol-source', args[1])
                s.write(Path(d) / 'sol/state.json', {'status': 'waiting', 'notBefore': '2099-02-01T00:00:00Z'})
                return SimpleNamespace(returncode=0)
            with patch.object(s.subprocess, 'run', side_effect=run):
                s.watch(cfg)
            self.assertEqual(len(calls), 2)
            arm.assert_called_once_with(cfg, '2099-02-01T00:00:00Z')

    def test_blocked_astra_does_not_start_sol(self):
        with tempfile.TemporaryDirectory() as d, patch.object(s, 'verify_source'), patch.object(s, 'finish') as finish, patch.object(s.subprocess, 'run') as run:
            cfg = self.fixture(d, 'blocked')
            s.watch(cfg)
            run.assert_not_called()
            finish.assert_called_once_with(cfg, 'blocked', None)

    def test_completed_queue_pauses(self):
        with tempfile.TemporaryDirectory() as d, patch.object(s, 'verify_source'), patch.object(s, 'finish') as finish:
            cfg = self.fixture(d, 'completed')
            s.write(Path(d) / 'sol/state.json', {'status': 'completed'})
            s.watch(cfg)
            finish.assert_called_once_with(cfg, 'completed')

    def test_early_tick_launches_nothing(self):
        with tempfile.TemporaryDirectory() as d, patch.object(s.subprocess, 'run') as run:
            cfg = self.fixture(d)
            s.tick(cfg, 'config.json')
            run.assert_not_called()


if __name__ == '__main__':
    unittest.main()
