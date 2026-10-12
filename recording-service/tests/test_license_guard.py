from recorder.license_guard import LicenseGuard


class Client:
    def __init__(self, phase):
        self.value = phase
    def phase(self):
        return self.value


def test_only_valid_lease_allows_recording():
    for phase in ("starting", "invalid", "dormant", "configuration_error"):
        assert not LicenseGuard(Client(phase)).licensed()[0]
    assert LicenseGuard(Client("valid")).licensed()[0]


def test_explicit_development_profile_is_unwired():
    assert LicenseGuard(None).licensed()[0]


def test_guard_does_not_own_docker_or_database_lifecycle():
    guard = LicenseGuard(Client("dormant"))
    assert not hasattr(guard, "_docker_stop")
    assert not hasattr(guard, "_interlock_fired")
