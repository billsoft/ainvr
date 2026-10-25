import socket
import struct
import tempfile
from pathlib import Path
import unittest
from virtual_camera import shift_ps, shift_pts, load_records, Camera

class CameraTest(unittest.TestCase):
    def test_pes_shift_and_wrap(self):
        # MPEG2 video PES with PTS=0, valid marker bits; no media decode.
        packet=bytes.fromhex('000001e0000a80800521000100010000')
        for delta in (90000,(1<<33)-100,1<<33):
            self.assertEqual(shift_ps(shift_ps(packet,delta),-delta),packet)
        self.assertNotEqual(shift_ps(packet,90000),packet)
    def test_rejects_truncation(self):
        for value in (b'bad',bytes.fromhex('000001e000ff')):
            with self.assertRaises(ValueError): shift_ps(value,90000)
    def test_records_bounded(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'sample'
            path.write_bytes(struct.pack('!II',0,1048577))
            with self.assertRaises(ValueError): load_records(path)
            path.write_bytes(b'123')
            with self.assertRaises(ValueError): load_records(path)
    def test_configured_network_is_used(self):
        camera=Camera(15060,[],server_host='192.168.100.189',local_ip='127.0.0.1')
        try:
            self.assertEqual(camera.destination,('192.168.100.189',15060))
            self.assertEqual(camera.media_host,'192.168.100.189')
        finally: camera.sock.close()

if __name__=='__main__': unittest.main()
