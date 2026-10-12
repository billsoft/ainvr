"""AINVR: compare every production-NMS detection for predeclared free text.

Retains the failed raw-grid diagnostic. This separately measures the actual
user-visible detection contract, not pointwise equality of redundant anchors.
The four functional cases do not establish broad open-vocabulary accuracy.
"""
import argparse
import hashlib
import json
import subprocess
from pathlib import Path

import hbm_runtime
import numpy as np


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def iou(left, right):
    x, y, w, h = left
    a, b, c, d = right
    intersection = max(0, min(x + w, a + c) - max(x, a)) * max(
        0, min(y + h, b + d) - max(y, b))
    return intersection / max(w * h + c * d - intersection, 1e-12)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ['references', 'text', 'reprta', 'detector', 'python',
                 'helper', 'assets', 'native-probe', 'decode-probe',
                 'raw-diagnostic', 'work', 'output']:
        parser.add_argument('--' + name, type=Path, required=True)
    args = parser.parse_args()
    assert not args.output.exists() and not args.work.exists()
    manifest = json.loads((args.references / 'manifest.json').read_text())
    raw = json.loads(args.raw_diagnostic.read_text())
    assert raw['detector_hbm_sha256'] == sha(args.detector)
    assert raw['text_hbm_sha256'] == sha(args.text)
    assert raw['reprta_hbm_sha256'] == sha(args.reprta)
    assert raw['native_prompt_generation_verified']
    cases = manifest['samples']
    assert len(cases) == 4
    args.work.mkdir()
    request = args.work / 'request.json'
    vectors = args.work / 'vectors.bin'
    request.write_text(json.dumps({'groups': [x['phrases'] for x in cases]}))
    subprocess.run([str(args.native_probe), str(args.text), str(args.reprta),
                    str(args.python), str(args.helper), str(args.assets),
                    str(request), str(vectors)], check=True, capture_output=True,
                   text=True, timeout=30)
    prompts = np.fromfile(vectors, dtype='<f4').reshape(4, 1, 8, 512)
    runtime = hbm_runtime.HB_HBMRuntime(str(args.detector))
    assert len(runtime.model_names) == 1
    name = runtime.model_names[0]
    runtime.set_scheduling_params(bpu_cores={name: [0]})
    rows = []
    passed = True
    for index, case in enumerate(cases):
        data = np.load(args.references / case['file'])
        ref = data['reference']
        actual = next(iter(runtime.run({name: {
            'images': data['image'], 'prompt_embeddings': prompts[index]
        }})[name].values()))
        assert actual.shape == ref.shape == (1, 12, 8400)
        assert np.isfinite(actual).all()
        labels = args.work / f'{index}-labels.json'
        labels.write_text(json.dumps(case['phrases']))
        decoded = []
        for kind, tensor in [('fp32', ref), ('bpu', actual)]:
            binary = args.work / f'{index}-{kind}.bin'
            tensor.astype('<f4').tofile(binary)
            result = subprocess.run([str(args.decode_probe), str(binary),
                                     str(labels)], check=True,
                                    capture_output=True, text=True, timeout=10)
            decoded.append(json.loads(result.stdout))
        reference, got = decoded
        # Match all outputs by class and overlap; unmatched outputs are failures.
        pairs = sorted([(iou(r['bbox'], g['bbox']), rindex, gindex)
                        for rindex, r in enumerate(reference)
                        for gindex, g in enumerate(got)
                        if r['class_id'] == g['class_id']], reverse=True)
        matched_ref, matched_got, matches = set(), set(), []
        for overlap, rindex, gindex in pairs:
            if overlap < .5 or rindex in matched_ref or gindex in matched_got:
                continue
            matched_ref.add(rindex)
            matched_got.add(gindex)
            matches.append({'reference_index': rindex, 'bpu_index': gindex,
                            'iou': overlap, 'confidence_error': abs(
                                reference[rindex]['confidence'] -
                                got[gindex]['confidence'])})
        false_positive = len(got) - len(matches)
        false_negative = len(reference) - len(matches)
        positive_pass = all(any(r['class_id'] == k for r in reference) and
                            any(g['class_id'] == k for g in got)
                            for k in case['required_positive_indices'])
        negative_pass = not case['negative_only'] or not reference and not got
        case_pass = (false_positive == false_negative == 0 and positive_pass and
                     negative_pass and all(m['iou'] >= .9 and
                                           m['confidence_error'] <= .15
                                           for m in matches))
        passed &= case_pass
        rows.append({'case': case, 'fp32_detections': reference,
                     'bpu_detections': got, 'matches': matches,
                     'false_positive_vs_fp32': false_positive,
                     'false_negative_vs_fp32': false_negative,
                     'passed': case_pass,
                     'raw_grid_max_probability_error': float(np.abs(
                         actual[:, 4:4 + len(case['phrases'])] -
                         ref[:, 4:4 + len(case['phrases'])]).max())})
    switch_pass = rows[0]['bpu_detections'] != rows[1]['bpu_detections']
    passed &= switch_pass
    report = {
        'scope': 'All production-NMS detections in four predeclared functional '
                 'free-text cases; not broad recognition accuracy or COCO AP',
        'detector_hbm_sha256': sha(args.detector),
        'text_hbm_sha256': sha(args.text), 'reprta_hbm_sha256': sha(args.reprta),
        'native_probe_sha256': sha(args.native_probe),
        'production_decoder_probe_sha256': sha(args.decode_probe),
        'reference_manifest_sha256': sha(args.references / 'manifest.json'),
        'confidence_threshold': .25, 'nms_iou_threshold': .45,
        'required_unmatched_outputs': 0, 'minimum_matched_iou': .9,
        'maximum_matched_confidence_error': .15,
        'native_text_generation_verified': True, 'cpu_neural_fallback': False,
        'same_image_runtime_phrase_switch_verified': switch_pass,
        'visible_free_text_functionality_verified': passed,
        'original_raw_grid_diagnostic': str(args.raw_diagnostic),
        'original_raw_grid_diagnostic_sha256': sha(args.raw_diagnostic),
        'raw_grid_diagnostic_passed': raw['runtime_free_text_verified'],
        'limitations': raw['limitations'], 'samples': rows,
        'production_approved': False,
    }
    args.output.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({k: report[k] for k in [
        'visible_free_text_functionality_verified',
        'same_image_runtime_phrase_switch_verified',
        'raw_grid_diagnostic_passed']}))
    print(json.dumps([{'case': i, 'reference': len(r['fp32_detections']),
                       'bpu': len(r['bpu_detections']), 'matches': r['matches'],
                       'passed': r['passed']} for i, r in enumerate(rows)]))
    if not passed:
        raise SystemExit(2)


if __name__ == '__main__':
    main()
