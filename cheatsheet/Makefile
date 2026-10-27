# Builds QLens-Cheatsheet.pdf from cheatsheet.tex (pdflatex via latexmk).
all:
	latexmk -pdf -interaction=nonstopmode -halt-on-error -jobname=QLens-Cheatsheet cheatsheet.tex
clean:
	latexmk -c -jobname=QLens-Cheatsheet cheatsheet.tex
