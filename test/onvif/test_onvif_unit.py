"""The ONVIF control service unit must leave room for LAN discovery.

Go resolves a network interface by name through a netlink route socket. With
RestrictAddressFamilies lacking AF_NETLINK, net.InterfaceByName fails
("netlinkrib: address family not supported by protocol") and every discovery
request returns invalid_interface, although the same binary works unconfined."""
from pathlib import Path
import unittest

UNIT = Path(__file__).resolve().parents[2] / 'deploy-package' / 'ainvr-onvif.service'


class OnvifUnitTest(unittest.TestCase):
    def test_discovery_can_resolve_interfaces(self):
        families = next(line for line in UNIT.read_text().splitlines()
                        if line.startswith('RestrictAddressFamilies=')).split('=', 1)[1].split()
        self.assertIn('AF_NETLINK', families)
        self.assertTrue({'AF_INET', 'AF_INET6', 'AF_UNIX'} <= set(families))


if __name__ == '__main__':
    unittest.main()
