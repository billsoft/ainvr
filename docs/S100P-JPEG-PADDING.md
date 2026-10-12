# AINVR S100P JPEG visible-size preservation

The JPU wrapper accepts even visible dimensions from 18 through 8192. SDK
buffers are padded to width multiple 16, height multiple 8 and minimum 32x32.
Luma repeats the final source column/row; interleaved UV repeats the final pair
and chroma row. This avoids introducing black padding into edge DCT blocks.
Small pictures also require an SDK bitstream buffer of at least 8192 bytes.

For the installed encoder's baseline 8-bit 4:2:0 output, the visible dimensions
are restored in SOF0. This is only done after checking the frame header, sampling
factors, encoded dimensions and unchanged 16x16 MCU grid. Entropy data and restart
markers remain unchanged. Unexpected SDK output is rejected; no guessed header
layout is accepted. This is padding and visible-size preservation, not resizing.

Odd dimensions and dimensions below 18 remain unsupported by this NV12 API;
the future business crop layer must select a supported output or use an explicit
alternative encoder. Input remains full-range BT.601 NV12. No CPU JPEG encoder
was silently substituted.

## Validation

From `/home/sunrise/ainvr`:

    test/runtime/model-audit-20261011/venv/bin/python test/ai_port/verify_jpeg_encoder.py
    test/runtime/model-audit-20261011/venv/bin/python test/ai_port/verify_snapshot_color.py

JPEG cases: 18x18, 30x22, 638x358, 1922x1082, 3840x2160 and 7680x3840,
three changing frames each. FFprobe verifies exact visible dimensions. FFmpeg
independently decodes without error-level output. Tests compare full image YUV
and separately check the final two luma rows/columns to detect padding artifacts.
Quality is 90 and fixtures are synthetic; this is not natural-image quality or
long-running performance acceptance.

All seven geometry/color/JPU cases now encode JPEG, including the former
638x358 rejection case. Evidence is indexed by
`test/results/jpeg-padding-20261011/summary.json`.

The previous JPU-alignment rejection described in S100P-JPEG-ENCODER.md and
S100P-SNAPSHOT-COLOR.md is historical. Business target-box cropping, the ERP
configuration switch, persistence and channel-service integration remain open.
