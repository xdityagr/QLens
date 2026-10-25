# Report status

Build: `latexmk -pdf main.tex` (or `.\build.ps1` / `make`) -> `report/main.pdf` (52 pages at last build).

## Complete (owned by the figure/preamble author)
- preamble.tex (typography, lane colours, SQL listings style, crow's-foot arrow tips, `\screenshot` macro, status macros `\stdone` `\stwip` `\stplan`)
- main.tex (cover page with real names/reg. nos./supervisor/year/section, roman front matter, robust chapter inputs, `\nocite{*}` + IEEEtran bibliography)
- chapters/abstract.tex, refs.bib
- Figures (TikZ, self-contained figure envs): er-part1 (fig:er1), er-part2 (fig:er2), architecture (fig:architecture), pipeline (fig:pipeline), sequence-query (fig:seq-query), usecase (fig:usecase), fee-example (fig:fee-example), bernstein (alg:bernstein)

## Placeholder / TODO
- fig:seq-query describes the query runner as specified (Task 13); verify message names when built.
- fig:architecture marks query, perf lab, stepthrough and assistant modules dashed (Tasks 13-18); make solid when built.
- fig:pipeline step 8 (apply transaction) depends on Task 11.
- fig:er1/er2 reflect 001_schema.sql incl. the draft/applied partial unique indexes; add chat/conversation tables when Task 18 adds them.
- University logo: place figures/muj-logo.png (4.56in x 0.9in) to replace the framed placeholder.
- Undefined ref `ch:implementation` in chapters/requirements.tex (NFR-6 row).

## Screenshot slots (report/screenshots/<file>.png)
sign-in, dashboard (light + dark), import, analyze (issues), analyze (clean), design canvas / ER, generated SQL,
apply + lossless result, query editor, step-through, performance plan tree + index experiment, history, assistant chat.
