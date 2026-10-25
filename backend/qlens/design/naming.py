"""Names for the proposed tables: plural entity names from their determinant, the fact from the file name."""
import re
import unicodedata
from collections.abc import Collection, Sequence

MAX_IDENT = 63
IDENTIFIER = re.compile(r"^[a-z_][a-z0-9_]{0,62}$")

# "student_name" names a student, "bill_no" a bill: the suffix says which attribute, not which thing.
_SUFFIX = re.compile(r"_(name|id|code|no|number)$")


def valid_identifier(name: str) -> bool:
    """A name the user may give a table or column. A leading `_` is reserved (`_staging`, `_raw`, `_row_id`)."""
    return bool(IDENTIFIER.match(name)) and not name.startswith("_")


def pluralize(word: str) -> str:
    if len(word) >= 2 and word.endswith("y") and word[-2] not in "aeiou":
        return word[:-1] + "ies"
    if word.endswith(("s", "x", "ch", "sh")):
        return word + "es"
    return word + "s"


def _fit(name: str, room: int = MAX_IDENT) -> str:
    return name[:room].rstrip("_") or name[:room]


def entity_name(determinant: Sequence[str]) -> tuple[str, str]:
    """(table name, singular) for the entity identified by these columns."""
    singular = "_".join(_SUFFIX.sub("", c) or c for c in determinant)
    singular = _fit(singular, MAX_IDENT - len("_id"))      # room for the `<singular>_id` foreign key
    return _fit(pluralize(singular)), singular


def fact_name(filename: str) -> str:
    """The original file's name without its extension, as an identifier ("Fee Register.xlsx" -> fee_register)."""
    stem = filename.rsplit(".", 1)[0] if "." in filename else filename
    folded = unicodedata.normalize("NFKD", stem).encode("ascii", "ignore").decode("ascii")
    name = re.sub(r"[^a-z0-9]+", "_", folded.lower()).strip("_")
    if not name:
        return "records"
    if name[0].isdigit():
        name = f"t_{name}"
    return _fit(name)


def unique_name(name: str, taken: Collection[str]) -> str:
    """`name`, or `name_2`, `name_3`, ... (shortened to stay a valid identifier) if it is already taken."""
    candidate, n = name, 1
    while candidate in taken:
        n += 1
        suffix = f"_{n}"
        candidate = _fit(name, MAX_IDENT - len(suffix)) + suffix
    return candidate
