#!/usr/bin/env python3
"""Small serial C++ software tests only. Never load HBM, JPU or GLES."""
import pathlib
import subprocess
import tempfile

root = pathlib.Path(__file__).resolve().parents[2]
with tempfile.TemporaryDirectory(prefix="face-pure-", dir=root / "test" / "ai_port") as build:
    objects = []
    for name in ("face_embedding_test", "face_identity_runtime_test", "face_residency_test"):
        obj = pathlib.Path(build) / (name + ".o")
        subprocess.run(["g++", "-std=c++20", "-O0", "-g0", "-pthread", "-Wall", "-Wextra",
                        "-I" + str(root / "ai-service" / "src"), "-c",
                        str(root / "test" / "ai_port" / (name + ".cpp")), "-o", str(obj)], check=True, timeout=60)
        objects.append(str(obj))
    binary = str(pathlib.Path(build) / "face_pure_tests")
    subprocess.run(["g++", "-pthread", *objects, "-lgtest_main", "-lgtest", "-lcrypto", "-o", binary], check=True, timeout=20)
    subprocess.run([binary], check=True, timeout=20, cwd=root)
