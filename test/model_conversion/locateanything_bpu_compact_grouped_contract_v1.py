"""Load complete compact decoder groups with frozen original BPU vision/vocabulary.

Evaluation only. The old decoder is never executed or used as a missing-group
fallback. Every native profile must contain all36 original decoder layers.
"""
from pathlib import Path
import json
from locateanything_bpu_components_v2 import digest
from locateanything_bpu_contract_v1 import CANDIDATES,RESULTS,CODE,checked_path,read_verified
from locateanything_bpu_grouped_contract_v1 import GROUPED_SOURCES,load_grouped_generator
from locateanything_compact_prefill_chunks_v1 import profile_capacities
from locateanything_bpu_compact_grouped_decoder_v1 import (
 BUILDER_SHA,CAPACITIES,GROUPS,CompactBpuDecoderGroup,CompactGroupedFullDecoder,CompactGroupedFullBpuGenerator)

FROZEN_GROUPED_SHA='3c3066a0808027b3fc1e0c591ce71f435e622b6b03c01cbfb12bb739ac37ff34'
COMPACT_SOURCES=GROUPED_SOURCES|{'locateanything_bpu_compact_grouped_decoder_v1.py','locateanything_bpu_compact_grouped_contract_v1.py','locateanything_compact_compiler_origin_v1.py','compile_locateanything_compact_saved_bc_v1.py','locateanything_compact_prefill_chunks_v1.py'}
FILES={'model.hbm','status.json','ports.json','compiler-status.json','disas.json'}


def load_compact_generator(path,expected_sha256):
    path=checked_path(path,CANDIDATES);assert digest(path)==expected_sha256
    contract=json.loads(path.read_text())
    assert contract['schema_version']==3 and contract['architecture']=='original36_compact_affine_four_groups'
    assert contract['evaluation_only'] is True and contract['release_approved'] is False
    assert contract['frozen_original_components']['sha256']==FROZEN_GROUPED_SHA
    assert set(contract['runtime_source_sha256'])==COMPACT_SOURCES
    for name,sha in contract['runtime_source_sha256'].items():assert digest(CODE/name)==sha,'Compact runtime source changed'
    policy=read_verified(contract['acceptance_policy'],RESULTS)
    assert policy['status']=='current_user_requirement' and not policy['release_approved'] and not policy['goal_complete']
    agreement=policy['box_agreement'];assert 0<agreement['precision_floor']<=1 and 0<agreement['recall_floor']<=1 and agreement['iou_threshold']==.9
    assert contract['quality_policy']==agreement
    package=read_verified(contract['group_package_manifest'],CANDIDATES)
    assert package['schema']=='compact_original_decoder_groups_v1' and package['status']=='complete_compact_decoder_profiles'
    assert package['evaluation_only'] and not package['release_approved'] and package['builder_sha256']==BUILDER_SHA
    assert package['original_decoder_layers']==36
    profiles=package['required_profiles'];assert len(profiles)==len(set(profiles)) and {'ar','prefill'}<=set(profiles)<=set(CAPACITIES)
    lengths=profile_capacities(package.get('profile_sequence_capacities'),profiles)
    assert profile_capacities(contract.get('profile_sequence_capacities'),profiles)==lengths
    assert contract['required_profiles']==profiles and contract['enabled_generation_modes']==package['enabled_generation_modes']
    assert package['checkpoint_manifest_sha256']==contract['decoder_checkpoint_manifest_sha256']
    expected={(start,profile) for start,_ in GROUPS for profile in profiles};indexed={}
    package_root=checked_path(contract['group_package_manifest']['path'],CANDIDATES).parent
    assert len(package['components'])==len(expected)
    for entry in package['components']:
        start,end,profile=entry['start'],entry['end'],entry['profile'];key=(start,profile)
        assert (start,end) in GROUPS and profile in profiles and key not in indexed and entry['sequence']==lengths[profile]
        root=checked_path(package_root/entry['directory'],package_root);assert root.parent==package_root and set(entry['files'])==FILES
        for name,sha in entry['files'].items():assert digest(root/name)==sha
        assert entry['files']['model.hbm']==entry['hbm_sha256']
        indexed[key]=dict(root=str(root),hbm_sha256=entry['hbm_sha256'],sequence_capacity=lengths[profile])
    assert set(indexed)==expected,'Every profile must cover all36 original layers'
    groups=[CompactBpuDecoderGroup(start,end,{p:indexed[(start,p)] for p in profiles},contract['decoder_checkpoint_manifest_sha256']) for start,end in GROUPS]
    decoder=CompactGroupedFullDecoder(groups)
    # Reuse the already frozen original29 vision and76 vocabulary components.
    # This constructor performs integrity checks only;it makes no neural calls.
    frozen_path=checked_path(contract['frozen_original_components']['path'],CANDIDATES)
    original,frozen=load_grouped_generator(frozen_path,FROZEN_GROUPED_SHA)
    generator=CompactGroupedFullBpuGenerator(original.vision,decoder,original.vocabulary,original.rope,
      original.image_token_index,original.token_ids,enabled_modes=tuple(contract['enabled_generation_modes']))
    assert len(generator.specs)==105+4*len(profiles) and len(generator.decoder.layer_indices)==36
    return generator,contract
