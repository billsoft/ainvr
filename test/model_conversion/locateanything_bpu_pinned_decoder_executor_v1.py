"""Evaluation cache policy: retain four decode contexts, rotate one other HBM.

Every neural call and copied output remains the unchanged base executor.
Enable only on the actually verified balanced-memory boot. No model is skipped.
"""
from pathlib import Path
import json
from locateanything_bpu_components_v2 import ComponentExecutor,digest

ROOT=Path('/home/sunrise/ainvr')
PROOF=ROOT/'test/results/locateanything-group-residency-balanced-guard-v1.json'
PROOF_SHA='e364dc14c2a84c7a79172283a3126a0ad5b75e1ee9f92842d0ff4d5a3eddc576'
BOOT=ROOT/'test/results/locateanything-balanced-reboot-verification-v1.json'
BOOT_SHA='afc494e0cb2e4fce7ce243284e4624b5ddc52267dc982a90acec6c901ef60c7b'
PIN_KEYS={f'decoder-group-{i:02d}-{i+8:02d}-decode' for i in (0,9,18,27)}


def verify_capability():
    assert digest(PROOF)==PROOF_SHA and digest(BOOT)==BOOT_SHA
    proof=json.loads(PROOF.read_text());boot=json.loads(BOOT.read_text())
    assert proof['status']=='completed' and proof['hardware_passed'] and proof['production_restored']
    assert proof['hardware']['uid']==1000 and proof['hardware']['actual_bpu_calls']==15
    assert proof['hardware']['four_decoder_plus_one_head_passed']
    assert boot['status']=='reboot_and_existing_production_verified'
    assert Path('/proc/sys/kernel/random/boot_id').read_text().strip()==boot['new_boot_id']
    assert boot['running_regions']['ion_reserved']['size_bytes']==8053063680


class PinnedDecoderExecutor(ComponentExecutor):
    def __init__(self,specs,budget_bytes,minimum_available_bytes=2*1024**3,maximum_models=1):
        verify_capability()
        super().__init__(specs,budget_bytes,minimum_available_bytes,maximum_models)
        assert PIN_KEYS<=set(self.specs) and len(specs)==113
        pinned_bytes=sum((self.specs[key].root/'model.hbm').stat().st_size for key in PIN_KEYS)
        largest_other=max((spec.root/'model.hbm').stat().st_size for key,spec in self.specs.items() if key not in PIN_KEYS)
        assert budget_bytes>=pinned_bytes+largest_other,'Budget must fit all pinned groups plus the largest rotating component'
        self._initial_maximum=maximum_models;self._pinning_started=False;self._closing=False

    def _load(self,key):
        if key in PIN_KEYS:self._pinning_started=True
        self.maximum_models=5 if self._pinning_started else self._initial_maximum
        return super()._load(key)

    def _evict_oldest(self):
        if not self._closing:
            eligible=next((key for key in self.loaded if key not in PIN_KEYS),None)
            if eligible is None:raise RuntimeError('Memory margin cannot be met while retaining verified decoder contexts')
            self.loaded.move_to_end(eligible,last=False)
        return super()._evict_oldest()

    def close(self):
        self._closing=True
        try:super().close()
        finally:
            self._closing=False;self._pinning_started=False;self.maximum_models=self._initial_maximum
