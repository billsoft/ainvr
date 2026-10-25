# GB28181 read-only implementation references

Reviewed 2026-10-25. These checkouts are reference material, not AINVR runtime entry points. Do not modify, build, run, or automatically update them. Read-only is a repository workflow rule, not a filesystem security boundary. Pin upgrades require an explicit review of the upstream diff and license. Existing build dependencies remain managed separately.

| Reference | Pinned commit | Purpose |
| --- | --- | --- |
| [WVP](https://github.com/648540858/wvp-GB28181-pro) | `2b656f4e55147f2377986a878da01a98ae564fe5` | Registration, SIP transactions, SDP, catalog and media-session coordination |
| [ZLMediaKit](https://github.com/ZLMediaKit/ZLMediaKit) | `bb83e697a60ad9dde679afcd7b85feeafdf7514b` | RTP transport, PS demultiplexing and protocol output; matches the current media dependency pin |

WVP is MIT licensed. ZLMediaKit's pinned LICENSE contains MIT text plus a supplemental obligation to retain ZLMediaKit identification in service fields such as title, Server and User-Agent. Read the complete upstream licenses before redistribution or copying code; nested dependencies have their own licenses.

## Code comparison entry points

WVP paths below are under `src/main/java/com/genersoft/iot/vmp/`.

| Phase | Upstream source | AINVR source / comparison |
| --- | --- | --- |
| Registration and authentication | WVP `gb28181/transmit/event/request/impl/RegisterRequestProcessor.java` | `gb28181-service/server.go`, `auth.go`: compare challenge, digest rejection, Expires and unregister. AINVR deliberately requires preconfigured device credentials; do not copy shared-password automatic enrollment. |
| SDP and media roles | WVP `gb28181/transmit/cmd/impl/SIPCommander.java`, `playStreamCmd` | `protocol.go`, `session.go`: inspect recvonly, TCP setup roles and y= SSRC. WVP offers additional direct RTP payloads. AINVR's PS payload contract must not be presented as support for every upstream payload. H.264/H.265 inside PS are distinct from direct RTP codec offers. |
| ACK timing | WVP `gb28181/transmit/event/response/impl/InviteResponseProcessor.java` | `session.go`: WVP sends ACK on successful INVITE response. AINVR uses sipgo dialogs, ACKs successful responses before validation cleanup, and ACK/BYE cleanup for a racing late success. Do not transplant WVP request-URI construction independently of the SIP dialog implementation. |
| Receiver before INVITE; media after SIP | WVP `gb28181/service/impl/PlayServiceImpl.java` | `runtime.go`: allocate receiver first, then INVITE. WVP uses media publication hooks; AINVR waits for media tracks, starts its bridge, then checks SRS publication. SIP 200 alone does not establish streaming health. |
| Failure cleanup | WVP `gb28181/service/impl/PlayServiceImpl.java` | `runtime.go`, `media.go`, `session.go`: receiver, dialog and bridge must all be released; late responses and old generations must not revive an obsolete stream. |
| RTP framing and identity | ZLM `src/Rtp/RtpSession.cpp` | `media.go`: ZLM checks RTP SSRC and handles TCP framing/resynchronization. AINVR owns per-session receiver/stream/SSRC leases. Keep stream isolation even if adding vendor-specific compatibility. |
| PS parsing | ZLM `src/Rtp/GB28181Process.cpp` | `media.go`, `bridge.go`: RTP decoding feeds PS/TS demultiplexing. This is packet/container parsing, not video pixel decoding. AINVR retains video copy, AAC copy and bounded G.711-to-AAC audio conversion. |

## Boundaries and follow-up evidence

- These references complement each other: WVP is the signaling/business implementation; ZLMediaKit is the media component, not a complete SIP registration service. Neither requires importing the whole WVP platform into AINVR.
- Open-source behavior is compatibility evidence, not the normative specification. WVP's stated 2016 support does not prove full 2022 compliance. Formal 2022 text verification and real-device acceptance remain separate gates.
- WVP includes SSRC compatibility handling in its play flow. AINVR's stricter answer validation should only be relaxed with a concrete device sample and isolation regression tests, not by disabling SSRC validation globally.
- Source comparison does not replace wire tests, independent simulator tests, audio/video timing measurements, fault recovery or real camera/NVR testing.
- No camera configuration, production service, runtime dependency version or existing RTSP/RTMP path was changed by adding these references.

## Fetch and verify

From the AINVR repository root:

```sh
git submodule update --init third_party/reference/wvp-GB28181-pro third_party/reference/ZLMediaKit
git submodule status
git -C third_party/reference/wvp-GB28181-pro status --porcelain
git -C third_party/reference/ZLMediaKit status --porcelain
```

Do not use `submodule update --remote` for reproducible review. Nested ZLMediaKit dependencies are not needed for the source comparison above and are not initialized by this command. Verify each gitlink against the pinned commits in this document. No source files inside either reference were edited.
