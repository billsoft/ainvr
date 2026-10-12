#!/usr/bin/env python3
"""Manual, bounded real-media probes. Not part of the default unit test suite."""
import argparse
import json
from pathlib import Path
import signal
import time
import urllib.request
import urllib.parse


def main():
    p = argparse.ArgumentParser()
    p.add_argument('mode', choices=['rtsp', 'whip'])
    p.add_argument('--codec', choices=['h264','h265'], default='h264')
    p.add_argument('--url')
    p.add_argument('--http-host', help='Host header supplied by a local HTTP proxy fixture')
    p.add_argument('--credential-file', type=Path)
    p.add_argument('--port', type=int, default=18554)
    p.add_argument('--seconds', type=int, default=40)
    p.add_argument('--image', type=Path)
    p.add_argument('--result', type=Path, required=True)
    a = p.parse_args()
    import gi
    gi.require_version('Gst', '1.0')
    from gi.repository import Gst, GLib
    Gst.init(None)
    encoder = ('x264enc tune=zerolatency speed-preset=ultrafast bitrate=300 key-int-max=15 threads=1 sliced-threads=false' if a.codec == 'h264'
               else 'x265enc tune=zerolatency speed-preset=ultrafast bitrate=300 key-int-max=15 option-string="pools=1:frame-threads=1:open-gop=0"')
    source = ('filesrc location=' + str(a.image) + ' ! jpegdec ! imagefreeze is-live=true' if a.image
              else 'videotestsrc is-live=true pattern=ball')
    media = source + ' ! videoconvert ! videoscale ! video/x-raw,format=I420,width=640,height=320,framerate=15/1 ! ' + encoder + ' ! ' + a.codec + 'parse ! '
    loop = GLib.MainLoop()
    result = {'mode': a.mode, 'codec': a.codec, 'started': time.time(), 'errors': []}
    pipeline = None
    session = None
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    auth = {'Authorization': 'Bearer ' + a.credential_file.read_text().strip()} if a.credential_file else {}
    if a.http_host:
        if any(c in a.http_host for c in '\r\n'):
            raise ValueError('Invalid HTTP Host')
        auth['Host'] = a.http_host
    if a.mode == 'rtsp':
        gi.require_version('GstRtspServer', '1.0')
        from gi.repository import GstRtspServer
        server = GstRtspServer.RTSPServer.new()
        server.set_service(str(a.port))
        factory = GstRtspServer.RTSPMediaFactory.new()
        factory.set_launch('( ' + media + 'rtp' + a.codec + 'pay name=pay0 pt=96 config-interval=-1 )')
        factory.set_shared(True)
        server.get_mount_points().add_factory('/camera', factory)
        server.attach(None)
        result['ready'] = True
    else:
        gi.require_version('GstWebRTC', '1.0')
        gi.require_version('GstSdp', '1.0')
        from gi.repository import GstWebRTC, GstSdp
        pipeline = Gst.parse_launch(media + 'rtp' + a.codec + 'pay pt=96 config-interval=-1 ! '
            'application/x-rtp,media=video,encoding-name=' + a.codec.upper() + ',payload=96,clock-rate=90000 ! '
            'webrtcbin name=pc bundle-policy=max-bundle')
        pc = pipeline.get_by_name('pc')
        agent = pc.get_property('ice-agent')
        nice = agent.get_property('agent')
        nice.set_property('upnp', False)
        offered = [False]
        negotiating = [False]
        def negotiate(_pc):
            if negotiating[0]: return
            negotiating[0] = True
            def on_offer(promise, *_args):
                reply = promise.get_reply()
                offer = reply.get_value('offer') if reply else None
                if not offer or not offer.sdp:
                    result['errors'].append('offer creation failed')
                    loop.quit(); return
                offer = offer.copy()
                pc.emit('set-local-description', offer, Gst.Promise.new())
            pc.emit('create-offer', None, Gst.Promise.new_with_change_func(on_offer, None, None))
        def gathered(_pc, _prop):
            nonlocal session
            if offered[0] or pc.get_property('ice-gathering-state') != GstWebRTC.WebRTCICEGatheringState.COMPLETE:
                return
            offered[0] = True
            try:
                sdp = pc.get_property('local-description').sdp.as_text()
                request = urllib.request.Request(a.url, data=sdp.encode(), headers={**auth, 'Content-Type': 'application/sdp'})
                with opener.open(request, timeout=8) as r:
                    answer = r.read().decode()
                    session = urllib.parse.urljoin(a.url, r.headers['Location'])
                    result['status'] = r.status
                _, parsed = GstSdp.SDPMessage.new_from_text(answer)
                description = GstWebRTC.WebRTCSessionDescription.new(GstWebRTC.WebRTCSDPType.ANSWER, parsed)
                pc.emit('set-remote-description', description, Gst.Promise.new())
            except Exception as e:
                result['errors'].append(type(e).__name__)
                loop.quit()
        def connection(_pc, _prop):
            state = pc.get_property('connection-state')
            result['connection'] = state.value_nick
        pc.connect('on-negotiation-needed', negotiate)
        pc.connect('notify::ice-gathering-state', gathered)
        pc.connect('notify::connection-state', connection)
        bus = pipeline.get_bus(); bus.add_signal_watch()
        def message(_bus, msg):
            if msg.type == Gst.MessageType.ERROR:
                err, _debug = msg.parse_error()
                result['errors'].append(str(err)[:300]); loop.quit()
        bus.connect('message', message)
        pipeline.set_state(Gst.State.PLAYING)
    def quit(*_args): loop.quit(); return False
    signal.signal(signal.SIGTERM, quit)
    signal.signal(signal.SIGINT, quit)
    GLib.timeout_add_seconds(min(300, a.seconds), quit)
    try: loop.run()
    finally:
        if pipeline: pipeline.set_state(Gst.State.NULL)
        if session:
            try:
                with opener.open(urllib.request.Request(session, method='DELETE', headers=auth), timeout=5) as r:
                    result['delete_status'] = r.status
            except Exception as e: result['delete_error'] = type(e).__name__
        result['ended'] = time.time()
        a.result.write_text(json.dumps(result, indent=2))
    print(json.dumps(result))


if __name__ == '__main__': main()
