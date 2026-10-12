#!/usr/bin/env python3
"""AINVR deployment configuration tests; all credentials and files are temporary."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, ROOT/'deploy-package'/file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


prepare = load('prepare_s100p', 'prepare-s100p.py')
install = load('install_ai', 'install-ai-s100p.py')


class RuntimePreparation(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.runtime = Path(self.tmp.name)
        self.original_runtime = prepare.RUNTIME
        prepare.RUNTIME = self.runtime
        self.material = self.runtime/'credentials.json'
        self.keys = {'recorder': 'existing-recorder', 'lease-ai-service': 'existing-license'}
        self.material.write_text(json.dumps(self.keys))

    def tearDown(self):
        prepare.RUNTIME = self.original_runtime
        self.tmp.cleanup()

    def test_fresh_token_is_private_and_stable(self):
        token = prepare.ensure_ai_config_token(self.keys, self.material)
        self.assertEqual(len(token), 64)
        self.assertEqual(prepare.ensure_ai_config_token(self.keys, self.material), token)
        saved = json.loads(self.material.read_text())
        self.assertEqual(saved['recorder'], 'existing-recorder')
        self.assertEqual(saved['lease-ai-service'], 'existing-license')
        self.assertEqual(self.material.stat().st_mode & 0o777, 0o600)

    def test_existing_deployed_token_is_adopted_without_rotation(self):
        (self.runtime/'backend.env').write_text('CONFIG_SERVICE_TOKEN_AI_SERVICE=existing-ai\n')
        (self.runtime/'ai-service.env').write_text('CONFIG_SERVICE_TOKEN_AI_SERVICE=existing-ai\n')
        self.assertEqual(prepare.ensure_ai_config_token(self.keys, self.material), 'existing-ai')

    def test_mismatched_service_tokens_preserve_credentials(self):
        (self.runtime/'backend.env').write_text('CONFIG_SERVICE_TOKEN_AI_SERVICE=one\n')
        (self.runtime/'ai-service.env').write_text('CONFIG_SERVICE_TOKEN_AI_SERVICE=two\n')
        before = self.material.read_bytes()
        with self.assertRaises(ValueError):
            prepare.ensure_ai_config_token(self.keys, self.material)
        self.assertEqual(self.material.read_bytes(), before)

    def test_stored_token_conflict_is_rejected(self):
        self.keys['config-ai-service'] = 'stored'
        (self.runtime/'backend.env').write_text('CONFIG_SERVICE_TOKEN_AI_SERVICE=different\n')
        with self.assertRaises(ValueError):
            prepare.ensure_ai_config_token(self.keys, self.material)

    def test_preparation_preserves_existing_environment_files(self):
        p = self.runtime/'backend.env'
        p.write_text('USER_SETTING=preserve\n')
        prepare.env_file('backend', {'USER_SETTING': 'replacement'})
        self.assertEqual(p.read_text(), 'USER_SETTING=preserve\n')

    def test_fresh_preparation_wires_matching_tokens_and_preserves_on_repeat(self):
        root = self.runtime
        binary = root/'out/build/s100p-license/license_service'
        binary.parent.mkdir(parents=True)
        binary.touch()
        pg = root/'deploy/infra/secrets/pg_app_password'
        pg.parent.mkdir(parents=True)
        pg.write_text('test-only-password')
        runtime = root/'deploy/s100p/runtime'
        account = SimpleNamespace(pw_uid=os.geteuid(), pw_gid=os.getegid())
        with patch.multiple(prepare, ROOT=root, RUNTIME=runtime), \
                patch.object(prepare.pwd, 'getpwnam', return_value=account), \
                patch.object(prepare.subprocess, 'check_output', return_value='TEST-MACHINE'):
            prepare.main()
            files = ['backend.env', 'ai-service.env', 'credentials.json']
            saved = {name: (runtime/name).read_bytes() for name in files}
            prepare.main()
            self.assertEqual({name: (runtime/name).read_bytes() for name in files}, saved)
        read_env = lambda name: dict(l.split('=', 1) for l in (runtime/name).read_text().splitlines())
        backend, ai = read_env('backend.env'), read_env('ai-service.env')
        self.assertEqual(backend['CONFIG_SERVICE_TOKEN_AI_SERVICE'], ai['CONFIG_SERVICE_TOKEN_AI_SERVICE'])
        self.assertEqual(ai['CONFIG_CENTER_URL'], 'http://127.0.0.1:3001')
        self.assertEqual(ai['LICENSE_SIGNAL_KEY'], json.loads(saved['credentials.json'])['lease-ai-service'])


class RuntimeInstallation(unittest.TestCase):
    def runtime_info(self):
        return {'version': 'ainvr-s100p-reused-control-0.5', 'ffmpeg': {
            'version': '8.1.2', 'avformat_version': (62 << 16) | (12 << 8) | 102,
            'avcodec_version': (62 << 16) | (28 << 8) | 102,
            'avutil_version': (60 << 16) | (26 << 8) | 102}}

    def test_bpu_service_health_is_accepted(self):
        info = self.runtime_info()
        self.assertTrue(install.service_healthy({'status': 'ok', 'version': info['version'],
            'media': {'ffmpeg': info['ffmpeg']},
            'capabilities': {'model_providers': ['bpu']}}))

    def test_binary_runtime_parsing_tolerates_sdk_messages(self):
        info = self.runtime_info()
        self.assertEqual(install.parse_binary_runtime('[SDK] test\n'+json.dumps(info)+'\n[SDK] closed\n'), info)

    def test_upgrade_cannot_report_success_after_losing_business_readiness(self):
        info = self.runtime_info()
        health = {'status': 'ok', 'version': info['version'],
            'media': {'ffmpeg': info['ffmpeg']}, 'capabilities': {'model_providers': ['bpu']}}
        for business in [None, {}, {'ready': False}]:
            health['business'] = business
            self.assertFalse(install.service_healthy(health, require_business_ready=True))
        health['business'] = {'ready': True}
        self.assertTrue(install.service_healthy(health, require_business_ready=True))

    def test_old_or_mixed_media_libraries_are_rejected(self):
        for field, value in [('version', '4.4.2'), ('avcodec_version', 58 << 16),
                             ('avformat_version', 58 << 16), ('avutil_version', 56 << 16)]:
            info = self.runtime_info()
            info['ffmpeg'][field] = value
            with self.assertRaises(ValueError):
                install.parse_binary_runtime(json.dumps(info))

    def test_legacy_health_upgrade_still_requires_verified_license(self):
        info = self.runtime_info()
        health = {'status': 'ok', 'version': info['version'],
            'media': {'ffmpeg': info['ffmpeg']}, 'capabilities': {'model_providers': ['bpu']},
            'business': {'license_phase': 'valid', 'license_allowed': True, 'ready': False}}
        self.assertTrue(install.service_healthy(health, require_license_valid=True))
        self.assertFalse(install.service_healthy(health, require_license_valid=True, require_business_ready=True))
        for patch in [{'license_phase': 'invalid'}, {'license_allowed': False}, {'license_allowed': 1}]:
            candidate = {**health, 'business': {**health['business'], **patch}}
            self.assertFalse(install.service_healthy(candidate, require_license_valid=True))

    def test_missing_or_ambiguous_binary_diagnostics_are_rejected(self):
        for output in ['[SDK] only', json.dumps(self.runtime_info())+'\n'+json.dumps(self.runtime_info())]:
            with self.assertRaises(ValueError):
                install.parse_binary_runtime(output)

    def test_legacy_or_cpu_service_health_is_rejected(self):
        info = self.runtime_info()
        for health in [
            {'status': 'ok'},
            {'status': 'ok', 'version': 'ainvr-native-0.2', 'media': {'ffmpeg': info['ffmpeg']},
             'capabilities': {'model_providers': ['bpu']}},
            {'status': 'ok', 'version': info['version'], 'media': {'ffmpeg': info['ffmpeg']},
             'capabilities': {'model_providers': ['cpu', 'bpu']}},
        ]:
            self.assertFalse(install.service_healthy(health))

    def test_cpu_and_jetson_linked_backends_are_rejected(self):
        for library in ['libonnxruntime.so.1', 'libcuda.so.1', 'libcudart.so.12', 'libnvinfer.so.10']:
            with self.assertRaises(ValueError):
                install.validate_dependency_report(library+' => /opt/lib/'+library)

    def test_icu_name_is_not_mistaken_for_cuda(self):
        install.validate_dependency_report('libicudata.so.70 => /lib/libicudata.so.70\nlibdnn.so => /usr/hobot/lib/libdnn.so')

    def test_missing_library_is_rejected(self):
        with self.assertRaises(ValueError):
            install.validate_dependency_report('libhbucp.so => not found')


if __name__ == '__main__':
    unittest.main()
