# AI-output arming isolation — 2026-10-24

- Monitor resolves arming from the currently displayed AI output, never from a raw input tile. Source selection follows the actual selected stream.
- Zones retain input geometry identity for compatibility, but new zones persist processor ownership. Trigger selections and counter bindings remain processor-specific.
- Scoped reads filter zones/selections/bindings. Scoped saves merge within the existing version-checked PostgreSQL transaction; foreign processor configuration and execution versions remain unchanged, even when its catalog is offline. Idempotency includes the processor scope.
- Legacy ownership is inferred from existing selections. Legacy shared geometry cannot be changed by one processor alone; create an independent zone instead. Legacy unassigned zones remain stored and are not arbitrarily claimed by an output. No bulk migration, historical deletion or production configuration rewrite was performed.
- Zone subscriptions are cached by input plus processor, keeping identical-input outputs separate. Counter displays only render returned binding IDs.

## Verification
21 backend tests passed, including real isolated PostgreSQL tests for two processors sharing an input, same-name zones, reuse of a counter with separate binding IDs, deletion isolation, historical binding retention, foreign rule stability, stale versions and idempotent retries.
20 frontend tests passed (monitor, arming launcher, saved overlays). TypeScript checks and production builds passed. Browser verification showed raw rear input with no arming/zone/count overlay and AI output with its existing zone/count and functional arming dialog. No production configuration was saved during UI verification.

## Release
Backend rollback: deploy/s100p/rollback-coverage-20261024-194539/backend
Original frontend rollback: deploy/s100p/rollback-rectangle-20261024-194540/frontend
Final frontend entry: index-B7nhQSyt.js (19:48 CST)
Only backend restarted; AI, recorder, ingest, alarm and LLM PIDs were preserved. Runtime configuration hashes unchanged. Test logs are board-local ignored files under test/results/output-arming/. Temporary PostgreSQL container stopped after verification.
No commit or push.


## Pre-commit ownership correction (2026-10-24)
Legacy zones now retain their known processor ownership before counter deletion,
trigger archival or scoped unbinding removes the last reference. Shared legacy
zones retain all original owners in legacy_processor_ids and remain protected
against unilateral geometry edits. Ownership metadata does not bump geometry
versions; UI payloads without ownership metadata can still save unchanged shared
geometry. No bulk migration or production configuration reset is performed.

Verification: 41 backend tests passed (including 15 real isolated PostgreSQL
arming tests; the final ownership refinement reran all 15), 185 frontend tests,
18 SRS observer tests and 4 detection-only unit tests passed. Two detection-only
integration tests requiring MongoDB/native probe were skipped in this run.
Backend compilation, frontend typecheck/build and git diff --check passed.
This correction is source/build verified, not deployed; previous release details
above refer to the earlier deployment. No commit or push performed.
