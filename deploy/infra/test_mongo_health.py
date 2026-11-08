import socket,subprocess,threading,unittest
from pathlib import Path
SCRIPT=Path(__file__).with_name('mongo-health.sh')
GOOD=bytes.fromhex('260000009650af002a000000dd070000000000000011000000016f6b00000000000000f03f00')
class PingTest(unittest.TestCase):
 def probe(self,reply):
  with socket.socket() as server:
   server.bind(('127.0.0.1',0));server.listen();port=server.getsockname()[1]
   def serve():
    c,_=server.accept()
    with c:
     c.recv(1024)
     for b in reply:c.sendall(bytes([b]))
   t=threading.Thread(target=serve);t.start()
   p=subprocess.run(['timeout','3','bash',str(SCRIPT),str(port)],capture_output=True,timeout=4);t.join(4)
   return p.returncode
 def test_fragmented_ping(self):self.assertEqual(self.probe(GOOD),0)
 def test_rejects_bad_response(self):
  for response in [GOOD[:-1],GOOD[:8]+bytes([43])+GOOD[9:],GOOD[:-9]+bytes(8)+b'\0',b'HTTP/1.1 200 OK\r\n\r\n']:
   self.assertNotEqual(self.probe(response),0)
 def test_connection_refused(self):
  with socket.socket() as s:s.bind(('127.0.0.1',0));port=s.getsockname()[1]
  p=subprocess.run(['timeout','3','bash',str(SCRIPT),str(port)],capture_output=True,timeout=4)
  self.assertNotEqual(p.returncode,0)
if __name__=='__main__':unittest.main()
