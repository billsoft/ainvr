#!/usr/bin/env python3
"""Compare dynamic-prompt ONNX with the user's PT under its producer version.

CPU is an isolated numerical oracle. This does not certify HBM compatibility,
semantic detection accuracy, tokenizer correctness, or production inference.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import time


def digest(p):
    h = hashlib.sha256()
    with p.open('rb') as f:
        for b in iter(lambda: f.read(1024 * 1024), b''):
            h.update(b)
    return h.hexdigest()


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--model', type=Path, required=True)
    p.add_argument('--onnx', type=Path, required=True)
    p.add_argument('--image-f32', type=Path, required=True)
    p.add_argument('--text-source', type=Path, required=True)
    p.add_argument('--text-onnx', type=Path, required=True)
    p.add_argument('--output', type=Path, required=True)
    args = p.parse_args()
    args.model = args.model.resolve(strict=True)
    args.onnx = args.onnx.resolve(strict=True)
    args.image_f32 = args.image_f32.resolve(strict=True)
    args.text_source = args.text_source.resolve(strict=True)
    args.text_onnx = args.text_onnx.resolve(strict=True)
    out = args.output.resolve()
    if not out.is_relative_to(Path('/mnt/ainvr-ssd')):
        p.error('Output must be a new SSD test directory')
    out.mkdir(parents=True, exist_ok=False)
    cfg = out / 'config'
    (cfg / 'Ultralytics').mkdir(parents=True)
    os.environ['YOLO_AUTOINSTALL'] = 'false'
    os.environ['YOLO_CONFIG_DIR'] = str(cfg)
    report = {'passed': False, 'test_only_cpu_oracle': True, 'bpu_verified': False}
    source_hash = digest(args.model)
    text_source_hash = digest(args.text_source)
    started = time.monotonic()
    try:
        import numpy as np
        import torch
        import onnxruntime as ort
        import ultralytics
        from ultralytics import YOLOE
        if ultralytics.__version__ != '8.4.24':
            raise RuntimeError('This user checkpoint records producer 8.4.24')
        torch.set_num_threads(2)
        torch.set_num_interop_threads(1)
        torch.manual_seed(24)
        model = YOLOE(str(args.model)).model.cpu().float().eval()
        head = model.model[-1]
        report['producer_version'] = ultralytics.__version__
        report['checkpoint_default_end2end'] = bool(head.end2end)
        head.end2end = False  # exact one-to-many path requested by reference nms=True
        if head.end2end or getattr(head, 'cv2', None) is None:
            raise RuntimeError('One-to-many head is unavailable')
        head.nc = 1
        head.no = 1 + 4 * head.reg_max
        head.export, head.format, head.dynamic = True, 'onnx', False
        image = np.fromfile(args.image_f32, dtype='<f4')
        if image.size != 3 * 640 * 640 or not np.isfinite(image).all() or image.min() < 0 or image.max() > 1:
            raise RuntimeError('Invalid hardware-preprocessed normalized RGB tensor')
        image = image.reshape(1, 3, 640, 640)
        options = ort.SessionOptions()
        options.intra_op_num_threads, options.inter_op_num_threads = 2, 1
        session = ort.InferenceSession(str(args.onnx), sess_options=options, providers=['CPUExecutionProvider'])
        text_session = ort.InferenceSession(str(args.text_onnx), sess_options=options,
                                           providers=['CPUExecutionProvider'])
        encoder = torch.jit.load(str(args.text_source), map_location='cpu').eval()
        parity = []
        detections = []
        for case in range(2):
            tokens = torch.zeros((1, 77), dtype=torch.int32)
            tokens[0, :3] = torch.tensor([49406, 100 + 100 * case, 49407])
            with torch.inference_mode():
                features = encoder(tokens).reshape(1, 1, 512)
                expected = model.predict(torch.from_numpy(image), tpe=features)
            text_features = text_session.run(None, {'tokens': tokens.numpy()})[0]
            np.testing.assert_allclose(text_features, features.numpy().reshape(1, 512), rtol=1e-4, atol=1e-5)
            np.testing.assert_allclose(np.linalg.norm(text_features, axis=-1), 1, rtol=1e-5, atol=1e-5)
            actual = session.run(None, {'images': image, 'clip_features': text_features.reshape(1, 1, 512)})
            detections.append(actual[0])
            if len(expected) != 2 or len(actual) != 2:
                raise RuntimeError('Detection/mask output contract missing')
            for index, (ref, value) in enumerate(zip(expected, actual)):
                ref = ref.cpu().numpy()
                if ref.shape != value.shape or not np.isfinite(value).all():
                    raise RuntimeError('Output shape/numbers differ')
                np.testing.assert_allclose(value, ref, rtol=0.002, atol=0.002)
                delta = np.abs(ref - value)
                parity.append({'case': case, 'output': index, 'shape': list(value.shape),
                               'max_abs_error': float(delta.max()), 'mean_abs_error': float(delta.mean())})
        effect = float(np.abs(detections[0][:, 4, :] - detections[1][:, 4, :]).max())
        if effect <= 1e-6:
            raise RuntimeError('Text input has no observed detection score effect')
        report.update({'passed': True, 'head_selection': 'one-to-many, reference nms=True',
                       'model_sha256': source_hash, 'onnx_sha256': digest(args.onnx),
                       'parity': parity, 'synthetic_token_ids': True,
                       'tokenizer_and_prompt_semantics_verified': False,
                       'linked_text_encoder_detector_verified': True,
                       'text_onnx_sha256': digest(args.text_onnx),
                       'changed_tokens_max_score_difference': effect,
                       'real_image_sha256': digest(args.image_f32)})
    except Exception as exc:
        report['error'] = type(exc).__name__ + ': ' + str(exc)
        raise
    finally:
        report['source_unchanged'] = source_hash == digest(args.model)
        report['text_source_unchanged'] = text_source_hash == digest(args.text_source)
        report['elapsed_seconds'] = time.monotonic() - started
        if not report['source_unchanged'] or not report['text_source_unchanged']:
            report['passed'] = False
        (out / 'summary.json').write_text(json.dumps(report, indent=2) + '\n')
        print(json.dumps(report), flush=True)


if __name__ == '__main__':
    main()
