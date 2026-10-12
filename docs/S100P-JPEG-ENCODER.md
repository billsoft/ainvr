> Update: JpegEncoder now preserves even visible dimensions 18..8192 using internal edge padding. Prior alignment rejection is historical. See S100P-JPEG-PADDING.md for evidence and remaining limits.

> Update 2026-10-11: Hardware/GLES/CPU color stages now feed JPU; see S100P-SNAPSHOT-COLOR.md. JPU width must be divisible by 16 and height by 8. Business archive integration remains unfinished.

# AINVR S100P JPU JPEG encoder

Implementation: `ai-service/src/platform/jpeg_encoder.*`, target `ainvr_jpeg`.
Uses the installed MediaCodec SDK and process-wide media-memory lifetime.
Input/output SDK waits are bounded at two seconds per call, calls are serialized,
and an SDK failure poisons the instance. Invalid input length is rejected before
hardware submission without poisoning a valid instance.

The API explicitly accepts packed FULL-RANGE BT.601/JPEG NV12. Limited-range
BT.601/BT.709 video frames require a real range/matrix conversion first; passing
them directly is not a correct snapshot implementation. GPU conversion and ERP
crop integration remain to be connected to this encoder. No silent CPU fallback
is implemented in this class.

The installed SDK adds trailing zero alignment and a two-byte APP9 frame counter.
The wrapper removes that private short APP9 segment, normalizes header fill bytes,
and removes trailing zero padding after EOI. It preserves entropy-coded image data,
Huffman/quantization tables and restart markers. Longer APP9 payloads are retained.
Independent FFmpeg decoding now produces no error-level messages.

## Reproduction

From `/home/sunrise/ainvr`:

    test/runtime/model-audit-20261011/venv/bin/python test/ai_port/verify_jpeg_encoder.py

The script builds `test/ai_port/jpeg_encode_probe.cpp`, checks short-input rejection,
encodes three different frames per size using one reusable encoder, independently
decodes every JPEG and compares YUV content. It writes a new results directory.
Dimensions tested: 640x360, 1920x1080, 3840x2160 and 7680x3840, quality 90.

Evidence: `test/results/jpeg-encoder-20261011-172457-434351/summary.json`.
Measured encoding plus host-copy/header handling: about 2.1 ms at 1080p,
7.8 ms at 3840x2160 and 27.1-27.5 ms at 7680x3840. These are three simple
synthetic frames per size, excluding encoder initialization, capture, color
conversion, ERP projection, disk/database I/O and inference. They are not a
30-fps end-to-end claim or a high-complexity/long-running/multi-channel benchmark.

Snapshot persistence, archive backpressure and the deployed AI channel service
remain separate unfinished work.
