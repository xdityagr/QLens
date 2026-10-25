# Report status

Build: `latexmk -g -pdf main.tex` -> `report/main.pdf`, 29 pages, no overfull boxes, no undefined references.
Title: "QLens: An Automated Relational Database Design and Normalization System".

## Approach
Syllabus vocabulary only (CSC2103, Korth/Navathe): ER model in textbook notation, ER to relational schema,
keys and integrity constraints, DDL/DML/DCL, joins, subqueries, views, aggregation, triggers, cursors, stored
functions, B-tree indexing, transactions/ACID, relational algebra, functional dependencies, closure,
canonical cover, 3NF decomposition, lossless join, dependency preservation.

## Status
All features built: import, analysis, clean-up, design, apply, Data page (Browse with constraint errors and
the audit trigger, SQL tab with confirmed DML, Step through, Explain & speed up, Ask AI), History.
Tests: final run 507 backend passed (1 skipped), 204 frontend passed.

## Screenshots
Body: final-analyze-dark, final-design-proposal-dark, final-data-browse-dark, final-data-fk-dark, final-stepthrough-dark.
Appendix: final-design-dark (applied, 3,000 rows), final-data-sql-dark, final-perf-index-dark. (final-data-ask-answer-dark shows a rate-limit message, so it is not used.)
If final-*.png arrive, swap them into the uishot/appshot calls in chapters/design.tex and chapters/appendix.tex.
