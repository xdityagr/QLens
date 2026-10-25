import csv
import io
from collections import Counter, defaultdict
from decimal import Decimal

from qlens.samples.generate import generate


def load(name):
    filename, data = generate(name)
    return filename, list(csv.DictReader(io.StringIO(data.decode("utf-8"))))


def norm(name: str) -> str:
    return " ".join(name.lower().split())


def test_fee_register_shape_and_plants():
    name, rows = load("fee_register")
    assert name == "fee_register.csv" and len(rows) == 3000
    gupta_phones = Counter(r["Teacher Phone"] for r in rows if r["Teacher"] == "Mr. Gupta")
    assert sorted(gupta_phones.values())[0] == 5            # old number exactly 5 rows
    assert sum(r["Student Name"] in {"riya sharma", "Riya  Sharma"} for r in rows) == 2


def test_fee_register_structure_guarantees():
    _, rows = load("fee_register")
    assert list(rows[0]) == ["Student Name", "Student Phone", "Batch", "Teacher", "Teacher Phone", "Month",
                             "Fee Paid", "Payment Mode"]
    months = ["Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec", "Jan"]
    assert {r["Month"] for r in rows} == set(months)

    # 300 students with unique phones, exactly one row per student per month
    by_phone = defaultdict(list)
    for r in rows:
        by_phone[r["Student Phone"]].append(r)
    assert len(by_phone) == 300
    for phone_rows in by_phone.values():
        assert sorted(r["Month"] for r in phone_rows) == sorted(months)
        assert len({r["Batch"] for r in phone_rows}) == 1           # student -> one batch

    # (Student Name, Month) stays unique
    assert len({(r["Student Name"], r["Month"]) for r in rows}) == 3000

    # Student Phone -> Student Name is violated by exactly the 8 variant rows
    violating = 0
    for phone_rows in by_phone.values():
        top = Counter(r["Student Name"] for r in phone_rows).most_common(1)[0][1]
        violating += len(phone_rows) - top
    assert violating == 8
    # ... which are exactly two spellings of each of the four students
    variants = Counter()
    for phone_rows in by_phone.values():
        common = Counter(r["Student Name"] for r in phone_rows).most_common(1)[0][0]
        for r in phone_rows:
            if r["Student Name"] != common:
                assert norm(r["Student Name"]) == norm(common)
                variants[norm(common)] += 1
    assert variants == Counter({"riya sharma": 2, "aman verma": 2, "neha singh": 2, "karan mehta": 2})
    # student names are globally unique (after normalising), so variants never collide with another student
    names = {norm(common) for common in (Counter(r["Student Name"] for r in pr).most_common(1)[0][0]
                                         for pr in by_phone.values())}
    assert len(names) == 300
    priya = {r["Student Phone"] for r in rows if norm(r["Student Name"]) == "priya sharma"}
    riya = {r["Student Phone"] for r in rows if norm(r["Student Name"]) == "riya sharma"}
    assert len(priya) == 1 and len(riya) == 1 and priya != riya
    # no whitespace padding (import strips cells; a padded variant would vanish)
    assert all(r["Student Name"] == r["Student Name"].strip() for r in rows)

    # batches, teachers, fees
    assert len({r["Batch"] for r in rows}) == 8
    assert len({r["Teacher"] for r in rows}) == 6
    teacher_of = defaultdict(set)
    for r in rows:
        teacher_of[r["Batch"]].add(r["Teacher"])
    assert all(len(t) == 1 for t in teacher_of.values())              # batch -> teacher
    batches_per_teacher = Counter(next(iter(t)) for t in teacher_of.values())
    assert max(batches_per_teacher.values()) == 2
    phones_per_teacher = defaultdict(Counter)
    for r in rows:
        phones_per_teacher[r["Teacher"]][r["Teacher Phone"]] += 1
    for teacher, phones in phones_per_teacher.items():
        assert len(phones) == (2 if teacher == "Mr. Gupta" else 1), teacher
    teacher_phones = {p for c in phones_per_teacher.values() for p in c}
    assert len(teacher_phones) == 7 and not teacher_phones & set(by_phone)

    fee_by_family = {"JEE": 4000, "NEET": 3500, "Foundation": 2500}
    unpaid = partial = 0
    for r in rows:
        if r["Fee Paid"] == "0":
            unpaid += 1
            assert r["Payment Mode"] == ""
        else:
            family = next(f for f in fee_by_family if r["Batch"].startswith(f))
            full = fee_by_family[family]
            assert int(r["Fee Paid"]) in {full, full // 2, full * 3 // 5, full * 3 // 4}
            partial += int(r["Fee Paid"]) != full
            assert r["Payment Mode"] in {"Cash", "UPI", "Card"}
    assert 0.05 < unpaid / 3000 < 0.11
    assert 0.10 < partial / (3000 - unpaid) < 0.20


def test_kirana_shape_and_plants():
    name, rows = load("kirana_sales")
    assert name == "kirana_sales.csv"
    assert list(rows[0]) == ["Bill No", "Date", "Customer", "Customer Phone", "Item", "Category",
                             "Unit Price", "Qty", "Amount"]
    bills = defaultdict(list)
    for r in rows:
        bills[r["Bill No"]].append(r)
    assert len(bills) == 600
    for lines in bills.values():
        assert 1 <= len(lines) <= 6
        assert len({ln["Item"] for ln in lines}) == len(lines)         # distinct items per bill
        assert len({ln["Date"] for ln in lines}) == 1
    assert len({r["Customer Phone"] for r in rows}) == 80
    assert len({r["Item"] for r in rows}) == 40 and len({r["Category"] for r in rows}) == 6
    assert any("." in r["Unit Price"] for r in rows)
    for r in rows:
        assert Decimal(r["Amount"]) == Decimal(r["Unit Price"]) * int(r["Qty"])
        d, m, y = r["Date"].split("/")
        assert len(d) == 2 and len(m) == 2 and len(y) == 4 and 1 <= int(d) <= 31 and 1 <= int(m) <= 12

    dal = Counter(Decimal(r["Unit Price"]) for r in rows if r["Item"] == "Toor Dal 1kg")
    assert len(dal) == 2 and min(dal.values()) == 3                    # old price in exactly 3 rows
    assert sum(r["Customer"] == "Mohan lal" for r in rows) == 3
    assert sum(r["Customer"] == "Mohan Lal" for r in rows) > 3
    assert len({(r["Item"], r["Category"]) for r in rows}) == 40
    assert len({(r["Customer Phone"], r["Customer"]) for r in rows}) == 81    # 80 customers + 1 variant spelling


def test_hostel_rows():
    assert len(list(csv.reader(io.StringIO(generate("hostel_mess")[1].decode())))) == 2521


def test_hostel_structure_and_plants():
    name, rows = load("hostel_mess")
    assert name == "hostel_mess.csv"
    assert list(rows[0]) == ["Room", "Student", "Hostel Block", "Warden", "Date", "Meal",
                             "Menu Item", "Attended"]
    assert len({r["Student"] for r in rows}) == 60
    assert len({r["Date"] for r in rows}) == 14
    assert {r["Meal"] for r in rows} == {"Breakfast", "Lunch", "Dinner"}
    assert {r["Attended"] for r in rows} == {"Yes", "No"}
    assert len({(r["Student"], r["Date"], r["Meal"]) for r in rows}) == 2520
    assert len({(r["Room"], r["Hostel Block"]) for r in rows}) == len({r["Room"] for r in rows})   # room -> block
    assert len({(r["Date"], r["Meal"], r["Menu Item"]) for r in rows}) == 14 * 3
    assert sum(r["Warden"] == "Mrs Rao" for r in rows) == 2
    wardens = defaultdict(set)
    for r in rows:
        wardens[r["Hostel Block"]].add(r["Warden"])
    assert wardens["B"] == {"Mrs. Rao", "Mrs Rao"} and len(wardens) == 3
    assert all(len(w) == 1 for b, w in wardens.items() if b != "B")


def test_samples_are_deterministic():
    for name in ("fee_register", "kirana_sales", "hostel_mess"):
        assert generate(name) == generate(name)
