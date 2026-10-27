# AINVR camera PTZ control contract

## Scope and protocol evidence

Physical-camera pan/tilt, lens zoom, Stop and native presets are implemented by
ONVIF and the independent GB28181 gateway. SRS does not receive control commands.
The source stream and every AI output resolve to the original camera; main/sub
profiles sharing a verified PTZ node share control and view protection. Separate
NVR nodes remain independent. Ambiguous source graphs are refused.

Formal-page review evidence and pinned read-only reference commits are in
PTZ-IMPLEMENTATION-20261027.md. ONVIF operations follow the official PTZ WSDL:
https://www.onvif.org/ver20/ptz/wsdl/ . The 2016/2022 GB annex control bytes and
preset response differences were checked against the saved original pages, not
only OCR or a third-party implementation.

- ONVIF resolves the selected Profile/video source, PTZ configuration and node.
  Only advertised generic velocity/translation spaces are exposed. Continuous
  movement requires a bounded device timeout; relative-only capability uses
  small bounded steps. Stop omits optional unsupported axes per the WSDL.
- GB2016/2022 share the base eight-byte PTZ encoding and checksum. SIP routes to
  the registered device/NVR; XML DeviceID selects its actual camera channel.
  The compatibility layer retains version-specific charset/preset list shape.
  SIP acceptance proves delivery only; it does not prove motor position.
- A directory PTZType is a hint. GB per-camera movement/zoom/preset capabilities
  require explicit confirmation. Unknown capability is not advertised as proven.
- Preset save writes a native camera preset, then stores native ID, display name,
  optional shortcut 1–9 and optional reported position in PostgreSQL. Device save
  followed by metadata failure is a partial result, not an automatic retry.
  Goto is sent once; keepalive never replays Goto. Native lens pose is preserved.
- Camera focus mode is left unchanged. No automatic-focus assumption, imaging
  setting write, synthetic optical倍率 or absolute-angle claim is made.

## Ownership and stopping

Commands have a short lease, sequence and deadline in the protocol service clock.
An expired command cannot replay after reconnect. Per-actuator calls are serialized;
Stop has reserved capacity and cancels pending movement. Browser release, pointer
cancel, blur, hidden/pagehide, close and unmount cancel local intent and request
Stop. A release during preparation never causes delayed movement.

The protocol service watchdog and device timeout complement the browser. If the
camera network is unavailable, show unconfirmed Stop; never claim a physical
motor stopped solely from a console timeout. Recovery reconciles pending Stop
with fresh protocol context. No movement is automatically replayed.

## Arming safety and limitations

Before movement: persist camera guard, await applied paused rules, reset affected
AI analytics, then permit movement. Detection, video and recording remain enabled.
Stopping does not restore old pixel geometry. Restore requires reliable matching
position feedback or actual saved arming documents newer than the movement.
Guards survive BFF/protocol restarts; old queued observations are time-gated after
restoration and old trajectory continuity is reset.

Optional status observation can detect movement by external clients. It is bounded
and polled, so detection is delayed, particularly across many cameras. A camera
without reliable status cannot reveal external movement. Do not promise immediate
external-motion protection or infer restoration from a preset acknowledgement.

## Configuration and verification

System configuration: shared enablement, control concurrency and stop-protection
lease. Channel wizard: original camera credentials and per-camera capability
restrictions, saved together with that channel. Monitor: everyday control,
native preset save/rename/shortcut, overwrite/delete confirmation and view restore.
Physical camera direction, stop distance, lens behavior and preset accuracy are
reserved for later user testing. Simulation and software tests prove the command
and safety paths; they do not constitute device certification or a 24-hour soak.

## Review corrections (2026-10-27)

Opening the panel is read-only. Acquisition prepares protection before control;
if a successful lease is stopped without ever issuing a movement/preset command,
only that lease's newly created pause is restored with a guard-revision CAS.
A pause that predated acquisition is preserved. Failed preparation deliberately
keeps protection; the UI explains the pause and offers a recovery entry.

