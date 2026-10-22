"""Deterministic 100k full-template comparisons; never load a BPU model.

Large temporary corpus/output files live on SSD and are removed after comparison.
This is a development corpus, not the independent image quality evaluation set.
"""
import hashlib
import json
from pathlib import Path
import random
import subprocess
import tempfile
import time
from tokenizers import Tokenizer

ROOT = Path(__file__).resolve().parents[2]
PACKAGE = Path('/mnt/ainvr-ssd/llm-packages/qwen3vl-4b-review-v3')
PROBE = Path('/mnt/ainvr-ssd/llm-build/ainvr/ainvr_llm_probe')


def main():
    started = time.monotonic()
    tokenizer = Tokenizer.from_file(str(PACKAGE / 'tokenizer.json'))
    template = json.loads((PACKAGE / 'task-template.json').read_text())
    rng = random.Random(20261022)
    alphabets = [
        '人车火烟门区域警戒进入离开安全未发现男女孩工厂车辆警报',
        'abcdefghijklmnopqrstuvwxyz ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
        'éàüßñ Ελληνικά русский العربية 日本語 한국어',
        ' !?，。；：\n\t{}[]()📷🔥🚗',
    ]
    count = 100000
    with tempfile.TemporaryDirectory(dir='/mnt/ainvr-ssd/llm-eval', prefix='tokenizer-') as tmp:
        inputs, outputs = Path(tmp) / 'inputs.jsonl', Path(tmp) / 'outputs.jsonl'
        with inputs.open('w') as f:
            for index in range(count):
                alphabet = alphabets[index % len(alphabets)]
                desc = ''.join(rng.choice(alphabet) for _ in range(1 + index % 96))
                item = dict(id=str(index), kind=['人员', 'fire', '车辆', '周界'][index % 4], desc=desc)
                f.write(json.dumps(item, ensure_ascii=False) + '\n')
        subprocess.run([str(PROBE), str(PACKAGE), 'encode', str(inputs), str(outputs)],
                       check=True, timeout=900)
        checked = 0
        with inputs.open() as source, outputs.open() as actual:
            for line in source:
                item = json.loads(line)
                output = json.loads(next(actual))
                prompt = template['prompt'].format(kind=item['kind'], desc=item['desc'])
                text = (template['prefix'] + template['image_token'] * template['image_tokens']
                        + template['suffix'].replace('{prompt}', prompt))
                assert output['id'] == item['id']
                assert output['input_ids'] == tokenizer.encode(text).ids, item['id']
                checked += 1
            assert next(actual, None) is None
        assert checked == count
    report = dict(passed=True, count=checked, seed=20261022, seconds=time.monotonic()-started,
                  tokenizer_sha256=hashlib.sha256((PACKAGE/'tokenizer.json').read_bytes()).hexdigest(),
                  probe_sha256=hashlib.sha256(PROBE.read_bytes()).hexdigest(), model_loaded=False)
    destination = ROOT/'test/results/llm-service-development/tokenizer-corpus.json'
    destination.write_text(json.dumps(report, indent=2))
    print(json.dumps(report))


if __name__ == '__main__':
    main()
