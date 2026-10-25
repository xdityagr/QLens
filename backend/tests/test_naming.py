import pytest

from qlens.design.naming import entity_name, fact_name, pluralize, unique_name, valid_identifier


@pytest.mark.parametrize("det,expected", [
    (["teacher"], ("teachers", "teacher")), (["batch"], ("batches", "batch")),
    (["student_name"], ("students", "student")), (["category"], ("categories", "category")),
    (["date", "meal"], ("date_meals", "date_meal")), (["hostel_block"], ("hostel_blocks", "hostel_block")),
    (["bill_no"], ("bills", "bill")), (["item_code"], ("items", "item")), (["roll_number"], ("rolls", "roll")),
    (["customer_id"], ("customers", "customer")),
])
def test_entity_name(det, expected):
    assert entity_name(det) == expected


@pytest.mark.parametrize("word,plural", [
    ("day", "days"), ("city", "cities"), ("box", "boxes"), ("class", "classes"), ("dish", "dishes"),
    ("room", "rooms"),
])
def test_pluralize(word, plural):
    assert pluralize(word) == plural


def test_bare_suffix_is_kept():
    # A column called just "name" or "id" has nothing left after stripping; it keeps its own name.
    assert entity_name(["name"]) == ("names", "name")


def test_long_names_stay_valid_identifiers():
    plural, singular = entity_name(["x" * 63])
    assert valid_identifier(plural) and valid_identifier(f"{singular}_id")


@pytest.mark.parametrize("filename,name", [
    ("fee_register.csv", "fee_register"), ("Fee Register (2024).xlsx", "fee_register_2024"),
    ("2024 sales.csv", "t_2024_sales"), ("....csv", "records"), ("data", "data"),
])
def test_fact_name(filename, name):
    assert fact_name(filename) == name


def test_unique_name():
    assert unique_name("students", {"teachers"}) == "students"
    assert unique_name("students", {"students"}) == "students_2"
    assert unique_name("students", {"students", "students_2"}) == "students_3"
    assert len(unique_name("s" * 63, {"s" * 63})) == 63


@pytest.mark.parametrize("name,ok", [
    ("learners", True), ("Bad Name", False), ("_hidden", False), ("1st", False), ("a" * 63, True),
    ("a" * 64, False), ("group", True), ("", False), ("abc\n", False), ("learners\n", False),
])
def test_valid_identifier(name, ok):
    assert valid_identifier(name) is ok
