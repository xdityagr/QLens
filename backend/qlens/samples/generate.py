"""Deterministic sample datasets with planted data-quality problems.

Every later demo and test relies on the exact numbers below, so they are asserted at generation time
and again in tests/test_samples.py. All randomness comes from random.Random(2026).

Guarantees (do not change without updating the tests that depend on them)

fee_register.csv  (3000 rows = 300 students x 10 months)
  * Each student has exactly ONE row per month (Apr..Jan). A variant spelling replaces the student's
    name in that row, so (Student Name, Month) stays unique.
  * Student names and student phones are globally unique; each student is in exactly one batch.
    'Priya Sharma' is a distinct, genuine student (own phone) and has no variants.
  * Variants: Riya Sharma, Aman Verma, Neha Singh and Karan Mehta each appear in exactly 2 rows under a
    lower-case spelling and a double-space spelling (never padded with leading/trailing blanks, which
    import would strip). They show up as the approximate FD  Student Phone -> Student Name with exactly
    8 violating rows.
  * batch -> teacher is exact (6 teachers, 8 batches; Mr. Gupta and Ms. Iyer have two batches each).
    Each teacher's phone is constant except Mr. Gupta's old number, which appears in exactly 5 rows
    (the first five April rows of his batches).
  * Fee Paid depends on the batch family (JEE 4000, NEET 3500, Foundation 2500); about 8% of rows are
    unpaid with Fee Paid 0 and an empty Payment Mode, and about 15% of the paid rows are partial
    payments (50%, 60% or 75% of the fee) with the Payment Mode drawn per row. Partial payments are
    spread at random so no pair of columns other than a key determines Fee Paid. Phones are written "+91 98765 43210" so they are
    inferred as text, not numbers.

kirana_sales.csv  (600 bills, 1-6 distinct items each)
  * Date is written dd/mm/yyyy.
  * 80 customers, 40 items in 6 categories; Amount = Unit Price x Qty in every row.
  * Planted: 'Toor Dal 1kg' has its old price in exactly 3 rows (the first three it appears in, Amount
    consistent with that price); 'Mohan Lal' is written 'Mohan lal' in exactly 3 rows.

hostel_mess.csv  (60 students x 14 days x 3 meals = 2520 rows)
  * Date is written yyyy-mm-dd; Attended is Yes or No.
  * Room is text such as "B-204" (block letter + number); room -> block and block -> warden are exact apart from the plant; one menu item per (date, meal).
  * Planted: Block B's warden 'Mrs. Rao' is written 'Mrs Rao' in exactly 2 rows.
"""

import csv
import io
import random
from datetime import date, timedelta
from decimal import Decimal
from typing import Literal

SampleName = Literal["fee_register", "kirana_sales", "hostel_mess"]
SEED = 2026


def generate(name: SampleName) -> tuple[str, bytes]:
    """Return (filename, UTF-8 CSV bytes) of the named sample."""
    builders = {"fee_register": _fee_register, "kirana_sales": _kirana_sales, "hostel_mess": _hostel_mess}
    if name not in builders:
        raise ValueError(f"unknown sample: {name}")
    header, rows = builders[name](random.Random(SEED))
    buf = io.StringIO()
    writer = csv.writer(buf, lineterminator="\n")
    writer.writerow(header)
    writer.writerows(rows)
    return f"{name}.csv", buf.getvalue().encode("utf-8")


def _phone(rng: random.Random, used: set[str]) -> str:
    while True:
        digits = f"9{rng.randrange(10**9):09d}"
        phone = f"+91 {digits[:5]} {digits[5:]}"
        if phone not in used:
            used.add(phone)
            return phone


# ---- fee_register ---------------------------------------------------------------------------------

_FEE_FIRST = ["Aarav", "Vivaan", "Aditya", "Arjun", "Ishaan", "Kabir", "Rohan", "Sai", "Dev", "Yash",
              "Riya", "Priya", "Neha", "Anaya", "Diya", "Kavya", "Meera", "Pooja", "Sneha", "Tanvi",
              "Aman", "Karan", "Rahul", "Vikram", "Nikhil", "Ananya", "Isha", "Ritu", "Simran", "Tara"]
_FEE_LAST = ["Sharma", "Verma", "Singh", "Mehta", "Patel", "Kulkarni", "Reddy", "Joshi", "Desai", "Bhatt",
             "Chopra", "Malhotra", "Kapoor", "Yadav", "Pandey"]
_FEE_MUST_EXIST = ["Riya Sharma", "Aman Verma", "Neha Singh", "Karan Mehta", "Priya Sharma"]
_FEE_VARIANT_OF = _FEE_MUST_EXIST[:4]

