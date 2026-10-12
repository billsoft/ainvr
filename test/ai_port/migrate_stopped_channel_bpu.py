#!/usr/bin/env python3
"""AINVR: migrate a stopped legacy channel through the original control API.

The default is read-only. --apply changes only the model backend, adapter and
artifact path. This does not compile, rename or certify a model. A missing HBM
remains unavailable; --verify-missing-model exercises the real start rejection
without changing the operator's persisted stop intent.
"""
import argparse
import copy
import datetime
import hashlib
import json
import os
from pathlib import Path
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
SSD = Path('/mnt/ainvr-ssd')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--channel', required=True)
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--verify-missing-model', action='store_true')
    args = parser.parse_args()
    if args.verify_missing_model and not args.apply:
        parser.error('--verify-missing-model requires --apply')
    if ROOT.resolve() != Path('/home/sunrise/ainvr'):
        raise SystemExit('Run the installed script in the authorized AINVR root')
    settings = json.loads((ROOT / 'deploy/s100p/runtime/ai-service.json').read_text())
    headers = {'x-api-key': settings['server']['api_key'],
               'Content-Type': 'application/json'}
    base = 'http://127.0.0.1:8000/api/v1/channels/'
    base += urllib.parse.quote(args.channel, safe='')

    def request(suffix='', patch=None, method=None):
        req = urllib.request.Request(
            base + suffix, headers=headers,
            data=None if patch is None else json.dumps(patch).encode(),
            method=method or ('GET' if patch is None else 'PUT'))
        try:
            with urllib.request.urlopen(req, timeout=30) as response:
                return response.status, json.load(response)
        except urllib.error.HTTPError as error:
            return error.code, json.load(error)

    status, before = request()
    if status != 200:
        raise SystemExit('Channel read failed: HTTP ' + str(status))
    cfg = before['config']
    if not cfg.get('manually_stopped') or before['state'] != 'idle':
        raise SystemExit('The channel must already be operator-stopped and idle')
    model = cfg['model']
    # Only the verified semantic adapter for this task is selected. Other
    # tasks need their own explicit conversion and cannot be guessed here.
    if model['name'] != 'yolo26m' or model['adapter'] not in (
            'yolo26_end2end', 'yolo26_bpu'):
        raise SystemExit('This migration handles the YOLO26m end-to-end task only')
    if model['input_size'] != [640, 640]:
        raise SystemExit('Unexpected YOLO26m input dimensions')
    target = copy.deepcopy(model)
    target.update(adapter='yolo26_bpu', provider='bpu', engine_cache='')
    if model['provider'] != 'bpu':
        target['path'] = 'models/derived/s100p/yolo26m.hbm'
    if Path(target['path']).suffix != '.hbm':
        raise SystemExit('Expected a compiled HBM artifact path')
    artifact = Path(target['path'])
    if not artifact.is_absolute():
        artifact = ROOT / 'ai-service' / artifact
    artifact_present = artifact.is_file()
    if args.verify_missing_model and artifact.exists():
        raise SystemExit('Refuse a production start probe when the artifact exists')
    report = {'checked_at': datetime.datetime.now().isoformat(),
              'channel_id': args.channel, 'applied': args.apply,
              'from_provider': model['provider'], 'target_provider': 'bpu',
              'target_path': target['path'], 'hbm_present': artifact_present,
              'inference_verified': False}
    if not args.apply:
        print(json.dumps(report))
        return
    if not SSD.is_mount():
        raise SystemExit('Mount the AINVR SSD for a recoverable migration backup')
    os.umask(0o077)
    stamp = datetime.datetime.now().strftime('%Y%m%d-%H%M%S-%f')
    backup = SSD / 'migration-backups' / ('channel-bpu-' + stamp)
    backup.mkdir(parents=True, mode=0o700)
    (backup / 'previous-view.json').write_text(json.dumps(before, indent=2))
    overlay = ROOT / 'data/ai/config_overlay.json'
    (backup / 'previous-overlay.json').write_bytes(overlay.read_bytes())
    status, current = request()
    if status != 200 or current['config'] != cfg:
        raise SystemExit('Channel changed during inspection; reconcile before retrying')
    status, result = request('/config', {'model': target})
    # A transport timeout is not retried: the remote write may have succeeded.
    if status != 200 or result.get('applied') is not True:
        raise SystemExit('Model migration rejected: HTTP ' + str(status))
    status, after = request()
    assert status == 200
    expected = copy.deepcopy(cfg)
    expected['model'] = target
    assert after['config'] == expected, 'Unexpected non-model configuration change'
    assert after['state'] == 'idle' and after['config']['manually_stopped']
    assert after['stats']['inference_count'] == before['stats']['inference_count']
    persisted = json.loads(overlay.read_text())
    saved = next(c for c in persisted['channels'] if c['id'] == args.channel)
    assert saved['model'] == target and saved['manually_stopped']
    digest = hashlib.sha256(overlay.read_bytes()).hexdigest()
    forbidden = copy.deepcopy(target)
    forbidden.update(adapter='yolo26_end2end', provider='cpu',
                     path='models/yolo26m.onnx')
    status, rejected = request('/config', {'model': forbidden})
    assert status == 422 and rejected['error']['code'] == 'invalid_config'
    assert hashlib.sha256(overlay.read_bytes()).hexdigest() == digest
    report.update(backup=str(backup), model_persisted=True,
                  non_model_config_preserved=True, cpu_write_rejected=True,
                  operator_stop_preserved=True)
    if args.verify_missing_model:
        # ValidateStart precedes the operation that clears persisted stop intent.
        status, rejected = request('/start', {}, method='POST')
        assert status == 422 and rejected['error']['code'] == 'bpu_model_not_ready'
        assert hashlib.sha256(overlay.read_bytes()).hexdigest() == digest
        report.update(missing_hbm_start_status=status,
                      missing_hbm_start_error=rejected['error']['code'])
    status, final = request()
    assert status == 200 and final['config'] == expected
    assert final['state'] == 'idle'
    assert final['stats']['inference_count'] == before['stats']['inference_count']
    report['final_provider'] = final['config']['model']['provider']
    report['final_state'] = final['state']
    destination = ROOT / 'test/results' / ('channel-bpu-migration-' + stamp + '.json')
    with destination.open('x') as output:
        json.dump(report, output, indent=2)
    print(json.dumps(report))


if __name__ == '__main__':
    main()