The actual worker advertises `analytics_reset_supported`. Before writing a guard,
the BFF checks every affected AI processor. A worker without non-disruptive reset
support is refused before pausing any rule; no video/model restart fallback is
introduced. The S100P reused worker implements this capability.

Legacy rules without input_stream_id are linked through the trusted current AI
source graph. A bare optional input field is never the only protection match.
The global read-only protection endpoint does not depend on AI/protocol health;
monitoring, alarms, dashboard and the source arming editor expose persistent
paused status. A recovery link focuses the original camera and its PTZ panel.

A result whose analytics epoch became stale is discarded, not published as an
empty scene. Publishing an empty detection is not equivalent to invalidating an
old track. Reset and result/SEI publication share the frame-publication mutex and
an epoch recheck, preventing append-after-clear. Video capture/publishing is not
stopped by this control reset.

The current restoration time gate compares PostgreSQL restored_at with AI
captured_at. Same-board deployment shares its system clock. Distributed database,
BFF and AI hosts MUST keep their wall clocks synchronized (e.g. NTP). No arbitrary
1–2 second tolerance is added: it could admit observations captured during a
changed view. Do not advertise an unsynchronized distributed deployment as
providing a reliable temporal view fence; a future cross-clock protocol should
use an acknowledged observation generation rather than weaken the fence.

## Timeout and preset feedback refinement

ONVIF fixed durations accept days, hours, minutes and fractional seconds, including
zero minimum. Invalid, overflowing, reversed or unsafe minimum ranges disable
continuous control with an explicit explanation; supported relative control remains.
Calendar years/months are not guessed as fixed seconds. Missing timeout limits do
not permit unbounded device movement solely because a server watchdog exists.

Preset keepalives may release control early after two explicit idle reports at
least 500 ms apart and at least one second after the initial command. Missing,
UNKNOWN, moving or failed status resets that evidence. This means movement stopped,
not that preset accuracy or the original armed view was verified. View protection
remains until the separate recovery procedure. Devices without feedback retain the
30-second upper bound; blur, hidden page and close still stop. No unverified 5–10
second delay is described as arrival.

Address aliases remain a known interoperability limit: register one ONVIF device
record per physical camera/NVR and reuse its profiles. Serial alone is not a safe
universal identifier (empty/repeated factory values exist). A future alias migration
must verify device identity and merge resource locks, source guards, camera settings
and preset metadata together; changing only the hash would leave guards incomplete.

Production publishing uses deploy_ptz_release.py. Build scripts are separate stages,
not alternative publishers. Retired console/ONVIF mutation entrypoints fail before
changing services. Standalone GB installation/rollback uses mounted SSD backups,
shared retention (three per service), and supports a read-only rollback preflight.

Known duplicated ONVIF EPR or manufacturer/serial/hardware identity records are
refused before movement. This conservative conflict check does not merge devices
or transfer presets/guards based on an untrusted serial number. Unknown aliases
remain subject to the one-device-record configuration rule above.

## Release retention correction (2026-10-27)

The coordinated and standalone GB publishers share one deployment lock. New
backup names use UTC. Older joint names bearing Z were actually local time;
retention uses their Unix nanosecond suffix, not the displayed hour. Each service
has one canonical SSD bucket and at most three snapshots. Removing a referenced
component marks the joint transaction incomplete; it cannot be offered as a valid
rollback. Alarm rollback reconstructs its runtime from checksummed SSD source;
old eMMC release directories are not required. Automatically generated runtimes
are removed after a successful switch, retaining the active runtime. Unmarked
legacy directories require an explicit ownership inventory before removal.

Capability restrictions are shown in the PTZ panel. Duplicate ONVIF identity
checks trim both identities and compare absent hardware IDs consistently; this
remains a conservative refusal, not automatic camera merging.
