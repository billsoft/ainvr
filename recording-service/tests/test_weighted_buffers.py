from types import SimpleNamespace

from recorder.supervisor import Supervisor, GLOBAL_BUFFER_BYTES, CHANNEL_BUFFER_MAX


def test_mixed_bitrates_get_weighted_bounded_buffers():
    s = Supervisor.__new__(Supervisor)
    s.retiring = {}
    s.orphans = {}
    s.channels = SimpleNamespace(channels=[
        {'id': str(i), 'recvKbps': bitrate}
        for i, bitrate in enumerate([100000, 100000, 20000, 20000])
    ])
    s._wanted = lambda cfg, cid: True
    caps = [s._buffer_caps(None, str(i))[1] for i in range(4)]
    assert caps[0] > caps[2]
    assert caps[0] == caps[1] == CHANNEL_BUFFER_MAX
    assert sum(caps) <= GLOBAL_BUFFER_BYTES


def test_unknown_rates_and_many_channels_never_overallocate():
    s = Supervisor.__new__(Supervisor)
    s.retiring = {}
    s.orphans = {}
    s._wanted = lambda cfg, cid: True
    for count in (1, 4, 50):
        s.channels = SimpleNamespace(channels=[{'id': str(i)} for i in range(count)])
        caps = [s._buffer_caps(None, str(i))[1] for i in range(count)]
        assert sum(caps) <= GLOBAL_BUFFER_BYTES
        assert all(0 < cap <= CHANNEL_BUFFER_MAX for cap in caps)
