# Stream recovery release — 2026-10-23

## Changes
- AI capture recovery now requires at least three decoded frames spanning one second, within the channel watchdog gap tolerance (minimum 500 ms), before the publisher sees the source as recovered. Opening a stream alone does not clear recovery. Publisher reconnect semantics remain unchanged.
- Reconnect elapsed times use a monotonic clock.
- H.264 recording scans bounded Annex-B NAL headers across TS packets. A fresh reader requires an IDR carrying SPS/PPS. Subsequent open-GOP cut points retain the existing segmentation contract and also require headers. Missing headers do not start an invalid new MP4. H.265 behavior remains covered by regression tests.
- Recorder errors no longer incorrectly attribute all muxer exits to storage.
- SRS diagnostics enumerate parent process relationships with bounded ps output; this kernel lacks the proc children interface. Actual SRS workers are now sampled.

## Validation
- Reconnect unit tests: 10 passed, including sustained recovery and repeated interruption.
- Recorder complete suite: 315 passed, one dependency deprecation warning.
- Targeted recorder + SRS observer tests: 52 passed.
- Native S100P build completed. The requested publisher_test target is unavailable in this build configuration; it is not counted as passing.
- Real original 8k and processed 8kai streams: 151/152 observed frames respectively, one complete safe starting keyframe each, no unknown AUs. Read-only sample before deployment. A prior eight-second probe expected two keyframes and failed that expectation; it observed one valid keyframe, so the final readiness check requires one rather than assuming a GOP interval.

## Deployment and rollback
- Final AI binary SHA256: aeb1d2a5d01815ed189a3e980472171a29ff8bf90fae67611fc237cb67bcf39a.
- Original AI backup: /mnt/ainvr-ssd/migration-backups/ai-install-20261023-210900-3605966/ainvr_ai_service.
- Intermediate AI backup: /mnt/ainvr-ssd/migration-backups/ai-install-20261023-211032-3608830 (contains the first recovery build, not the original baseline).
- Recorder original source and observer backup: /home/sunrise/ainvr/deploy/s100p/rollback-stream-recovery-20261023-211059/.
- AI installer verified BPU-only capabilities and health. Recorder health returned ok=true and storageHealthy=true. Channel configuration was preserved. SRS and databases were not restarted. AI and recorder were restarted for deployment.
- Rollback: atomically replace deploy/s100p/bin/ainvr_ai_service with the ORIGINAL backup binary and restart ainvr-ai. Restore the two recorder source files under recording-service/src/recorder from the recorder backup and restart ainvr-recorder. Restore its srs-observer.py to /opt/ainvr/srs-observer.py and restart ainvr-srs-observer. Do not restore unrelated configuration or data.

## Outstanding acceptance boundary
Original publisher 192.168.100.182 timed out at 21:08:50 CST, before the first AI deployment, and remained absent during post-deployment checks. ICMP probes also received no replies (not sufficient alone to prove a network outage). Live post-deployment recording/recovery acceptance remains pending restoration of the source. No claim that upstream camera/network faults or all stream instability are resolved. No commits or pushes performed.


## Post-deployment source restoration
User restored original publishing at approximately 21:18. Original recording resumed automatically; AI recovered on its existing retry backoff, with no additional manual restart. During 21:19:05–21:19:45 the original publisher j8nh3306 and processed publisher 94424i9l stayed unchanged and received byte counters increased at every ten-second sample. Both original and processed MP4 files were created and grew; ffprobe read H.264 1920x1080 headers successfully, including AAC in the original recording. Original recording also completed a segment rollover. No AI/recorder ERROR logs occurred in the checked interval since 21:18:50. This is short functional recovery validation, not a long stability or external-network fix claim.
Final AI deployment rollback snapshot is /mnt/ainvr-ssd/migration-backups/ai-install-20261023-211411-3615723, containing the preceding recovery build. Use the ORIGINAL backup above to return to the pre-task baseline.
