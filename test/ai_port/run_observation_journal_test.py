"""Run durable-journal contracts in an isolated directory on the build filesystem."""
import subprocess,sys,tempfile
from pathlib import Path
with tempfile.TemporaryDirectory(prefix="journal-test-",dir=sys.argv[2]) as folder:
    raise SystemExit(subprocess.run([sys.argv[1],str(Path(folder)/"journal")],timeout=55).returncode)
