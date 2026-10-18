"""Load a complete frozen evaluation contract; never install/open a model.

All original components are mandatory. Artifact hashes and every decoder
layer's selected-checkpoint hashes are checked before constructing the full
generator. Model quality/release evidence is a separate requirement.
"""
from pathlib import Path
import json
from locateanything_bpu_components_v2 import digest
from locateanything_bpu_vision_v1 import BpuVisionStage,FullVision
from locateanything_bpu_decoder_v1 import BpuDecoderLayer,FullDecoder,RopeTables,PROFILES
from locateanything_bpu_vocabulary_v1 import BpuVocabulary
from locateanything_bpu_generation_v1 import FullBpuGenerator

CANDIDATES=Path('/mnt/ainvr-ssd/model-compile-candidates/locateanything-3b-w4-v1')
RESULTS=Path('/home/sunrise/ainvr/test/results')
CODE=Path('/home/sunrise/ainvr/test/model_conversion')
RUNTIME_SOURCES={
 'locateanything_bpu_components_v1.py','locateanything_bpu_components_v2.py',
 'locateanything_bpu_vision_v1.py','locateanything_bpu_decoder_v1.py',
 'locateanything_bpu_vocabulary_v1.py','locateanything_bpu_generation_v1.py',
 'locateanything_generation_control_v1.py','locateanything_sampling_v1.py'}

def checked_path(value,parent):
 path=Path(value).resolve()
 assert path.is_relative_to(parent.resolve()),'Artifact outside declared task root'
 return path

def read_verified(entry,parent):
 path=checked_path(entry['path'],parent)
 assert digest(path)==entry['sha256'],'Frozen JSON artifact changed'
 return json.loads(path.read_text())

def load_complete_generator(path,expected_sha256):
 path=checked_path(path,CANDIDATES)
 assert digest(path)==expected_sha256
 contract=json.loads(path.read_text())
 assert contract['schema_version']==1
 assert contract['model_family']=='locateanything-3b' and contract['original_parameters']==3517975280
 assert contract['image_profile']==dict(height=224,width=448,patch_grid=[16,32],image_tokens=128)
 assert contract['structure']==dict(vision_blocks=27,decoder_layers=36,vocabulary_size=152681)
 assert set(contract['runtime_source_sha256'])==RUNTIME_SOURCES
 for name,sha in contract['runtime_source_sha256'].items():assert digest(CODE/name)==sha,'Runtime code differs from frozen contract'
 candidate=read_verified(contract['selected_checkpoint_report'],RESULTS)
 assert contract['selected_checkpoint_report']['sha256']=='071195f09709241b3de2c823a04ae869320e373c0b779467cbde0a863d5737fb'
 assert candidate['status']=='completed' and len(candidate['modules'])==252
 selected={record['name']:record['sha256'] for record in candidate['modules']}
 parent=read_verified(contract['f32_recipe_report'],RESULTS)
 assert contract['f32_recipe_report']['sha256']=='18e4acd5b7e4ca6da0a53cf9da36b43eb38d6d3262b41b9bc1532cb1c3fe0e93'
 assert parent['status']=='completed' and len(parent['modules'])==252
 representations={record['name']:record for record in parent['modules']}
 visual=contract['vision'];assert len(visual['blocks'])==27 and [b['index'] for b in visual['blocks']]==list(range(27))
 layers=contract['decoder'];assert len(layers)==36 and [layer['index'] for layer in layers]==list(range(36))
 assert all(set(layer['profiles'])==set(PROFILES) for layer in layers)
 visual_entries=[visual['prefix'],*visual['blocks'],visual['connector']]
 decoder_entries=[entry for layer in layers for entry in layer['profiles'].values()]
 roots=[checked_path(entry['root'],CANDIDATES) for entry in visual_entries+decoder_entries]
 assert len(roots)==137 and len(set(roots))==137
 missing=[str(root/'model.hbm') for root in roots if not (root/'model.hbm').is_file()]
 assert not missing,'Incomplete original architecture;missing '+str(len(missing))+' HBM files'
 # Hash every neural artifact before constructing any runtime. Constructor
 # metadata is insufficient to certify the bytes belonging to this contract.
 for entry,root in zip(visual_entries+decoder_entries,roots):assert digest(root/'model.hbm')==entry['hbm_sha256']
 for layer in layers:
  for entry in layer['profiles'].values():
   state=json.loads((checked_path(entry['root'],CANDIDATES)/'status.json').read_text())
   assert state['layer']==layer['index'] and len(state['packed_hashes'])==7
   for suffix,sha in state['packed_hashes'].items():
    name=f"language_model.model.layers.{layer['index']}.{suffix}"
    assert selected[name]==sha==representations[name]['checkpoint_sha256'],'Decoder components mix different weight checkpoints'
    assert state['weight_representation'][suffix]['int8_branches']==representations[name]['int8_branches']
 def stage(kind,entry,index=None):return BpuVisionStage(kind,checked_path(entry['root'],CANDIDATES),entry['hbm_sha256'],index)
 vision=FullVision(stage('prefix',visual['prefix']),[stage('block',entry,entry['index']) for entry in visual['blocks']],stage('connector',visual['connector']))
 decoder=FullDecoder([BpuDecoderLayer(layer['index'],layer['profiles']) for layer in layers])
 vocab=contract['vocabulary']
 for name in ['embedding','head']:
  root=checked_path(vocab[name+'_root'],CANDIDATES)
  assert digest(root/'manifest.json')==vocab[name+'_manifest_sha256']
 vocabulary=BpuVocabulary(vocab['embedding_root'],vocab['head_root'])
 for spec in vocabulary.specs:assert digest(spec.root/'model.hbm')==spec.hbm_sha256
 rotation=contract['rope'];rope=RopeTables(checked_path(rotation['root'],CANDIDATES),rotation['cos_sha256'],rotation['sin_sha256'])
 token_contract=read_verified(contract['token_contract'],CANDIDATES)
 assert token_contract['status']=='prepared_original_token_contract' and token_contract['image_token_index']==151665
 assert token_contract['vocabulary_size']==152681 and token_contract['decoder_layers']==36 and token_contract['vision_blocks']==27
 generator=FullBpuGenerator(vision,decoder,vocabulary,rope,token_contract['image_token_index'],token_contract['token_ids'])
 assert len(generator.specs)==213
 return generator,contract
