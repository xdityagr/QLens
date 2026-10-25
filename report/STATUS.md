# Report status

Build: `latexmk -pdf main.tex` (or `.\build.ps1` / `make`) -> `report/main.pdf`, 29 pages, no overfull boxes,
no undefined references. Format: 12pt, 1.25 line spacing, TOC depth 1 (fits one page), short captions.

## Structure (format order)
Cover, Abstract, TOC, List of Figures, List of Tables; 1 Introduction (1.1 Scope of the Work, 1.2 Product
Scenarios); 2 Requirement Analysis (FR, NFR, Use Case Scenarios, Other SE Methodologies with test summary);
3 System Design (Design Goals, System Architecture, Detailed Design Methodologies); 4 Conclusion; References;
Appendix A (sample datasets, screen gallery).

## Status markers (update when built)
- Built: import, discovery, clean-up, 3NF synthesis, proposal + DDL, apply + lossless check, landing,
  dashboard, Analyze.
- In progress (`\stwip`): design canvas (FR-8), sandboxed query runner (FR-9, fig:seq-query), assistant (FR-10).
- Planned (`\stplan`): performance lab and step-through (FR-11).
- Test counts: 229 backend (latest full run, query-runner tests excluded), 63 frontend.

## Figures
architecture, er (one landscape page from er-part1 + er-part2), pipeline, usecase, fee-example,
sequence-query, bernstein (algorithm). Screenshots used: landing-hero, dashboard-dark, import-dark,
analyze-issues-dark; gallery: login-dark, landing-how, dashboard-light, analyze-clean-dark.

## Open
- University logo: put figures/muj-logo.png (4.56in x 0.9in) to replace the framed placeholder.
- When the canvas/query runner/assistant land: flip their markers, solidify their modules in
  figures/architecture.tex, and add a design-canvas screenshot (replace analyze-clean in the gallery).
