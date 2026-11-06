import observability as ob


def test_budget_snapshot_is_bounded_and_not_actual_memory():
    raw={"memory":{"scope":"recording_gop_buffer","budget_bytes":256,"reserved_bytes":128,
                   "retiring_bytes":32,"channels":[{"secret":"not exported"}]}}
    assert ob.memory_budget_view(raw)=={"scope":"recording_gop_buffer","budget_bytes":256,
                                        "reserved_bytes":128,"retiring_bytes":32}
    assert ob.memory_budget_view({"memory":{"scope":"other","budget_bytes":256,"reserved_bytes":1}}) is None
    assert ob.memory_budget_view({"memory":{"scope":"recording_gop_buffer","budget_bytes":True,"reserved_bytes":1}}) is None
    assert ob.memory_budget_view({}) is None
