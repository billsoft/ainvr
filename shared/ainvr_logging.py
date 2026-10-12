"""Shared Python event formatting and bounded repeat suppression (stdlib only)."""
import collections
import json
import logging
import re
import threading
import time


def safe(text):
    text = re.sub(r'(?i)\bBearer\s+[^\s,;"}]+', 'Bearer [REDACTED]', str(text))
    text = re.sub(r'(?i)([a-z][a-z0-9+.-]*://)[^\s/@]+:[^\s/@]+@', r'\1[REDACTED]@', str(text))
    return re.sub(r'(?i)((?:password|passwd|secret|token|authorization|api[_-]?key)["\s]*[:=]["\s]*)([^\s,;}]+)', r'\1[REDACTED]', text)[:8192]


class EventFormatter(logging.Formatter):
    def format(self, record):
        message = record.getMessage()
        if record.exc_info: message += '\n' + self.formatException(record.exc_info)
        return json.dumps({'ts':int(record.created*1000),'level':record.levelname,
                           'module':record.name,'category':'runtime','message':safe(message),
                           'count':getattr(record,'repeat_count',1)},ensure_ascii=False)


class RepeatFilter(logging.Filter):
    def __init__(self):
        super().__init__(); self.lock=threading.Lock(); self.recent=collections.OrderedDict()

    def filter(self, record):
        # Healthy GET polling has no operational value; writes/errors remain visible.
        if record.name.endswith('access') and isinstance(record.args,tuple) and len(record.args)>=5:
            if record.args[1] in ('GET','HEAD') and isinstance(record.args[4],int) and record.args[4]<400: return False
        key=(record.name,record.levelno,safe(record.getMessage()))
        now=time.monotonic()
        with self.lock:
            old=self.recent.get(key)
            if old and now-old[0]<60:
                self.recent[key]=(old[0],old[1]+1); return False
            record.repeat_count=1+(old[1] if old else 0)
            self.recent[key]=(now,0);self.recent.move_to_end(key)
            if len(self.recent)>512:self.recent.popitem(last=False)
        return True


def configure_handler(handler):
    handler.setFormatter(EventFormatter())
    handler.addFilter(RepeatFilter())
    return handler
