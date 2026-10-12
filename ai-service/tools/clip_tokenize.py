"""AINVR bounded JSON BPE helper. String/token logic only, no neural libraries."""
import argparse
import hashlib
import json
from pathlib import Path
import sys

p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--assets',type=Path,required=True)
a=p.parse_args()
try:
    payload=sys.stdin.buffer.read(32769)
    if len(payload)>32768:raise ValueError('文字输入过长')
    request=json.loads(payload.decode('utf-8'))
    if not isinstance(request,dict) or set(request)!={'phrases'}:
        raise ValueError('需要 phrases 文字列表')
    phrases=request['phrases']
    if not isinstance(phrases,list) or not 1<=len(phrases)<=8:
        raise ValueError('一次请输入 1 到 8 个识别描述')
    for phrase in phrases:
        if not isinstance(phrase,str) or not phrase.strip() or len(phrase.encode('utf-8'))>4096:
            raise ValueError('识别描述为空或过长')
    sha=lambda path:hashlib.sha256(path.read_bytes()).hexdigest()
    source=a.assets/'simple_tokenizer.py';vocab=a.assets/'bpe_simple_vocab_16e6.txt.gz'
    # Bind the reviewed upstream MIT implementation; do not import a module
    # selected by the request or execute user text as code.
    if sha(source)!='d1b09f10ed3d1e2c343619cb98cbfacb92363dd8607526a43aa7fe2d60d15bad':
        raise ValueError('分词器文件校验失败')
    if sha(vocab)!='924691ac288e54409236115652ad4aa250f48203de50a9e4722a6ecd48d6804a':
        raise ValueError('分词词表文件校验失败')
    sys.path.insert(0,str(a.assets.resolve()))
    from simple_tokenizer import SimpleTokenizer
    tokenizer=SimpleTokenizer(str(vocab));tokens=[]
    for phrase in phrases:
        ids=[49406]+tokenizer.encode(phrase)+[49407]
        if len(ids)>77:raise ValueError('识别描述太长，请缩短后重试')
        if any(not isinstance(x,int) or not 0<=x<=49407 for x in ids):
            raise ValueError('分词结果超出范围')
        tokens.append(ids+[0]*(77-len(ids)))
    print(json.dumps({'tokens':tokens,'phrases':phrases,'context_length':77,
                      'vocab_size':49408,'neural_inference':False},ensure_ascii=False))
except (ValueError,OSError,ImportError) as e:
    print(str(e),file=sys.stderr)
    raise SystemExit(2)
