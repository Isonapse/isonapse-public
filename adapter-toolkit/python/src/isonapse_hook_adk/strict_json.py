"""Bounded strict JSON shared by the ADK and the shipped Hermes glue."""
import json
import math

MAX_BYTES = 1024 * 1024


def _unique(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON key")
        result[key] = value
    return result


def _validate(value, depth=0):
    if depth > 256:
        raise ValueError("JSON nesting limit")
    if isinstance(value, str):
        value.encode("utf-8", errors="strict")
    elif isinstance(value, float) and not math.isfinite(value):
        raise ValueError("non-finite JSON number")
    elif isinstance(value, list):
        for item in value:
            _validate(item, depth + 1)
    elif isinstance(value, dict):
        for key, item in value.items():
            _validate(key, depth + 1)
            _validate(item, depth + 1)


def loads(raw):
    """Reject ambiguous keys, invalid Unicode, nonfinite values and excess size."""
    if isinstance(raw, str):
        raw = raw.encode("utf-8", errors="strict")
    if not isinstance(raw, bytes) or len(raw) > MAX_BYTES:
        raise ValueError("JSON size or type limit")
    value = json.loads(raw.decode("utf-8", errors="strict"), object_pairs_hook=_unique)
    _validate(value)
    return value
