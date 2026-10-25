# Third-party simulator interop — 2026-10-25

## Scope and immutable inputs

Signaling-only test against an unmodified external camera implementation. No media bindings, ZLM, SRS, production configuration or production device changes.

- Upstream: https://github.com/sb-im/sbgb28181
- Commit: `1da9bc62134d4cb1fd4374f733583fb5997c3f0a`
- File: `gb28181_pusher.py`
- SHA256: `ab3469718b873037c05a5db302883cfdf8b4fd143c4b654ea2725c935e37cd8a`
- Gateway SHA256: `2abbe2c5b0c4f8665db8ecbe6cb8291450c724ab2a2e04b76193e396d41d22ed`
- The upstream source is kept under ignored test results; it is not copied into product code, modified, or distributed. No license conclusion has been made.

## Observed results

| Check | UDP | TCP |
|---|---|---|
| Digest registration | Pass | Pass |
| DeviceInfo response received | Pass | Pass |
| Complete catalog discovered | Fail | Fail |
| Media / audio / recording | Not run | Not run |

Both cases remained version-unconfirmed with the 2016 compatibility profile. This upstream run does not validate 2022.

The upstream Catalog responses contain `<DeviceList><Item>` without the `Num` attribute. The gateway checks the declared item count against the received items and rejects this response. Source locations: upstream `_register` and `_handle_message`; gateway `protocol.go` catalog-size validation. The upstream also does not implement a DeviceStatus response in `_handle_message`.

Do not weaken gateway validation merely to make this example pass. A separately documented adapter or a different independent simulator is needed before using this candidate for full-media acceptance. Adapted tests must not be described as unmodified third-party interoperability.

## Reproduction

Download the exact upstream file at the pinned commit into a local test-only directory. The runner verifies the source hash before executing it. It passes random disposable test credentials through a private subprocess pipe, never command-line arguments. Logs stay local and private. There are no active media bindings.

```sh
timeout 65 python3 test/gb28181/third_party_signaling.py \
  --source test/results/gb28181/third-party/sbgb28181-1da9bc6.py \
  --gateway /home/sunrise/ainvr/out/gb28181/gateway-acceptance-20261025-v2 \
  --output test/results/gb28181/third-party/NEW-UNIQUE-RUN
```

Requires free loopback management port 19196 and SIP TCP/UDP port 15160. Maximum observation is 18 seconds per transport. The runner stops only its own gateway and camera subprocesses. A nonzero exit and `passed:false` are expected until catalog compatibility is resolved. Registration alone is not a passing result.

Evidence on this board: `test/results/gb28181/third-party/signaling-20261025-r2/report.json`. Results are ignored by Git; this document records the findings for reviewers. The first run exposed a null-catalog handling defect in the test runner; it was fixed and the complete two-transport run repeated.

## Other acceptance work

The pre-existing two-channel 24-hour test continues. The immutable v2 gateway matrix and long tests remain queued behind its lock. Historical self-simulator LAN/media results are recorded separately in REPORT-LAN-20261025.md and must not be substituted for this candidate's missing third-party media results.