# batch -> (family, teacher)
_BATCHES = [
    ("JEE Morning", "JEE", "Mr. Gupta"), ("JEE Evening", "JEE", "Mr. Gupta"),
    ("NEET Morning", "NEET", "Ms. Iyer"), ("NEET Evening", "NEET", "Ms. Iyer"),
    ("NEET Dropper", "NEET", "Dr. Rao"), ("Foundation 8", "Foundation", "Mr. Khan"),
    ("Foundation 9", "Foundation", "Ms. Das"), ("Foundation 10", "Foundation", "Mr. Nair"),
]
_TEACHER_PHONE = {"Mr. Gupta": "+91 98100 11001", "Ms. Iyer": "+91 98100 22002", "Dr. Rao": "+91 98100 33003",
                  "Mr. Khan": "+91 98100 44004", "Ms. Das": "+91 98100 55005", "Mr. Nair": "+91 98100 66006"}
_GUPTA_OLD_PHONE = "+91 98100 99009"
_FEE = {"JEE": 4000, "NEET": 3500, "Foundation": 2500}
_PARTIAL_SHARE = 0.15
_PARTIAL_FRACTIONS = [(1, 2), (3, 5), (3, 4)]
_MONTHS = ["Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec", "Jan"]


def _fee_register(rng: random.Random):
    header = ["Student Name", "Student Phone", "Batch", "Teacher", "Teacher Phone", "Month", "Fee Paid",
              "Payment Mode"]
    pool = [f"{f} {l}" for f in _FEE_FIRST for l in _FEE_LAST if f"{f} {l}" not in _FEE_MUST_EXIST]
    names = _FEE_MUST_EXIST + rng.sample(pool, 300 - len(_FEE_MUST_EXIST))
    rng.shuffle(names)
    used = set(_TEACHER_PHONE.values()) | {_GUPTA_OLD_PHONE}
    students = [(n, _phone(rng, used), _BATCHES[i % len(_BATCHES)]) for i, n in enumerate(names)]

    # name -> {month index -> variant spelling}
    variants: dict[str, dict[int, str]] = {}
    for name in _FEE_VARIANT_OF:
        m1, m2 = rng.sample(range(len(_MONTHS)), 2)
        variants[name] = {m1: name.lower(), m2: name.replace(" ", "  ")}

    rows = []
    gupta_old_left = 5
    for mi, month in enumerate(_MONTHS):
        for name, phone, (batch, family, teacher) in students:
            shown = variants.get(name, {}).get(mi, name)
            tphone = _TEACHER_PHONE[teacher]
            if mi == 0 and teacher == "Mr. Gupta" and gupta_old_left:
                tphone, gupta_old_left = _GUPTA_OLD_PHONE, gupta_old_left - 1
            if rng.random() < 0.08:
                fee, mode = 0, ""
            else:
                fee, mode = _FEE[family], rng.choice(["Cash", "UPI", "Card"])
                if rng.random() < _PARTIAL_SHARE:
                    num, den = rng.choice(_PARTIAL_FRACTIONS)
                    fee = fee * num // den
            rows.append([shown, phone, batch, teacher, tphone, month, fee, mode])
    assert gupta_old_left == 0 and len(rows) == 3000
    return header, rows


# ---- kirana_sales ---------------------------------------------------------------------------------

_KIRANA_FIRST = ["Mohan", "Suresh", "Ramesh", "Geeta", "Sunita", "Lakshmi", "Anil", "Rajesh", "Kiran", "Deepa",
                 "Manoj", "Seema", "Ajay", "Usha", "Vijay", "Radha", "Harish", "Pushpa", "Sanjay", "Kamla"]
_KIRANA_LAST = ["Lal", "Devi", "Kumar", "Rao", "Nair", "Pillai", "Shah", "Khan"]

_ITEMS = [  # (item, category, unit price)
    ("Toor Dal 1kg", "Grains & Pulses", "160"), ("Moong Dal 1kg", "Grains & Pulses", "145"),
    ("Chana Dal 1kg", "Grains & Pulses", "118.50"), ("Basmati Rice 1kg", "Grains & Pulses", "110"),
    ("Atta 5kg", "Grains & Pulses", "245"), ("Sugar 1kg", "Grains & Pulses", "46.50"),
    ("Poha 500g", "Grains & Pulses", "52"), ("Besan 500g", "Grains & Pulses", "68"),
    ("Milk 1L", "Dairy & Eggs", "66"), ("Curd 400g", "Dairy & Eggs", "35"),
    ("Paneer 200g", "Dairy & Eggs", "95"), ("Butter 100g", "Dairy & Eggs", "58"),
    ("Eggs 12 Pack", "Dairy & Eggs", "84"), ("Ghee 500ml", "Dairy & Eggs", "310"),
    ("Cheese Slices 200g", "Dairy & Eggs", "125.50"),
    ("Parle-G Biscuits", "Snacks", "10"), ("Marie Biscuits", "Snacks", "30"),
    ("Namkeen Mixture 200g", "Snacks", "55"), ("Potato Chips", "Snacks", "52.50"),
    ("Rusk 300g", "Snacks", "40"), ("Peanut Chikki", "Snacks", "25"), ("Instant Noodles", "Snacks", "14"),
    ("Tea Leaves 250g", "Beverages", "135"), ("Coffee Powder 100g", "Beverages", "190"),
    ("Cold Drink 1L", "Beverages", "65"), ("Mango Juice 1L", "Beverages", "98"),
    ("Packaged Water 1L", "Beverages", "20"), ("Green Tea 25 Bags", "Beverages", "175.50"),
    ("Detergent Powder 1kg", "Household", "105"), ("Dishwash Liquid 500ml", "Household", "99"),
    ("Floor Cleaner 1L", "Household", "175"), ("Phenyl 500ml", "Household", "62.50"),
    ("Matchbox", "Household", "10"), ("Garbage Bags 30 pcs", "Household", "75"),
    ("Bathing Soap", "Personal Care", "38"), ("Toothpaste 100g", "Personal Care", "72"),
    ("Shampoo 180ml", "Personal Care", "135"), ("Hair Oil 100ml", "Personal Care", "62"),
    ("Hand Wash 200ml", "Personal Care", "89"), ("Face Wash 50g", "Personal Care", "99.50"),
]
_TOOR_OLD_PRICE = Decimal("148")


