import importlib.util
from pathlib import Path
import unittest
spec = importlib.util.spec_from_file_location('supervisor', Path(__file__).resolve().parents[1] / 'scripts/supervise.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

class SupervisorTests(unittest.TestCase):
    def test_quota_uses_recorded_reset(self):
        report = {'status':'paused','quarters':[{'summary':{'availability':{'notBefore':'2026-09-26T00:12:11Z'}}}]}
        self.assertEqual(m.classify(report, 1), ('quota','2026-09-26T00:12:11Z'))
        self.assertEqual(m.wait_seconds('1970-01-01T00:10:00Z', 120), 480)
        self.assertEqual(m.wait_seconds('1970-01-01T00:10:00Z', 700), 0)
    def test_failure_is_terminal(self):
        for report, code in [({},0),({'status':'incomplete'},0),({'status':'invalid'},1),({'status':'completed'},1)]:
            self.assertEqual(m.classify(report,code)[0], 'blocked')
    def test_auth_and_storage_wait(self):
        self.assertEqual(m.classify({},1,'BENCH_AUTH_PAUSE')[0], 'auth')
        self.assertEqual(m.classify({},1,'BENCH_STORAGE_PAUSE')[0], 'storage')
    def test_verify_does_not_resume(self):
        cmd=m.command('exact/model','annual','/data',resume=True,verify=True)
        self.assertIn('--verify=true',cmd)
        self.assertNotIn('--resume=true',cmd)
        self.assertIn('--pause-on-quota=true',cmd)
        self.assertIn('--concurrency=1',cmd)
    def test_smoke_owns_separate_id(self):
        cmd=m.command('exact/model','annual','/data',smoke=True)
        self.assertIn('annual-smoke',cmd)
        self.assertIn('--smoke=true',cmd)
        resumed=m.command('exact/model','annual','/data',smoke=True,resume=True)
        self.assertEqual(resumed[2], 'resume')
    def test_malformed_output_is_not_completion(self):
        for text in ['', '[]', 'completed', '{"status":"completed"} trailing']:
            self.assertEqual(m.parse_report(text), {})
        self.assertEqual(m.parse_report('{"status":"completed"}'), {'status':'completed'})
