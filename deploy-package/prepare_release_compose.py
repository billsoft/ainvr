#!/usr/bin/env python3
"""Create source-free Compose with the same explicit tags as the build project."""
from pathlib import Path
import re
import sys


def render(source):
    lines = source.splitlines()
    out = []
    service = None
    skip_indent = None
    found = set()
    for line in lines:
        indent = len(line) - len(line.lstrip())
        if skip_indent is not None:
            if not line.strip() or indent > skip_indent:
                continue
            skip_indent = None
        match = re.fullmatch(r'  ([a-zA-Z0-9_-]+):\s*', line)
        if match:
            service = match[1]
        if service in ('frontend', 'backend') and re.match(r'^    build:\s*$', line):
            skip_indent = 4
            continue
        if service in ('frontend', 'backend') and re.match(r'^    image:', line):
            continue
        out.append(line)
        if match and service in ('frontend', 'backend'):
            found.add(service)
            out.append(f'    image: srs-web-console-{service}:latest')
    if found != {'frontend', 'backend'}:
        raise ValueError('Expected frontend and backend service definitions')
    return '\n'.join(out) + '\n'


if __name__ == '__main__':
    Path(sys.argv[2]).write_text(render(Path(sys.argv[1]).read_text()))
