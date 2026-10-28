# AINVR HTTP dependency pin

Unmodified official cpp-httplib header and MIT license, used header-only by the
new search-service. This is the same HTTP framework already used in AINVR, not
a second protocol parser. Do not edit vendor source.

- Version: **v0.63.0**
- Commit: `5bcfea7b90575c80a3e54a6967b11b39afa60d5c`
- Source: https://github.com/yhirose/cpp-httplib/tree/5bcfea7b90575c80a3e54a6967b11b39afa60d5c
- `httplib.h` SHA256: `9021001a719768893a8a6e4051c56107690e8b8e49b41e5f903534fa19ae9afb`
- `LICENSE` SHA256: `4b45cbe16d7b71b89ae6127e26e0d90a029198ca5e958ad8e3d0b8bbed364d8b`

The board's unmodified system package is 0.10.3+ds-1. The native BFF test proved
that identical valid multipart bytes succeed in one write and fail when a TCP
split falls inside the boundary prefix. Upstream fixed this in commit
`106be19c3ef35aff0d464135ef9ed29a8b79f589` (first release v0.11.1).

AINVR pins the current upstream stable release instead of forking that parser.
The search target must **not** link the old system `libcpp-httplib.so`; existing
LLM/media services and system packages are not changed. CMake verifies the
header checksum. TLS/compression features are not enabled for this loopback-only
transport. Authentication, size limits, deadlines and scoped endpoints remain
required. A newer library alone is not a complete security assessment.

The upstream fixed-size bounded `ThreadPool(4, 0, 4)` replaces the prototype
`BoundedHttpQueue`. `test/search/run-native-bff.sh` retains a full-write control
and forced boundary-split requests as a real transport regression test.
