#!/usr/bin/env python3
"""Software-only complete scalar/whitespace comparison with export Python13.

Uses the board's ICU70 shared library directly; does not import any model code.
"""
import ctypes
import argparse
import hashlib
import json
import struct
import subprocess
import unicodedata

if unicodedata.unidata_version != '13.0.0':
    raise RuntimeError('Reference Python must use Unicode13')
lib = ctypes.CDLL('libicuuc.so.70')
age = lib.u_charAge_70
age.argtypes = [ctypes.c_int32, ctypes.POINTER(ctypes.c_uint8)]
simple = lib.u_tolower_70
simple.argtypes = [ctypes.c_int32]
simple.restype = ctypes.c_int32
lower = lib.u_strToLower_70
lower.argtypes = [ctypes.POINTER(ctypes.c_uint16), ctypes.c_int32,
                 ctypes.POINTER(ctypes.c_uint16), ctypes.c_int32,
                 ctypes.c_char_p, ctypes.POINTER(ctypes.c_int32)]
lower.restype = ctypes.c_int32
spaces = [lib.u_isWhitespace_70, lib.u_isUWhiteSpace_70]
for f in spaces:
    f.argtypes = [ctypes.c_int32]
    f.restype = ctypes.c_int8
checked = 0
digest = hashlib.sha256()
for cp in range(0x110000):
    if 0xd800 <= cp <= 0xdfff:
        continue
    char = chr(cp)
    if bool(spaces[0](cp) or spaces[1](cp)) != char.isspace():
        raise AssertionError(('whitespace', hex(cp)))
    version = (ctypes.c_uint8 * 4)()
    age(cp, version)
    actual = char
    if version[0] <= 13 and (simple(cp) != cp or char.lower() != char):
        encoded = char.encode('utf-16-le')
        source = (ctypes.c_uint16 * (len(encoded)//2)).from_buffer_copy(encoded)
        target = (ctypes.c_uint16 * 16)()
        error = ctypes.c_int32()
        count = lower(target, 16, source, len(source), b'', ctypes.byref(error))
        if error.value > 0:
            raise AssertionError(('icu', error.value))
        actual = bytes(target)[:count*2].decode('utf-16-le')
    if actual != char.lower():
        raise AssertionError(('lower', hex(cp)))
    # Query preprocessing also replaces literal SentencePiece underline.
    normalized = (' ' if cp == 0x2581 else actual).encode('utf-8')
    digest.update(struct.pack('>II', cp, len(normalized)))
    digest.update(normalized)
    checked += 1
parser = argparse.ArgumentParser()
parser.add_argument('--native')
args = parser.parse_args()
if args.native:
    actual = json.loads(subprocess.check_output([args.native, '--unicode-digest'], text=True))
    if actual != dict(valid_scalars=checked, sha256=digest.hexdigest()):
        raise AssertionError('Native scalar normalization differs from Python13')
print(json.dumps(dict(valid_scalars=checked, lower_differences=0, whitespace_differences=0,
                      reference_unicode='13.0.0', runtime_icu='70.1', ageguard=True,
                      native_verified=bool(args.native), sha256=digest.hexdigest())))
