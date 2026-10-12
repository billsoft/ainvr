# AINVR stopped-channel BPU migration

The production service advertises only the BPU model provider. Legacy CPU/ONNX
configuration can still be read so older installations remain inspectable, but
the production controller rejects writing CPU models and the real worker cannot
execute them. A legacy configuration is not an accepted production backend.

For the existing YOLO26m channel, audit first:

```sh
cd /home/sunrise/ainvr
python3 test/ai_port/migrate_stopped_channel_bpu.py \
  --channel 2baec0a3-9941-47dc-b1bd-d3d284488097
```

Then migrate through the original control API:

```sh
python3 test/ai_port/migrate_stopped_channel_bpu.py \
  --channel 2baec0a3-9941-47dc-b1bd-d3d284488097 \
  --apply --verify-missing-model
```

The script requires an already idle, operator-stopped channel. It changes only
the model backend, adapter, artifact path and obsolete engine cache, preserving
task name, dimensions, classes, preprocessing and every non-model setting.
It creates a private SSD backup before writing and verifies durable overlay
state through the original API. It does not modify the runtime configuration
file directly, copy another model into place, rename ONNX to HBM or compile a
model. Other tasks deliberately require their own explicit conversion contract.

The optional start-rejection probe is refused if the HBM artifact exists. With
a missing artifact, it verifies HTTP 422 `bpu_model_not_ready`, unchanged stop
intent, unchanged config and unchanged inference count. It also verifies that a
CPU model write is rejected without changing the saved configuration.

Verified on 2026-10-12: the channel now uses `yolo26_bpu`, provider `bpu`, and
`models/derived/s100p/yolo26m.hbm`; it remains stopped. No user HBM was installed,
so production inference and model accuracy/performance remain unverified.
Runtime maps contain no ONNXRuntime/CUDA/TensorRT inference libraries.

Evidence: `test/results/channel-bpu-migration-20261012-045255-252485.json`.
Private backup: `/mnt/ainvr-ssd/migration-backups/channel-bpu-20261012-045255-252485`.
The backup contains the prior view and overlay for inspection. Prefer restoring
selected settings through the API; replacing the whole overlay could overwrite
later channel changes. Do not re-enable the legacy CPU backend for production.

Next gate is the actual user-model HBM conversion, matching compilation contract,
class mapping, calibration, accuracy comparison and real BPU pipeline performance.
Saving a BPU path or running an official sample does not pass that gate.
