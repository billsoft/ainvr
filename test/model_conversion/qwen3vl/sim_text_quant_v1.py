"""PC simulation of text-decoder weight quantization for Qwen3-VL alarm review, then yes/no evaluation vs frozen BF16.
mode rtn : per-row symmetric INT8 round-to-nearest (scale=absmax/127, codes +-127)
mode gptq: same grid, GPTQ rounding (IST-DASLab: act-order, damp .01, block 128), sequential per layer with requantized
           inputs, teacher forcing on calib-v2 prompts + BF16 answers; DeepStack adds replayed after layers 0..2.
Vision stays BF16 here (BPU vision features replace it once vision HBMs exist). lm_head: RTN W8 in both modes.
usage: sim_text_quant_v1.py MODE OUTDIR [--save-codes] [--calib N]"""
import os, sys, json, time, gc
os.environ['OMP_NUM_THREADS'] = '2'
sys.path.insert(0, '/qwork/scripts')
from qwen3vl_common_v1 import *

mode, out = sys.argv[1], Path(sys.argv[2]); save_codes = '--save-codes' in sys.argv
ncal = int(sys.argv[sys.argv.index('--calib') + 1]) if '--calib' in sys.argv else 10 ** 9
assert mode in ('rtn', 'gptq') and not out.exists(); out.mkdir(parents=True)
codes_dir = out / 'codes'
if save_codes:
    codes_dir.mkdir()
r = dict(mode=mode, started=time.time(), modules=[], status='loading')


def persist():
    t = out / 'status.json.tmp'; t.write_text(json.dumps(r, indent=1, ensure_ascii=False)); t.replace(out / 'status.json')


def row_scale(W):
    return (W.abs().amax(1, keepdim=True) / 127).clamp_min(1e-12)


def store(name, codes, s, mod):
    if save_codes:
        np.savez(codes_dir / f'{name}.npz', codes=codes.to(torch.int8).cpu().numpy(), scales=s.cpu().numpy().astype(np.float32))
    mod.weight.data.copy_((codes * s).to(mod.weight.dtype))


@torch.no_grad()
def rtn(name, mod):
    W = mod.weight.data.float(); s = row_scale(W); store(name, torch.round(W / s).clamp(-127, 127), s, mod)


@torch.no_grad()
def gptq(name, mod, H):
    W = mod.weight.data.float().clone(); rows, cols = W.shape; s = row_scale(W)
    dead = torch.diag(H) == 0; H[dead, dead] = 1; W[:, dead] = 0
    perm = torch.argsort(torch.diag(H), descending=True); W = W[:, perm]; H = H[perm][:, perm]
    H[torch.arange(cols), torch.arange(cols)] += .01 * torch.mean(torch.diag(H))
    Hinv = torch.linalg.cholesky(torch.cholesky_inverse(torch.linalg.cholesky(H)), upper=True); Q = torch.zeros_like(W); err = 0.
    for i1 in range(0, cols, 128):
        i2 = min(i1 + 128, cols); W1 = W[:, i1:i2].clone(); Q1 = torch.zeros_like(W1); E1 = torch.zeros_like(W1); Hi = Hinv[i1:i2, i1:i2]
        for i in range(i2 - i1):
            w = W1[:, i]; d = Hi[i, i]; q = torch.round(w / s[:, 0]).clamp(-127, 127) * s[:, 0]; Q1[:, i] = q
            e = (w - q) / d; W1[:, i:] -= e[:, None] * Hi[i, i:][None, :]; E1[:, i] = e; err += float(((w - q) ** 2 / d ** 2).sum())
        Q[:, i1:i2] = Q1; W[:, i2:] -= E1 @ Hinv[i1:i2, i2:]
    Q = Q[:, torch.argsort(perm)]; codes = torch.round(Q / s).clamp(-127, 127)
    store(name, codes, s, mod); r['modules'].append(dict(name=name, shape=[rows, cols], loss=err, dead=int(dead.sum())))


def items(split):
    return [json.loads(l) for l in Path(f'/qwork/data/items-{split}-v2.jsonl').read_text(encoding='utf-8').splitlines()]


def refs(split):
    return {json.loads(l)['id']: json.loads(l) for l in Path(f'/qwork/ref/bf16-{split}-v2.jsonl').read_text(encoding='utf-8').splitlines()}


