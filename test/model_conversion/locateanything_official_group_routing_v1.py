"""Control-only routing for official9layer AR1/prefill256 groups with interleaved KV ports.

This family has a different port order from the frozen compact-affine family.
It does no neural computation and never shortens tokens or cache.
"""
import numpy as np

def prepare_official_group_arrays(hidden,caches,layout,length,rope):
 q,p=layout.query_length,layout.past_length
 assert length in [1,256] and 0<q<=length and p+length<=512 and len(caches)==9
 assert hidden.shape==(q,2048) and hidden.dtype==np.float32 and np.isfinite(hidden).all()
 assert layout.visibility.shape==(q,p+q) and layout.visibility.dtype==np.bool_
 h=np.zeros((length,2048),np.float32);h[:q]=hidden;cos,sin=rope.padded(layout.positions,length)
 assert cos.shape==sin.shape==(1,length,128) and cos.dtype==sin.dtype==np.float32
 mask=np.full((length,512),-512.,np.float32)
 mask[:q,512-length-p:512-length]=np.where(layout.visibility[:,:p],0.,-512.)
 mask[:q,512-length:512-length+q]=np.where(layout.visibility[:,p:],0.,-512.)
 if q<length:mask[q:,512-length]=0.
 result=[h,np.ascontiguousarray(cos[0]),np.ascontiguousarray(sin[0]),mask]
 for pair in caches:
  if pair is None:
   assert p==0;pair=(np.empty((2,0,128),np.float32),np.empty((2,0,128),np.float32))
  assert len(pair)==2
  for value in pair:
   assert value.shape==(2,p,128) and value.dtype==np.float32 and np.isfinite(value).all()
   padded=np.zeros((2,512,128),np.float32)
   if p:padded[:,512-p:]=value
   result.append(padded)
 assert len(result)==22 and all(x.flags.c_contiguous and np.isfinite(x).all() for x in result)
 return result

def commit_official_group_arrays(outputs,caches,layout,length):
 q,p=layout.query_length,layout.past_length;keep=layout.keep_cache_length-p
 assert len(caches)==9 and len(outputs)==19 and length in [1,256] and 0<keep<=q<=length
 assert outputs[0].shape==(length,2048) and all(x.shape==(2,length,128) for x in outputs[1:])
 assert all(x.dtype==np.float32 and np.isfinite(x).all() for x in outputs)
 result=[]
 for i,pair in enumerate(caches):
  if pair is None:
   assert p==0;pair=(np.empty((2,0,128),np.float32),np.empty((2,0,128),np.float32))
  assert len(pair)==2 and all(v.shape==(2,p,128) and v.dtype==np.float32 for v in pair)
  updated=tuple(np.concatenate([old,new[:,:keep]],axis=1) for old,new in zip(pair,[outputs[1+2*i],outputs[2+2*i]]))
  assert all(v.shape==(2,layout.keep_cache_length,128) for v in updated);result.append(updated)
 return outputs[0][:q].copy(),tuple(result)

class OfficialRopeArrays:
 """Original theta1e6 rotary function in the same F32 format used by these HBM profiles."""
 def __init__(self):
  positions=np.arange(1024,dtype=np.float32)[:,None]
  inverse=1/(1000000.**(np.arange(0,128,2,dtype=np.float32)/128))
  angle=positions*inverse[None];angle=np.concatenate([angle,angle],-1)
  self.cos=np.cos(angle);self.sin=np.sin(angle);self.cos.setflags(write=False);self.sin.setflags(write=False)
 def padded(self,positions,length):
  positions=np.asarray(positions);assert positions.ndim==1 and np.issubdtype(positions.dtype,np.integer) and 0<len(positions)<=length
  assert positions.min()>=0 and positions.max()<1024
  c=np.ones((1,length,128),np.float32);s=np.zeros_like(c);c[0,:len(positions)]=self.cos[positions];s[0,:len(positions)]=self.sin[positions]
  return c,s
