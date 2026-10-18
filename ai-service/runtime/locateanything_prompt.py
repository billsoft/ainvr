"""LocateAnything's validated single-image text/layout contract, no neural ops."""
from pathlib import Path
import hashlib
import numpy as np

PREFIX='<|im_start|>system\nYou are a helpful assistant.\n<|im_end|>\n<|im_start|>user\n'
IMAGE='<image 1><img>'+('<IMG_CONTEXT>'*128)+'</img>'
SUFFIX='<|im_end|>\n<|im_start|>assistant\n'

class LocateAnythingPrompt:
 def __init__(self,tokenizer_file,expected_sha256):
  from tokenizers import Tokenizer,__version__
  if __version__!='0.22.1':raise RuntimeError('Tokenizer runtime differs from validated version')
  path=Path(tokenizer_file)
  if hashlib.sha256(path.read_bytes()).hexdigest()!=expected_sha256:raise ValueError('Tokenizer artifact hash mismatch')
  self.tokenizer=Tokenizer.from_file(str(path))
  if self.tokenizer.get_vocab_size(with_added_tokens=True)!=152681:raise ValueError('Original complete vocabulary required')
  if self.tokenizer.token_to_id('<IMG_CONTEXT>')!=151665:raise ValueError('Original image token mismatch')

 def encode(self,description,maximum_tokens=128,mode='slow'):
  if not isinstance(description,str) or not description.strip() or len(description.encode('utf-8'))>4096:
   raise ValueError('Description must contain1..4096 UTF-8 bytes')
  if type(maximum_tokens) is not int or not 1<=maximum_tokens<=256 or mode not in ('slow','hybrid','fast'):
   raise ValueError('Unsupported generation length or mode')
  # Structural tokens in human text could replace the image or chat boundary.
  if any(fragment in description for fragment in ('<|','<IMG_CONTEXT>','<image','<img>','</img>','<video')):
   raise ValueError('Description contains reserved media/chat tokens')
  ids=np.asarray(self.tokenizer.encode(PREFIX+IMAGE+description+SUFFIX,add_special_tokens=False).ids,dtype=np.int64)
  dummy=0 if mode=='slow' else 6
  if len(ids)+dummy>256 or len(ids)+maximum_tokens+dummy>512:
   raise ValueError('Description/generation exceeds compiled prefill or KV capacity;no truncation')
  if np.count_nonzero(ids==151665)!=128:raise ValueError('Exactly128 original image placeholders required')
  return ids

 def decode(self,ids):return self.tokenizer.decode([int(x) for x in ids],skip_special_tokens=False)

def patchify_prepared_chw(values):
 """Only transpose/copy already hardware-resized/normalized pixels on CPU."""
 a=np.asarray(values)
 if a.dtype!=np.float32 or a.shape!=(3,224,448) or not np.isfinite(a).all():
  raise ValueError('Expected finite hardware-prepared RGB float32[3,224,448]')
 return np.ascontiguousarray(a.reshape(3,16,14,32,14).transpose(1,3,0,2,4).reshape(512,3,14,14))
