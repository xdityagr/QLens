// @vitest-environment jsdom
import { cleanup, createEvent, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, expect, test, vi } from "vitest"
import { statementInfo } from "../../lib/sqlKind"
import { ConfirmWrite } from "./WriteParts"

afterEach(cleanup)

/** Enter as a browser handles it: keydown on the focused element, then a click if it is a button and nothing
 *  prevented the default (jsdom does not synthesise that activation itself). */
function pressEnter(el: Element | null, init: { repeat?: boolean } = {}) {
  if (!el) throw new Error("nothing focused")
  const ev = createEvent.keyDown(el, { key: "Enter", ...init })
  fireEvent(el, ev)
  if (!ev.defaultPrevented && el instanceof HTMLButtonElement) el.click()
}

function open(sql = "DELETE FROM students WHERE id = 3") {
  const onRun = vi.fn()
  const onCancel = vi.fn()
  render(<ConfirmWrite info={statementInfo(sql)} lane={0} running={false} onRun={onRun} onCancel={onCancel} />)
  return { onRun, onCancel }
}

test("the card opens with focus on Cancel, so a stray Enter cancels instead of running the write", () => {
  const { onRun, onCancel } = open()
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }))
  pressEnter(document.activeElement)
  expect(onRun).not.toHaveBeenCalled()
  expect(onCancel).toHaveBeenCalledTimes(1)
})

test("a held-down Enter (key repeat) never runs it, even on the Run button", () => {
  const { onRun } = open("UPDATE fee_register SET fee_paid = 0")
  const run = screen.getByRole("button", { name: /Run UPDATE/ })
  run.focus()
  pressEnter(run, { repeat: true })
  expect(onRun).not.toHaveBeenCalled()
  // a deliberate press does
  pressEnter(run)
  expect(onRun).toHaveBeenCalledTimes(1)
})

test("Esc cancels", () => {
  const { onRun, onCancel } = open()
  fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" })
  expect(onCancel).toHaveBeenCalledTimes(1)
  expect(onRun).not.toHaveBeenCalled()
})
