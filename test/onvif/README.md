# ONVIF simulator and bounded acceptance

These tools are test peers, not production components. Run serially on the
S100P test board from the repository root. Reports/media/private credentials
belong under ignored `test/results/`; never commit camera.json, keys or media.
There are no physical cameras available for this acceptance.

## Dependencies

- Production candidate: `deploy-package/build-onvif.sh`,
  `deploy-package/build-media-bridge.sh`. Runtime video is copy-only.
- Independent RTSP peer: MediaMTX v1.21.3 Linux ARM64 at
  `https://github.com/bluenviron/mediamtx/releases/download/v1.21.3/mediamtx_v1.21.3_linux_arm64.tar.gz`.
  Archive SHA256 `27f038237cb5f77a724f6afc58eca2798f2bc4edf9989895631a80eeb41a4fe2`.
  Verify before extracting to `out/onvif-test-media`; preserve MIT license.
- Board `/usr/bin/ffmpeg` is an independent test publisher/audio converter,
  `/opt/ainvr/ffmpeg-8.1.2/bin/ffprobe` an independent file oracle. Software
  video encoding/decoding must not be used for the production media path.
- Fixture generation uses the board VPU sample SDK `/app/multimedia_samples`;
  audio-only timing correlation uses system Python3/NumPy. Disposable capacity
  SRS uses existing Docker image `ossrs/srs:7.0.162`, never production container.

## Independent virtual camera

`virtual_camera.py --config <private-json>` uses only Python standard library,
not the Go client or its XML builders. Supply an independently published RTSP
source (MediaMTX or an existing test source), plus a private file mode0600:

```json
{
  "listen_host":"192.0.2.10", "listen_port":18890,
  "base_url":"http://192.0.2.10:18890",
  "username":"test-operator", "password":"REPLACE_WITH_TEST_SECRET",
  "authentication":"digest", "clock_offset_seconds":120,
  "profiles":[{"token":"main","name":"Main","video_source":"source-a",
    "video_codec":"H264","audio_codec":"AAC",
    "rtsp_uri":"rtsp://192.0.2.10:18554/camera"}]
}
```

Replace example IP with the host's real routable interface address. Optional
`discovery_interface_address` enables WS-Discovery on that interface.
`authentication` can be `wsse`, `digest`, or `none`; `media_services` can restrict
the default `["media1","media2"]`. Configuration is reread for request tests.
Keep passwords out of argv, URLs pasted into terminal, and ordinary logs.
This Python script can run on another PC with Python3 and an RTSP server; the
hardware fixture generator and namespace/capacity runners are board/Linux-only.

## Reproducible checks

Use a new result directory per run. Never overwrite failed reports. Example
board address189/interface must be replaced when running on another board.
Set `INGEST_FFMPEG=$PWD/out/media-bridge/runtime/bin/ffmpeg` and
`INGEST_FFPROBE=$PWD/out/media-bridge/runtime/bin/ffprobe` for ingest runners.

```sh
python3 test/onvif/prepare_vpu_fixtures.py --result test/results/onvif/fixtures
python3 test/onvif/run_media_matrix.py --fixtures test/results/onvif/fixtures --host 192.168.100.189 --interface eth0 --result test/results/onvif/matrix
python3 test/onvif/robustness_acceptance.py --sample test/results/onvif/fixtures/h264.mp4 --audio alaw --result test/results/onvif/fault-h264
python3 test/onvif/robustness_acceptance.py --sample test/results/onvif/fixtures/hevc.mp4 --audio g726 --result test/results/onvif/fault-hevc
python3 test/onvif/capacity_acceptance.py --sample test/results/onvif/fixtures/h264.mp4 --channels 4,16,32 --hold-seconds 30 --result test/results/onvif/capacity
python3 test/onvif/capacity_acceptance.py --sample test/results/onvif/fixtures/h264.mp4 --channels 4 --hold-seconds 600 --result test/results/onvif/soak
python3 test/onvif/capacity_acceptance.py --sample test/results/onvif/fixtures/h264.mp4 --channels 4 --hold-seconds 30 --restart-srs --result test/results/onvif/srs-recovery
```

`fault_link.py` requires root/TUN/network-namespace support. It creates a private
198.18.0.0/30 link, with bounded queues and actual packet loss/jitter; it does not
change physical NIC qdisc/firewall. Check finally cleanup and absence of owned
namespace/container after interruption. Capacity ports21935/21985 and19454 must
be unused; the runner refuses an existing owned container. Capacity currently
uses board address192.168.100.189 in its controlled fixture: adapt that literal
before using a differently addressed board, do not claim portability unchanged.

`media_acceptance.py` additionally exposes `--recorder`, `--budget-check`,
`--audio opus`, and `--aac-rate 44100|48000 --aac-channels 2`.
`av_content.py` matches compressed video identity and AAC packets; converted
audio uses content correlation. Add an intentional500ms audio offset as a
positive control. B-frame fixtures require comparing direct-source timing
against bridged timing; a source already out of sync cannot be marked passing
just because the bridge did not add drift.

`production_fixture.py` is a bounded20-minute opt-in peer for manual browser
acceptance. It does not itself create/delete production channel records. Record
owned UUIDs and prior settings, clean only those objects, restore the global
switch/layout and verify original inputs. Never restart production SRS to test
failure recovery; `--restart-srs` targets only the disposable test container.

Latest results and interpretation are recorded in
`docs/ONVIF-IMPLEMENTATION-20261026.md`; large raw reports remain ignored.
