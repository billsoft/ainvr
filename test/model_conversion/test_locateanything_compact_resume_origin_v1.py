"""Compiler provenance controls only;synthetic completion flags are NOT HBMs."""
from pathlib import Path
import copy,hashlib,json,time,unittest
from locateanything_compact_compiler_origin_v1 import verify_compiler_origin,EXPORT_SHA,RESUME_SHA
ROOT=Path('/home/sunrise/ainvr')
LEGACY=Path('/mnt/ainvr-ssd/model-compile-candidates/locateanything-3b-w4-v1/compact-affine-decoder-block-v1/compiler-status.json')
EXPORT=ROOT/'test/results/locateanything-compact-ar9-converted-before-resume-v1.json'

def synthetic_provenance():
    raw=EXPORT.read_text();r=json.loads(raw)
    r.update(status='completed',bpu_only=True,source_sha256=RESUME_SHA,export_source_sha256=EXPORT_SHA,
      compile_jobs=1,optimization=0,maximum_compile_seconds=None,serialized_graph_identity_checked=True,
      compile_resume=dict(original_status_utf8=raw,original_status_sha256=hashlib.sha256(raw.encode()).hexdigest(),
        original_converted_bc_sha256=r['converted_bc_sha256'],compiler_restarted_from_saved_bc=True,
        recalibration_executed=False,graph_or_weight_changes=False))
    return r

class OriginControls(unittest.TestCase):
    def reject(self,mutate):
        r=synthetic_provenance();mutate(r)
        with self.assertRaises(AssertionError):verify_compiler_origin(r)
    def test_actual_legacy_completed_report(self):self.assertFalse(verify_compiler_origin(json.loads(LEGACY.read_text()))['resumed_from_saved_bc'])
    def test_actual_incomplete_export_rejected(self):
        with self.assertRaises(AssertionError):verify_compiler_origin(json.loads(EXPORT.read_text()))
    def test_synthetic_resume_origin_structure(self):self.assertTrue(verify_compiler_origin(synthetic_provenance())['resumed_from_saved_bc'])
    def test_no_original_producer_impersonation(self):self.reject(lambda r:r.update(source_sha256=EXPORT_SHA))
    def test_raw_export_bytes_tamper_rejected(self):self.reject(lambda r:r['compile_resume'].update(original_status_utf8=r['compile_resume']['original_status_utf8']+' '))
    def test_checkpoint_tamper_rejected(self):self.reject(lambda r:r.update(selected_checkpoint_sha256='0'*64))
    def test_weight_module_tamper_rejected(self):self.reject(lambda r:r['selected_modules'][0].update(checkpoint_file_sha256='0'*64))
    def test_calibration_metadata_tamper_rejected(self):self.reject(lambda r:r['layers'][0].update(calibration='different calibration'))
    def test_graph_hash_tamper_rejected(self):self.reject(lambda r:r.update(converted_bc_sha256='0'*64))
    def test_recalibration_flag_rejected(self):self.reject(lambda r:r['compile_resume'].update(recalibration_executed=True))
    def test_changed_optimization_rejected(self):self.reject(lambda r:r.update(optimization=2))
    def test_unknown_producer_rejected(self):self.reject(lambda r:r.update(source_sha256='0'*64))

if __name__=='__main__':
    report=ROOT/'test/results/locateanything-compact-resume-origin-controls-v1.json';assert not report.exists()
    start=time.time();result=unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(OriginControls))
    names=['locateanything_compact_compiler_origin_v1.py','compile_locateanything_compact_saved_bc_v1.py']
    r=dict(status='passed' if result.wasSuccessful() else 'failed',started=start,finished=time.time(),tests_run=result.testsRun,
      failures=[str(x) for x in result.failures],errors=[str(x) for x in result.errors],
      source_sha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),dependency_sha256={n:hashlib.sha256((Path(__file__).parent/n).read_bytes()).hexdigest() for n in names},
      synthetic_provenance_control_only=True,actual_neural_calls=0,new_resumed_hbm_verified=False,whole_model_verified=False,release_approved=False)
    report.write_text(json.dumps(r,indent=2)+'\n');assert result.wasSuccessful()
