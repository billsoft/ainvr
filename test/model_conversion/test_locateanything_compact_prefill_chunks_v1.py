"""Assembly and acceptance controls only; replayed arrays are NOT neural outputs."""
from pathlib import Path
from types import SimpleNamespace as NS
from collections import Counter
import argparse,copy,hashlib,json,time,unittest
import numpy as np
from locateanything_generation_control_v1 import step_layout
from locateanything_compact_prefill_chunks_v1 import profile_capacities,prefill_chunk_layouts
from locateanything_bpu_compact_grouped_decoder_v1 import CompactBpuDecoderGroup,CompactGroupedFullDecoder,GROUPS
from locateanything_compact_quality_v1 import verify_slow_call_coverage
from test_locateanything_compact_grouped_layout_v1 import LayoutTests
from test_locateanything_compact_quality_v1 import QualityControls


class Rope:
    def padded(self,positions,length):
        cos=np.zeros((1,length,128),np.float32);sin=np.zeros_like(cos)
        cos[0,:len(positions)]=positions[:,None]
        return cos,sin


class ChunkControls(unittest.TestCase):
    def replay(self,q,length):
        rng=np.random.default_rng(92);hidden=rng.normal(size=(q,2048)).astype(np.float32)
        outputs=[rng.normal(size=(q,2048)).astype(np.float32) for _ in GROUPS]
        kv=[tuple(rng.normal(size=(2,q,128)).astype(np.float32) for _ in range(2)) for _ in range(36)]
        groups=[]
        for start,end in GROUPS:
            g=object.__new__(CompactBpuDecoderGroup);g.start=start;g.end=end
            g.lengths={'ar':1,'prefill':length}
            g.specs={p:NS(key=f'group-{start}-{p}') for p in ['ar','prefill']};groups.append(g)
        decoder=CompactGroupedFullDecoder(groups)
        offsets=Counter();calls=Counter()
        class Replay:
            def run_ordered(inner,key,arrays):
                index=next(i for i,g in enumerate(groups) if g.specs['prefill'].key==key)
                g=groups[index];p=offsets[key];n=min(length,q-p)
                reference=hidden if index==0 else outputs[index-1]
                np.testing.assert_array_equal(arrays[0][:n],reference[p:p+n])
                np.testing.assert_array_equal(arrays[1][:n,0],np.arange(p,p+n))
                self.assertTrue(np.all(arrays[0][n:]==0))
                # Independent logical column labels include dummy/gap columns.
                columns=np.full(512,-1,np.int64)
                columns[512-length-p:512-length]=np.arange(p)
                columns[512-length:512-length+n]=np.arange(p,p+n)
                visible=(columns[None,:]>=0)&(columns[None,:]<=np.arange(p,p+n)[:,None])
                np.testing.assert_array_equal(arrays[3][:n]==0,visible)
                for local,layer in enumerate(range(g.start,g.end+1)):
                    for value,ref in [(arrays[4+local],kv[layer][0]),(arrays[13+local],kv[layer][1])]:
                        if p:np.testing.assert_array_equal(value[:,512-p:],ref[:,:p])
                        self.assertTrue(np.all(value[:,:512-p]==0))
                result=[np.full((length,2048),999,np.float32)]
                result[0][:n]=outputs[index][p:p+n]
                for component in [0,1]:
                    for layer in range(g.start,g.end+1):
                        value=np.full((2,length,128),999,np.float32)
                        value[:,:n]=kv[layer][component][:,p:p+n];result.append(value)
                offsets[key]+=n;calls[key]+=1
                return result
        actual,caches=decoder.forward(Replay(),hidden,(None,)*36,step_layout(q,0,False),'prefill',Rope())
        np.testing.assert_array_equal(actual,outputs[-1])
        for a,b in zip(caches,kv):
            for x,y in zip(a,b):np.testing.assert_array_equal(x,y)
        self.assertEqual(set(calls.values()),{(q+length-1)//length})
        self.assertEqual(len(caches),36)
    def test_full36_causal_chunks12_and_partial_last(self):self.replay(155,12)
    def test_full36_explicit_AR1_prefill_reuse(self):self.replay(13,1)
    def test_full36_existing_prefill256_unchanged(self):self.replay(155,256)
    def test_positions_masks_and_MTP_rejected_before_callback(self):
        for layout in [step_layout(155,0,True),step_layout(156,155,False)]:
            with self.assertRaises(AssertionError):prefill_chunk_layouts(layout,12)
        a=step_layout(155,0,False);a.positions[1]=20
        with self.assertRaises(AssertionError):prefill_chunk_layouts(a,12)
        a=step_layout(155,0,False);a.visibility[0,1]=True
        with self.assertRaises(AssertionError):prefill_chunk_layouts(a,12)
    def test_boundary_and_explicit_profile_policy(self):
        for q in [1,12,13,155,256]:
            for length in [1,12,256]:
                chunks=prefill_chunk_layouts(step_layout(q,0,False),length)
                self.assertEqual(chunks[-1][1].keep_cache_length,q)
                self.assertEqual(sum(x.query_length for _,x in chunks),q)
        self.assertEqual(profile_capacities(None,['ar','prefill']),{'ar':1,'prefill':256})
        for value in [{'ar':12,'prefill':12},{'ar':1,'prefill':6},{'ar':1,'prefill':12.0},{'ar':1,'prefill':True},{'ar':1}]:
            with self.assertRaises(AssertionError):profile_capacities(value,['ar','prefill'])


def coverage_fixture(length):
    lengths={'ar':1,'prefill':length}
    groups=[NS(lengths=lengths,specs={p:NS(key=f'g-{i}-{p}') for p in lengths}) for i in range(4)]
    vision=[NS(key=f'vision-{i}') for i in range(29)];heads=[NS(key=f'head-{i}') for i in range(38)]
    embedding=NS(key='embedding-test')
    specs=vision+heads+[embedding]+[s for g in groups for s in g.specs.values()]
    generator=NS(specs=specs,vision=NS(specs=vision),image_token_index=7,
      decoder=NS(layer_indices=tuple(range(36)),groups=groups,compiled_profiles={'ar','prefill'},profile_sequence_capacities=lengths),
      vocabulary=NS(tables={'head':[{'key':s.key} for s in heads]}))
    ids=np.array([7]*128+[1]*27,np.int64)
    counts=Counter({s.key:1 for s in vision})
    counts.update({s.key:2 for s in heads});counts[embedding.key]=28
    for g in groups:counts[g.specs['prefill'].key]=(155+length-1)//length;counts[g.specs['ar'].key]=1
    answer=dict(generation_mode='slow',neural_cpu_fallback=False,bpu_calls=sum(counts.values()),steps=[
      dict(profile='prefill',accepted_tokens=[1],mtp=False,query_length=155),
      dict(profile='ar',accepted_tokens=[2],mtp=False,query_length=1)])
    return generator,counts,answer,ids


class CoverageControls(unittest.TestCase):
    def test_each_supported_prefill_call_count(self):
        for length in [1,12,256]:
            args=coverage_fixture(length);r=verify_slow_call_coverage(*args)
            self.assertEqual(r['prefill_calls_per_group'],(155+length-1)//length)
    def test_missing_chunk_rejected_even_with_consistent_total(self):
        g,c,a,i=coverage_fixture(12);c[g.decoder.groups[1].specs['prefill'].key]-=1;a['bpu_calls']=sum(c.values())
        with self.assertRaises(AssertionError):verify_slow_call_coverage(g,c,a,i)
    def test_extra_chunk_rejected_even_with_consistent_total(self):
        g,c,a,i=coverage_fixture(12);c[g.decoder.groups[2].specs['prefill'].key]+=1;a['bpu_calls']=sum(c.values())
        with self.assertRaises(AssertionError):verify_slow_call_coverage(g,c,a,i)
    def test_inconsistent_group_or_original_prompt_rejected(self):
        g,c,a,i=coverage_fixture(12);g.decoder.groups[0].lengths={'ar':1,'prefill':256}
        with self.assertRaises(AssertionError):verify_slow_call_coverage(g,c,a,i)
        g,c,a,i=coverage_fixture(12);a['steps'][0]['query_length']=154
        with self.assertRaises(AssertionError):verify_slow_call_coverage(g,c,a,i)


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--report',type=Path,required=True);a=parser.parse_args()
    root=Path('/home/sunrise/ainvr');assert a.report.parent.resolve()==root/'test/results' and not a.report.exists()
    started=time.time();suite=unittest.TestSuite()
    for cls in [ChunkControls,CoverageControls,LayoutTests,QualityControls]:suite.addTests(unittest.defaultTestLoader.loadTestsFromTestCase(cls))
    result=unittest.TextTestRunner(verbosity=2).run(suite)
    names=['locateanything_compact_prefill_chunks_v1.py','locateanything_bpu_compact_grouped_decoder_v1.py','locateanything_compact_quality_v1.py']
    r=dict(status='passed' if result.wasSuccessful() else 'failed',started=started,finished=time.time(),tests_run=result.testsRun,
      failures=[dict(test=t.id(),traceback=m) for t,m in result.failures],errors=[dict(test=t.id(),traceback=m) for t,m in result.errors],
      source_sha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),runtime_source_sha256={n:hashlib.sha256((root/'test/model_conversion'/n).read_bytes()).hexdigest() for n in names},
      scope=__doc__,neural_calls=0,board_calls=0,actual_compact_constructor_executed=False,whole_model_verified=False,release_approved=False)
    a.report.write_text(json.dumps(r,indent=2)+'\n');assert result.wasSuccessful()
if __name__=='__main__':main()
