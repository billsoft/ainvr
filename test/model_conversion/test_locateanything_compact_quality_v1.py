"""Synthetic acceptance-control boundaries only;ZERO actual model quality claims."""
from pathlib import Path
import copy,hashlib,json,time,unittest
from locateanything_compact_quality_v1 import summarize_compact,parse_response,maximum_matches,iou

def box_text(boxes):
    return ''.join('<box>'+''.join('<'+str(v)+'>' for v in box)+'</box>' for box in boxes) or '<box>none</box>'

def fixture(matches=9,predicted=20,reference=20):
    target=[[i*40,10,i*40+20,30] for i in range(reference)]
    boxes=target[:matches]+[[i*40,300,i*40+20,320] for i in range(predicted-matches)]
    cases=[]
    for index in range(72):
        response=box_text(boxes if index==0 else [])
        ref=parse_response(box_text(target if index==0 else []));candidate=parse_response(response)
        count=len(maximum_matches(ref['boxes'],candidate['boxes'],lambda a,b:iou(a,b)>=.9))
        cases.append(dict(index=index,kind='box' if index<64 else 'point',response=response,reference=ref,
          candidate=candidate,matched_boxes=count,matched_points=0,terminal=True,neural_cpu_fallback=False,
          architecture_coverage_verified=True,executor_stats=dict(calls=1)))
    return cases

class QualityControls(unittest.TestCase):
    def score(self,cases):return summarize_compact(cases,list(range(72)))
    def test_exact_45_boundary(self):
        result=self.score(fixture());self.assertEqual((result['precision'],result['recall']),(.45,.45))
        self.assertTrue(result['box_trial_quality_passed']);self.assertFalse(result['historical_70_percent_trial_passed'])
        self.assertFalse(result['whole_model_release_approved'])
    def test_precision_floor_independent(self):
        result=self.score(fixture(8,20,8));self.assertEqual(result['recall'],1.);self.assertFalse(result['box_trial_quality_passed'])
    def test_recall_floor_independent(self):
        result=self.score(fixture(8,8,20));self.assertEqual(result['precision'],1.);self.assertFalse(result['box_trial_quality_passed'])
    def test_partial_cannot_pass(self):self.assertFalse(self.score(fixture()[:-1])['box_trial_quality_passed'])
    def test_duplicate_case_rejected(self):
        cases=fixture();cases[-1]=copy.deepcopy(cases[0])
        with self.assertRaises(AssertionError):self.score(cases)
    def test_nonterminal_cannot_pass(self):
        cases=fixture();cases[0]['terminal']=False;self.assertFalse(self.score(cases)['box_trial_quality_passed'])
    def test_malformed_output_cannot_pass(self):
        cases=fixture();cases[1].update(response='<box>bad</box>',candidate=parse_response('<box>bad</box>'))
        self.assertFalse(self.score(cases)['box_trial_quality_passed'])
    def test_neural_fallback_cannot_pass(self):
        cases=fixture();cases[0]['neural_cpu_fallback']=True;self.assertFalse(self.score(cases)['box_trial_quality_passed'])
    def test_wrong_geometry_type_cannot_pass(self):
        cases=fixture();cases[0]['kind']='point';self.assertFalse(self.score(cases)['box_trial_quality_passed'])
    def test_missing_actual_architecture_flag_cannot_pass(self):
        cases=fixture();cases[0]['architecture_coverage_verified']=False;self.assertFalse(self.score(cases)['box_trial_quality_passed'])
    def test_invented_match_count_rejected(self):
        cases=fixture();cases[0]['matched_boxes']=10
        with self.assertRaises(AssertionError):self.score(cases)
    def test_duplicate_predictions_remain_in_denominator(self):
        cases=fixture();case=cases[0];boxes=case['candidate']['boxes'];case['response']=box_text(boxes+boxes)
        case['candidate']=parse_response(case['response']);result=self.score(cases)
        self.assertEqual(result['matched_boxes'],9);self.assertEqual(result['candidate_boxes'],40);self.assertFalse(result['box_trial_quality_passed'])

if __name__=='__main__':
    path=Path('/home/sunrise/ainvr/test/results/locateanything-compact-quality-controls-v1.json');assert not path.exists()
    start=time.time();result=unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(QualityControls))
    r=dict(status='passed' if result.wasSuccessful() else 'failed',started=start,finished=time.time(),tests_run=result.testsRun,
      failures=[str(x) for x in result.failures],errors=[str(x) for x in result.errors],source_sha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
      synthetic_acceptance_control_data_only=True,actual_neural_calls=0,actual_independent_final_quality_measured=False,release_approved=False)
    path.write_text(json.dumps(r,indent=2)+'\n');assert result.wasSuccessful()