def _kirana_sales(rng: random.Random):
    header = ["Bill No", "Date", "Customer", "Customer Phone", "Item", "Category", "Unit Price",
              "Qty", "Amount"]
    assert len(_ITEMS) == 40 and len({c for _, c, _ in _ITEMS}) == 6
    pool = [f"{f} {l}" for f in _KIRANA_FIRST for l in _KIRANA_LAST if f"{f} {l}" != "Mohan Lal"]
    names = ["Mohan Lal"] + rng.sample(pool, 79)
    used: set[str] = set()
    customers = [(n, _phone(rng, used)) for n in names]
    # every customer shops at least once; the remaining bills pick customers at random
    order = customers[:]
    rng.shuffle(order)
    start = date(2026, 7, 1)
    days = sorted(rng.randrange(90) for _ in range(600))

    rows = []
    for b in range(600):
        cust, phone = order[b] if b < len(order) else rng.choice(customers)
        bill_date = (start + timedelta(days=days[b])).strftime("%d/%m/%Y")
        for item, category, price in rng.sample(_ITEMS, rng.randint(1, 6)):
            rows.append([f"KB-{b + 1:04d}", bill_date, cust, phone, item, category, Decimal(price),
                         rng.randint(1, 5), None])

    toor = [r for r in rows if r[4] == "Toor Dal 1kg"]
    for r in toor[:3]:
        r[6] = _TOOR_OLD_PRICE
    mohan = [r for r in rows if r[2] == "Mohan Lal"]
    assert len(toor) > 3 and len(mohan) > 3
    for r in rng.sample(mohan, 3):
        r[2] = "Mohan lal"
    for r in rows:
        r[8] = r[6] * r[7]
    return header, rows


# ---- hostel_mess ----------------------------------------------------------------------------------

_HOSTEL_FIRST = ["Aarav", "Vivaan", "Aditya", "Arjun", "Ishaan", "Kabir", "Rohan", "Sai", "Dev", "Yash",
                 "Aman", "Karan", "Rahul", "Vikram", "Nikhil", "Harsh", "Mihir", "Tushar", "Varun", "Zaid"]
_HOSTEL_LAST = ["Sharma", "Patel", "Reddy"]
_BLOCKS = [("A", "Mr. Sharma", range(101, 111)), ("B", "Mrs. Rao", range(201, 211)),
           ("C", "Mr. Thomas", range(301, 311))]
_MENU = {
    "Breakfast": ["Poha", "Idli Sambar", "Aloo Paratha", "Upma", "Bread Omelette", "Dosa", "Puri Bhaji"],
    "Lunch": ["Dal Rice", "Rajma Chawal", "Chole Bhature", "Kadhi Rice", "Veg Pulao", "Aloo Gobi Roti",
              "Sambar Rice"],
    "Dinner": ["Paneer Butter Masala", "Egg Curry", "Mixed Veg", "Dal Tadka Roti", "Khichdi", "Chicken Curry",
               "Veg Biryani"],
}


def _hostel_mess(rng: random.Random):
    header = ["Room", "Student", "Hostel Block", "Warden", "Date", "Meal", "Menu Item",
              "Attended"]
    names = rng.sample([f"{f} {l}" for f in _HOSTEL_FIRST for l in _HOSTEL_LAST], 60)
    rooms = [(room, block, warden) for block, warden, nums in _BLOCKS for room in (f"{block}-{n}" for n in nums)]   # 30 rooms
    # two students per room
    students = [(names[2 * i + k], *rooms[i]) for i in range(30) for k in range(2)]
    start = date(2026, 8, 3)
    rows = []
    for d in range(14):
        day = (start + timedelta(days=d)).isoformat()
        for meal, items in _MENU.items():
            menu_item = rng.choice(items)
            for student, room, block, warden in students:
                rows.append([room, student, block, warden, day, meal, menu_item,
                             "Yes" if rng.random() < 0.85 else "No"])
    block_b = [r for r in rows if r[2] == "B"]
    for r in rng.sample(block_b, 2):
        r[3] = "Mrs Rao"
    assert len(rows) == 2520
    return header, rows
