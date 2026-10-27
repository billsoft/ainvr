"""Shared artifact verification and fail-closed retired publisher entrypoints.
Production swap/rollback coverage lives in test/ptz/test_production_deploy.py.
"""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
import sys
sys.path.insert(0,str(ROOT/'deploy-package'))
import release_common as RELEASE
import console_release as LEGACY



class ConsoleReleaseTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.root_patch = patch.object(RELEASE, 'ROOT', self.root)
        self.root_patch.start()
        self.addCleanup(self.root_patch.stop)
        self.candidate = self.root/'out/verified-console'
        self.candidate.mkdir(parents=True)
        self.source = self.root/'source.ts'
        self.source.write_text('source generation')
        (self.candidate/'source-manifest.json').write_text(json.dumps({'source.ts': RELEASE.sha(self.source)}))
        (self.candidate/'status.json').write_text(json.dumps({'phase': 'built'}))
        for base in [self.candidate, self.root/'srs-web-console']:
            for name in ['backend', 'frontend']:
                folder = base/name if base == self.candidate else base/name/'dist'
                folder.mkdir(parents=True)
                entry = folder/('server.js' if name == 'backend' else 'index.html')
                entry.write_text(('new' if base == self.candidate else 'old')+' '+name)
                if name == 'frontend':
                    (folder/'assets').mkdir()
                    (folder/'assets'/('new.js' if base == self.candidate else 'old.js')).write_text('page asset')
        manifest = {n: RELEASE.files(self.candidate/n) for n in ['backend', 'frontend']}
        (self.candidate/'artifacts.json').write_text(json.dumps(manifest))
        self.before = {n: RELEASE.files(self.root/'srs-web-console'/n/'dist') for n in ['backend', 'frontend']}
        self.calls = []
        self.ready_patch = patch.object(RELEASE, 'ready')
        self.ready = self.ready_patch.start()
        self.addCleanup(self.ready_patch.stop)

    def command(self, args):
        self.calls.append(args)
        if args[:2] == ['systemctl', 'is-active']:
            return 'active'
        if args[:2] == ['systemctl', 'show']:
            return 'MainPID=100\nActiveState=active\nExecMainStartTimestampMonotonic=123'
        if args[:2] == ['docker', 'inspect']:
            return '101 fixed-start-identity'
        self.assertIn(args, [['systemctl', 'stop', 'ainvr-backend'], ['systemctl', 'start', 'ainvr-backend']])
        return ''

    def test_validate_hashes_and_reject_source_changes(self):
        self.assertEqual(RELEASE.validate(self.candidate), self.candidate)
        self.source.write_text('concurrent edit')
        with self.assertRaises(ValueError):
            RELEASE.validate(self.candidate)
        self.assertEqual(self.calls, [])

    def test_artifact_changes_and_symlinks_are_rejected(self):
        file = self.candidate/'frontend/index.html'
        file.write_text('changed')
        with self.assertRaises(ValueError):
            RELEASE.validate(self.candidate)
        file.unlink()
        file.symlink_to(self.source)
        with self.assertRaises(ValueError):
            RELEASE.validate(self.candidate)

    def test_manifest_paths_cannot_escape_source(self):
        (self.candidate/'source-manifest.json').write_text(json.dumps({'../other': '0'*64}))
        with self.assertRaises(ValueError):
            RELEASE.validate(self.candidate)

    def test_retired_mutations_never_change_services_or_files(self):
        for action in [LEGACY.apply, LEGACY.restore]:
            with self.assertRaisesRegex(RuntimeError, 'retired'):
                action(self.candidate)
        self.assertEqual(self.calls, [])
        for name, before in self.before.items():
            self.assertEqual(RELEASE.files(self.root/'srs-web-console'/name/'dist'), before)


if __name__ == '__main__':
    unittest.main()
