"""Complete original architecture with official grouped decoder, evaluation only.

The parent freezes the reused vision/vocabulary assets. Its previous decoder
checkpoint is deliberately not attributed to this different official recipe.
"""
from pathlib import Path
import json
from locateanything_bpu_components_v2 import digest
from locateanything_bpu_contract_v1 import CANDIDATES, RESULTS, CODE, RUNTIME_SOURCES, checked_path, read_verified
from locateanything_bpu_vision_v1 import BpuVisionStage, FullVision
from locateanything_bpu_decoder_v1 import RopeTables
from locateanything_bpu_vocabulary_v1 import BpuVocabulary
from locateanything_bpu_grouped_decoder_v1 import BpuDecoderGroup, GroupedFullDecoder, GroupedFullBpuGenerator

PARENT_SHA = '3bf0014b3e1b1d1b00014875ee37f7120848a2a3bbdaf231ade356319a08f942'
BUILDER_SHA = '2fbfa740c46f21c63263b2852c040a720da0ce4048199c02fbb230d23a39b4a1'
GROUPED_SOURCES = RUNTIME_SOURCES | {
    'locateanything_bpu_contract_v1.py',
    'locateanything_bpu_grouped_decoder_v1.py',
    'locateanything_bpu_grouped_contract_v1.py',
}


def load_grouped_generator(path, expected_sha256):
    path = checked_path(path, CANDIDATES)
    assert digest(path) == expected_sha256
    contract = json.loads(path.read_text())
    assert contract['schema_version'] == 2 and contract['architecture'] == 'original36_official_four_groups'
    assert contract['evaluation_only'] is True and contract['release_approved'] is False
    assert contract['parent_contract']['sha256'] == PARENT_SHA
    parent = read_verified(contract['parent_contract'], CANDIDATES)
    assert parent['structure'] == dict(vision_blocks=27, decoder_layers=36, vocabulary_size=152681)
    assert parent['original_parameters'] == 3517975280
    assert parent['image_profile'] == dict(height=224,width=448,patch_grid=[16,32],image_tokens=128)
    assert set(contract['runtime_source_sha256']) == GROUPED_SOURCES
    for name, sha in contract['runtime_source_sha256'].items():
        assert digest(CODE/name) == sha, 'Grouped runtime source changed'
    # Reused component implementations must also match their old frozen recipe.
    assert set(parent['runtime_source_sha256']) == RUNTIME_SOURCES
    for name, sha in parent['runtime_source_sha256'].items():
        assert digest(CODE/name) == sha, 'Reused runtime differs from parent'
    for key in ['selected_checkpoint_report','f32_recipe_report']:
        report = read_verified(parent[key], RESULTS)
        assert report['status'] == 'completed' and len(report['modules']) == 252
    def visual_stage(kind, entry, index=None):
        root=checked_path(entry['root'],CANDIDATES)
        assert digest(root/'model.hbm') == entry['hbm_sha256']
        return BpuVisionStage(kind,root,entry['hbm_sha256'],index)
    visual=parent['vision']
    assert [b['index'] for b in visual['blocks']] == list(range(27))
    vision=FullVision(visual_stage('prefix',visual['prefix']),
        [visual_stage('block',b,b['index']) for b in visual['blocks']],
        visual_stage('connector',visual['connector']))
    package=read_verified(contract['group_package_manifest'],CANDIDATES)
    assert package['status']=='complete_decoder_profiles' and len(package['components'])==8
    assert package['all36_decode_compiled'] and package['all36_prefill_compiled']
    assert package['evaluation_only'] and not package['release_approved']
    assert package['builder_sha256']==BUILDER_SHA
    package_root=checked_path(contract['group_package_manifest']['path'],CANDIDATES).parent
    indexed={}
    for entry in package['components']:
        start,end,length=entry['start'],entry['end'],entry['sequence']
        assert (start,end) in [(0,8),(9,17),(18,26),(27,35)] and length in (12,256)
        key=(start,length);assert key not in indexed
        root=checked_path(package_root/entry['directory'],package_root)
        assert root.parent==package_root
        assert set(entry['files'])=={'model.hbm','status.json','ports.json','compiler-status.json','disas.json'}
        for name,sha in entry['files'].items():assert digest(root/name)==sha
        state=json.loads((root/'compiler-status.json').read_text())
        assert state['status']=='completed' and state['start_layer']==start and state['end_layer']==end
        assert state['sequence_capacity']==length and not state['fresh_final_used']
        assert [x['index'] for x in state['layers']]==list(range(start,end+1))
        assert all(x['strict_weight_load'] for x in state['layers'])
        assert not state.get('original_final_norm_included',False)
        assert state['final_norm_location']=='existing complete BPU vocabulary head'
        disas=json.loads((root/'disas.json').read_text())
        assert len(disas['graphs'])==1
        assert disas['graphs'][0]['nodes'] and all(n['device']=='DEVICE_CATEGORY_BPU' for n in disas['graphs'][0]['nodes'])
        indexed[key]=dict(root=str(root),hbm_sha256=entry['files']['model.hbm'])
    assert set(indexed)=={(s,l) for s in (0,9,18,27) for l in (12,256)}
    decoder=GroupedFullDecoder([BpuDecoderGroup(s,s+8,dict(decode=indexed[(s,12)],prefill=indexed[(s,256)])) for s in (0,9,18,27)])
    vocab=parent['vocabulary']
    for name in ['embedding','head']:
        root=checked_path(vocab[name+'_root'],CANDIDATES)
        assert digest(root/'manifest.json')==vocab[name+'_manifest_sha256']
    vocabulary=BpuVocabulary(vocab['embedding_root'],vocab['head_root'])
    for spec in vocabulary.specs:assert digest(spec.root/'model.hbm')==spec.hbm_sha256
    rotation=parent['rope']
    rope=RopeTables(checked_path(rotation['root'],CANDIDATES),rotation['cos_sha256'],rotation['sin_sha256'])
    tokens=read_verified(parent['token_contract'],CANDIDATES)
    assert tokens['status']=='prepared_original_token_contract' and tokens['image_token_index']==151665
    assert (tokens['vocabulary_size'],tokens['decoder_layers'],tokens['vision_blocks'])==(152681,36,27)
    generator=GroupedFullBpuGenerator(vision,decoder,vocabulary,rope,tokens['image_token_index'],tokens['token_ids'])
    assert len(generator.specs)==113
    return generator,contract
