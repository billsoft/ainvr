"""Reject missing/tampered/narrow qualification;never write the live queue gate."""
from pathlib import Path
import copy,hashlib,json,time,traceback
import queue_locateanything_compact_remaining_ar_groups_v1 as queue

ROOT=Path('/work/official-llm-v1');OUT=ROOT/'locateanything-compact-remaining-queue-gate-controls-v1.json'
WORK=Path('/opt/locate-compact-queue-gate-controls-v1')
assert not OUT.exists() and not WORK.exists()
assert not (ROOT/'locateanything-compact-ar9-board-qualification-v1.json').exists()
original=json.loads((ROOT/'compact-profile-chunk-fixture-regression-ar1-v4-guard-v5.json').read_text())
assert original['status']=='completed' and original['hardware']['layer_indices']==[0]
assert original['hardware']['board_calls']==12
WORK.mkdir();cases=[]
def exercise(name,receipt,proof=original,exception=AssertionError):
    directory=WORK/name;directory.mkdir()
    queue.RECEIPT=directory/'receipt.json';queue.BOARD=directory/'proof.json'
    raw=(json.dumps(proof,indent=2)+'\n').encode();queue.BOARD.write_bytes(raw)
    if receipt is not None:
        value=dict(status='actual_ar9_board_qualification_verified',board_report_file='proof.json',board_report_sha256=hashlib.sha256(raw).hexdigest())
        value.update(receipt);queue.RECEIPT.write_text(json.dumps(value,indent=2)+'\n')
    try:queue.actual_qualification()
    except exception:cases.append(dict(name=name,rejected=True,expected_exception=exception.__name__))
    else:raise AssertionError('Unsafe/narrow qualification was admitted: '+name)
started=time.time()
exercise('missing-receipt',None,exception=FileNotFoundError)
exercise('wrong-receipt-status',dict(status='unit_tests_passed'))
exercise('wrong-proof-filename',dict(board_report_file='other.json'))
exercise('wrong-proof-digest',dict(board_report_sha256='0'*64))
exercise('actual-single-layer-proof-cannot-qualify-nine',{})
tampered=copy.deepcopy(original);tampered['hardware']['layer_indices']=list(range(9))
exercise('tampered-layer-label-still-has-only-three-outputs',{},tampered)
report=dict(status='passed',started=started,finished=time.time(),controls=cases,control_count=len(cases),
  source_sha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),queue_source_sha256=hashlib.sha256((ROOT/'queue_locateanything_compact_remaining_ar_groups_v1.py').read_bytes()).hexdigest(),
  actual_neural_calls=0,compiler_jobs_started=0,live_gate_written=False,
  actual_nine_layer_positive_qualification_verified=False,whole_model_verified=False,release_approved=False)
OUT.write_text(json.dumps(report,indent=2)+'\n');print(json.dumps({k:report[k] for k in ['status','control_count','compiler_jobs_started','live_gate_written']}))
