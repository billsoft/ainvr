> Update: JpegEncoder now preserves even visible dimensions 18..8192 using internal edge padding. Prior alignment rejection is historical. See S100P-JPEG-PADDING.md for evidence and remaining limits.

# AINVR S100P snapshot color pipeline

`ImagePreprocessor::RunJpegNv12` now returns packed full-range BT.601 NV12 in
`PreprocessedImage::jpeg_nv12`. It preserves the existing GDC/PYM first, GLES
second, CPU last dispatch and explicit fallback reasons. Normalization and BGR
model settings are overridden because JPEG input must be image samples.

GLES performs input BT.601/BT.709 limited/full range conversion through RGB and
converts to full-range JPEG YUV. Chroma is averaged over 2x2 output pixels. Its
shader packs four bytes per uint, with padded GPU rows copied back to packed
host rows. This uses approximately 1.5 bytes/output pixel rather than a 12-byte
float RGB tensor; 7680x3840 output was verified. Host copies remain; this is not
a zero-copy pipeline. CPU conversion is available when GPU initialization or
processing fails, using the existing CPU geometry implementation.

## Reproduction

From `/home/sunrise/ainvr`:

    test/runtime/model-audit-20261011/venv/bin/python test/ai_port/verify_snapshot_color.py

The script compiles `test/ai_port/snapshot_color_probe.cpp`, runs seven cases,
compares accelerated NV12 with CPU reference, and independently decodes the six
hardware-compatible JPEG outputs. Tests cover BT.601/BT.709, limited/full input
range, PYM scaling, GDC ERP perspective, 8K ERP GLES perspective, and 8K native
size color conversion/JPU encoding. No fallback was taken in accelerated cases.
The CPU path is selected explicitly for the comparison, not silently substituted.

Evidence: `test/results/snapshot-color-20261011-173154-015771/summary.json`.
GPU-only color conversion matched CPU exactly for the tested native-size cases.
GDC perspective differed by at most one byte value in this fixture. PYM scaling
had low average error but a maximum difference of 52 on an edge; its resampling
is not identical to the CPU bilinear reference. JPEG comparisons include lossy
compression and are checked separately.

## Remaining integration and limits

The installed JPU requires width divisible by 16 and height divisible by 8.
`JpegEncoder` now rejects unsupported dimensions before SDK configuration.
638x358 is tested for preprocessing and explicit JPU rejection, not successful
JPEG encoding. Arbitrary detection-crop sizes need padding/cropping or a CPU
encoder fallback in the snapshot orchestration layer; that is unfinished.

This completes reusable geometry/color/JPU stages, not business snapshot wiring.
Bounding-box ROI selection, configuration toggle integration, persistent archive
and backpressure, shutdown/retry semantics, live AI channel deployment and
performance under concurrent load still require work. The synthetic fixtures
do not validate camera calibration or model accuracy.

Regression: 20 CTest groups passed. SCRFD/YOLO26m native inference tests passed. First-call preprocessing was about 99-105 ms with shader initialization, versus roughly 31 ms in the previous shader; subsequent calls remained about 6.2-6.5 ms. Warm-up latency should be included in future channel startup measurements.
