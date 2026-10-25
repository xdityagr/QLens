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
