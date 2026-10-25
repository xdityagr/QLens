"""Pure-Python functional-dependency algebra: closure, minimal cover, 3NF synthesis."""
from __future__ import annotations

from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field


@dataclass(frozen=True)
class FD:
    lhs: frozenset[str]
    rhs: str


@dataclass
class Relation:
    determinant: tuple[str, ...] | None
    equivalents: list[tuple[str, ...]] = field(default_factory=list)
    attributes: tuple[str, ...] = ()
    is_fact: bool = False


def closure(attrs: Iterable[str], fds: Sequence[FD]) -> frozenset[str]:
    result = set(attrs)
    changed = True
    while changed:
        changed = False
        for fd in fds:
            if fd.rhs not in result and fd.lhs <= result:
                result.add(fd.rhs)
                changed = True
    return frozenset(result)


def minimal_cover(fds: Sequence[FD], order: Sequence[str]) -> list[FD]:
    """Canonical cover. Deterministic: all tie-breaks follow the column order."""
    ordinal = {a: i for i, a in enumerate(order)}

    def lhs_key(lhs: Iterable[str]) -> tuple[int, ...]:
        return tuple(sorted(ordinal[a] for a in lhs))

    ordered = sorted(
        {fd for fd in fds if fd.rhs not in fd.lhs},
        key=lambda fd: (len(fd.lhs), lhs_key(fd.lhs), ordinal[fd.rhs]),
    )

    # Left-reduce: drop an LHS attribute when the rest still implies the RHS.
    work = list(ordered)
    for i, fd in enumerate(work):
        lhs = set(fd.lhs)
        for a in sorted(fd.lhs, key=lambda x: ordinal[x], reverse=True):
            if len(lhs) > 1 and fd.rhs in closure(lhs - {a}, work):
                lhs.discard(a)
        work[i] = FD(frozenset(lhs), fd.rhs)

    deduped: list[FD] = []
    for fd in work:
        if fd not in deduped:
            deduped.append(fd)

    # Remove redundant FDs, scanning last to first.
    for i in range(len(deduped) - 1, -1, -1):
        fd = deduped[i]
        rest = deduped[:i] + deduped[i + 1:]
        if fd.rhs in closure(fd.lhs, rest):
            deduped = rest
    return deduped


def synthesize_3nf(
    attributes: Sequence[str], fds: Sequence[FD], keys: Sequence[frozenset[str]]
) -> list[Relation]:
    ordinal = {a: i for i, a in enumerate(attributes)}

    def in_order(attrs: Iterable[str]) -> tuple[str, ...]:
        return tuple(sorted(set(attrs), key=lambda a: ordinal[a]))

    cover = minimal_cover(fds, attributes)

    # Group by LHS, ordered by first appearance.
    groups: list[tuple[frozenset[str], set[str]]] = []
    for fd in cover:
        for lhs, attrs in groups:
            if lhs == fd.lhs:
                attrs.add(fd.rhs)
                break
        else:
            groups.append((fd.lhs, set(fd.lhs) | {fd.rhs}))

    # Merge groups with equivalent determinants (transitively, via the first group they match).
    merged: list[dict] = []
    for lhs, attrs in groups:
        for m in merged:
            if any(lhs <= closure(d, cover) and d <= closure(lhs, cover) for d in m["lhss"]):
                m["lhss"].append(lhs)
                m["attrs"] |= attrs
                break
        else:
            merged.append({"lhss": [lhs], "attrs": set(attrs)})

    relations: list[Relation] = []
    determined: set[str] = set()
    for m in merged:
        by_column = sorted(m["lhss"], key=lambda l: sorted(ordinal[a] for a in l))
        det = in_order(by_column[0])
        relations.append(Relation(
            determinant=det,
            equivalents=[in_order(l) for l in by_column[1:]],
            attributes=in_order(m["attrs"]),
            is_fact=False,
        ))
        determined |= m["attrs"] - set(det)

    fact_attrs = [a for a in attributes if a not in determined]
    fact = next((r for r in relations if set(r.attributes) >= set(fact_attrs)), None)
    if fact is not None:
        fact.is_fact = True
    else:
        key = keys[0] if keys and keys[0] <= set(fact_attrs) else None
        fact = Relation(
            determinant=in_order(key) if key is not None else None,
            equivalents=[],
            attributes=tuple(fact_attrs),
            is_fact=True,
        )
        relations.append(fact)

    # Lossless-join guarantee (Bernstein's key step): if no relation contains a candidate key the
    # decomposition can be lossy (e.g. a key attribute is derivable only through a cycle).
    if keys and not any(any(k <= set(r.attributes) for k in keys) for r in relations):
        key = in_order(keys[0])
        if fact.determinant is None:
            fact.determinant = key
            fact.attributes = in_order(set(fact.attributes) | set(key))
        else:
            fact.is_fact = False
            fact = Relation(determinant=key, equivalents=[], attributes=key, is_fact=True)
            relations.append(fact)

    # Drop entity relations fully contained in another relation (equal sets: keep the earlier/fact one).
    kept: list[Relation] = []
    for i, r in enumerate(relations):
        rs = set(r.attributes)
        redundant = not r.is_fact and any(
            j != i and (rs < set(o.attributes)
                        or (rs == set(o.attributes) and (o.is_fact or j < i)))
            for j, o in enumerate(relations)
        )
        if not redundant:
            kept.append(r)

    covered = {a for r in kept for a in r.attributes}
    missing = [a for a in attributes if a not in covered]
    if missing:
        fact.attributes = in_order(set(fact.attributes) | set(missing))

    return [r for r in kept if not r.is_fact] + [fact]
