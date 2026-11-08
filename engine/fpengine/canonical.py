"""Canonical JSON, hashing and the binary dataset encoding shared with the TypeScript importer.

The dataset hash is defined over bytes, not over number formatting, so the browser importer and
this engine compute the same value independently:

    "fp.dataset-hash/1\\n"
    for each column in order:
        u32le(len(name_utf8)) name_utf8
        u8(kind)            1 = number, 2 = string
        u32le(row_count)
        number: row_count x float64le (missing = canonical quiet NaN 0x7ff8000000000000)
                followed by row_count x u8 missing mask (1 = missing)
        string: for each cell u8 missing flag, then u32le(len) utf8 bytes (len 0 when missing)

A hash identifies bytes. It does not prove where the data came from.
"""

from __future__ import annotations

import hashlib
import json
import math
import struct
from typing import Any

import numpy as np

HASH_HEADER = b"fp.dataset-hash/1\n"
CANONICAL_NAN = struct.pack("<Q", 0x7FF8000000000000)


def _normalize(value: Any) -> Any:
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError("canonical JSON does not allow NaN or infinity")
        if value == 0.0:
            return 0  # collapse -0.0 and 0.0
        if value.is_integer() and abs(value) < 2**53:
            return int(value)
        return value
    if isinstance(value, (np.floating,)):
        return _normalize(float(value))
    if isinstance(value, (np.integer,)):
        return int(value)
    if isinstance(value, dict):
        return {str(k): _normalize(v) for k, v in value.items() if v is not None or True}
    if isinstance(value, (list, tuple)):
        return [_normalize(v) for v in value]
    return value


def canonical_json(value: Any) -> str:
    """Sorted keys, no whitespace, integral floats written as integers, shortest float repr."""
    return json.dumps(_normalize(value), sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def hash_json(value: Any) -> str:
    return sha256_text(canonical_json(value))


def dataset_hash(columns: list[dict]) -> str:
    """Hash a dataset given as [{"name", "kind": "number"|"string", "values": [...]}]."""
    h = hashlib.sha256()
    h.update(HASH_HEADER)
    for col in columns:
        name = col["name"].encode("utf-8")
        values = col["values"]
        h.update(struct.pack("<I", len(name)))
        h.update(name)
        if col["kind"] == "number":
            h.update(b"\x01")
            h.update(struct.pack("<I", len(values)))
            mask = bytearray(len(values))
            buf = bytearray()
            for i, v in enumerate(values):
                if v is None or (isinstance(v, float) and math.isnan(v)):
                    buf += CANONICAL_NAN
                    mask[i] = 1
                else:
                    f = float(v)
                    buf += struct.pack("<d", 0.0 if f == 0.0 else f)
            h.update(bytes(buf))
            h.update(bytes(mask))
        elif col["kind"] == "string":
            h.update(b"\x02")
            h.update(struct.pack("<I", len(values)))
            for v in values:
                if v is None:
                    h.update(b"\x01" + struct.pack("<I", 0))
                else:
                    b = str(v).encode("utf-8")
                    h.update(b"\x00" + struct.pack("<I", len(b)) + b)
        else:
            raise ValueError(f"unknown column kind {col['kind']!r}")
    return h.hexdigest()


def array_digest(arr: np.ndarray, decimals: int | None = None) -> str:
    """Digest of a numeric array. Floats can be rounded first to compare within a tolerance."""
    a = np.asarray(arr)
    if decimals is not None:
        a = np.round(a.astype("<f8"), decimals) + 0.0  # +0.0 turns -0.0 into 0.0
    if a.dtype.kind == "f":
        a = np.where(np.isnan(a), np.nan, a).astype("<f8")
    else:
        a = a.astype("<i8")
    return hashlib.sha256(a.tobytes()).hexdigest()
