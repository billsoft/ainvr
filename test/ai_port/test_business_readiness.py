"""AINVR: distinguish service dependencies from actual recognition/archive gates."""
import copy
import importlib.util
from pathlib import Path
import unittest

ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('ainvr_readiness',ROOT/'deploy-package/check-business-ready.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)


class BusinessReadinessTest(unittest.TestCase):
    def setUp(self):
        self.health={'version':'ainvr-s100p-reused-control-0.7','status':'ok',
            'business':{'license_phase':'valid','ready':True},'capabilities':{'model_providers':['bpu']}}
        self.channel={'id':'test-only','state':'running','config':{'enabled':True,
            'model':{'provider':'bpu'},'snapshot':{'enabled':True}},
            'stats':{'frame_count':12,'inference_count':3,'last_error':None}}

    def test_current_health_contract_accepts_only_dependency_readiness(self):
        ok,message=module.readiness(self.health)
        self.assertTrue(ok);self.assertIn('仍需专项验收',message)

    def test_missing_invalid_and_expired_license_rejected(self):
        for phase in [None,'unknown','invalid','expired']:
            with self.subTest(phase=phase):
                self.health['business']['license_phase']=phase
                self.assertFalse(module.readiness(self.health)[0])

    def test_old_controller_cpu_provider_and_bad_status_rejected(self):
        for patch in [{'version':'old-native-service'},{'capabilities':{'model_providers':['cpu','bpu']}},
                      {'status':'error'},{'business':{'license_phase':'valid','ready':False}}]:
            with self.subTest(patch=patch):
                h=copy.deepcopy(self.health);h.update(patch);self.assertFalse(module.readiness(h)[0])

    def test_archive_requires_enabled_channel_and_actual_connection(self):
        self.assertFalse(module.readiness(self.health,True,channels=[],archive_views={})[0])
        for connected in [None,False,1]:
            self.assertFalse(module.readiness(self.health,True,channels=[self.channel],
                archive_views={'test-only':{'connected':connected}})[0])
        self.assertTrue(module.readiness(self.health,True,channels=[self.channel],
            archive_views={'test-only':{'connected':True}})[0])

    def test_idle_running_without_frames_and_stale_errors_do_not_prove_inference(self):
        for patch in [{'state':'idle'},{'stats':{'frame_count':0,'inference_count':3}},
                      {'stats':{'frame_count':12,'inference_count':0}},
                      {'stats':{'frame_count':True,'inference_count':True}},
                      {'stats':{'frame_count':12,'inference_count':3,'last_error':'source lost'}}]:
            with self.subTest(patch=patch):
                c=copy.deepcopy(self.channel);c.update(patch)
                self.assertFalse(module.readiness(self.health,channels=[c],require_inference=True)[0])

    def test_all_enabled_channels_must_prove_inference(self):
        self.assertTrue(module.readiness(self.health,channels=[self.channel],require_inference=True)[0])
        stopped=copy.deepcopy(self.channel);stopped['id']='draft';stopped['state']='idle'
        self.assertFalse(module.readiness(self.health,channels=[self.channel,stopped],require_inference=True)[0])
        stopped['config']['enabled']=False
        self.assertTrue(module.readiness(self.health,channels=[self.channel,stopped],require_inference=True)[0])

    def test_malformed_payloads_fail_closed(self):
        for h in [None,[],{'version':self.health['version'],'business':[]}]:
            self.assertFalse(module.readiness(h)[0])
        for channels in [None,{},[None],[{'id':'invalid','config':None}]]:
            self.assertFalse(module.readiness(self.health,channels=channels,require_inference=True)[0])


if __name__=='__main__':unittest.main()
