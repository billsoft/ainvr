"""AINVR compare complete raw YOLOE BPU detections with the original FP32 oracle.

Eight runtime slots map to per-image class names. Inactive slots are ignored.
Agreement gates match the existing detector gates; this is not ground-truth AP.
"""
import argparse
import json
from pathlib import Path
import numpy as np
from scipy.optimize import linear_sum_assignment

p = argparse.ArgumentParser(description=__doc__)
p.add_argument('--reference', type=Path, required=True)
p.add_argument('--actual', type=Path, required=True)
p.add_argument('--output', type=Path, required=True)
a = p.parse_args()
assert not a.output.exists()
reference = json.loads((a.reference / 'manifest.json').read_text())
actual = json.loads((a.actual / 'manifest.json').read_text())
assert reference['backend'] == 'onnx-cuda' and actual['backend'] == 'bpu'
assert reference['source_onnx_sha256'] == actual['source_onnx_sha256']
assert reference['prepared_manifest_sha256'] == actual['prepared_manifest_sha256']
refs = {x['id']: x for x in reference['samples']}
gots = {x['id']: x for x in actual['samples']}
assert refs.keys() == gots.keys() and len(refs) == 128

def iou(x, y):
    top = np.maximum(x[:, None, :2], y[None, :, :2])
    bottom = np.minimum(x[:, None, 2:4], y[None, :, 2:4])
    area = np.prod(np.maximum(bottom - top, 0), axis=-1)
    ax = np.prod(np.maximum(x[:, 2:4] - x[:, :2], 0), axis=-1)
    ay = np.prod(np.maximum(y[:, 2:4] - y[:, :2], 0), axis=-1)
    return area / np.maximum(ax[:, None] + ay[None, :] - area, 1e-12)

def decode(raw, item):
    assert raw.shape == (1, 12, 8400) and np.isfinite(raw).all()
    raw = raw[0].T.astype(np.float64)
    scores = raw[:, 4:4 + item['active_count']]
    cls = np.argmax(scores, axis=1)
    conf = scores[np.arange(len(scores)), cls]
    keep = (conf >= .25) & (raw[:, 2] > 0) & (raw[:, 3] > 0)
    raw, cls, conf = raw[keep], cls[keep], conf[keep]
    boxes = np.column_stack((raw[:, :2] - raw[:, 2:4] / 2,
                             raw[:, :2] + raw[:, 2:4] / 2))
    order = np.argsort(-conf, kind='stable')[:30000]
    selected = []
    while len(order) and len(selected) < 300:
        index = order[0]
        selected.append(index)
        rest = order[1:]
        if not len(rest):
            break
        overlap = iou(boxes[index:index + 1], boxes[rest])[0]
        order = rest[(cls[rest] != cls[index]) | (overlap <= .45)]
    indices = np.array(selected, dtype=np.int64)
    labels = np.array(item['class_ids'], dtype=np.int64)[cls[indices]]
    return np.column_stack((boxes[indices], conf[indices], labels))

rows = []
reference_count = actual_count = matched_count = 0
overlaps = []
score_errors = []
for key in sorted(refs):
    xmeta, ymeta = refs[key], gots[key]
    for field in ['image_sha256', 'prompt_sha256', 'class_ids', 'active_count']:
        assert xmeta[field] == ymeta[field], (key, field)
    xr = np.load(a.reference / (key + '.npz'))['output']
    yr = np.load(a.actual / (key + '.npz'))['output']
    x, y = decode(xr, xmeta), decode(yr, ymeta)
    reference_count += len(x)
    actual_count += len(y)
    matches = 0
    if len(x) and len(y):
        matrix = iou(x, y)
        same = x[:, None, 5] == y[None, :, 5]
        ii, jj = linear_sum_assignment(1 - matrix + 1000 * (~same))
        for i, j in zip(ii, jj):
            if same[i, j] and matrix[i, j] >= .5:
                matches += 1
                overlaps.append(float(matrix[i, j]))
                score_errors.append(float(abs(x[i, 4] - y[j, 4])))
    matched_count += matches
    rows.append({'id': key, 'active_classes': xmeta['class_names'][:xmeta['active_count']],
                 'reference_detections': len(x), 'actual_detections': len(y),
                 'matches_iou50': matches,
                 'raw_box_max_abs_error': float(np.max(np.abs(xr[:, :4] - yr[:, :4]))),
                 'raw_score_max_abs_error': float(np.max(np.abs(xr[:, 4:] - yr[:, 4:])))})
metrics = {'reference_detections': reference_count, 'actual_detections': actual_count,
           'agreement_precision': matched_count / max(actual_count, 1),
           'agreement_recall': matched_count / max(reference_count, 1),
           'mean_matched_iou': float(np.mean(overlaps)) if overlaps else 0,
           'mean_score_abs_error': float(np.mean(score_errors)) if score_errors else None}
passed = (reference_count >= 32 and metrics['agreement_precision'] >= .95
          and metrics['agreement_recall'] >= .95 and metrics['mean_matched_iou'] >= .9)
report = {'scope': 'Complete dual-input detector, offline FP32 prompt oracle; not BPU text encoding',
          'samples': 128, 'metrics': metrics, 'quantization_parity_passed': passed,
          'hbm_sha256': actual['model_sha256'], 'reference_onnx_sha256': reference['model_sha256'],
          'prepared_manifest_sha256': reference['prepared_manifest_sha256'],
          'board_fps_with_production_running': actual['sequential_fps'],
          'thresholds': {'confidence': .25, 'class_aware_nms_iou': .45,
                         'precision': .95, 'recall': .95, 'matched_iou': .9},
          'note': 'FP32 agreement is not labeled accuracy. Text encoder, semantic switch and real channel remain.',
          'production_approved': False, 'full_dynamic_text_pipeline_verified': False, 'rows': rows}
if actual.get('prompts_generated_on_bpu'):
    report.update(scope='Full BPU text+RepRTA+detector parity against original FP32 prompt/detector oracle',
                  bpu_text_detector_parity_passed=passed,
                  text_hbm_sha256=actual['text_hbm_sha256'],reprta_hbm_sha256=actual['reprta_hbm_sha256'],
                  distinct_texts_encoded_on_bpu=actual['distinct_texts_encoded'],
                  note='Actual vectors are generated on BPU, not the reference files. Still requires non-COCO semantic and service/UI checks.')
a.output.write_text(json.dumps(report, indent=2))
print(json.dumps({k: v for k, v in report.items() if k != 'rows'}, indent=2))
if not passed:
    raise SystemExit(2)
