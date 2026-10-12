> UPDATE 2026-10-11: Production POC matching is now integrated and tested. B-frame rejection described below is historical. See S100P-VPU-POC-REPAIR.md for current behavior and remaining limits.

# AINVR S100P VPU display timestamp diagnosis

Validated 2026-10-11 on the current board. Production B-frame rejection remains in place until the mapping is integrated and tested.

The SDK output frame pixels follow display order, while vframe_buf.pts follows the current decode operation. EOS outputs inherit the EOS token. Therefore the token is not a reliable presentation timestamp for reordered video.

Reproduction from /home/sunrise/ainvr:

    test/runtime/model-audit-20261011/venv/bin/python test/ai_port/verify_vpu_timestamps.py

The script builds test/ai_port/vpu_timestamp_probe.cpp and generates bounded H.264 and HEVC fixtures (36 frames each, two B frames, three closed GOPs). It compares the full packed NV12 output to software decoding, and matches FFmpeg parser output_picture_number to the SDK display_poc before looking up source PTS.

Evidence: test/results/vpu-timestamps-20261011-171010-893668/summary.json and per-codec metadata. Both codecs had zero pixel error for every frame and exact source PTS matching within one nanosecond rounding. Direct SDK token matching failed on 36/36 H.264 frames and 27/36 HEVC frames. The initial 1920x1080 H.264 fixture also matched software pixels byte-for-byte (test/results/vpu-timestamp-20261011/pixels.json).

This is diagnostic evidence, not a completed production repair. Required follow-up: bounded per-channel parser and POC mapping, safe cleanup on errors/reconnect, GOP reset handling, open GOPs, variable PTS, dropped/corrupt input, EOS and sequence changes. Do not infer general accuracy from these closed-GOP fixtures. The current SDK header describes display_poc as H265-only, but this installed runtime returns usable H264 POC in the tested cases; preserve a fail-closed check instead of assuming portability to other SDK versions.
