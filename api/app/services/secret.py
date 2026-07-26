from __future__ import annotations

import base64
import hashlib

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.exceptions import InvalidTag

NONCE_SIZE = 12  # AES-GCM standard nonce size (matches Go gcm.NonceSize())


def derive_key(passphrase: str) -> bytes:
    return hashlib.sha256(passphrase.encode("utf-8")).digest()


def encrypt(plain: str, key: bytes) -> str:
    if plain == "":
        return ""
    aesgcm = AESGCM(key)
    import os

    nonce = os.urandom(NONCE_SIZE)
    ct = aesgcm.encrypt(nonce, plain.encode("utf-8"), None)
    return base64.standard_b64encode(nonce + ct).decode("ascii")


def decrypt(cipher_b64: str, key: bytes) -> str:
    if not cipher_b64:
        return ""
    raw = base64.standard_b64decode(cipher_b64)
    if len(raw) < NONCE_SIZE:
        raise ValueError("ciphertext too short")
    nonce, ct = raw[:NONCE_SIZE], raw[NONCE_SIZE:]
    aesgcm = AESGCM(key)
    try:
        plain = aesgcm.decrypt(nonce, ct, None)
    except InvalidTag as exc:
        raise ValueError("decrypt failed") from exc
    return plain.decode("utf-8")
