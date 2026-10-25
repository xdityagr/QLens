import itertools
import random

from qlens.analysis.fd_algebra import FD, closure, minimal_cover, synthesize_3nf


def F(lhs, rhs):
    return FD(frozenset(lhs), rhs)


def test_closure():
    assert closure({"A", "D"}, [F("A", "B"), F("B", "C"), F("CD", "E")]) == set("ABCDE")


def test_closure_no_progress_returns_input():
    assert closure({"X"}, [F("A", "B")]) == frozenset({"X"})


def test_minimal_cover_classic():
    cover = minimal_cover([F("A", "B"), F("A", "C"), F("B", "C"), F("AB", "C")], "ABC")
    assert set(cover) == {F("A", "B"), F("B", "C")}


def test_left_reduction():
    assert minimal_cover([F("A", "B"), F("AB", "C")], "ABC") == [F("A", "B"), F("A", "C")]


def test_minimal_cover_drops_trivial_and_duplicates():
    assert minimal_cover([F("AB", "A"), F("A", "B"), F("A", "B")], "AB") == [F("A", "B")]


def test_minimal_cover_is_equivalent_to_input():
    fds = [F("A", "B"), F("B", "C"), F("AC", "D"), F("D", "A"), F("CD", "B")]
    cover = minimal_cover(fds, "ABCD")
    for attrs in ("A", "B", "C", "D", "AC", "BD"):
        assert closure(set(attrs), cover) == closure(set(attrs), fds)
    assert all(len(fd.lhs) >= 1 and fd.rhs not in fd.lhs for fd in cover)


def test_fee_register_synthesis():
    s, p, b, t, tp, m, f = "s p b t tp m f".split()
    fds = [F([s], p), F([p], s), F([s], b), F([b], t), F([t], tp), F([s, m], f)]
    rels = synthesize_3nf([s, p, b, t, tp, m, f], fds, [frozenset({s, m}), frozenset({p, m})])
    assert [(r.determinant, set(r.attributes), r.is_fact) for r in rels] == [
        ((s,), {s, p, b}, False), ((b,), {b, t}, False), ((t,), {t, tp}, False), ((s, m), {s, m, f}, True)]
    assert rels[0].equivalents == [(p,)]


def test_no_key_fact_keeps_undetermined():
    rels = synthesize_3nf(["c", "cp", "item", "qty"], [F(["c"], "cp")], [])
    assert rels[-1].is_fact and rels[-1].determinant is None and set(rels[-1].attributes) == {"c", "item", "qty"}


def test_fact_absorbs_group_containing_key():
    rels = synthesize_3nf(["A", "B", "C"], [F("A", "B"), F("B", "C")], [frozenset("A")])
    assert [(set(r.attributes), r.is_fact) for r in rels] == [({"B", "C"}, False), ({"A", "B"}, True)]


def test_no_fds_single_fact():
    rels = synthesize_3nf(["a", "b", "c"], [], [frozenset({"b", "a"})])
    assert len(rels) == 1
    assert rels[0].is_fact and rels[0].determinant == ("a", "b")
    assert rels[0].attributes == ("a", "b", "c") and rels[0].equivalents == []
    rels = synthesize_3nf(["a", "b"], [], [])
    assert len(rels) == 1 and rels[0].is_fact and rels[0].determinant is None
    assert rels[0].attributes == ("a", "b")


def test_equivalent_determinant_stays_in_fact():
    rels = synthesize_3nf(["c", "cp", "item", "qty"], [F(["c"], "cp"), F(["cp"], "c")], [])
    assert set(rels[-1].attributes) == {"c", "item", "qty"} and rels[0].equivalents == [("cp",)]


def test_attributes_follow_column_order():
    rels = synthesize_3nf(["z", "y", "x", "w"], [F(["x"], "z"), F(["x"], "y")], [frozenset({"x", "w"})])
    assert rels[0].attributes == ("z", "y", "x")
    assert rels[-1].is_fact and rels[-1].attributes == ("x", "w")


def test_unmentioned_attribute_lands_in_fact():
    # 'n' is in no FD and not part of fact_attrs' source group; it must still be placed somewhere
    rels = synthesize_3nf(["a", "b", "n"], [F(["a"], "b")], [frozenset({"a", "n"})])
    assert "n" in rels[-1].attributes and rels[-1].is_fact
    assert set().union(*(set(r.attributes) for r in rels)) == {"a", "b", "n"}


def test_key_is_kept_when_only_derivable_through_other_relations():
    # Key {a,b,c}: b is determined (d -> b) yet needed in the key, so the fact built from the
    # undetermined columns {a,c} alone would not contain a key and the join would be lossy.
    cols = list("abcdef")
    fds = [F("d", "b"), F("df", "b"), F("db", "e"), F("ab", "d"), F("d", "f")]
    keys = [frozenset("abc"), frozenset("acd")]
    rels = synthesize_3nf(cols, fds, keys)
    assert rels[-1].is_fact and sum(r.is_fact for r in rels) == 1
    assert any(k <= set(r.attributes) for r in rels for k in keys)
    assert set().union(*(set(r.attributes) for r in rels)) == set(cols)


def _shape(rels):
    return [(r.determinant, r.equivalents, r.attributes, r.is_fact) for r in rels]


