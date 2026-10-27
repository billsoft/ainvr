import socket
import io
import struct
import tempfile
from pathlib import Path
import unittest
from unittest.mock import patch
from virtual_camera import shift_ps, shift_pts, load_records, Camera
from soak import ContinuousDevice

class CameraTest(unittest.TestCase):
    def test_continuous_source_uses_requested_peer_and_stops_on_bye(self):
        camera=ContinuousDevice(0,'2.0','tcp','h264','aac',io.BytesIO(),server_host='192.0.2.2',local_ip='127.0.0.1',port=5060,source_dir=Path('/tmp/fixture-source'))
        camera.media=(32000,1234)
        commands=[]
        class Process:
            def __init__(self,data):self.stdout=io.BytesIO(data)
            def terminate(self):pass
            def wait(self,timeout=None):return 0
        def launch(command,**kwargs):
            commands.append(command)
            return Process(b'TS' if len(commands)==1 else struct.pack('!II',90000,1)+b'P')
        class Wire:
            def settimeout(self,_):pass
            def __enter__(self):return self
            def __exit__(self,*_):pass
            def sendall(self,_):camera.media_stop.set()
        try:
            with patch('soak.subprocess.Popen',side_effect=launch),patch('soak.socket.create_connection',return_value=Wire()) as connect:
                camera.send_media()
            connect.assert_called_once_with(('192.0.2.2',32000),timeout=3)
            self.assertIn('/tmp/fixture-source/h264-aac.ts',commands[0])
            self.assertIsNone(camera.media_error)
            self.assertFalse(camera.stop.is_set())
        finally:camera.sock.close()
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
    def test_wire_clock_wrap_does_not_change_pacing_or_ps_payload(self):
        original=bytes.fromhex('000001e0000a80800521000100010000')
        for bits in (32,33):
            with self.subTest(bits=bits):
                camera=Camera(15060,[(i*9000,original) for i in (0,1,0,1,2)],timestamp_offset_ticks=(1<<bits)-9000)
                camera.media=(32000,1234)
                packets=[]
                class Wire:
                    def settimeout(self,_):pass
                    def __enter__(self):return self
                    def __exit__(self,*_):pass
                    def sendto(self,packet,_):
                        packets.append(packet)
                        if len(packets)==5:camera.stop.set()
                waits=[]
                def wait(seconds):waits.append(seconds);return False
                try:
                    with patch('virtual_camera.socket.socket',return_value=Wire()),patch.object(camera.media_stop,'wait',side_effect=wait):
                        camera.send_media()
                    self.assertIsNone(camera.media_error)
                    self.assertEqual([struct.unpack('!I',p[4:8])[0] for p in packets],[(1<<32)-9000,0,(1<<32)-9000,0,9000])
                    for i,packet in enumerate(packets):
                        self.assertEqual(packet[12:],shift_ps(original,(1<<bits)-9000))
                    self.assertLess(max(waits),.3)
                    self.assertEqual(camera.rtp_timestamp_wraps,1)
                    self.assertEqual(camera.ps_timestamp_wraps,1 if bits==33 else 0)
                finally:camera.sock.close()

if __name__=='__main__': unittest.main()
