# ONVIF dependencies and references

Production: Go standard library (Go BSD license) and github.com/icholy/digest
v1.2.0 (MIT, pinned in go.mod/go.sum). The release includes both license texts.
SIP, WVP and the reference camera server are not ONVIF runtime dependencies.

Media: FFmpeg 8.1.2, official archive SHA-256
`464beb5e7bf0c311e68b45ae2f04e9cc2af88851abb4082231742a74d97b524c`.
`deploy-package/build-media-bridge.sh` records its configure options. This
LGPL build enables no video decoder or encoder. Only audio conversion uses
software. The small RTSP-redirect rejection patch, LGPL text, build information
and relative executable checksums accompany the runtime. Keep the original
FFmpeg source/archive and this repository's build script/patch available with
binary distribution; do not describe this as an unmodified FFmpeg binary.

Read-only protocol reference:
`third_party/reference/onvif_simple_server`, upstream
https://github.com/roleoroleo/onvif_simple_server,
commit `d0ca1a78fefeb47aeb0207b68ac0f56adf92bc13`, GPL-3.0.
It is not linked, executed or copied into product releases. Comparison covers
WS-Security digest construction, Device/Media1/Media2 response shapes,
GetStreamUri transport semantics and WS-Discovery correlation. Official ONVIF
normative text/WSDL takes precedence over reference behavior.

Test media server: MediaMTX v1.21.3, MIT. Linux ARM64 archive SHA-256
`27f038237cb5f77a724f6afc58eca2798f2bc4edf9989895631a80eeb41a4fe2`.
It is a disposable independent test peer, never a production media layer.

Official unmodified protocol snapshots and hashes are in
`protocol/manifest.json`, pinned to onvif/specs commit
`e5790320408db7acb19a8f826411f1a94083bf96`. Original ONVIF copyright and terms
are preserved. Transitive WSDL imports are not a complete frozen schema tree;
none is fetched dynamically at runtime. This ingestion subset does not claim
full Profile S/T client conformance or a certification result.
