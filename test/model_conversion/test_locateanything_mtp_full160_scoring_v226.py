"""Pure controls using actual frozen160 reference text;zero model/GPU calls.

The synthetic candidate copies original text solely to exercise coverage,
existing scoring and strict-parity separation. It is not an MTP measurement.
"""
from pathlib import Path
import ast
import copy
import hashlib
import importlib.util
import json
import re
import time

STAGE = Path('/work/official-llm-v1')
SOURCE = STAGE / 'probe_locateanything_verified_mtp_full160_v225.py'
assert hashlib.sha256(SOURCE.read_bytes()).hexdigest() == '6e1aa988cbd7146cc51524fec957f3b5290a455cd200ab2bc3ff84d4381ad34c'
spec = importlib.util.spec_from_file_location('mtp_scoring225', SOURCE)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
reference = json.loads((module.REF / 'status.json').read_text())
assert hashlib.sha256((module.REF / 'status.json').read_bytes()).hexdigest() == '20ef947af737c09436e59a58ce89ef682143ffb3458633a698cef38e719e6821'
parser = STAGE / 'validate_locateanything_official_heldout_bpu_v2.py'
assert hashlib.sha256(parser.read_bytes()).hexdigest() == '616e0504988c3ff480922717f9c18a0538ce3395752d42f4bc554fdfd01cef1b'
names = {'parse_response', 'iou', 'maximum_matches'}
nodes = [n for n in ast.parse(parser.read_text()).body if isinstance(n, ast.FunctionDef) and n.name in names]
assert {n.name for n in nodes} == names
functions = {'re': re}
exec(compile(ast.Module(body=nodes, type_ignores=[]), str(parser), 'exec'), functions)
candidates = [dict(index=e['index'], target_matches_frozen_reference=True,
                   candidate_response=e['response'], candidate_terminal='<|im_end|>' in e['response'],
                   all_token_IDs_equal=True) for e in reference['cases']]
baseline = module.score_existing_thresholds(reference, candidates, functions)
assert baseline['operational_failure_indices'] == [52, 105, 117]
assert baseline['existing_threshold_quality_summary']['precision'] == 1
assert baseline['existing_threshold_quality_summary']['recall'] == 1
assert baseline['strict_token_gate_passed'] is True
assert baseline['candidate_failures_outside_existing_human_exception']==[52,105]
assert baseline['existing_threshold_quality_summary']['trial_quality_passed'] is False
negative = []
for name, mutation in [
    ('missing_case', lambda rows: rows.pop()),
    ('duplicate_case', lambda rows: rows[159].update(index=158)),
    ('baseline_not_original', lambda rows: rows[0].update(target_matches_frozen_reference=False)),
]:
    rows = copy.deepcopy(candidates)
    mutation(rows)
    try:
        module.score_existing_thresholds(reference, rows, functions)
    except (AssertionError, ValueError):
        negative.append(name)
    else:
        raise AssertionError('Invalid research evidence accepted: ' + name)
# A strict token mismatch is retained even when parsed geometry is unchanged.
rows = copy.deepcopy(candidates)
rows[6]['all_token_IDs_equal'] = False
strict = module.score_existing_thresholds(reference, rows, functions)
assert strict['strict_token_gate_passed'] is False
assert strict['existing_threshold_quality_summary'] == baseline['existing_threshold_quality_summary']
# A new nonterminal case remains visible;the prior117 exception cannot hide it.
rows = copy.deepcopy(candidates)
rows[1]['candidate_response'] = rows[1]['candidate_response'].replace('<|im_end|>', '')
rows[1]['candidate_terminal'] = False
new_failure = module.score_existing_thresholds(reference, rows, functions)
assert new_failure['operational_failure_indices'] == [1, 52, 105, 117]
assert new_failure['no_new_failure_exception_granted'] is True
report = dict(status='full160_reference_scoring_controls_passed_not_candidate_quality',
              finished=time.time(), source_sha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
              synthetic_positive_controls=3, negative_controls=negative,
              actual_reference_cases=160, original_reference_failure_indices=[52, 105, 117],
              strict_failure_not_hidden_by_geometry=True, new_failure_not_waived=True,
              neural_calls=0, CUDA_initialized=False, services_modified=False,
              MTP_actual_full160_executed=False, BPU_qualified=False)
out = STAGE / 'verified-mtp-full160-scoring-controls-v226.json'
assert not out.exists()
out.write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(report))
