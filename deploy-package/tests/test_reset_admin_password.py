import importlib.util
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('reset_tool', Path(__file__).parents[1] / 'reset-admin-password.py')
tool = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tool)


def result(code=0, output=''):
    return subprocess.CompletedProcess([], code, output, '')


class ResetTests(unittest.TestCase):
    def test_secret_only_in_stdin_not_argv(self):
        with patch.object(tool.subprocess, 'run', return_value=result()) as run:
            tool.run_backend('ainvr-backend', 'reset', 'not-a-real-password')
        args, kwargs = run.call_args
        self.assertNotIn('not-a-real-password', str(args))
        self.assertIn('not-a-real-password', kwargs['input'])
        self.assertNotIn('env', kwargs)

    def test_success_restarts_only_backend(self):
        with patch.object(tool, 'run_backend', return_value=result(output='RESET_OK\n')), \
             patch.object(tool.subprocess, 'run', return_value=result()) as run:
            tool.reset('ainvr-backend', 'test-password')
        self.assertEqual(run.call_args.args[0], ['docker', 'restart', '--time', '10', 'ainvr-backend'])

    def test_uncertain_commit_invalidates_sessions(self):
        with patch.object(tool, 'run_backend', side_effect=subprocess.TimeoutExpired('docker', 75)), \
             patch.object(tool.subprocess, 'run', return_value=result()) as run:
            with self.assertRaises(subprocess.TimeoutExpired):
                tool.reset('ainvr-backend', 'test-password')
        run.assert_called_once()

    def test_db_error_never_claims_success(self):
        with patch.object(tool, 'run_backend', return_value=result(1)), \
             patch.object(tool.subprocess, 'run', return_value=result()):
            with self.assertRaisesRegex(RuntimeError, '未确认'):
                tool.reset('ainvr-backend', 'test-password')

    def test_restart_failure_reports_possible_commit(self):
        with patch.object(tool, 'run_backend', return_value=result(output='RESET_OK\n')), \
             patch.object(tool.subprocess, 'run', return_value=result(1)):
            with self.assertRaisesRegex(RuntimeError, '可能已写入'):
                tool.reset('ainvr-backend', 'test-password')

    def test_nonroot_fails_before_backend_access(self):
        with patch.object(tool.sys, 'argv', ['reset']), patch.object(tool.os, 'geteuid', return_value=1000), \
             patch.object(tool, 'run_backend') as backend:
            with self.assertRaises(SystemExit):
                tool.main()
        backend.assert_not_called()

    def test_check_does_not_prompt_or_write(self):
        with patch.object(tool.sys, 'argv', ['reset', '--check']), patch.object(tool.os, 'geteuid', return_value=0), \
             patch.object(tool, 'run_backend', return_value=result(output='CHECK_OK\n')) as backend, \
             patch.object(tool.getpass, 'getpass') as prompt, patch.object(tool, 'reset') as reset:
            self.assertEqual(tool.main(), 0)
        backend.assert_called_once_with('ainvr-backend', 'check')
        prompt.assert_not_called()
        reset.assert_not_called()

    def test_mismatch_does_not_reset(self):
        with patch.object(tool.sys, 'argv', ['reset']), patch.object(tool.os, 'geteuid', return_value=0), \
             patch.object(tool, 'run_backend', return_value=result(output='CHECK_OK\n')), \
             patch.object(tool.sys.stdin, 'isatty', return_value=True), \
             patch.object(tool.sys.stdout, 'isatty', return_value=True), \
             patch.object(tool.getpass, 'getpass', side_effect=['test-password', 'other-password']), \
             patch.object(tool, 'reset') as reset:
            self.assertEqual(tool.main(), 1)
        reset.assert_not_called()

    def test_matches_web_utf16_length(self):
        self.assertFalse(tool.valid_password('short'))
        self.assertTrue(tool.valid_password('abcdefgh'))
        self.assertTrue(tool.valid_password('\U0001f600' * 50))
        self.assertFalse(tool.valid_password('\U0001f600' * 51))


if __name__ == '__main__':
    unittest.main()
