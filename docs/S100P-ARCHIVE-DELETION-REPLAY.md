# AINVR deletion-aware prepared replay

ArchiveMongo::ApplyDeletionRules validates every rule before issuing any deletes, limits each filter to records from older archive epochs (including legacy records with no epoch), and uses acknowledged journaled deletion. ReplayPreparedArchiveWithDeletions flushes the durable intent journal, applies database deletion, then processes pending records. Matching old records are retired as durably cancelled; others are upserted and retired as committed. The result reports these outcomes separately.

One channel owner must serialize intent mutation, capture acceptance and replay. The helper does not introduce a cross-channel global lock or background service. Direct Put or the older no-policy replay helper must not be used to bypass deletion policy in production. The caller must bind journal, spool and Mongo collection to the same channel.

Verification script: python3 test/ai_port/verify_archive_deletion.py. Four separate processes stage old records, persist ID/range rules, recover and replay, persist clear-history intent and then recover again with an old retry plus a new-generation record whose timestamp moves backward. Old records remain deleted; the new generation survives. A legacy record without archive_epoch is treated as generation zero. A request containing an invalid later rule is rejected before any earlier valid rule deletes data.

Evidence: test/results/archive-deletion-20261011_182727_148078/summary.json. Mongo/pending counts progress 4/4, 2/0, 2/3, 1/0. Test collection test_delete_20261011_182727_148078 retains the one new-generation metadata fixture; production collections were untouched. The prior actual-JPEG commit-before-local-removal crash test also passes: test/results/archive-replay-20261011_182659_115080/summary.json.

Still pending: channel worker integration, cross-stage accepted-record accounting, pre-encoding durable recovery, retention/max-count handling and fault injection during deletion acknowledgement. These tests establish the single-owner prepared-record policy across process restarts, not a complete deployed AI channel service.
