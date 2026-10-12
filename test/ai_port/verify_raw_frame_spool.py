#!/usr/bin/env python3
"""Copyright AINVR. Run process-crash recovery in an isolated temporary directory."""
import pathlib
import subprocess
import sys
import tempfile

binary = pathlib.Path(sys.argv[1]).resolve(strict=True)
with tempfile.TemporaryDirectory(prefix="ainvr-raw-frame-") as directory:
    subprocess.run([str(binary), str(pathlib.Path(directory) / "spool")],
                   check=True, timeout=45)
