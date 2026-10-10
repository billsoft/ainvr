#!/usr/bin/env python3
import fcntl
from common import Experiment, ROOT, parser, digest

def probe(exp):
    detail = exp.native(exp.build("shader_platform_probe", [ROOT / "native/shader_platform_probe.c"],
                                 ["EGL", "GLESv2", "wayland-client", "vulkan"]))
    rows = detail["measurements"]
    if not any(r.get("event") == "gles_driver" and "Mali" in r.get("renderer", "") for r in rows):
        raise RuntimeError("Hardware GLES renderer missing")
    if not any(r.get("max_texture_size", 0) >= 7680 for r in rows):
        raise RuntimeError("Texture dimension limit below requested 8K width")
    for channels in [1, 2]:
        if not any(r.get("channels") == channels and r.get("framebuffer_complete") and r.get("native_readback_error") == 0 for r in rows):
            raise RuntimeError(f"Native {channels}-channel render/readback unavailable")
    if not any(r.get("event") == "vulkan_device" and "Mali" in r.get("name", "") for r in rows):
        raise RuntimeError("Vulkan Mali physical device missing")
    detail["context_header_sha256"] = digest(ROOT / "native/gles_context.h")
    return detail
def main():
    ROOT.joinpath("results").mkdir(exist_ok=True)
    with ROOT.joinpath("results/.run.lock").open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        exp = Experiment("shader_platform", parser("shader_platform").parse_args())
        exp.case("GLES-context-and-Vulkan-devices", lambda: probe(exp))
        raise SystemExit(exp.finish())
if __name__ == "__main__":
    main()
