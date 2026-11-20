"""ONVIF backchannel sink. stdin: one JSON configuration line, then mono S16LE/8kHz."""
import ctypes
import json
import os
import secrets
import select
import signal
import struct
import sys
import time
from urllib.parse import urlsplit

import gi
gi.require_version("Gst", "1.0")
gi.require_version("GstRtsp", "1.0")
from gi.repository import Gst, GstRtsp, GObject


def g711(sample, codec):
    if codec == "PCMA":
        mask = 0xd5 if sample >= 0 else 0x55
        value = sample if sample >= 0 else -sample - 1
        exponent = (value >> 8).bit_length()
        mantissa = value >> (exponent + 3 if exponent else 4)
    else:
        mask = 0xff if sample >= 0 else 0x7f
        value = min(abs(sample), 32635) + 132
        exponent = (value >> 8).bit_length()
        mantissa = value >> (exponent + 3)
    return ((exponent << 4) | (mantissa & 15)) ^ mask


def run():
    location, user, password = json.loads(sys.stdin.buffer.readline(8192))
    address = urlsplit(location)
    if address.scheme != "rtsp" or not address.hostname:
        return "invalid_source"
    Gst.init(None)
    pipeline = Gst.Pipeline()
    src = Gst.ElementFactory.make("rtspsrc")
    src.props.location = location
    src.props.user_id = user
    src.props.user_pw = password
    src.props.protocols = GstRtsp.RTSPLowerTrans.TCP
    src.props.backchannel = 1
    src.props.tcp_timeout = 5000000
    pipeline.add(src)
    track = {}
    running = True

    def stop(*_):
        nonlocal running
        running = False

    def before_send(_, message):
        result, _, target, _ = message.parse_request()
        if result != GstRtsp.RTSPResult.OK:
            return False
        if target == "*":
            return True
        peer = urlsplit(target)
        return (peer.scheme, peer.hostname, peer.port or 554) == (
            address.scheme, address.hostname, address.port or 554)

    def choose(_, index, caps):
        for i in range(caps.get_size()):
            fmt = caps.get_structure(i)
            codec = fmt.get_string("encoding-name")
            if (not track and fmt.get_string("media") == "audio"
                    and fmt.has_field("a-sendonly") and codec in ("PCMA", "PCMU")
                    and fmt.get_value("clock-rate") == 8000
                    and fmt.get_string("encoding-params") in (None, "1")):
                track.update(index=index, codec=codec, payload=fmt.get_value("payload"))
                return True
        return False

    src.connect("before-send", before_send)
    src.connect("select-stream", choose)
    signal.signal(signal.SIGTERM, stop)
    bus = pipeline.get_bus()
    pipeline.set_state(Gst.State.PLAYING)
    try:
        deadline = time.monotonic() + 9
        while running and time.monotonic() < deadline:
            msg = bus.timed_pop_filtered(100 * Gst.MSECOND, Gst.MessageType.ERROR | Gst.MessageType.PROGRESS)
            if msg and msg.type == Gst.MessageType.ERROR:
                return "negotiation_failed" if track else "backchannel_unavailable"
            if msg and msg.type == Gst.MessageType.PROGRESS:
                kind, code, _ = msg.parse_progress()
                if track and code == "request" and kind == Gst.ProgressType.COMPLETE:
                    break
        else:
            return "negotiation_timeout"
        print("ready", flush=True)
        seq, stamp, ssrc = secrets.randbits(16), secrets.randbits(32), secrets.randbits(32)
        codes = bytes(g711(i if i < 32768 else i - 65536, track["codec"]) for i in range(65536))
        pending = bytearray()
        due = time.monotonic()
        # GStreamer 1.20 consumes the sample passed to the action signal.
        # PyGObject also owns one reference. Give the action its own reference.
        libgst = ctypes.CDLL("libgstreamer-1.0.so.0")
        ref = libgst.gst_mini_object_ref
        ref.argtypes = [ctypes.c_void_p]
        ref.restype = ctypes.c_void_p
        modern = GObject.signal_lookup("push-backchannel-sample", src.__gtype__) != 0
        first = True
        while running:
            if bus.pop_filtered(Gst.MessageType.ERROR | Gst.MessageType.EOS):
                return "disconnected"
            if len(pending) < 320:
                if not select.select([0], [], [], 0.2)[0]:
                    continue
                block = os.read(0, 3200)
                if not block:
                    break
                pending.extend(block)
                continue
            time.sleep(max(0, due - time.monotonic()))
            due = max(due + 0.020, time.monotonic())
            header = struct.pack("!BBHII", 128, track["payload"] | (128 if first else 0), seq, stamp, ssrc)
            packet = header + bytes(codes[v] for (v,) in struct.iter_unpack("<H", pending[:320]))
            del pending[:320]
            sample = Gst.Sample.new(Gst.Buffer.new_wrapped(packet), None, None, None)
            action = "push-backchannel-sample" if modern else "push-backchannel-buffer"
            if not modern:
                ref(hash(sample))
            if src.emit(action, track["index"], sample) != Gst.FlowReturn.OK:
                return "send_failed"
            first = False
            seq, stamp = (seq + 1) & 65535, (stamp + 160) & 0xffffffff
    finally:
        pipeline.set_state(Gst.State.NULL)


if __name__ == "__main__":
    try:
        error = run()
    except Exception:
        error = "audio_runtime_error"
    if error:
        print(error, flush=True)
        sys.exit(1)
