"""Reject altered provenance or editorial evidence before reading session inputs."""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class EvidenceTests(unittest.TestCase):
    def fixture(self, root):
        (root / 'scripts').mkdir()
        out = root / 'results/current'
        out.mkdir(parents=True)
        shutil.copy(ROOT / 'scripts/analyze.py', root / 'scripts/analyze.py')
        for name in ['manifest.json', 'provenance.json', 'memory-audit.json', 'rule-review.json']:
            shutil.copy(ROOT / 'results/current' / name, out / name)
        return out

    def check_rejection(self, root, expected):
        p = subprocess.run([sys.executable, str(root / 'scripts/analyze.py'), '--check'], capture_output=True, text=True)
        self.assertNotEqual(p.returncode, 0)
        self.assertIn(expected, p.stderr)

    def test_changed_supporting_file_is_rejected(self):
        for name in ['provenance.json', 'memory-audit.json', 'rule-review.json']:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                out = self.fixture(root)
                with (out / name).open('a') as f:
                    f.write(' ')
                self.check_rejection(root, 'Input checksum: ' + name)

    def test_rule_totals_are_recomputed_even_when_bytes_match_manifest(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            out = self.fixture(root)
            path = out / 'rule-review.json'
            rules = json.loads(path.read_text())
            rules['counts']['aligned'] += 1
            path.write_text(json.dumps(rules))
            manifest = json.loads((out / 'manifest.json').read_text())
            manifest['supporting_sha256']['rule-review.json'] = hashlib.sha256(path.read_bytes()).hexdigest()
            (out / 'manifest.json').write_text(json.dumps(manifest))
            self.check_rejection(root, 'Rule review counts disagree with cases')


if __name__ == '__main__':
    unittest.main()
