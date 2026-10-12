import asyncio
from unittest.mock import patch
import pytest
from fastapi import HTTPException
from starlette.requests import Request
from recorder import auth


def request(headers=(), query=b'', client=None):
    scope = {'type': 'http', 'headers': list(headers), 'query_string': query}
    if client is not None:
        scope['client'] = client
    return Request(scope)


def test_no_local_empty_password_bypass():
    with patch.object(auth, '_authorize', return_value=401):
        with pytest.raises(HTTPException) as error:
            asyncio.run(auth.require_media_token(request()))
        assert error.value.status_code == 401


def test_authority_failure_is_unavailable_not_unprotected():
    with patch.object(auth, '_authorize', return_value=503):
        with pytest.raises(HTTPException) as error:
            asyncio.run(auth.require_media_token(request()))
        assert error.value.status_code == 503


def test_provisioned_service_token_is_independent_of_user_password(monkeypatch):
    monkeypatch.setenv('CONFIG_SERVICE_TOKEN_RECORDER', 'test-secret')
    with patch.object(auth, '_authorize', side_effect=AssertionError('must not ask user auth')):
        asyncio.run(auth.require_console_token(request([(b'x-service-token', b'test-secret')])))


def test_playback_cookie_forwarded_but_cannot_authenticate_control():
    with patch.object(auth, '_authorize', return_value=204) as check:
        asyncio.run(auth.require_media_token(request([(b'cookie', b'ainvr-media=example')])))
        check.assert_called_with(None, 'ainvr-media=example')
        asyncio.run(auth.require_console_token(request([(b'cookie', b'ainvr-media=example')])))
        check.assert_called_with(None, None)

def test_url_token_is_never_forwarded():
    with patch.object(auth, '_authorize', return_value=401) as check:
        with pytest.raises(HTTPException):
            asyncio.run(auth.require_media_token(request(query=b'token=old-password-hash')))
        check.assert_called_with(None, None)


def test_loopback_health_probe_needs_no_user_session():
    # The host observer polls health every 10 s without a browser session.
    with patch.object(auth, '_authorize', side_effect=AssertionError('loopback probe must not ask user auth')):
        for host in ('127.0.0.1', '::1', '::ffff:127.0.0.1'):
            asyncio.run(auth.require_console_or_local_probe(request(client=(host, 50000))))


def test_container_peer_cannot_forge_loopback_for_health():
    forged = [(b'x-forwarded-for', b'127.0.0.1'), (b'x-real-ip', b'127.0.0.1')]
    with patch.object(auth, '_authorize', return_value=401):
        for peer in (('172.19.0.3', 50000), None):
            with pytest.raises(HTTPException) as error:
                asyncio.run(auth.require_console_or_local_probe(request(forged, client=peer)))
            assert error.value.status_code == 401


def test_only_health_route_has_local_probe_exemption(store, tmp_data):
    from conftest import guard_with_phase
    from recorder.app import create_app
    app = create_app(store, tmp_data, guard_factory=guard_with_phase('valid'))
    exempt = sorted(route.path for route in app.routes
                    if any(d.call is auth.require_console_or_local_probe
                           for d in getattr(getattr(route, 'dependant', None), 'dependencies', [])))
    assert exempt == ['/v1/recorder/health']
