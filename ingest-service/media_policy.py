"""Shared RTSP audio policy. Media stays encoded; G.711/G.726 use bounded AAC encoding."""
import json
import os
import signal
import subprocess
import threading


class MediaError(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def error_code(text):
    value = text.lower()
    if 'ainvr rtsp redirect denied' in value:
        return 'redirect_not_allowed'
    if any(word in value for word in ('error while opening encoder', 'error initializing output stream 0:1', "unknown decoder 'pcm_alaw'", "unknown decoder 'pcm_mulaw'", 'error while decoding stream #0:1')):
        return 'audio_processing_failed'
    if any(word in value for word in ('401 unauthorized', '403 forbidden', 'authorization failed', 'method describe failed: 401')):
        return 'authentication_failed'
    if any(word in value for word in ('codec not currently supported in container', 'unsupported codec', 'video codec not supported')):
        return 'unsupported_video_codec'
    return 'source_unavailable'


def audio_policy(codec):
    codec = (codec or '').lower()
    if codec == 'aac':
        return ['-map', '0:a:0?', '-c:a', 'copy'], None, False
    if codec in ('pcm_alaw', 'pcm_mulaw', 'pcma', 'pcmu', 'adpcm_g726', 'adpcm_g726le'):
        return ['-map', '0:a:0?', '-c:a', 'aac', '-ar', '16000', '-ac', '1', '-b:a', '64k', '-threads:a', '1'], None, True
    return ['-an'], 'unsupported_audio_codec' if codec else 'no_audio', False


def probe(args, fd, timeout=15):
    """The source and its credentials are already in a private inherited memfd."""
    tool = os.environ.get('INGEST_FFPROBE', '/opt/ainvr/ffmpeg-8.1.2/bin/ffprobe')
    begin = args.index('-f')
    end = args.index('-map')
    command = [tool, '-v', 'error', *args[begin:end], '-show_entries',
               'stream=codec_type,codec_name,width,height', '-of', 'json']
    proc = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, pass_fds=(fd,), start_new_session=True)
    output, errors = bytearray(), bytearray()
    exceeded = threading.Event()
    def drain(pipe, dest, maximum):
        while True:
            chunk = pipe.read(4096)
            if not chunk:
                return
            remaining = maximum - len(dest)
            dest.extend(chunk[:max(0, remaining)])
            if len(chunk) > remaining:
                exceeded.set()
                try:
                    os.killpg(proc.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
    readers = [threading.Thread(target=drain, args=(proc.stdout, output, 131072), daemon=True),
               threading.Thread(target=drain, args=(proc.stderr, errors, 8192), daemon=True)]
    for thread in readers:
        thread.start()
    try:
        proc.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        raise MediaError('probe_timeout') from None
    finally:
        if proc.poll() is None:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            proc.wait(timeout=2)
        for thread in readers:
            thread.join(timeout=1)
        proc.stdout.close()
        proc.stderr.close()
    if proc.returncode or exceeded.is_set():
        raise MediaError(error_code(errors.decode(errors='replace')))
    try:
        streams = json.loads(output).get('streams', [])
        if not isinstance(streams, list) or len(streams) > 32:
            raise ValueError()
        video = next((s for s in streams if s.get('codec_type') == 'video'), {})
        if video.get('codec_name') not in ('h264', 'hevc'):
            raise MediaError('unsupported_video_codec')
        audio = next((s for s in streams if s.get('codec_type') == 'audio'), {})
        return video.get('codec_name'), audio.get('codec_name')
    except (ValueError, TypeError, AttributeError):
        raise MediaError('invalid_media_probe') from None


class AudioBudget:
    def __init__(self, limit=2):
        self.limit = limit
        self.used = 0
        self.lock = threading.Lock()

    def acquire(self):
        with self.lock:
            if self.used >= self.limit:
                return False
            self.used += 1
            return True

    def release(self):
        with self.lock:
            self.used -= 1

    def configure(self, limit):
        if type(limit) is not int or not 0 <= limit <= 8:
            raise ValueError('invalid audio capacity')
        with self.lock:
            self.limit = limit


AUDIO_BUDGET = AudioBudget()
