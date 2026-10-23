# Rotated counting verification — 2026-10-23

Scope: single finite edge, two gates, and observed whole-zone traversal. Existing configuration and counts were not changed.

## Changes
- Shared traversal intersection marks edge endpoints ambiguous even when an adjacent collinear edge produces no intersection. This prevents two-gate counts along a polygon boundary through its corners.
- Whole-zone binding checks source-pixel enclosing widths along edge normals instead of the axis-aligned bounding box. Rotating a narrow rectangle cannot bypass the stable-interior clearance requirement. This is a necessary check, not a complete concave-path clearance proof.
- Added rotated counting regression cases for 1920x1080 sources, both directions, finite edges, corners, same-edge returns, first observation inside, and missing interior observations. Added binding validation cases for narrow and valid rectangles at eight orientations.

## Semantics
Stable edge IDs retain their identity through rotation. Direction uses actual coordinates. Zone mode requires observed interior; gates mode permits two unambiguous intersections between real observations. No cross-identity merging was introduced.

## Verification and release
- Alarm service suite: 184 passed, 40 skipped (224 total), zero failures. Skipped checks remain unverified.
- Backend geometry/library tests: 7 passed. Backend TypeScript compilation passed.
- Rotation tests include 7 arbitrary angles on a non-square source, plus 5 orientations through the production engine.
- Deployed 2026-10-23 22:37:12 using deploy-package/deploy-rotation-validation.py.
- Alarm release: deploy/s100p/alarm-service/release-rotation-validation-20261023-223712.
- Rollback: deploy/s100p/rollback-rotation-validation-20261023-223712 contains original service unit and backend distribution. Restore both and restart alarm/backend together if rollback is needed.
- Health checks passed; AI, recorder, ingest and LLM PIDs and runtime configuration hashes unchanged. Frontend unchanged in this release.
- No commit or push. Real crowd accuracy and identity-loss limits are not proven by synthetic geometry tests.
