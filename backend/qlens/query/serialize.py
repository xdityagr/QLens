import datetime as dt
import math
import uuid
from decimal import Decimal
from typing import Any


def cell(v: Any) -> Any:
    """One result value as something json.dumps accepts and a browser can show without losing precision."""
    if v is None or isinstance(v, (bool, int, str)):
        return v
    if isinstance(v, float):
        return v if math.isfinite(v) else str(v)
    if isinstance(v, Decimal):
        return str(v)  # a JSON number would round-trip through a binary float
    if isinstance(v, (dt.datetime, dt.date, dt.time)):
        return v.isoformat()
    if isinstance(v, dt.timedelta):
        return str(v)
    if isinstance(v, (bytes, bytearray, memoryview)):
        return "\\x" + bytes(v).hex()
    if isinstance(v, uuid.UUID):
        return str(v)
    if isinstance(v, (list, tuple)):
        return [cell(x) for x in v]
    if isinstance(v, dict):
        return v
    return str(v)
