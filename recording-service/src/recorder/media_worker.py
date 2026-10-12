"""One disposable reader process. No NAS syscall runs in the ASGI process."""
import json
import errno
import os
import stat
import sys


def main():
    announced = False
    try:
        with open(sys.argv[1], 'rb', buffering=0) as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode):
                raise OSError(errno.EINVAL, 'not a regular file')
            sys.stdout.buffer.write((json.dumps({'size': info.st_size}) + '\n').encode())
            sys.stdout.buffer.flush()
            announced = True
            start, length = json.loads(sys.stdin.buffer.readline())
            stream.seek(start)
            while length > 0:
                chunk = stream.read(min(256 * 1024, length))
                if not chunk:
                    break
                sys.stdout.buffer.write(chunk)
                sys.stdout.buffer.flush()
                length -= len(chunk)
    except (OSError, ValueError) as error:
        if not announced:
            # No path/credentials in the protocol. Preserve errno so a missing
            # file is not mistaken for a failed NAS mount by the parent.
            sys.stdout.buffer.write((json.dumps({'error': getattr(error, 'errno', None)}) + '\n').encode())
            sys.stdout.buffer.flush()
        sys.exit(1)


if __name__ == '__main__':
    main()