def test_no_keys_still_lossless_when_fact_columns_do_not_reach_everything():
    # de -> f, f -> e: the undetermined columns {a,b,c,d} alone never reach e/f.
    rels = synthesize_3nf(list("abcdef"), [F("de", "f"), F("f", "e")], [])
    assert _shape(rels) == [
        (("d", "e"), [], ("d", "e", "f"), False),
        (None, [], ("a", "b", "c", "d", "e"), True),
    ]


def test_data_key_that_is_not_an_fd_key_pulls_missing_column_into_fact():
    cols = ["student", "date", "period", "subject", "teacher"]
    fds = [F(["teacher"], "subject"), F(["student", "subject"], "teacher")]
    rels = synthesize_3nf(cols, fds, [frozenset({"student", "date", "period"})])
    assert _shape(rels) == [
        (("student", "subject"), [], ("student", "subject", "teacher"), False),
        # determinant stays the data key: it is unique in the data and contained in the fact
        (("student", "date", "period"), [], ("student", "date", "period", "subject"), True),
    ]


def test_equivalence_redundant_fd_is_pruned_after_merging():
    # Bernstein step 5: c -> a used to leave a non-prime attribute in a merged relation.
    fds = [F("ac", "f"), F("cf", "a"), F("be", "d"), F("ef", "d"), F("bc", "f"), F("bc", "d"),
           F("bd", "c"), F("ad", "c"), F("c", "a")]
    rels = synthesize_3nf(list("abcdef"), fds, [])
    assert _shape(rels) == [
        (("c",), [], ("a", "c", "f"), False),
        (("a", "d"), [], ("a", "c", "d"), False),
        (("b", "c"), [("b", "d")], ("b", "c", "d"), False),
        (("e", "f"), [], ("d", "e", "f"), False),
        (("b", "e"), [], ("b", "d", "e"), True),
    ]
    assert all(_is_3nf(r.attributes, fds) for r in rels)


def test_equivalent_first_column_is_not_dragged_into_fact():
    # ce -> b, a <-> b: a is derivable (ce -> b -> a), so it must not sit in the fact next to c,d,e,f.
    fds = [F("ce", "b"), F("a", "b"), F("b", "a")]
    rels = synthesize_3nf(list("abcdef"), fds, [frozenset("cdef")])
    assert _shape(rels) == [
        (("a",), [("b",)], ("a", "b"), False),
        (("c", "e"), [], ("b", "c", "e"), False),
        (("c", "d", "e", "f"), [], ("c", "d", "e", "f"), True),
    ]


# --- property check: lossless join (tableau chase) and 3NF of every relation ---

def _candidate_keys(attrs, fds):
    full, found = set(attrs), []
    for n in range(1, len(attrs) + 1):
        for c in itertools.combinations(attrs, n):
            s = frozenset(c)
            if not any(k <= s for k in found) and closure(s, fds) >= full:
                found.append(s)
    return found


def _is_3nf(rel_attrs, fds):
    r = set(rel_attrs)
    subsets = [set(c) for n in range(1, len(r) + 1) for c in itertools.combinations(sorted(r), n)]
    keys = []
    for s in subsets:
        if not any(k <= s for k in keys) and closure(s, fds) & r >= r:
            keys.append(s)
    prime = set().union(*keys)
    return all(
        closure(z, fds) & r >= r or a in prime
        for z in subsets for a in (closure(z, fds) & r) - z
    )


def _lossless(attrs, rels, fds):
    rows = [{a: ("d", a) if a in r else ("b", i, a) for a in attrs} for i, r in enumerate(rels)]
    changed = True
    while changed:
        changed = False
        for fd in fds:
            for r1 in rows:
                for r2 in rows:
                    if r1 is not r2 and all(r1[x] == r2[x] for x in fd.lhs) and r1[fd.rhs] != r2[fd.rhs]:
                        keep, drop = (r1[fd.rhs], r2[fd.rhs]) if r1[fd.rhs][0] == "d" else (r2[fd.rhs], r1[fd.rhs])
                        for r in rows:
                            if r[fd.rhs] == drop:
                                r[fd.rhs] = keep
                        changed = True
    return any(all(r[a] == ("d", a) for a in attrs) for r in rows)


def test_random_fd_sets_give_lossless_3nf_decompositions():
    rng = random.Random(20261025)
    for _ in range(300):
        attrs = list("abcdef"[: rng.randint(3, 6)])
        fds = []
        for _ in range(rng.randint(0, 6)):
            lhs = frozenset(rng.sample(attrs, rng.randint(1, 2)))
            rhs = rng.choice(attrs)
            if rhs not in lhs:
                fds.append(FD(lhs, rhs))
        real = _candidate_keys(attrs, fds)
        rng.shuffle(real)
        # real keys, no keys at all, and an arbitrary "data key" unrelated to the FDs
        for keys in (real, [], [frozenset(rng.sample(attrs, rng.randint(1, 3)))]):
            rels = synthesize_3nf(attrs, fds, keys)
            where = (attrs, fds, keys, _shape(rels))
            assert sum(r.is_fact for r in rels) == 1 and rels[-1].is_fact, where
            assert set().union(*(set(r.attributes) for r in rels)) == set(attrs), where
            assert closure(rels[-1].attributes, fds) >= set(attrs), where
            assert _lossless(attrs, [r.attributes for r in rels], fds), where
            assert all(_is_3nf(r.attributes, fds) for r in rels), where
