import datetime as dt
import uuid
from decimal import Decimal

import pytest

from qlens.query.serialize import cell


@pytest.mark.parametrize("v,out", [
    (1, 1), (1.5, 1.5), (True, True), (None, None), ("x", "x"),
    (float("nan"), "nan"), (float("inf"), "inf"), (float("-inf"), "-inf"),
    (Decimal("1.50"), "1.50"),
    (dt.date(2026, 4, 1), "2026-04-01"),
    (dt.datetime(2026, 4, 1, 10, 30), "2026-04-01T10:30:00"),
    (dt.datetime(2026, 4, 1, 10, 30, tzinfo=dt.timezone.utc), "2026-04-01T10:30:00+00:00"),
    (dt.time(9, 5), "09:05:00"),
    (dt.timedelta(days=1), "1 day, 0:00:00"),
    (b"\x01\x02", "\\x0102"), (memoryview(b"\x01\x02"), "\\x0102"),
    (uuid.UUID(int=1), "00000000-0000-0000-0000-000000000001"),
    ([1, Decimal("2.5"), [None]], [1, "2.5", [None]]),
    ({"a": [1]}, {"a": [1]}),
    (object, str(object)),
])
def test_cell(v, out):
    assert cell(v) == out
