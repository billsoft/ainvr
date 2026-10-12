# AINVR PYM integration

The native image preprocessor selects PYM for eligible NV12 downscaling, then
uses Mali GLES for color conversion, normalization and letterbox padding.
Inputs beyond PYM capability (including 7680x3840) and nearest sampling use
GLES. ERP perspective now uses GDC where supported, otherwise GLES; see
`S100P-GDC-INTEGRATION.md`. This is a reusable library;
the complete AI channel worker and service deployment remain unfinished.

`ai-service/src/platform/image_preprocessor.hpp` is the dispatch entry point.
The result reports its actual backend and any hardware failures. A failed
hardware backend is disabled for that instance and the next backend is tried;
CPU is last. Dedicated scaling does not imply that color
conversion or the complete AI pipeline is handled by PYM.

PYM configuration follows the installed S100P sample: input width aligned to
32, height to 8, dimensions 32..4096; output dimensions even and at least 32.
One pyramid layer supplies a final downscale ratio in (1/2,1] on both axes.
Requests outside this representable range use GLES. The selected hardware
interpolation is not advertised as pixel-identical to a single GLES bilinear
sample. Accuracy comparison with real calibrated models remains required.

The implementation copies packed NV12 into SDK allocated cached memory,
flushes before submission, invalidates output before CPU access, copies only
visible rows, returns the buffer and preserves the caller's PTS. There is one
in-flight frame per scaler, with a 2 second receive timeout. A failed operation
poisons the instance to avoid stale frame association. VPU and PYM share one
process-wide SDK memory lifetime. This is not yet a zero-copy decoder pipeline.

## Board verification, 2026-10-11

- Changing constant frames: 1920x1080 -> 640x360, 3840x2160 -> 640x360,
  4096x4096 -> 640x640. All visible Y/UV bytes checked, eight frames per case.
- Nonconstant quadrant image: orientation and quadrants checked after scaling.
- PYM destruction/recreation while a VPU decoder remains alive.
- Dispatcher: hardware preference, letterbox padding, color conversion,
  nearest and ERP bypass, actual 7680x3840 GLES processing.
- Full C++ regression and VPU/JPU codec regression are captured in
  `test/results/pym-integration-20261011/`.

Initial short copy-and-validation throughput was approximately 327, 109 and
55 frames/s for the three PYM cases respectively. These include host copies
and result checks, exclude constructor time and are not sustained multi-channel
or end-to-end inference rates. Only PYM hardware id 0 was used for this adapter
test; earlier standalone experiments tested other ids separately.

Repeat hardware tests with `python3 test/ai_port/verify_pym.py`. Run serially on
the board, with no competing PYM benchmark. Raw logs go to a unique results
directory. Reference TecheAI files and uploaded models are unchanged.
