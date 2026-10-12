#!/usr/bin/env python3
"""AINVR offline real-description parity against the reference YOLOE workflow.

This is a CPU numerical oracle in test/model_conversion, never a production
backend. It uses the original local weights and official pinned tokenizer.
It compares the detection-only YAML/load/get_text_pe/set_classes workflow to
the exported text encoder plus two-input segmentation ONNX's detection output.
Positive parity does not establish object accuracy, quantization or BPU support.
"""
import argparse
import hashlib
from importlib import metadata
import json
import os
from pathlib import Path
import socket
import time

CLIP_COMMIT = '7ffa84b3bfa40c42ecc1c77147a855e69cb2dd40'


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as f:
        for b in iter(lambda: f.read(1024 * 1024), b''):
            h.update(b)
    return h.hexdigest()


def validate_description(value):
    # Same request boundary as the read-only reference runtime.
    if (not isinstance(value, str) or not value.strip() or len(value) > 160
            or len(value.encode()) > 640
            or any(ord(c) < 32 or ord(c) == 127 or c in '<>' for c in value)):
        raise ValueError('Invalid one-line description')
    return value.strip()


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--model', type=Path, required=True)
    p.add_argument('--yoloe-onnx', type=Path, required=True)
    p.add_argument('--encoder', type=Path, required=True)
    p.add_argument('--text-onnx', type=Path, required=True)
    p.add_argument('--image-f32', type=Path, required=True)
    p.add_argument('--output', type=Path, required=True)
    p.add_argument('--description', action='append')
    args = p.parse_args()
    files = {name: getattr(args, name).resolve(strict=True) for name in
             ['model', 'yoloe_onnx', 'encoder', 'text_onnx', 'image_f32']}
    out = args.output.resolve()
    if not out.is_relative_to(Path('/mnt/ainvr-ssd')):
        p.error('Output must be a new SSD test directory')
    descriptions = [validate_description(d) for d in
                    (args.description or ['person', 'car', 'adult woman', '\u6234\u5e3d\u5b50\u7684\u4eba'])]
    if len(descriptions) < 2 or len(descriptions) > 8 or len(set(descriptions)) != len(descriptions):
        p.error('Provide 2-8 distinct descriptions')
    out.mkdir(parents=True, exist_ok=False)
    cfg = out / 'config'
    (cfg / 'Ultralytics').mkdir(parents=True)
    os.environ['YOLO_CONFIG_DIR'] = str(cfg)
    os.environ['YOLO_AUTOINSTALL'] = 'false'
    source_hashes = {k: digest(v) for k, v in files.items()}
    report = {'passed': False, 'test_only_cpu_oracle': True,
              'bpu_compiled': False, 'production_inference_verified': False,
              'detection_accuracy_verified': False, 'source_sha256': source_hashes}
    started = time.monotonic()
    previous_cwd = Path.cwd()
    original_connect, original_connect_ex = socket.socket.connect, socket.socket.connect_ex
    try:
        import numpy as np
        import torch
        import clip
        import onnxruntime as ort
        import ultralytics
        from ultralytics import YOLOE
        if ultralytics.__version__ != '8.4.24':
            raise RuntimeError('Producer oracle requires Ultralytics 8.4.24')
        direct = json.loads(metadata.distribution('clip').read_text('direct_url.json'))
        if (direct.get('url') != 'https://github.com/ultralytics/CLIP.git'
                or direct.get('vcs_info', {}).get('commit_id') != CLIP_COMMIT):
            raise RuntimeError('Official pinned CLIP tokenizer required')
        report['tokenizer'] = {'url': direct['url'], 'commit': CLIP_COMMIT}
        bpe = Path(clip.__file__).parent / 'bpe_simple_vocab_16e6.txt.gz'
        report['tokenizer']['vocabulary_sha256'] = digest(bpe)
        torch.set_num_threads(2)
        torch.set_num_interop_threads(1)

        def refuse_network(*_args, **_kwargs):
            raise RuntimeError('Offline model test refuses network access')

        socket.socket.connect = refuse_network
        socket.socket.connect_ex = refuse_network
        # Existing official fixed filename lets get_text_pe use the uploaded TS.
        if files['encoder'].name != 'mobileclip2_b.ts':
            raise RuntimeError('Reference text-encoder filename required')
        os.chdir(files['encoder'].parent)
        reference = YOLOE('yoloe-26x.yaml').load(str(files['model']))
        model = reference.model.cpu().float().eval()
        if model.text_model != 'mobileclip2:b':
            raise RuntimeError('Unexpected reference text-encoder family: ' + model.text_model)
        head = model.model[-1]
        head.end2end = False  # match the reference's nms=True request
        if head.end2end:
            raise RuntimeError('Cannot select the reference NMS head')
        head.export, head.format, head.dynamic = True, 'onnx', False
        report['reference_flow'] = 'detection YAML -> load original PT -> get_text_pe -> set_classes -> one-to-many NMS head'
        report['mask_outputs_retained_in_candidate'] = True
        image = np.fromfile(files['image_f32'], dtype='<f4')
        if (image.size != 3 * 640 * 640 or not np.isfinite(image).all()
                or image.min() < 0 or image.max() > 1):
            raise RuntimeError('Invalid normalized RGB NCHW hardware frame')
        image = image.reshape(1, 3, 640, 640)
        options = ort.SessionOptions()
        options.intra_op_num_threads, options.inter_op_num_threads = 2, 1
        text = ort.InferenceSession(str(files['text_onnx']), sess_options=options,
                                   providers=['CPUExecutionProvider'])
        detector = ort.InferenceSession(str(files['yoloe_onnx']), sess_options=options,
                                       providers=['CPUExecutionProvider'])
        cases, outputs = [], []
        for index, description in enumerate(descriptions):
            tokens = clip.tokenize([description], truncate=True)
            if tokens.shape != (1, 77) or tokens.dtype != torch.int32:
                raise RuntimeError('Invalid tokenizer contract')
            raw_features = model.get_text_pe([description], cache_clip_model=True, without_reprta=True)
            processed = model.get_text_pe([description], cache_clip_model=True)
            reference.set_classes([description], processed)
            features = text.run(None, {'tokens': tokens.numpy()})[0]
            np.testing.assert_allclose(features, raw_features.numpy().reshape(1, 512),
                                       rtol=1e-4, atol=1e-5)
            np.testing.assert_allclose(np.linalg.norm(features, axis=-1), 1, rtol=1e-5, atol=1e-5)
            with torch.inference_mode():
                expected = model.predict(torch.from_numpy(image)).cpu().numpy()
            actual, prototypes = detector.run(None, {'images': image, 'clip_features': features.reshape(1, 1, 512)})
            if expected.shape != (1, 5, 8400) or actual.shape != (1, 37, 8400) or prototypes.shape != (1, 32, 160, 160):
                raise RuntimeError('Reference/candidate detector contract mismatch')
            if not np.isfinite(actual).all() or not np.isfinite(prototypes).all():
                raise RuntimeError('Non-finite output')
            detection = actual[:, :5, :]
            np.testing.assert_allclose(detection, expected, rtol=0.002, atol=0.002)
            delta = np.abs(detection - expected)
            token_path = out / ('prompt_' + str(index) + '.tokens.i32')
            feature_path = out / ('prompt_' + str(index) + '.features.f32')
            tokens.numpy().astype('<i4').tofile(token_path)
            features.astype('<f4').tofile(feature_path)
            cases.append({'description': description, 'token_count': int(torch.count_nonzero(tokens)),
                          'max_abs_error': float(delta.max()), 'mean_abs_error': float(delta.mean()),
                          'pre_nms_max_score': float(detection[:, 4, :].max()),
                          'tokens_i32': str(token_path), 'features_f32': str(feature_path)})
            outputs.append(detection[:, 4, :])
        change = max(float(np.abs(outputs[0] - value).max()) for value in outputs[1:])
        if change <= 1e-6:
            raise RuntimeError('Real descriptions have no observed detection-score effect')
        # Reference context limit/truncation is preserved for long valid prompts.
        long_prompt = validate_description('a ' * 79)
        long_tokens = clip.tokenize([long_prompt], truncate=True)
        if long_tokens.shape != (1, 77) or int(long_tokens[0, -1]) != 49407:
            raise RuntimeError('Long description lost end-of-text token')
        report.update({'passed': True, 'cases': cases, 'real_descriptions_tokenized': True,
                       'reference_prompt_encoding_and_detector_parity_verified': True,
                       'changed_description_max_score_difference': change,
                       'offline_only': True, 'representative_calibration_verified': False,
                       'vocabulary_language_accuracy_verified': False})
    except Exception as exc:
        report['error'] = type(exc).__name__ + ': ' + str(exc)
        raise
    finally:
        socket.socket.connect, socket.socket.connect_ex = original_connect, original_connect_ex
        os.chdir(previous_cwd)
        report['source_unchanged'] = all(digest(files[k]) == sha for k, sha in source_hashes.items())
        report['elapsed_seconds'] = time.monotonic() - started
        if not report['source_unchanged']:
            report['passed'] = False
        (out / 'summary.json').write_text(json.dumps(report, indent=2, ensure_ascii=False) + '\n')
        print(json.dumps(report), flush=True)


if __name__ == '__main__':
    main()