try:
    persist(); torch.backends.cuda.matmul.allow_tf32 = False
    model, proc = load_model(); lm = model.model.language_model; layers = lm.layers
    LIN = ['self_attn.q_proj', 'self_attn.k_proj', 'self_attn.v_proj', 'self_attn.o_proj', 'mlp.gate_proj', 'mlp.up_proj', 'mlp.down_proj']
    if mode == 'rtn':
        for li, layer in enumerate(layers):
            mods = dict(layer.named_modules())
            for n in LIN:
                rtn(f'layer{li}.{n}', mods[n])
    else:
        r['status'] = 'capturing'; persist(); inps = []

        class Stop(Exception):
            pass

        ds_store = []

        def catch(m, args, kwargs):
            h = args[0] if args else kwargs['hidden_states']
            inps.append([h, {k: v for k, v in kwargs.items() if k != 'hidden_states'}]); raise Stop

        orig_ds = lm._deepstack_process

        def ds_spy(h, mask, emb):
            ds_store[-1].append((mask, emb)); return orig_ds(h, mask, emb)

        hk = layers[0].register_forward_pre_hook(catch, with_kwargs=True)
        ref_c = refs('calib')
        with torch.no_grad():
            for it in items('calib')[:ncal]:
                ans = YES if ref_c[it['id']]['p_yes'] >= .5 else NO
                enc = build_inputs(proc, load_image(Path('/qwork/data') / it['image']), it['kind'], it['desc'], answer=ans)
                # capture deepstack embeds by running the visual tower explicitly
                pv = enc['pixel_values'].cuda().to(model.dtype); thw = enc['image_grid_thw'].cuda()
                _, ds = model.model.visual(pv, grid_thw=thw)
                vmask = (enc['input_ids'][0] == model.config.image_token_id).cuda()
                ds_store.append([(vmask, x) for x in ds])
                try:
                    model(**{k: v.cuda() for k, v in enc.items()}, use_cache=False)
                except Stop:
                    pass
        hk.remove()
        r['calibration_sequences'] = len(inps); r['calibration_tokens'] = int(sum(x[0].shape[1] for x in inps)); persist()
        groups = [['self_attn.q_proj', 'self_attn.k_proj', 'self_attn.v_proj'], ['self_attn.o_proj'], ['mlp.gate_proj', 'mlp.up_proj'], ['mlp.down_proj']]
        for li, layer in enumerate(layers):
            r['status'] = f'gptq_layer_{li}'; persist(); mods = dict(layer.named_modules())
            for g in groups:
                H = {}

                def hook(m, args):
                    x = args[0].reshape(-1, args[0].shape[-1]).float(); H['h'] = H.get('h', 0) + x.T @ x
                hh = mods[g[0]].register_forward_pre_hook(hook)
                with torch.no_grad():
                    for x, kw in inps:
                        layer(x, **kw)
                hh.remove()
                for n in g:
                    gptq(f'layer{li}.{n}', mods[n], H['h'].clone())
                del H; torch.cuda.empty_cache()
            with torch.no_grad():
                for j, (x, kw) in enumerate(inps):
                    y = layer(x, **kw); y = y[0] if isinstance(y, tuple) else y
                    if li < 3:
                        vmask, emb = ds_store[j][li]
                        y = y.clone(); y[0, vmask] = y[0, vmask] + emb.to(y.dtype)
                    inps[j][0] = y
        del inps, ds_store; gc.collect(); torch.cuda.empty_cache()
    head = model.lm_head
    if head.weight.data_ptr() == lm.embed_tokens.weight.data_ptr():
        head.weight = torch.nn.Parameter(head.weight.detach().clone())
    rtn('lm_head', head)
    r['status'] = 'evaluating'; persist(); r['eval'] = {}
    for split in ['dev', 'final']:
        ref = refs(split); rows = []
        for it in items(split):
            enc = build_inputs(proc, load_image(Path('/qwork/data') / it['image']), it['kind'], it['desc'])
            q = yes_no(model, proc, enc); b = ref[it['id']]
            rows.append(dict(id=it['id'], label=it['label'], p_ref=b['p_yes'], p=q['p_yes'],
                             d_ref=b['logit_yes'] - b['logit_no'], d=q['logit_yes'] - q['logit_no']))
        (out / f'eval-{split}.jsonl').write_text(''.join(json.dumps(x) + '\n' for x in rows))
        r['eval'][split] = n = len(rows)
        persist()
    r['status'] = 'completed'
except BaseException:
    import traceback; r.update(status='failed', error=traceback.format_exc()); raise
finally:
    r['finished'] = time.time(); persist()
print(json.dumps({k: r.get(k) for k in ['status', 'calibration_sequences', 'calibration_tokens', 'error']}))
