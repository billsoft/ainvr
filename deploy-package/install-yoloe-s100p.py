#!/usr/bin/env python3
"""AINVR install validated dynamic YOLOE components; does not restart services.

HBM files and tokenizer assets stay on SSD. Deployment model entries are links,
not PT/ONNX or compiler output directories. Requires the tested tokenizer venv.
"""
import argparse
import hashlib
import json
import os
import shutil
import subprocess
import time
import uuid
from pathlib import Path


def digest(path):
    with path.open('rb') as file:
        return hashlib.file_digest(file, 'sha256').hexdigest() if hasattr(hashlib, 'file_digest') else hashlib.sha256(file.read()).hexdigest()


def install_file(source, destination, expected):
    assert digest(source) == expected, str(source)
    if destination.exists():
        assert destination.is_file() and digest(destination) == expected, str(destination)
        return
    assert not destination.is_symlink(), str(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_name('.' + destination.name + '.' + uuid.uuid4().hex)
    shutil.copyfile(source, temporary)
    assert digest(temporary) == expected
    os.chmod(temporary, 0o644)
    os.replace(temporary, destination)


def install_link(destination, target, expected):
    if destination.exists():
        assert digest(destination) == expected, str(destination)
        return
    assert not destination.is_symlink(), str(destination)
    temporary = destination.with_name('.' + destination.name + '.' + uuid.uuid4().hex)
    temporary.symlink_to(target)
    os.replace(temporary, destination)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--research', type=Path, required=True)
    parser.add_argument('--tokenizer-python', type=Path, required=True)
    args = parser.parse_args()
    repo = Path('/home/sunrise/ainvr')
    assert Path.cwd().resolve() == repo
    research = args.research.resolve()
    assert research.is_relative_to(Path('/mnt/ainvr-ssd/model-compile-candidates'))
    # Preserve the virtual-environment executable entry point, not its symlink target.
    python = args.tokenizer_python.absolute()
    subprocess.run([str(python), '-c', 'import ftfy,regex; assert ftfy.__version__ == "6.3.1"; assert regex.__version__ == "2026.9.29"'],
                   check=True, timeout=15)
    detector = research / 'detector-approved-o2-v3/detector.hbm'
    contract = json.loads(Path(str(detector) + '.ainvr.json').read_text())
    quality = json.loads((repo/'test/results/yoloe-final-unseen-parity-20261013.json').read_text())
    functional = json.loads((repo/'test/results/yoloe-free-text-visible-20261013.json').read_text())
    live = json.loads((repo/'test/results/yoloe-channel-adapter-live-20261013.json').read_text())
    guards = json.loads((repo/'test/results/yoloe-channel-contract-20261013.json').read_text())
    assert quality['bpu_text_detector_parity_passed'] and quality['samples'] == 128
    assert functional['visible_free_text_functionality_verified'] and guards['passed']
    assert live['passed'] and live['same_hbm_runtime_prompt_reload_verified']
    # First-frame GPU/driver initialization is preserved separately in the report.
    warm = [frame['total_adapter_ms'] for group in live['groups'] for frame in group['frames'][1:]]
    assert len(warm) >= 10 and 1000 / (sum(warm) / len(warm)) > 5
    root = Path('/mnt/ainvr-ssd/ainvr-models/yoloe-26x-20261013')
    assert root.resolve().is_relative_to(Path('/mnt/ainvr-ssd').resolve())
    root.mkdir(parents=True, exist_ok=True)
    model_dir = repo / 'ai-service/models/derived/s100p'
    model_dir.mkdir(parents=True, exist_ok=True)
    sources = {'yoloe-26x.hbm': detector,
               'yoloe-26x-text.hbm': research/'text-float-softmax-tail-v18/mobileclip2-text.hbm',
               'yoloe-26x-reprta.hbm': research/'reprta-ec-headroom-v5/reprta.hbm'}
    expected = {'yoloe-26x.hbm': contract['hbm_sha256'],
                'yoloe-26x-text.hbm': contract['dynamic_text']['text_hbm_sha256'],
                'yoloe-26x-reprta.hbm': contract['dynamic_text']['reprta_hbm_sha256']}
    for name, source in sources.items():
        install_file(source, root/name, expected[name])
    assets = root/'clip-tokenizer'
    for name in ['simple_tokenizer.py','bpe_simple_vocab_16e6.txt.gz','LICENSE','provenance.json']:
        source = research/'clip-tokenizer-mit'/name
        install_file(source, assets/name, digest(source))
    text = contract['dynamic_text']
    text['text_hbm'] = str(root/'yoloe-26x-text.hbm')
    text['reprta_hbm'] = str(root/'yoloe-26x-reprta.hbm')
    text['tokenizer_assets'] = str(assets)
    text['tokenizer_python'] = str(python)
    contract['lifecycle'] = 'Validated hardware model installed; actual service and Web UI acceptance remain required'
    contract['validation']['native_channel_adapter_report'] = str(repo/'test/results/yoloe-channel-adapter-live-20261013.json')
    contract['validation']['warm_adapter_fps_excluding_first_frame_initialization'] = 1000 / (sum(warm)/len(warm))
    manifest = root/'yoloe-26x.hbm.ainvr.json'
    data = (json.dumps(contract, indent=2)+'\n').encode()
    if manifest.exists():
        existing = json.loads(manifest.read_text())
        for key,value in contract.items():
            if key == 'lifecycle':
                continue
            if key == 'validation':
                for field,expected_value in value.items():
                    if field not in {'service_integration_verified','web_ui_verified'}:
                        assert existing[key].get(field) == expected_value, field
            else:
                assert existing.get(key) == value, key
        # Keep later runtime/UI evidence rather than undoing completed acceptance.
    else:
        temporary = manifest.with_name('.'+manifest.name+'.'+uuid.uuid4().hex)
        temporary.write_bytes(data); os.chmod(temporary,0o644); os.replace(temporary,manifest)
    for name in sources:
        install_link(model_dir/name, root/name, expected[name])
    install_link(model_dir/manifest.name, manifest, digest(manifest))
    installed_contract = json.loads(manifest.read_text())
    report = {'installed_model': str(model_dir/'yoloe-26x.hbm'),
              'ssd_model_root': str(root),'model_sha256':expected,
              'manifest_sha256':digest(manifest),'services_restarted':False,
              'this_install_run_verifies_service_or_web_ui':False,
              'existing_service_integration_verified':installed_contract['validation'].get('service_integration_verified',False),
              'existing_web_ui_verified':installed_contract['validation'].get('web_ui_verified',False)}
    output = repo/'test/results/yoloe-model-install-20261013.json'
    if output.exists():
        output = output.with_name(output.stem+'-recheck-'+str(time.time_ns())+'.json')
    output.write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps(report,indent=2))


if __name__ == '__main__':
    main()
