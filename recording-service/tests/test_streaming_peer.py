import asyncio
from types import SimpleNamespace
from recorder.main import InternalPeerMiddleware


def test_cancelled_media_can_finish_without_a_response():
    async def check():
        async def receive(): return {'type': 'http.disconnect'}
        async def send(message): raise AssertionError('no response expected after disconnect')
        async def media(scope, receive, send):
            assert (await receive())['type'] == 'http.disconnect'
        await InternalPeerMiddleware(media, SimpleNamespace(allows=lambda host: host == '127.0.0.1'))(
            {'type': 'http', 'client': ('127.0.0.1', 123)}, receive, send)
    asyncio.run(check())


def test_untrusted_peer_cannot_spoof_forwarded_address():
    async def check():
        sent = []
        async def receive(): return {'type': 'http.request'}
        async def send(message): sent.append(message)
        async def media(*args): raise AssertionError('must reject peer')
        await InternalPeerMiddleware(media, SimpleNamespace(allows=lambda host: host == '127.0.0.1'))(
            {'type': 'http', 'client': ('203.0.113.1', 123), 'headers': [(b'x-forwarded-for',b'127.0.0.1')]}, receive, send)
        assert sent[0]['status'] == 403
    asyncio.run(check())
