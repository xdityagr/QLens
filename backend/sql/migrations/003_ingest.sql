-- Helpers for importing spreadsheets.

-- Parses a date written ISO (2026-04-01) or day-first (31/12/2026, 1-2-2026); anything else, or a
-- date that does not exist (2026-02-30, 31/02/2026), gives NULL instead of an error. Type inference
-- calls this on every value of a candidate date column, so a bad value must not abort the import.
-- Day-first is deliberate: the sample data and the target users write dd/mm/yyyy, and a column like
-- "03/04/2026" is therefore read as 3 April.
CREATE FUNCTION qlens.try_date(p text) RETURNS date
LANGUAGE plpgsql STABLE AS $$
BEGIN
    IF p ~ '^\d{4}-\d{2}-\d{2}$' THEN
        RETURN p::date;
    ELSIF p ~ '^\d{1,2}[/-]\d{1,2}[/-]\d{4}$' THEN
        RETURN to_date(replace(p, '-', '/'), 'DD/MM/YYYY');
    END IF;
    RETURN NULL;
EXCEPTION WHEN others THEN
    RETURN NULL;
END;
$$;
