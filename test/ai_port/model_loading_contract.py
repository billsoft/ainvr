#!/usr/bin/env python3
"""Architecture gate: new features must not create another raw SDK loader."""
from pathlib import Path
import re

root = Path(__file__).resolve().parents[2]
allowed = {
    "ai-service/src/platform/bpu.cpp",  # private ctor + shared runtime cache
    "ai-service/src/platform/bpu_pack.cpp",  # Qwen embedding package owner
    "llm-service/src/bpu_program.cpp",  # single review worker/Engine
}
managed_loaders = {
    r"\bBpuPack::Load\s*\(": {"ai-service/src/platform/bpu_pack.cpp", "ai-service/src/embedding/qwen3vl_embedder.cpp"},
    r"\bQwen3VlEmbedder::Load\s*\(": {"ai-service/src/embedding/qwen3vl_embedder.cpp", "ai-service/src/output/search_qwen_runtime.cpp"},
    r"(?:make_unique|make_shared)<ainvr::llm::Engine>": {"llm-service/src/service.cpp"},
    r"ainvr::llm::Engine\s+\w+\s*\(": {"llm-service/src/probe.cpp"},
}
found = set()
for directory in ("ai-service/src", "search-service/src", "llm-service/src", "shared"):
    for path in (root / directory).rglob("*"):
        if path.suffix not in {".cpp", ".hpp", ".h", ".cc"}:
            continue
        text = path.read_text(encoding="utf-8")
        relative = path.relative_to(root).as_posix()
        for pattern, owners in managed_loaders.items():
            assert not re.search(pattern, text) or relative in owners, f"Unowned model loader: {relative}"
        if re.search(r"\bhbDNNInitialize\w*\s*\(", path.read_text(encoding="utf-8")):
            found.add(path.relative_to(root).as_posix())
assert found == allowed, f"Raw model loader boundary changed; review ownership: {found ^ allowed}"
header = (root / "ai-service/src/platform/bpu.hpp").read_text(encoding="utf-8")
assert "explicit BpuModel(" in header.split(" private:", 1)[1]
print("PASS model loader ownership boundary")
