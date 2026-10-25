# Unified GB28181 channel entry — 2026-10-25

Access Management uses New Channel for RTMP / RTSP / GB28181. GB registration and catalog selection are embedded in the channel wizard; gateway / SIP / media global settings remain in Config Center. Registration is explicitly saved before a device can register and provide a catalog. Selecting catalog inputs then saves bindings. Closing never reverses previously saved registrations.

Existing GB inputs are identified by authenticated binding metadata, not inferred from stream-name prefixes or their internal RTMP protocol. Their original identity and generated publishing addresses are preserved. The editor offers device/transport settings and existing name/playback settings. NVR catalog multi-selection remains supported.

Checks: frontend 23 tests and backend 6 tests passed; frontend/backend builds passed; git diff --check passed. Browser checked removal of the standalone section, protocol choice, embedded registration fields and close without saving. No live devices were registered or changed. Hardware/real-device protocol compatibility was not retested by this UI change.

Deployment: frontend dist, backend dist and ainvr-backend restart only. Original SRS, AI and recording services were not restarted. Rollback artifacts: out/gb-unified-20261025/frontend-before and backend-before. Existing staged changes retained; no commit or push.
