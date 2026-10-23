# Rectangle editor rotation — 2026-10-23

Rectangle geometry uses source pixels, including non-square source frames. Four-corner order and edge IDs are retained. Corner dragging scales proportionally around the opposite corner. Side dragging adjusts only its perpendicular dimension. Rotation uses the rectangle centre; out-of-frame transforms are rejected rather than clipping individual vertices. Existing non-rectangular polygons remain polygons; ERP wrap geometry is unchanged.

Both unified arming and the existing shape editor share RectangleRotation and rectangleGeometry. Rotation handle has a 44px target, a connecting line, pointer cancellation, keyboard 1-degree adjustment and Shift 15-degree adjustment. Changes remain draft operations with undo and one final arming save.

Single-line counting arrows already use source-pixel normals; no second counting algorithm was introduced. Tests verify rotated normals, preserved edge IDs, aspect ratio, boundaries, undo/cancel, and production engine line/gates/region traversals in both directions. Geometry/editor tests 22 passed; four other arming/flow test files passed (39 tests). Engine rotated regression and imported continuity tests: 7 passed. TypeScript and frontend production build passed.

Frontend deployed at 22:25:37, assets index-sP_QROaV.js. Immediate backup: deploy/s100p/rollback-rectangle-20261023-222537/frontend. Pre-feature backup: deploy/s100p/rollback-rectangle-20261023-222136/frontend. Script: deploy-package/deploy-rectangle-rotation.py. No microservice process restarted. Existing zone/counter configuration not saved or changed by deployment. No commit/push.

Browser draft acceptance: rotated existing rear rectangle by 15 degrees, retained the associated counter and perpendicular arrow, then undid and cancelled without saving site geometry. Handle moved to the side to avoid the zone title marker.
