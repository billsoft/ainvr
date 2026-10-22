import observability as ob


def test_llm_ready_requires_running_unit_and_loaded_model(monkeypatch):
    monkeypatch.setenv('AINVR_DEPLOYMENT_MODE', 'native')
    assert ob.deployment_units()['llm-service'] == 'ainvr-llm.service'
    assert 'llm-service' in ob.SOURCES
    assert ob.llm_service_health('active', {'ready': True, 'model': 'ready'})[0]
    assert not ob.llm_service_health('failed', {'ready': True, 'model': 'ready'})[0]
    assert not ob.llm_service_health('active', {'ready': True, 'model': 'loading'})[0]
    assert not ob.llm_service_health('active', {'ready': False, 'model': 'ready'})[0]


def test_llm_unavailable_does_not_expose_internal_error():
    ready, detail = ob.llm_service_health('active', {'model': 'fault', 'last_error': 'private/path'})
    assert not ready
    assert 'private/path' not in detail
