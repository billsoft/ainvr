#!/usr/bin/env python3
"""Verify real FFmpeg cannot follow a camera redirect to an unvalidated host."""
import argparse
import json
from pathlib import Path
import re
import socketserver
import subprocess
import threading

class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address=True
    daemon_threads=True
class Handler(socketserver.BaseRequestHandler):
    def handle(self):
        self.request.settimeout(2)
        try:data=self.request.recv(8192)
        except OSError:return
        self.server.contacts+=1
        found=re.search(br'(?im)^CSeq:\s*(\d+)',data)
        cseq=found.group(1) if found else b'1'
        response=b'RTSP/1.0 302 Moved Temporarily\r\nLocation: rtsp://127.0.0.1:19855/forbidden\r\n' if self.server.redirect else b'RTSP/1.0 454 Session Not Found\r\n'
        try:self.request.sendall(response+b'CSeq: '+cseq+b'\r\nContent-Length: 0\r\n\r\n')
        except OSError:pass
def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--host',required=True)
    parser.add_argument('--candidate',type=Path,required=True)
    parser.add_argument('--baseline',type=Path)
    parser.add_argument('--result',type=Path,required=True)
    args=parser.parse_args();args.result.mkdir(parents=True,exist_ok=False)
    camera=Server((args.host,19854),Handler);target=Server(('127.0.0.1',19855),Handler)
    camera.redirect=True;target.redirect=False;camera.contacts=target.contacts=0
    threads=[threading.Thread(target=s.serve_forever,daemon=True) for s in [camera,target]]
    for t in threads:t.start()
    report={}
    def run(binary):
        before=target.contacts
        process=subprocess.run([str(binary),'-v','error','-rtsp_transport','tcp','-timeout','2000000','-show_format','-of','json',f'rtsp://{args.host}:19854/redirect'],capture_output=True,timeout=8)
        return {'exit':process.returncode,'unvalidatedHostContacts':target.contacts-before,'redirectDenied':'AINVR RTSP redirect denied' in process.stderr.decode(errors='replace')}
    try:
        if args.baseline:
            report['baseline']=run(args.baseline)
            assert report['baseline']['unvalidatedHostContacts']>0,'fixture_did_not_exercise_redirect'
        report['candidate']=run(args.candidate)
        assert report['candidate']['exit']!=0 and report['candidate']['unvalidatedHostContacts']==0 and report['candidate']['redirectDenied']
        report['passed']=True
    finally:
        for s in [camera,target]:s.shutdown();s.server_close()
        (args.result/'report.json').write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps(report))
if __name__=='__main__':main()
