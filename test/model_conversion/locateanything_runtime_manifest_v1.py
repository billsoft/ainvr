"""Construct a complete76-program trial input/output manifest;no neural calls.

This declares stage metadata,not quality approval or production installation.
The model-owned C++ startup validator and actual backend verify execution.
"""
from pathlib import Path
import hashlib,math,re
BASE=Path('/mnt/ainvr-ssd/model-compile-candidates/locateanything-3b-w4-v1')
SOCKET_ROOT=Path('/home/sunrise/ainvr/data/ai')
PREFIX_SHA='4a2b199c817cf5378c188ed1f6965057f3f865126033d46d0a283cee71c081c5'
def build_runtime_manifest(anchor,socket,contract_sha256,maximum_seconds):
 anchor=Path(anchor);socket=Path(socket)
 if not anchor.is_file() or not anchor.resolve().is_relative_to(BASE) or anchor.suffix!='.hbm':raise ValueError('Task-owned prefix HBM required')
 if not socket.is_absolute() or socket.parent!=SOCKET_ROOT or len(str(socket).encode())>=108:raise ValueError('Private task endpoint required')
 if not re.fullmatch('[0-9a-f]{64}',contract_sha256):raise ValueError('Invalid full-family contract digest')
 if isinstance(maximum_seconds,bool) or not isinstance(maximum_seconds,(int,float)) or not math.isfinite(maximum_seconds) or not 0<maximum_seconds<=3600:raise ValueError('Invalid native request bound')
 h=hashlib.sha256()
 with anchor.open('rb') as f:
  for b in iter(lambda:f.read(4*1024**2),b''):h.update(b)
 if h.hexdigest()!=PREFIX_SHA:raise ValueError('Original full-family vision prefix differs')
 delay=maximum_seconds+5
 return dict(schema_version=1,target='rdk_s100p',adapter='locateanything_bpu',model_family='locateanything-3b',architecture='original36_qwen_moonvit27_shared_programs',component_count=76,physical_hbm_files=46,text_layers=36,vision_blocks=27,vocabulary_size=152681,input_contract='complete-hbm-components-rgb-chw-v1',output_contract='locateanything_geometry_tokens_v1',input_size=[224,448],image_resample='pillow9-bicubic-rgb8',hbm_sha256=PREFIX_SHA,evaluation_only=True,release_approved=False,production_approved=False,quality_override_accepted=False,generation=dict(socket=str(socket),contract_sha256=contract_sha256,maximum_seconds=maximum_seconds,mode='slow'),media_retention=dict(delay_seconds=delay,maximum_bytes=16*1024**3,maximum_frames=math.ceil(delay*144.0)+1,spool_directory='/mnt/ainvr-ssd/ainvr-au-cache'))
