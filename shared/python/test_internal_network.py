from internal_network import allowed_networks, source_allowed
from internal_network import NetworkPolicy

def test_missing_policy_allows_only_loopback(tmp_path):
    peers=allowed_networks(tmp_path/'missing')
    assert source_allowed('127.0.0.1',peers)
    assert not source_allowed('172.17.0.2',peers)

def test_only_actual_subnet_is_allowed(tmp_path):
    policy=tmp_path/'policy.json';policy.write_text('["172.19.0.0/16"]')
    peers=allowed_networks(policy)
    assert source_allowed('172.19.0.8',peers)
    assert not source_allowed('172.31.0.8',peers)
    assert not source_allowed('192.168.100.183',peers)
    policy.write_text('["0.0.0.0/0"]')
    assert not source_allowed('8.8.8.8',allowed_networks(policy))


def test_policy_reload_revokes_old_network_and_fails_closed(tmp_path):
    path = tmp_path / 'policy.json'
    path.write_text('["172.19.0.0/16"]')
    now = [10]
    policy = NetworkPolicy(path, clock=lambda: now[0])
    assert policy.allows('172.19.0.2')
    path.write_text('["172.20.0.0/16", "192.168.100.182/32", "fd00::/64"]')
    now[0] += 6
    assert not policy.allows('172.19.0.2')
    assert policy.allows('172.20.0.2')
    assert policy.allows('192.168.100.182')
    assert not policy.allows('192.168.100.181')
    assert policy.allows('fd00::2')
    path.write_text('invalid')
    now[0] += 6
    assert not policy.allows('172.20.0.2')
    assert policy.allows('127.0.0.1')
    path.write_text('["172.20.0.0/16", "invalid"]')
    now[0] += 6
    assert not policy.allows('172.20.0.2')
