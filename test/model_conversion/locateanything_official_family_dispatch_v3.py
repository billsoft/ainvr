"""Strict complete-family schema dispatch;no reduced model or inference fallback."""
from pathlib import Path
import importlib
from locateanything_official_family_contract_v1 import checked,read_json,digest
CODE=Path(__file__).resolve().parent
LOADERS={
 'locateanything_official_full_family_head_optimization_v1':('locateanything_official_family_head_optimization_v1','3ff3405fd38d2622e0cd2ac5b83f9d25b1d18450951dc32929453f5e261ce7a8'),
 'locateanything_official_full_family_v1':('locateanything_official_family_contract_v1','94988129e3da8c7849316ef3f8ff372464418cdee809c32333e53927333d8c5f'),
 'locateanything_official_full_family_optimization_v1':('locateanything_official_family_optimization_v1','8d7f00d10a8e037328d29c6b9bb8f82eabcca6ac1d8b80b84c617af1b1bbcd39'),
 'locateanything_official_full_family_profile_optimization_v1':('locateanything_official_family_profile_optimization_v1','deae598806afa92ac8a114bb21edf721f4ad78dc8d8c7cb9390a1a5733941e05'),
 'locateanything_official_full_family_profile_optimization_v2':('locateanything_official_family_profile_optimization_v2','bf3c7084ca8680ad9b55bbbd8f6857ce9ece9a813e33971d9d02ce11db01e07c'),
}
def load_official_generator(path,expected_sha256):
 path=checked(path)
 if digest(path)!=expected_sha256:raise ValueError('Complete-family contract hash mismatch')
 schema=read_json(path).get('schema')
 if schema not in LOADERS:raise ValueError('Unsupported complete-family schema')
 for name,pin in LOADERS.values():
  if digest(CODE/(name+'.py'))!=pin:raise ValueError('Complete-family admission source changed')
 name,_=LOADERS[schema]
 generator,contract=importlib.import_module(name).load_official_generator(path,expected_sha256)
 if len(generator.specs)!=76 or len({str(s.path.resolve()) for s in generator.specs})!=46:
  raise ValueError('Complete original architecture required')
 return generator,contract
