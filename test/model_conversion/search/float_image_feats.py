"""Float image embeddings from HF SiglipModel for eval_inputs.npy. usage: float_image_feats.py MODEL_DIR INPUTS.npy OUT.npy"""
import sys, numpy as np, torch
from transformers import SiglipModel
torch.set_num_threads(6)
m = SiglipModel.from_pretrained(sys.argv[1], torch_dtype=torch.float32).eval()
x = np.load(sys.argv[2])
out = []
with torch.no_grad():
    for i in range(len(x)):
        out.append(m.get_image_features(pixel_values=torch.from_numpy(x[i:i + 1])).numpy())
np.save(sys.argv[3], np.concatenate(out)); print(np.concatenate(out).shape)
