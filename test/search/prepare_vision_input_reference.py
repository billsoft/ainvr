#!/usr/bin/env python3
"""Manual image oracle for the vision integration probe; never a runtime fallback.

CPU image processing is intentionally confined to this test. The probe runs the
result through the same verified HBM on BPU, so this is not floating-model or
semantic-accuracy validation. OpenCV's NV12 conversion here is BT.601 limited.
"""
import argparse
import hashlib
import json
from pathlib import Path

import cv2
import numpy as np


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input-nv12', required=True, type=Path)
    parser.add_argument('--width', required=True, type=int)
    parser.add_argument('--height', required=True, type=int)
    parser.add_argument('--roi', help='integer x,y,width,height; default full image')
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    width, height = args.width, args.height
    if not (2 <= width <= 4096 and 2 <= height <= 4096) or width % 2 or height % 2:
        parser.error('expected bounded, even NV12 dimensions')
    roi = [0, 0, width, height] if args.roi is None else [int(v) for v in args.roi.split(',')]
    if len(roi) != 4:
        parser.error('expected four ROI integers')
    x, y, rw, rh = roi
    if x < 0 or y < 0 or rw <= 0 or rh <= 0 or x + rw > width or y + rh > height:
        parser.error('ROI outside the source image')
    if args.input_nv12.stat().st_size != width * height * 3 // 2:
        parser.error('expected exactly one packed NV12 frame')
    results = (Path(__file__).resolve().parents[1] / 'results').resolve(strict=True)
    output = args.output.parent.resolve(strict=True) / args.output.name
    if not output.is_relative_to(results) or output.exists() or output.is_symlink():
        parser.error('output must be new and under test/results')
    metadata = output.with_suffix(output.suffix + '.json')
    if metadata.exists() or metadata.is_symlink():
        parser.error('metadata output already exists')
    raw = args.input_nv12.read_bytes()
    nv12 = np.frombuffer(raw, dtype=np.uint8).reshape(height * 3 // 2, width)
    rgb = cv2.cvtColor(nv12, cv2.COLOR_YUV2RGB_NV12)
    resized = cv2.resize(rgb[y:y + rh, x:x + rw], (256, 256), interpolation=cv2.INTER_AREA)
    tensor = np.ascontiguousarray(((resized.astype(np.float32) - 127.5) / 127.5).transpose(2, 0, 1), dtype='<f4')
    data = tensor.tobytes()
    with output.open('xb') as file:
        file.write(data)
    report = {
        'schema': 'search-vision-test-input-reference-v1',
        'source_sha256': hashlib.sha256(raw).hexdigest(),
        'reference_sha256': hashlib.sha256(data).hexdigest(),
        'width': width, 'height': height, 'source_rectangle': roi,
        'matrix': 'bt601', 'range': 'limited', 'shape': [1, 3, 256, 256],
        'cpu_image_processing': True, 'cpu_model_inference': False,
        'floating_network_reference': False, 'semantic_accuracy_verified': False,
        'opencv_version': cv2.__version__, 'numpy_version': np.__version__,
    }
    with metadata.open('x', encoding='utf-8') as file:
        json.dump(report, file, ensure_ascii=False, indent=2)
        file.write('\n')
    print(json.dumps(report, ensure_ascii=False))


if __name__ == '__main__':
    main()
