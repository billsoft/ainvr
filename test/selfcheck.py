#!/usr/bin/env python3
"""Validate evidence collection without using hardware or modifying system state."""
import argparse
import json
import sys
import unittest
from common import Experiment


class EvidenceChecks(unittest.TestCase):
    def setUp(self):
        self.exp = Experiment("selfcheck", argparse.Namespace(timeout=1))

    def test_zero_exit_without_evidence_is_rejected(self):
        with self.assertRaisesRegex(RuntimeError, "No HWJSON"):
            self.exp.native(sys.executable, "-c", "print('help text')")

    def test_json_stdout_is_not_contaminated_by_warning(self):
        text, _ = self.exp.command([sys.executable, "-c",
            "import sys; print('driver warning',file=sys.stderr); print('{\"frames\":12}')"],
            "separate-stderr", separate_stderr=True)
        self.assertEqual(json.loads(text)["frames"], 12)
        self.assertIn("driver warning", (self.exp.out / "separate-stderr.stderr.log").read_text())

    def test_nonzero_exit_cannot_become_pass(self):
        row = self.exp.case("failing-command", lambda: self.exp.command(
            [sys.executable, "-c", "raise SystemExit(7)"], "exit-seven"))
        self.assertEqual(row["status"], "FAIL")
        self.assertEqual(self.exp.finish(), 1)

    def test_timeout_is_bounded_and_reported(self):
        with self.assertRaisesRegex(RuntimeError, "timeout"):
            self.exp.command([sys.executable, "-c", "import time; time.sleep(20)"], "timeout")
        self.assertTrue(self.exp.commands[-1]["timeout"])
        self.assertLess(self.exp.commands[-1]["seconds"], 5)


if __name__ == "__main__":
    unittest.main(verbosity=2)
