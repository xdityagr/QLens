# Report status

Build: `latexmk -g -pdf main.tex` -> `report/main.pdf`, 29 pages, no overfull boxes, no undefined references.
Title: "QLens: An Automated Relational Database Design and Normalization System".

## Approach
Syllabus vocabulary only (CSC2103): ER model (textbook notation: rectangles, diamonds, 1/N/M), ER to
relational schema, keys and integrity constraints, DDL/DML/DCL, joins, subqueries, views, aggregation,
triggers, cursors, stored functions, B-tree indexing, transactions/ACID, functional dependencies,
closure, canonical cover, 3NF decomposition, lossless join (relational algebra), dependency preservation.
Removed: crow's-foot, Bernstein/minimal-cover naming, trigram/GIN, window functions, g3, plan internals.

## Figures
architecture (3-tier), er (conceptual ER of qlens), relational schema (26 tables), usecase, pipeline,
fee-example (dependency diagram), alg:synthesis, er-generated (fee register ER), seq-query (7 steps).
Body screenshots (5, full width, 16:10): import-crop, analyze-crop, design-erd-dark, design-applied-dark,
query-dark. Appendix: landing-hero, dashboard-dark, history-crop. Crops made with PIL; originals untouched.

## Status markers
Built: import, analysis, clean-up, design, design screen, apply, query screen. In progress: Data screen
(row_changes + audit trigger, migration 006 uncommitted), performance lab, assistant screen.
Tests: 302 backend, 63 frontend.
