-- Dependency discovery runs inside the database: these functions inspect a staged table with
-- dynamic SQL, so the heavy lifting (grouping up to 100,000 rows per candidate) never leaves PostgreSQL.
-- The schema and table names are passed in as text and always go through format('%I').

-- Does the functional dependency p_lhs -> p_rhs hold in p_schema.p_table, and how badly is it broken?
--   row_count        rows in the table
--   lhs_values       distinct LHS combinations
--   repeated_groups  LHS combinations that occur in at least two rows (a dependency that was never
--                    tested against a repeated value proves nothing)
--   violating_rows   rows that would have to change for the dependency to hold: per LHS group,
--                    every row except those carrying the most common RHS value
-- NULL is treated as an ordinary value (GROUP BY puts all NULLs in one group), which matches how the
-- normalized design will store it.
CREATE FUNCTION qlens.check_fd(p_schema text, p_table text, p_lhs text[], p_rhs text)
RETURNS TABLE (row_count bigint, lhs_values bigint, repeated_groups bigint, violating_rows bigint)
LANGUAGE plpgsql STABLE AS $$
DECLARE
    t   text := format('%I.%I', p_schema, p_table);
    lhs text;
BEGIN
    SELECT string_agg(format('%I', c), ', ') INTO lhs FROM unnest(p_lhs) AS c;
    RETURN QUERY EXECUTE format(
        'WITH c AS (SELECT %1$s, %2$I, count(*) AS cnt FROM %3$s GROUP BY %1$s, %2$I), '
        '     g AS (SELECT %1$s, sum(cnt) AS n, max(cnt) AS keep FROM c GROUP BY %1$s) '
        'SELECT (SELECT count(*) FROM %3$s), count(*), count(*) FILTER (WHERE n >= 2), '
        '       coalesce(sum(n - keep), 0)::bigint FROM g',
        lhs, p_rhs, t);
END;
$$;

-- True when no two rows agree on all of p_cols (NULLs compare equal here; the caller separately
-- refuses key columns that contain NULL).
CREATE FUNCTION qlens.is_unique(p_schema text, p_table text, p_cols text[]) RETURNS boolean
LANGUAGE plpgsql STABLE AS $$
DECLARE
    t     text := format('%I.%I', p_schema, p_table);
    cols  text;
    total bigint;
    uniq  bigint;
BEGIN
    SELECT string_agg(format('%I', c), ', ') INTO cols FROM unnest(p_cols) AS c;
    EXECUTE format('SELECT count(*) FROM %s', t) INTO total;
    EXECUTE format('SELECT count(*) FROM (SELECT DISTINCT %s FROM %s) d', cols, t) INTO uniq;
    RETURN total = uniq;
END;
$$;
