"""Read official model config and installed SDK defaults;no model execution."""
from pathlib import Path
import ast
import hashlib
import json
import time
import urllib.request

OUT = Path('/work/official-llm-v1')
SOURCE = Path('/opt/locate-oellm-research-v1/leap-source-overlay/leap_llm/apis/oellm_build.py')
REPORT = OUT / 'official-qwen-omni-vs-locate-layout-v1.json'
CONFIG = OUT / 'official-qwen2.5-omni-3b-config-v1.json'
assert not REPORT.exists() and not CONFIG.exists()
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
assert sha(SOURCE) == '93f1fbb48269651670b43b071ffaf6194d9eceba373864e9decdfcb722c8611f'
url = 'https://huggingface.co/Qwen/Qwen2.5-Omni-3B/resolve/main/config.json'
with urllib.request.urlopen(url, timeout=20) as response:
    content = response.read(128000)
    commit = response.headers.get('x-repo-commit')
assert commit and len(commit) == 40 and all(x in '0123456789abcdef' for x in commit)
fixed_url = f'https://huggingface.co/Qwen/Qwen2.5-Omni-3B/resolve/{commit}/config.json'
with urllib.request.urlopen(fixed_url, timeout=20) as response:
    frozen = response.read(128000)
assert frozen == content
official = json.loads(content)
CONFIG.write_bytes(content)
locate_path = Path('/model/config.json')
locate = json.loads(locate_path.read_text())
assert locate['architectures'] == ['LocateAnythingForConditionalGeneration']
assert official['architectures'] == ['Qwen2_5OmniModel']
text_keys = ['hidden_size', 'intermediate_size', 'num_attention_heads', 'num_hidden_layers',
             'num_key_value_heads', 'rms_norm_eps', 'rope_theta', 'vocab_size', 'tie_word_embeddings']
ot = {k: official['thinker_config']['text_config'][k] for k in text_keys}
lt = {k: locate['text_config'][k] for k in text_keys}
shared = [k for k in text_keys if ot[k] == lt[k]]
assert all(k in shared for k in text_keys[:7])
defaults = None
for node in ast.parse(SOURCE.read_text()).body:
    if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'DEFAULT_COMPILE_KWARGS' for t in node.targets):
        defaults = ast.literal_eval(node.value)
assert defaults['march'] == 'nash-m' and defaults['opt'] == 2
report = dict(status='official_config_and_sdk_defaults_read_only', checked=time.time(),
    source_sha256=sha(Path(__file__)), official_config=dict(url=fixed_url, revision=commit, sha256=sha(CONFIG)),
    locate_original_config_sha256=sha(locate_path), official_build_source_sha256=sha(SOURCE),
    official_text=ot, locate_text=lt, identical_text_fields=shared,
    vocabulary_extra_fraction=(lt['vocab_size']-ot['vocab_size'])/ot['vocab_size'],
    official_compile_defaults=defaults,
    inference_notes=[
        'Matching layer/hidden/FFN/head dimensions rule out a much larger text backbone as a sufficient explanation for the previous order-of-magnitude speed gap.',
        'This does not prove equal speed:MRoPE,quantization precision,compiler optimization,group boundaries,integer IO,runtime copy/check overhead and production contention still differ.',
        'Official SDK default O2 is source evidence;the current official-family O0 baseline still needs complete native quality/speed before selecting the next optimized artifact.',
        'Vision architectures differ:official Omni has32blocks/width1280 and temporal/window handling;Locate has27MoonViT blocks/width1152/interleaved2D RoPE. Preserve original model semantics.',
        'Actual whole-family resident memory and5TPS success remain unverified;no extrapolation from file sizes or partial groups.'
    ], neural_calls=0, compilation_started=False, whole_model_verified=False, release_approved=False)
REPORT.write_text(json.dumps(report, indent=2)+'\n')
print(json.dumps(dict(report=str(REPORT), report_sha256=sha(REPORT), official_revision=commit,
    identical_text_fields=shared, vocabulary_extra_fraction=report['vocabulary_extra_fraction'], official_opt=defaults['opt'])))
