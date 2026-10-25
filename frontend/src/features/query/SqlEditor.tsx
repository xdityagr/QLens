import { PostgreSQL, sql as sqlLang } from "@codemirror/lang-sql"
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language"
import { StateEffect, StateField } from "@codemirror/state"
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view"
import { tags as t } from "@lezer/highlight"
import CodeMirror, { type ReactCodeMirrorRef } from "@uiw/react-codemirror"
import { forwardRef, useImperativeHandle, useMemo, useRef } from "react"

export interface SqlEditorHandle {
  /** replace the selection (or insert at the cursor) and focus the editor */
  insert: (text: string) => void
  focus: () => void
  /** underline the token at `offset` (0-based); null clears it. Typing clears it too. */
  markError: (offset: number | null) => void
}

// ---- error underline ------------------------------------------------------------------------------

const setErrorMark = StateEffect.define<{ from: number; to: number } | null>()
const errorMark = Decoration.mark({ class: "cm-error-mark" })

const errorMarkField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    let next = tr.docChanged ? Decoration.none : deco.map(tr.changes)
    for (const e of tr.effects) {
      if (e.is(setErrorMark))
        next = e.value ? Decoration.set([errorMark.range(e.value.from, e.value.to)]) : Decoration.none
    }
    return next
  },
  provide: (f) => EditorView.decorations.from(f),
})

/** The token starting at `offset`, or one character when the position sits on punctuation or the end. */
function tokenRange(doc: string, offset: number): { from: number; to: number } | null {
  if (doc.length === 0) return null
  let from = Math.min(Math.max(0, offset), doc.length)
  if (from === doc.length) from = doc.length - 1
  const m = /^(?:"(?:[^"]|"")*"|[\w$.]+)/.exec(doc.slice(from))
  return { from, to: from + (m ? m[0].length : 1) }
}

// ---- theme: every colour is a token, so the editor follows the light/dark switch on its own ----------

const editorTheme = EditorView.theme({
  "&": { color: "var(--text)", backgroundColor: "transparent", fontSize: "13.5px" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--font-code)", lineHeight: "1.7" },
  ".cm-content": { caretColor: "var(--accent)", padding: "14px 0" },
  ".cm-line": { padding: "0 16px 0 6px" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent)", borderLeftWidth: "2px" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
    { backgroundColor: "color-mix(in oklab, var(--accent) 26%, transparent)" },
  ".cm-gutters": { backgroundColor: "transparent", color: "var(--faint)", border: "none", paddingLeft: "6px" },
  ".cm-lineNumbers .cm-gutterElement": { minWidth: "28px", fontVariantNumeric: "tabular-nums" },
  ".cm-activeLine": { backgroundColor: "color-mix(in oklab, var(--text) 3.5%, transparent)" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--muted)" },
  ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": {
    backgroundColor: "color-mix(in oklab, var(--accent) 18%, transparent)",
    outline: "1px solid color-mix(in oklab, var(--accent) 45%, transparent)",
  },
  ".cm-placeholder": { color: "var(--faint)" },
  ".cm-error-mark": {
    textDecoration: "underline wavy var(--danger)",
    textDecorationSkipInk: "none",
    textUnderlineOffset: "4px",
    backgroundColor: "color-mix(in oklab, var(--danger) 14%, transparent)",
    borderRadius: "2px",
  },
  ".cm-tooltip": {
    backgroundColor: "var(--raised)",
    border: "1px solid var(--border-strong)",
    borderRadius: "8px",
    boxShadow: "var(--shadow-pop)",
    overflow: "hidden",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul": { fontFamily: "var(--font-code)", fontSize: "12.5px", maxHeight: "16em" },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > li": { padding: "3px 10px 3px 6px", color: "var(--text)" },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]": {
    backgroundColor: "color-mix(in oklab, var(--accent) 20%, transparent)",
    color: "var(--text)",
  },
  ".cm-completionIcon": { opacity: "0.55", width: "1.4em" },
  ".cm-completionDetail": { color: "var(--faint)", fontStyle: "normal", marginLeft: "1em" },
  ".cm-completionMatchedText": { textDecoration: "none", color: "var(--accent)" },
  ".cm-panels": { backgroundColor: "var(--raised)", color: "var(--text)", borderColor: "var(--border)" },
  ".cm-searchMatch": { backgroundColor: "color-mix(in oklab, var(--lane-6) 30%, transparent)" },
})

const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.operatorKeyword, t.modifier], color: "var(--lane-1)" },
  { tag: [t.typeName, t.standard(t.name)], color: "var(--lane-5)" },
  { tag: [t.string, t.special(t.string)], color: "var(--lane-4)" },
  { tag: [t.number, t.bool, t.null], color: "var(--lane-3)" },
  { tag: [t.lineComment, t.blockComment, t.comment], color: "var(--faint)", fontStyle: "italic" },
  { tag: [t.operator, t.punctuation, t.paren, t.squareBracket, t.brace, t.separator], color: "var(--muted)" },
  { tag: t.special(t.name), color: "var(--lane-0)" },
])

// ---- component -------------------------------------------------------------------------------------

export const SqlEditor = forwardRef<
  SqlEditorHandle,
  {
    value: string
    onChange: (v: string) => void
    onRun: () => void
    /** table -> column names, for completion */
    schema: Record<string, string[]>
    label: string
  }
>(function SqlEditor({ value, onChange, onRun, schema, label }, ref) {
  const cm = useRef<ReactCodeMirrorRef>(null)

  useImperativeHandle(ref, () => ({
    insert(text) {
      const view = cm.current?.view
      if (!view) return
      // keep a clicked name from gluing onto the word before the cursor
      const at = view.state.selection.main.from
      const before = at > 0 ? view.state.sliceDoc(at - 1, at) : ""
      view.dispatch(view.state.replaceSelection(/[\w$")]/.test(before) ? " " + text : text), { scrollIntoView: true })
      view.focus()
    },
    focus: () => cm.current?.view?.focus(),
    markError(offset) {
      const view = cm.current?.view
      if (!view) return
      const range = offset === null ? null : tokenRange(view.state.doc.toString(), offset)
      view.dispatch({
        effects: [setErrorMark.of(range), ...(range ? [EditorView.scrollIntoView(range.from, { y: "nearest" })] : [])],
      })
    },
  }))

  const language = useMemo(() => sqlLang({ dialect: PostgreSQL, schema, upperCaseKeywords: true }), [schema])
  const extensions = useMemo(
    () => [
      language,
      errorMarkField,
      syntaxHighlighting(highlight),
      EditorView.lineWrapping,
      EditorView.contentAttributes.of({ "aria-label": label }),
    ],
    [language, label],
  )

  return (
    // Ctrl/Cmd+Enter is caught on the way down, before CodeMirror's own binding (insert a blank line) sees it.
    <div
      onKeyDownCapture={(e) => {
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
          e.preventDefault()
          e.stopPropagation()
          onRun()
        }
      }}
    >
      <CodeMirror
        ref={cm}
        value={value}
        onChange={onChange}
        extensions={extensions}
        theme={editorTheme}
        minHeight="190px"
        maxHeight="440px"
        placeholder="SELECT … FROM …"
        basicSetup={{
          foldGutter: false,
          highlightActiveLineGutter: true,
          autocompletion: true,
          closeBrackets: true,
          bracketMatching: true,
          lintKeymap: false,
          syntaxHighlighting: false,
        }}
        className="text-left"
      />
    </div>
  )
})
