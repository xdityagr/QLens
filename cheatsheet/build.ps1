# Builds cheatsheet/QLens-Cheatsheet.pdf with pdflatex via latexmk.
Set-Location $PSScriptRoot
latexmk -pdf -interaction=nonstopmode -halt-on-error -jobname=QLens-Cheatsheet cheatsheet.tex
