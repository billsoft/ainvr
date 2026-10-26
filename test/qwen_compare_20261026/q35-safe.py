"""Board: full-BPU Qwen3.5 alarm review (vision 4 groups -> text 4 groups chunked prefill -> decision head) on prepared items.
Host side only does data layout: patchify, token-embedding row lookup (BF16 table, see note), MRoPE cos/sin, KV/mask layout.
usage: python3 board_run_alarm_v1.py MANIFEST.json ITEMS.jsonl OUT.jsonl [limit]
NOTE: token embedding rows are looked up on the host from the BF16 table (a gather, no arithmetic); a BPU embedding
program is a later step and is reported as such, not hidden."""
import sys, json, time, os
from pathlib import Path
import numpy as np
import hbm_runtime
from PIL import Image
sys.path.insert(0, str(Path(__file__).parent))
import qwen35_host_v1 as hv


class Prog:
    def __init__(self, pkg):
        pkg = Path(pkg); self.rt = hbm_runtime.HB_HBMRuntime(str(pkg / 'model.hbm')); names = list(self.rt.model_names)
        self.rt.set_scheduling_params(bpu_cores={n: [0] for n in names}); self.by = {}
        for d in sorted(x for x in pkg.glob('s*') if x.is_dir()):
            ports = json.loads((d / 'ports.json').read_text()); shp = {x['name']: list(x['shape']) for x in ports['inputs']}
            n = [m for m in names if {k: list(v) for k, v in dict(self.rt.input_shapes[m]).items()} == shp]; assert len(n) == 1
            self.by[int(d.name[1:]) if d.name[1:].isdigit() else d.name] = (n[0], [x['name'] for x in ports['inputs']], [x['name'] for x in ports['outputs']])
        self.ms = 0.0; self.calls = 0

    def __call__(self, key, xs):
        n, ins, outs = self.by[key]; t = time.perf_counter()
        o = self.rt.run({n: {a: np.ascontiguousarray(x, np.float32) for a, x in zip(ins, xs)}})[n]
        self.ms += (time.perf_counter() - t) * 1000; self.calls += 1
        return [np.asarray(o[a]) for a in outs]


man = json.loads(Path(sys.argv[1]).read_text()); root = Path(sys.argv[1]).parent
items = [json.loads(l) for l in Path(sys.argv[2]).read_text(encoding='utf-8').splitlines()]
if len(sys.argv) > 4:
    items = items[:int(sys.argv[4])]
def own_ion_bytes_lower_bound():
    seen={}
    for fd in os.listdir('/proc/self/fd'):
        try:
            if not os.readlink('/proc/self/fd/'+fd).startswith('/dmabuf'): continue
            fields=dict(l.split(':',1) for l in Path('/proc/self/fdinfo/'+fd).read_text().splitlines() if ':' in l)
            if fields.get('exp_name','').strip()=='ion': seen[int(fields['ino'])]=int(fields['size'])
        except (OSError,ValueError,KeyError): pass
    return sum(seen.values())
def mem_sample():
    st={l.split(':')[0]:int(l.split()[1])*1024 for l in Path('/proc/self/status').read_text().splitlines() if l.startswith(('VmRSS:','VmHWM:'))}
    return dict(ion=own_ion_bytes_lower_bound(),rss=st.get('VmRSS',0),hwm=st.get('VmHWM',0))


PEAK = dict(ion=0, rss=0, hwm=0, total=0)


def mem_peak():
    m = mem_sample()
    for k in ('ion', 'rss', 'hwm'):
        PEAK[k] = max(PEAK[k], m[k])
    PEAK['total'] = max(PEAK['total'], m['ion'] + m['rss'])


t0 = time.time()
VFEAT = os.environ.get('QVFEAT') == '1'
vis = [] if VFEAT else [Prog(root / p) for p in man['vision']]; txt = [Prog(root / p) for p in man['text']]; head = Prog(root / man['head'])
groups = man['text_groups']; CAP, P = man['cap'], man['prefill']
emb = np.load(root / man['embedding'], mmap_mode='r')
rope = np.load(root / man['vision_rope']); vcos, vsin = rope['cos'], rope['sin']
tok = json.loads((root / man['head'] / 'tokens.json').read_text(encoding='utf-8')); YES, NO = tok['words'].index('是'), tok['words'].index('否')
load_s = time.time() - t0; mem_peak()
print('loaded', round(load_s, 1), 's', flush=True)
with open(sys.argv[3], 'w', encoding='utf-8') as fo:
    for it in items:
        T = {}; t = time.perf_counter()
        img = np.asarray(Image.open(root / it['image_path']).convert('RGB'))
        x = hv.patchify(img); T['patchify'] = time.perf_counter() - t
        vision_start=time.perf_counter()
        if VFEAT:   # attribution mode: BF16 vision features from the PC (raw bf16 bits), text+head on BPU
            a = (np.load(root / 'vision-bf16' / (Path(it['image_path']).stem + '.npy')).astype(np.uint32) << 16).view(np.float32)
            merged, ds = a[0], [a[1], a[2], a[3]]
        else:
            h = x
            for i, v in enumerate(vis):
                h = v(next(iter(v.by)), [h, vcos, vsin] if v.by[next(iter(v.by))][1].__len__() == 3 else [h])[0]
            merged = h
        T['vision'] = time.perf_counter() - vision_start
        text_start=time.perf_counter()
        ids = np.array(it['input_ids'], np.int64); L = len(ids)
        hid = (np.asarray(emb[ids]).astype(np.uint32) << 16).view(np.float32); vm = ids == hv.IMAGE_TOKEN; assert vm.sum() == merged.shape[0]
        hid[vm] = merged
        cos, sin = hv.mrope_cos_sin(hv.rope_index(ids))
        for g, (first, count) in enumerate(groups):
            hs = hv.HostState(hv.KINDS[first:first + count], CAP); rows = []
            for start, q, Pq in hv.prefill_plan(L, P):
                o = txt[g](Pq, hs.inputs(hid, cos, sin, start, q, Pq))
                rows.append(o[0][:q]); hs.update(o, q)
            hid = np.concatenate(rows)
        T['text'] = time.perf_counter() - text_start
        head_start=time.perf_counter()
        lg = head(next(iter(head.by)), [hid[-1:]])[0][0]
        T['head'] = time.perf_counter() - head_start
        T['total'] = time.perf_counter() - t
        two = np.array([lg[YES], lg[NO]], np.float64); p = float(np.exp(two[0] - two.max()) / np.exp(two - two.max()).sum())
        rec = dict(id=it['id'], p_yes=p, logit_yes=float(lg[YES]), logit_no=float(lg[NO]), logits={w: float(v) for w, v in zip(tok['words'], lg)},
                   seq=L, expected=it.get('expected'), answer_mode=it.get('answer_mode'), category=it.get('category'), ms={k: round(v * 1000, 1) for k, v in T.items()})
        mem_peak()
        fo.write(json.dumps(rec, ensure_ascii=False) + '\n'); fo.flush(); print(json.dumps(dict(id=it['id'], p=round(p, 4), ms=rec['ms'])), flush=True)
print(json.dumps(dict(load_s=load_s, memory_peak_bytes=PEAK, memory_scope='Process RSS and fdinfo ION lower bound; separately reported; sampled after load and each item', bpu_ms=dict(vision=sum(v.ms for v in vis), text=sum(x.ms for x in txt), head=head.ms))))
