# AINVR deletion journal validation

Before connecting deletion policy to prepared-archive replay, HistoryDeletions now validates complete filters and journal epochs. Supported filters are clear (empty object), one nonempty image_id string, or one timestamp range with exactly finite numeric inclusive $gte/$lte bounds in ascending order. Unknown/compound filters and invalid ranges are rejected before mutating the epoch or existing rules.

Load validates an unsigned bounded top-level epoch, strictly increasing positive rule epochs, valid filters and a final rule epoch matching the journal epoch. Compacted clear-history journals may legitimately start above epoch one. Loaded state replaces the previous in-memory state only after the entire journal validates; corrupt files remain intact and the load exception must stop replay.

Evidence: test/results/deletion-validation-build.log and deletion-validation-test.log. All seven targeted durable-file/deletion tests pass, including ten invalid-filter cases, five corrupt-journal cases and compacted clear-history reload. Existing durable-file fsync failure and old/new-generation matching tests still pass.

This closes a validation gap where unknown or malformed deletion rules could be ignored or fail late. Mongo deletion and spool replay are not yet connected to this journal. The future single history coordinator must persist/flush intent, apply journaled Mongo deletion and prevent matching older pending records from being upserted. No end-to-end deleted-record resurrection prevention claim is made yet.
