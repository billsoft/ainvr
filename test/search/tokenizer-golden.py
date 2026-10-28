#!/usr/bin/env python3
"""Pure-tokenizer oracle; never imports or loads a neural model.

Run in the exporter's isolated PYTHONPATH=/work/pylibs, USE_TORCH=0 USE_TF=0,
HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 PYTHONDONTWRITEBYTECODE=1 environment.
Original calibration artifacts are read only and optional; outputs belong to
first-party tests, not the model package. Do not regenerate to bless a failure.
"""
import argparse
import hashlib
import inspect
import json
from pathlib import Path
import platform
import re
import unicodedata


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--model-dir', required=True, type=Path)
    parser.add_argument('--original-dir', type=Path)
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    import sentencepiece
    import transformers
    from transformers import SiglipTokenizer
    if (transformers.__version__, sentencepiece.__version__, unicodedata.unidata_version) != ('4.46.3', '0.2.0', '13.0.0'):
        raise RuntimeError('Use the pinned original tokenizer environment; do not silently change reference versions')
    tok = SiglipTokenizer.from_pretrained(str(args.model_dir), local_files_only=True)
    model_sha = hashlib.sha256((args.model_dir / 'spiece.model').read_bytes()).hexdigest()
    if model_sha != 'ef78f86560d809067d12bac6c09f19a462cb3af3f54d2b8acbba26e1433125d6':
        raise RuntimeError('Unexpected default tokenizer bytes')
    prompt_sha = token_sha = None
    originals = []
    if args.original_dir:
        import numpy as np
        prompts_file = args.original_dir / 'prompts.json'
        tokens_file = args.original_dir / 'eval_tokens.npy'
        originals = json.loads(prompts_file.read_text())['eval']
        expected = np.load(tokens_file, allow_pickle=False)
        actual = np.asarray(tok(originals, padding='max_length', max_length=64, truncation=True)['input_ids'], dtype=np.int64)
        if expected.shape != (128, 64) or not np.array_equal(actual, expected):
            raise RuntimeError('Original export golden does not match this reference')
        prompt_sha = hashlib.sha256(prompts_file.read_bytes()).hexdigest()
        token_sha = hashlib.sha256(tokens_file.read_bytes()).hexdigest()
    boundary = [
        '', ' ', '\t\n\r', 'A PERSON walking!', 'Red-Car_in parking',
        '人员穿过入口', '人员，穿过：入口！', 'Ａ ＲＥＤ ＣＡＲ', 'é e\u0301 café',
        'İSTANBUL I\u0307 ẞ', 'ΟΣ ΟΣΑ A\u0301Σ ΑΣ\u200d',
        '\U00010570 \uA7C0',  # Unicode14: Python13 leaves these unchanged.
        '👨\u200d👩\u200d👧\u200d👦 🚗🔥', '▁person▁car', '▁▁人',
        '<unk>', '</s>', '<UNK>', '</S>', '<unk></s>', '</s><unk>',
        'person <unk> car', 'person\t</s>\u00a0car', '<unk> <unk>',
        ' <unk> ', 'person</s>', '</s> person', '<<unk>>',
        '<extra_id_99>', '＜extra＿id＿99＞', '＜ｅｘｔｒａ＿ｉｄ＿９９＞',
        'before ＜extra＿id＿0＞ after',
        'a' + ''.join(chr(i) for i in range(0x110000) if chr(i).isspace()) + 'b',
        'a\u200bb\u2060c', '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~',
    ] + ['person ' * n for n in (62, 63, 64, 65)]
    pattern = '(' + '|'.join(re.escape(s) for s in tok.all_special_tokens) + ')|(.+?)'
    rows = []
    for group, texts in [('original', originals), ('boundary', boundary)]:
        for index, text in enumerate(texts):
            raw = tok(text, truncation=False)['input_ids']
            error = ('tokenizer_embedding_token_out_of_range' if any(i >= 250000 for i in raw)
                     else 'tokenizer_query_too_long' if len(raw) > 64 else None)
            lower = re.sub(pattern, lambda m: m.groups()[0] or m.groups()[1].lower(), '▁' + text.replace('▁', ' '))
            rows.append(dict(group=group, id=index, text=text, normalized=lower,
                             raw_ids=raw, expected_error=error,
                             ids=None if error else raw + [1] * (64-len(raw))))
    result = dict(schema_version=1, model_sha256=model_sha, reference=dict(
        transformers=transformers.__version__, sentencepiece=sentencepiece.__version__,
        python=platform.python_version(), unicode=unicodedata.unidata_version,
        tokenizer_source_sha256=hashlib.sha256(Path(inspect.getfile(SiglipTokenizer)).read_bytes()).hexdigest(),
        official_source='https://github.com/huggingface/transformers/blob/v4.46.3/src/transformers/models/siglip/tokenization_siglip.py',
        original_prompts_sha256=prompt_sha, original_tokens_sha256=token_sha),
        original_rows=len(originals), boundary_rows=len(boundary), rows=rows)
    encoded = json.dumps(result, ensure_ascii=True, separators=(',', ':')) + '\n'
    if args.output:
        if args.output.exists():
            raise RuntimeError('Refuse to overwrite an existing golden')
        args.output.write_text(encoded)
    else:
        print(encoded, end='')


if __name__ == '__main__':
    main()
