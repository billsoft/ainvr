# AINVR S100P media runtime

Run all commands in `/home/sunrise/ainvr` on the S100P. TecheAI is a read-only
reference. The media source, original controller, publisher and channel worker
remain the production implementation; this change pins their FFmpeg dependency.

## Runtime contract

The AI service links the installed static libraries in
`/opt/ainvr/ffmpeg-8.1.2/lib`, using the headers from that same prefix:

| Library | Required runtime version |
| --- | --- |
| FFmpeg | 8.1.2 |
| libavformat | 62.12.102 |
| libavcodec | 62.28.102 |
| libavutil | 60.26.102 |

`ai-service/cmake/ffmpeg_runtime.cmake` rejects missing headers, a different
release or ABI, and libraries resolved outside the selected prefix. The three
static libraries do not export their symbols to plugins: GStreamer plugins
retain their own system FFmpeg ABI.

An absence of `libav*.so` in `ldd` is not enough evidence of the runtime version.
The candidate's `--runtime-info` and the service's `/health` call the linked
FFmpeg version functions. The installer checks all three actual ABI versions.

The license client still verifies the Unix peer account and service identity.
`build-ai-s100p.sh` selects the S100P deployment account `sunrise`; the media
validation runner reads the active license service's `User` and passes it to
CMake. A separate fresh build must not silently use the generic default account.

## Reproduce validation

```sh
cd /home/sunrise/ainvr
python3 test/ai_port/test_runtime_deployment.py
python3 -u test/ai_port/run_ffmpeg8_validation.py
```

The second command requires the SSD mount, active licensed service and real
`live/xm` source. It builds `out/build/ai-ffmpeg8`, runs hardware serially under
the AI service account, and writes individual and aggregate reports under
`test/results/ffmpeg8-<timestamp>`.

| Stage | Evidence required |
| --- | --- |
| Linked runtime | Version functions, mapped libraries, packet ownership and timestamps |
| Source | Real H.264/H.265 B-frame ordering, 4K VPU frames, JPU, lifecycle and bounds |
| SEI | Original publisher, separate temporary SRS output, original compressed VCL hashes, matched display PTS, output VPU decode, production browser parser |
| Worker | Original worker lifecycle and hardware adapters; report distinguishes test inference doubles and official sample BPU execution |
| Controller | Isolated actual service, authorization, output saving, loop rejection, missing-model rejection and preserved manual stop |

The SEI probe uses the original adaptive cache policy. A bounded three-second
startup is reported separately, including any metadata misses. After warmup,
every attempted stamp is strict. SRS cached GOP frames from startup cannot count
toward the required twelve steady-state SEI/VCL matches. At least three output
frames must decode through VPU. Test metadata contains empty detections and is
sent only to the temporary stream, never presented as user model inference.

The isolated controller filters production configuration-center and systemd
notification variables from both its environment and private configuration. It
must not acknowledge production PG configuration or write the user's overlay.

## Deploy a validated candidate

Only deploy the candidate whose hash is recorded by a fully passing report:

```sh
cd /home/sunrise/ainvr
python3 deploy-package/install-ai-s100p.py \
  --binary /home/sunrise/ainvr/out/build/ai-ffmpeg8/ainvr_s100p_control_service \
  --start
```

The installer validates AArch64 format, dependencies and actual FFmpeg runtime,
backs up the installed binary and unit on the SSD, preserves the managed unit
symlink, and atomically replaces the candidate. Failed startup restores the
previous binary and unit. If business readiness was true before deployment, it
must be true afterward before the installer reports success.

After deployment, verify the running process's binary hash, `/health`, PG
configuration acknowledgments, stable watchdog heartbeat, input publishing and
unchanged user channel/model/storage configuration. Output-configuration saving
must preserve an operator-stopped channel.

## Separate product acceptance gates

These checks do not prove user-model conversion, accuracy or BPU throughput.
Official sample BPU execution is not user-model acceptance. A Node test of the
production SEI parser is not actual browser playback/overlay acceptance.
Both gates, and the remaining full migration requirements, remain explicit.

## Verified deployment on 2026-10-12

Installed version: `ainvr-s100p-reused-control-0.5`.
Candidate and running executable SHA-256:
`d6eed683f05ffdf1a4bc62b57a6128afb487ba183a25d31cc78bb4161e9ffb30`.

- Media aggregate: `test/results/ffmpeg8-20261012-035200/summary.json`.
  Runtime 3 tests, source 34 tests, worker 32 tests, isolated controller passed.
- Runtime configuration/control: `test/results/runtime-control-20261012-035323/summary.json`.
  20 unit tests, 7 actual service callback phases and 53 watchdog notifications.
- Preparation/installer: `test/results/ffmpeg8-deployment-validation.log`.
  15 tests passed, including business-readiness regression rejection.
- Production: `test/results/ffmpeg8-production-verification.json`.
  Running hash matches, actual linked ABI matches, business ready, original output
  save returns 200, input publishing, unchanged configuration and PG state,
  AI version 3 applied without restart requirement, stable PID and advancing watchdog.
- Rollback: `/mnt/ainvr-ssd/migration-backups/ai-install-20261012-035508`.

The SEI run stamped 76 steady-state frames. Twelve received steady-state frames
matched the original VCL; 82 output frames decoded through VPU. Six misses were
recorded during the separate three-second startup. The adaptive cache finished
at 0.5917 seconds. These figures describe this bounded run, not a general latency
or model throughput guarantee.

An additional recorder check found ten-second DTS gaps in completed production
segments, despite zero reported intentional drops. A separate 12-second incoming
RTMP sample had 359 video packets, approximately 30 FPS and continuous 33/34 ms
DTS steps. These different observation windows do not prove where loss occurred.
Recordings continue on SSD, but packet continuity and 4K30 recording acceptance
remain unresolved. `test/non_ai/verify_recording_packet_timing.py` isolates the
original reader/writer commands without modifying user channels or configuration.
