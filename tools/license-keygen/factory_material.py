"""Factory device credentials; never contains the v3 signing private key."""
from pathlib import Path
import re
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
HERE = Path(__file__).resolve().parent

def normalize_code(code: str) -> str:
    value = re.sub(r"[\s-]+", "", code).upper().replace("O", "0").replace("I", "1").replace("L", "1")
    if not re.fullmatch(r"[0-9A-HJKMNP-TV-Z]{24}", value):
        raise ValueError("申请码必须是24位Crockford Base32")
    return value


def load_master(directory: Path) -> bytes:
    key = bytes.fromhex((directory / "MASTER_KEY.local").read_text().strip())
    if len(key) != 32:
        raise ValueError("厂内主密钥长度错误")
    return key


def device_key(master: bytes, code: str) -> bytes:
    return HKDF(algorithm=hashes.SHA256(), length=32, salt=b"AINVR/device/v2",
                info=normalize_code(code).encode("ascii")).derive(master)


