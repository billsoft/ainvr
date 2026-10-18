"""Full original152681-token embedding/head routing through real BPU HBMs.

CPU only routes ordinals, copies arrays and joins ordered output partitions.
All learned table access, final RMSNorm and head projection execute on BPU.
"""
from pathlib import Path
import json
import numpy as np
from locateanything_bpu_components_v1 import ComponentSpec

class BpuVocabulary:
    def __init__(self,embedding_root,head_root):
        self.tables={};self.specs=[]
        for kind,root in [('embedding',embedding_root),('head',head_root)]:
            root=Path(root).resolve();assert root.is_relative_to(Path('/mnt/ainvr-ssd/model-compile-candidates'))
            manifest=json.loads((root/'manifest.json').read_text());chunks=manifest['chunks'];assert len(chunks)==38
            start=0;entries=[]
            for i,chunk in enumerate(chunks):
                assert chunk['chunk']==i and chunk['start']==start and 0<chunk['count']<=4096
                assert chunk['count']==min(4096,152681-start)
                assert chunk['directory']==f'chunk-{i:02d}'
                key=f'{kind}-{i:02d}';shape=(1,) if kind=='embedding' else (1,2048);dtype='int32' if kind=='embedding' else 'float32'
                self.specs.append(ComponentSpec(key,root/chunk['directory'],chunk['hbm_sha256'],(shape,),(dtype,)))
                entries.append(dict(key=key,start=start,count=chunk['count']));start+=chunk['count']
            assert start==152681,'Missing or shortened original vocabulary'
            self.tables[kind]=entries

    def embed(self,executor,token_ids):
        ids=np.asarray(token_ids);assert ids.ndim==1 and np.issubdtype(ids.dtype,np.integer)
        assert np.all(ids>=0) and np.all(ids<152681)
        output=np.empty((len(ids),2048),np.float32)
        for row,token in enumerate(ids):
            # Chunk construction is contiguous4096-token partitions with only
            # the final partition shorter. Never reinterpret a global ID as a
            # local ordinal, nor restrict logits to prompt/coordinate tokens.
            chunk=self.tables['embedding'][int(token)//4096]
            local=int(token)-chunk['start'];assert 0<=local<chunk['count']
            result=executor.run_ordered(chunk['key'],[np.asarray([local],np.int32)])
            assert len(result)==1 and result[0].shape==(1,2048) and result[0].dtype==np.float32
            output[row]=result[0][0]
        return output

    def project(self,executor,hidden_rows,return_raw=False):
        hidden_rows=np.asarray(hidden_rows);assert hidden_rows.ndim==2 and hidden_rows.shape[1]==2048 and hidden_rows.dtype==np.float32
        assert np.isfinite(hidden_rows).all()
        formatted=np.empty((len(hidden_rows),152681),np.float32)
        raw=np.empty_like(formatted) if return_raw else None
        # Group rows by model to avoid loading a head chunk for every row when
        # an MTP step requests six complete-vocabulary output distributions.
        for chunk in self.tables['head']:
            start,count=chunk['start'],chunk['count']
            for row in range(len(hidden_rows)):
                result=executor.run_ordered(chunk['key'],[np.ascontiguousarray(hidden_rows[row:row+1])])
                assert len(result)==2 and all(x.shape==(1,count) and x.dtype==np.float32 for x in result)
                formatted[row,start:start+count]=result[0][0]
                if return_raw:raw[row,start:start+count]=result[1][0]
        return (formatted,raw) if return_raw else formatted
