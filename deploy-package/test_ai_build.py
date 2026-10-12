"""Run the actual AI packaging block against a fake compiler and a live-file sentinel."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


class AiBuildTest(unittest.TestCase):
    def run_block(self, skip=False, cached_type=None):
        script = Path(__file__).with_name('build-release.sh').read_text()
        block = script.split('# Independent build:', 1)[1].split('# 3.5 Required', 1)[0]
        block = '# Independent build:' + block
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            live = root / 'ai-service/build/ai_service'
            live.parent.mkdir(parents=True)
            live.write_text('running-binary-do-not-touch')
            config = root / 'ai-service/config'
            config.mkdir()
            (config / 'config.example.yaml').write_text('server: {}\n')
            work = root / 'package'
            for sub in ('bin', 'config', 'deploy'):
                (work / 'ai-service' / sub).mkdir(parents=True)
            fake = root / 'fake-bin'
            fake.mkdir()
            cmake = fake / 'cmake'
            cmake.write_text('''#!/bin/sh
set -eu
dir="$REPO_ROOT/out/build/ai-service-release"
mkdir -p "$dir"
printf 'CMAKE_BUILD_TYPE:STRING=RelWithDebInfo\\n' > "$dir/CMakeCache.txt"
printf '#!/bin/sh\\nprintf "mandatory-v2-no-runtime-bypass\\\\n"\\n' > "$dir/ai_service"
chmod +x "$dir/ai_service"
''')
            cmake.chmod(0o755)
            git = fake / 'git'
            git.write_text('#!/bin/sh\necho fixture-commit\n')
            git.chmod(0o755)
            if cached_type:
                build = root / 'out/build/ai-service-release'
                build.mkdir(parents=True)
                (build / 'ai_service').write_text('unused')
                (build / 'CMakeCache.txt').write_text('CMAKE_BUILD_TYPE:STRING=' + cached_type + '\n')
            env = {**os.environ, 'PATH': str(fake) + ':' + os.environ['PATH'],
                   'REPO_ROOT': str(root), 'WORK': str(work), 'SKIP_BUILD': '1' if skip else '0'}
            result = subprocess.run(['bash', '-eu', '-c', 'log() { :; };\n' + block],
                                    env=env, capture_output=True, text=True, timeout=10)
            self.assertEqual(live.read_text(), 'running-binary-do-not-touch')
            return result, (work / 'ai-service/build-info.txt').exists()

    def test_build_is_independent_and_records_metadata(self):
        result, metadata = self.run_block()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(metadata)

    def test_skip_cannot_package_only_the_live_binary(self):
        result, _ = self.run_block(skip=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Missing independent AI build', result.stderr)

    def test_skip_rejects_debug_cache(self):
        result, _ = self.run_block(skip=True, cached_type='Debug')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Unexpected AI build type', result.stderr)


if __name__ == '__main__':
    unittest.main()
