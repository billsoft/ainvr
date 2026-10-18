"""Complete compact affine-W4 BPU backend for the native LocateAnything adapter.

Evaluation only. Constructor validates every original component before a socket
is bound. Reuse the frozen framing/generation/cancellation path;no neural CPU
fallback and no unproven43-context residency policy from the older model.
"""
from pathlib import Path
import argparse,hashlib,json,math,os,signal,socket,stat,sys,threading,time

ROOT=Path('/home/sunrise/ainvr');CODE=ROOT/'test/model_conversion'
BASE=Path('/mnt/ainvr-ssd/model-compile-candidates/locateanything-3b-w4-v1')
ORIGINAL_EXECUTOR_SHA='bd99c0e13b62fdb4e22eeb2f4a24e0257d5efdf691db30a71c53d349d9b2db02'
assert hashlib.sha256((ROOT/'ai-service/runtime/locateanything_bpu_executor_v2.py').read_bytes()).hexdigest()==ORIGINAL_EXECUTOR_SHA
from locateanything_bpu_executor_v2 import CompleteBpuBackend,prepare_socket_path,serve_connection
from locateanything_request_server import BoundedRequestServer
from locateanything_prompt import LocateAnythingPrompt
sys.path.insert(0,str(CODE))
from locateanything_bpu_compact_grouped_contract_v1 import load_compact_generator

class CompactEvaluationBackend(CompleteBpuBackend):
    def __init__(self,contract,contract_sha256,tokenizer,tokenizer_sha256,mode,maximum_seconds,resident_models):
        assert os.getuid()==1000
        if mode not in ['slow','hybrid','fast'] or not math.isfinite(maximum_seconds) or not 0<maximum_seconds<=3600 or resident_models not in [1,2]:
            raise ValueError('Invalid declared inference request bounds')
        started=time.monotonic()
        # Never invoke the base constructor:it loads the older individual-layer
        # decoder. Only the complete compact contract may supply these weights.
        self.generator,self.contract=load_compact_generator(contract,contract_sha256)
        assert self.contract['architecture']=='original36_compact_affine_four_groups'
        assert len(self.generator.specs) in [113,117] and self.generator.decoder.layer_indices==tuple(range(36))
        if mode not in self.generator.enabled_modes:raise ValueError('Requested native generation mode is not compiled/validated')
        self.prompt=LocateAnythingPrompt(tokenizer,tokenizer_sha256)
        self.contract_sha256=contract_sha256;self.mode=mode;self.maximum_seconds=maximum_seconds;self.resident_models=resident_models
        self.constructor_seconds=time.monotonic()-started

    def health(self):
        return dict(super().health(),architecture='original36_compact_affine_four_groups',
          evaluation_only=True,release_approved=False,constructor_seconds=self.constructor_seconds,
          enabled_generation_modes=sorted(self.generator.enabled_modes),
          cache_policy='one_or_two_request_owned_contexts_close_at_request_end',
          full_model_memory_and_quality_verified=False)

    # Generation is inherited unchanged from the frozen stateless executor.
    # It executes this compact generator and closes every SDK context on return
    # or failure. Native logits/EOS/sampling/output JSON are not rewritten.

def main():
    p=argparse.ArgumentParser();p.add_argument('--contract',type=Path,required=True);p.add_argument('--contract-sha256',required=True)
    p.add_argument('--tokenizer',type=Path,required=True);p.add_argument('--tokenizer-sha256',required=True)
    p.add_argument('--socket',type=Path,required=True);p.add_argument('--mode',choices=['slow','hybrid','fast'],default='slow')
    p.add_argument('--maximum-seconds',type=float,default=900);p.add_argument('--resident-models',type=int,choices=[1,2],default=1)
    p.add_argument('--check-only',action='store_true');a=p.parse_args()
    # No ready listener is created until the real complete constructor passes.
    path=prepare_socket_path(a.socket,ROOT/'data/ai')
    backend=CompactEvaluationBackend(a.contract,a.contract_sha256,a.tokenizer,a.tokenizer_sha256,a.mode,a.maximum_seconds,a.resident_models)
    if a.check_only:
        print(json.dumps(dict(status='complete_compact_backend_constructor_checked',health=backend.health(),neural_calls=0,release_approved=False)));return
    stopping=threading.Event();signal.signal(signal.SIGTERM,lambda *_:stopping.set());signal.signal(signal.SIGHUP,lambda *_:stopping.set())
    listener=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);identity=None
    try:
        previous=os.umask(0o177)
        try:listener.bind(str(path))
        finally:os.umask(previous)
        identity=(path.lstat().st_dev,path.lstat().st_ino);os.chmod(path,0o600);listener.listen(8)
        BoundedRequestServer(listener,backend,serve_connection,stopping).serve()
    finally:
        listener.close()
        if identity is not None:
            try:
                current=path.lstat()
                if stat.S_ISSOCK(current.st_mode) and (current.st_dev,current.st_ino)==identity:path.unlink()
            except FileNotFoundError:pass

if __name__=='__main__':main()
