"""Host API peers: loopback plus the deployment's actual container subnets."""
import ipaddress
import json
import threading
import time
from pathlib import Path

POLICY = Path('/etc/ainvr-ai-internal-networks.json')

def allowed_networks(path=POLICY):
    networks = [ipaddress.ip_network('127.0.0.0/8'), ipaddress.ip_network('::1/128')]
    try:
        values = json.loads(Path(path).read_text())
        if not isinstance(values, list) or len(values) > 32:
            return networks
        parsed = []
        for value in values:
            net = ipaddress.ip_network(value, strict=True)
            if net.prefixlen == 0:
                continue
            parsed.append(net)
        networks.extend(parsed)
    except (OSError, ValueError, TypeError):
        pass  # A missing/broken policy never grants an entire private address range.
    return networks

def source_allowed(addr, networks):
    try:
        ip = ipaddress.ip_address(addr)
        if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped:
            ip = ip.ipv4_mapped
        return any(ip in net for net in networks)
    except ValueError:
        return False


class NetworkPolicy:
    """Reload a root-managed policy without restarting recording/inference."""
    def __init__(self, path=POLICY, refresh_seconds=5, clock=time.monotonic):
        self.path = path
        self.refresh_seconds = refresh_seconds
        self.clock = clock
        self._expires = 0
        self._networks = []
        self._lock = threading.Lock()

    def allows(self, addr):
        with self._lock:
            now = self.clock()
            if now >= self._expires:
                self._networks = allowed_networks(self.path)
                self._expires = now + self.refresh_seconds
            return source_allowed(addr, self._networks)
