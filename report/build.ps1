# Builds report/main.pdf with pdflatex + bibtex via latexmk.
Set-Location $PSScriptRoot
latexmk -pdf -interaction=nonstopmode -halt-on-error main.tex
