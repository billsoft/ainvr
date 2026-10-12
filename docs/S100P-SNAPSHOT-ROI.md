# AINVR S100P snapshot ROI rendering

SnapshotTransform bridges the native crop plan to ImageTransform, preserving exact output dimensions and source field of view. Ordinary crops specify pixel-edge x/y/width/height; out-of-image coordinates replicate the image border. ERP plans preserve yaw/pitch/FOV. Color metadata is explicit.

GLES now renders ordinary source regions directly from NV12 or RGBA textures. The CPU path uses the same region contract. Region transforms reject letterboxing and ERP combinations, invalid dimensions and nonfinite coordinates before hardware dispatch. Existing full-frame PYM scaling and GDC perspective dispatch remain available. Arbitrary region cropping currently uses GLES (CPU fallback); native PYM ROI acceleration still needs implementation and validation and is not claimed unsupported by hardware.

Verification: test/ai_port/verify_snapshot_roi.py with the model-audit virtual environment. Six cases cover ordinary interior scaling, top-left and bottom-right border replication, 7680x3840 source, 21x19 output and 2x2 output. GPU pixels are compared against CPU and an independent analytical grayscale ramp. Four eligible outputs are JPU encoded and FFmpeg decoded with dimensions/storage and mean-error assertions. Odd and tiny outputs are rendered but not JPEG encoded.

Evidence: test/results/snapshot-roi-20261011-175621-792513/summary.json. Existing 20 CTest groups pass (test/results/roi-ctest.log), and all seven existing color/ERP/PYM/GDC/JPU cases pass (test/results/snapshot-color-20261011-175555-484082/summary.json).

Remaining: odd/tiny JPEG encoding; reference INTER_AREA downsampling and supersampled cubic ERP image-quality parity; native PYM ROI acceleration; actual channel snapshot configuration, original/enhanced outputs and Mongo archive integration. Current GPU/CPU crops use bilinear sampling; these tests do not prove reference pixel-identical behavior or production throughput.
