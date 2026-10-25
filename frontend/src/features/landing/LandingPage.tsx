import { Check, Menu, X } from "lucide-react"
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react"
import { Link } from "react-router"
import { buttonClass } from "../../components/buttonClass"
import { ThemeToggle } from "../../components/ThemeToggle"
import { Wordmark } from "../../components/Wordmark"
import { fmtInt } from "../../lib/format"
import { laneAlpha, laneVar } from "../../lib/lanes"
import { useCountUp, useInView, useReducedMotion } from "../../lib/reveal"
import "./landing.css"
import { Untangle } from "./Untangle"
import { AnalyzeVisual, DesignVisual, GrainField, ImportVisual, QueryVisual } from "./Visuals"

const d = (ms: number) => ({ "--d": `${ms}ms` }) as CSSProperties

/** A block whose children with ld-* classes animate once it scrolls into view. */
function InView({ as: Tag = "div", className = "", children, threshold = 0.2, id }: {
  as?: "div" | "section" | "footer"
  className?: string
  children: ReactNode
  threshold?: number
  id?: string
}) {
  const [ref, inView] = useInView<HTMLDivElement>({ threshold })
  return (
    <Tag ref={ref} id={id} data-in={inView} className={className}>
      {children}
    </Tag>
  )
}

const NAV_LINKS = [
  { href: "#how", label: "How it works" },
  { href: "#lossless", label: "Lossless check" },
  { href: "#sql", label: "The SQL" },
]

/**
 * Transparent over the hero, so its gradient runs to the top edge. Once the page scrolls it
 * condenses into a floating glass pill. On small screens the links move into a menu.
 */
function Nav() {
  const [scrolled, setScrolled] = useState(false)
  const [open, setOpen] = useState(false)
  const toggleRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  // Closing from inside the menu unmounts the focused element, so hand focus back to the toggle.
  // For a section link the browser's fragment navigation runs after this handler and resets focus,
  // so the hand-back waits a frame.
  const closeMenu = () => {
    setOpen(false)
    requestAnimationFrame(() => toggleRef.current?.focus())
  }
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 24)
    onScroll()
    window.addEventListener("scroll", onScroll, { passive: true })
    return () => window.removeEventListener("scroll", onScroll)
  }, [])
  useEffect(() => {
    if (!open) return
    menuRef.current?.querySelector<HTMLElement>("a")?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return
      setOpen(false)
      toggleRef.current?.focus()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [open])

  const pill = scrolled || open
  return (
    <header className="pointer-events-none fixed inset-x-0 top-0 z-40 px-3 sm:px-6">
      <div
        data-pill={pill}
        className="ld-nav pointer-events-auto mx-auto flex items-center gap-2 sm:gap-4"
      >
        <Wordmark />
        <nav aria-label="Sections" className="ml-4 hidden items-center gap-1 md:flex">
          {NAV_LINKS.map((l) => (
            <a
              key={l.href}
              href={l.href}
              className="rounded-full px-3 py-1.5 text-[14px] text-muted transition-colors duration-150 hover:bg-[color-mix(in_oklab,var(--text)_7%,transparent)] hover:text-text"
            >
              {l.label}
            </a>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-1">
          <span className="[&>button]:rounded-full">
            <ThemeToggle />
          </span>
          <Link
            to="/login"
            className="hidden h-9 items-center rounded-full px-3.5 text-[14px] text-muted transition-colors duration-150 hover:bg-[color-mix(in_oklab,var(--text)_7%,transparent)] hover:text-text sm:inline-flex"
          >
            Sign in
          </Link>
          {/* wrapper owns the breakpoint: buttonClass sets its own display */}
          <span className="ml-1 hidden sm:block">
            <Link to="/signup" className={`${buttonClass("primary", "sm")} h-9 rounded-full! px-4`}>
              Create account
            </Link>
          </span>
          <button
            type="button"
            aria-label={open ? "Close menu" : "Open menu"}
            aria-expanded={open}
            ref={toggleRef}
            aria-controls="ld-menu"
            onClick={() => setOpen((o) => !o)}
            className="grid size-9 place-items-center rounded-full text-muted transition-colors hover:bg-[color-mix(in_oklab,var(--text)_7%,transparent)] hover:text-text md:hidden"
          >
            {open ? <X size={18} strokeWidth={1.75} /> : <Menu size={18} strokeWidth={1.75} />}
          </button>
        </div>
      </div>
      {open && (
        <div id="ld-menu" ref={menuRef} className="ld-menu pointer-events-auto mx-auto mt-2 max-w-[560px] p-2 md:hidden">
          {NAV_LINKS.map((l) => (
            <a key={l.href} href={l.href} onClick={closeMenu} className="block rounded-[12px] px-4 py-3 text-[15px] text-text hover:bg-hover">
              {l.label}
            </a>
          ))}
          <div className="mt-2 grid grid-cols-2 gap-2 border-t border-border p-2 pt-3">
            <Link to="/login" className={`${buttonClass("secondary")} rounded-full!`}>
              Sign in
            </Link>
            <Link to="/signup" className={`${buttonClass("primary")} rounded-full!`}>
              Create account
            </Link>
          </div>
        </div>
      )}
    </header>
  )
}

function Hero() {
  const ref = useRef<HTMLElement>(null)
  const reduced = useReducedMotion()
  useEffect(() => {
    const el = ref.current
    if (!el || reduced) return
    let raf = 0
    const onScroll = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        const p = Math.min(1, Math.max(0, window.scrollY / Math.max(1, el.offsetHeight)))
        el.style.setProperty("--ld-scroll", p.toFixed(3))
      })
    }
    onScroll()
    window.addEventListener("scroll", onScroll, { passive: true })
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener("scroll", onScroll)
    }
  }, [reduced])

  return (
    <section ref={ref} className="relative isolate overflow-hidden pt-[72px]">
      <GrainField lanes={[0, 1, 5]} strength={0.3} className="ld-parallax-slow" />
      <div className="relative mx-auto grid max-w-[1240px] items-center gap-12 px-4 pb-20 pt-14 sm:px-8 lg:min-h-[calc(100dvh-72px)] lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] lg:gap-14 lg:pb-24 lg:pt-6">
        <div className="ld-parallax-fade">
          <h1 className="ld-display text-[clamp(42px,3.9vw,56px)] text-text">
            <span className="block">One messy sheet in.</span>
            <span className="block">Clean, related tables out.</span>
          </h1>
          <p className="mt-7 max-w-[46ch] text-[16px] leading-relaxed text-muted sm:text-[17px]">
            QLens reads the dependencies hiding in a spreadsheet, splits it into normalized PostgreSQL tables, and
            proves that not a single row was lost on the way.
          </p>
          <div className="mt-9 flex flex-wrap items-center gap-3">
            <Link to="/signup" className={`${buttonClass("primary")} h-11 px-5 text-[15px]`}>
              Create an account
            </Link>
            <Link to="/login" className={`${buttonClass("secondary")} h-11 px-5 text-[15px]`}>
              Sign in
            </Link>
          </div>
          <p className="mt-5 text-[13px] text-faint">Runs on your own machine against PostgreSQL. Try it with a bundled sample sheet.</p>
        </div>
        <div className="relative rounded-[14px] border border-border bg-[color-mix(in_oklab,var(--bg)_55%,transparent)] p-4 backdrop-blur-sm sm:p-6">
          <Untangle />
        </div>
      </div>
    </section>
  )
}

const STEPS: { title: string; body: string; lane: number; visual: ReactNode }[] = [
  {
    title: "Import",
    body: "Upload a CSV or Excel sheet, or pick a sample. QLens loads it into PostgreSQL and infers a SQL type for every column.",
    lane: 0,
    visual: <ImportVisual />,
  },
  {
    title: "Analyze",
    body: "SQL measures which columns decide which, finds candidate keys, and flags values typed two ways so you can merge them.",
    lane: 1,
    visual: <AnalyzeVisual />,
  },
  {
    title: "Design",
    body: "The dependencies you accept become 3NF tables with primary and foreign keys. Rename what you like, then apply.",
    lane: 2,
    visual: <DesignVisual />,
  },
  {
    title: "Data",
    body: "Browse and edit rows, run SELECTs and confirmed INSERT, UPDATE or DELETE statements, step through a query, read its plan, or ask in plain English with Ask AI.",
    lane: 4,
    visual: <QueryVisual />,
  },
]

function HowItWorks() {
  return (
    <section id="how" className="relative scroll-mt-4 border-t border-border">
      <div className="mx-auto max-w-[1240px] px-4 py-24 sm:px-8 sm:py-32">
        <InView className="max-w-[640px]">
          <h2 className="ld-reveal ld-display text-[40px] text-text sm:text-[60px]">Four steps, all of them SQL.</h2>
          <p className="ld-reveal mt-5 max-w-[52ch] text-[16px] leading-relaxed text-muted" style={d(120)}>
            Every check QLens makes runs as a query inside PostgreSQL, and the Design step shows the exact DDL before
            it runs.
          </p>
        </InView>

        {/* No observer around the whole list: each step reveals on its own, so on a phone steps 2-4
            don't play while they're still off screen. The connector has its own observer. */}
        <div className="relative mt-16">
          {/* the lane that ties the four steps together, like a branch in a commit graph */}
          <InView className="absolute left-0 top-[11px] hidden h-[2px] w-full lg:block" threshold={0.1}>
            <svg aria-hidden className="block h-[2px] w-full" preserveAspectRatio="none" viewBox="0 0 100 2">
              <path d="M0 1 H100" className="ld-draw" pathLength={1} stroke="var(--border-strong)" strokeWidth={2} vectorEffect="non-scaling-stroke" />
            </svg>
          </InView>
          <ol className="grid gap-x-6 gap-y-14 md:grid-cols-2 lg:grid-cols-4">
            {STEPS.map((s, i) => (
              <li key={s.title} className="relative">
                <InView threshold={0.2}>
                  <div className="ld-reveal relative flex w-fit items-center gap-3 bg-bg pr-4" style={d(i * 140)}>
                    <span
                      className="relative grid size-6 place-items-center rounded-full text-[11px] font-semibold"
                      style={{ background: laneVar(s.lane), color: "var(--on-accent)" }}
                    >
                      {i + 1}
                    </span>
                    <h3 className="text-[20px] font-medium tracking-[-0.03em] text-text">{s.title}</h3>
                  </div>
                  <p className="ld-reveal mt-3 max-w-[38ch] text-[14.5px] leading-relaxed text-muted" style={d(i * 140 + 80)}>
                    {s.body}
                  </p>
                  <div
                    className="ld-reveal mt-6 rounded-card border border-border bg-surface p-3"
                    style={{ ...d(i * 140 + 160), boxShadow: `inset 0 1px 0 ${laneAlpha(s.lane, 0.35)}` }}
                  >
                    {s.visual}
                  </div>
                </InView>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  )
}

function Lossless() {
  const [ref, inView] = useInView<HTMLDivElement>({ threshold: 0.2 })
  const staging = useCountUp(3000, inView, 1400)
  const rebuilt = useCountUp(3000, inView, 1900)
  const done = rebuilt >= 3000
  return (
    <section id="lossless" className="relative isolate scroll-mt-4 overflow-hidden border-t border-border">
      <GrainField lanes={[4, 5]} strength={0.16} />
      <div ref={ref} data-in={inView} className="relative mx-auto grid max-w-[1240px] items-center gap-14 px-4 py-24 sm:px-8 sm:py-32 lg:grid-cols-2">
        <div>
          <h2 className="ld-reveal ld-display max-w-[13ch] text-[40px] text-text sm:text-[60px]">Proves nothing was lost.</h2>
          <p className="ld-reveal mt-6 max-w-[48ch] text-[16px] leading-relaxed text-muted" style={d(120)}>
            After the new tables are built, QLens joins them back into the original shape and compares that with the
            imported rows using <code className="text-text">EXCEPT ALL</code> in both directions. Both differences must
            be zero, duplicates included, or nothing is applied.
          </p>
        </div>
        <div className="ld-reveal rounded-[14px] border border-border bg-surface p-6 sm:p-8" style={d(200)}>
          <p className="text-[13px] text-muted">Coaching fee register sample</p>
          <div className="mt-6 grid grid-cols-[1fr_auto_1fr] items-end gap-4">
            <div>
              <div className="num text-[44px] leading-none text-text sm:text-[60px]">{fmtInt(staging)}</div>
              <div className="mt-2 text-[13px] text-muted">rows imported</div>
            </div>
            <svg aria-hidden width="44" height="20" viewBox="0 0 44 20" className="mb-8">
              <path d="M2 10 H40 M33 4 l7 6 -7 6" className="ld-draw" pathLength={1} fill="none" stroke="var(--border-strong)" strokeWidth={1.5} style={d(300)} />
            </svg>
            <div>
              <div className="num text-[44px] leading-none text-text sm:text-[60px]">{fmtInt(rebuilt)}</div>
              <div className="mt-2 text-[13px] text-muted">rows rebuilt from tables</div>
            </div>
          </div>
          <dl className="mt-8 grid grid-cols-2 gap-px overflow-hidden rounded-control border border-border bg-border text-[13px]">
            <div className="bg-raised px-4 py-3">
              <dt className="text-muted">missing rows</dt>
              <dd className="num mt-1 text-[18px] text-text">{done ? 0 : "…"}</dd>
            </div>
            <div className="bg-raised px-4 py-3">
              <dt className="text-muted">extra rows</dt>
              <dd className="num mt-1 text-[18px] text-text">{done ? 0 : "…"}</dd>
            </div>
          </dl>
          <div className="mt-6 flex items-center gap-3">
            <span
              className="ld-check grid size-8 place-items-center rounded-full"
              data-on={done}
              style={{ background: laneAlpha(4, 0.18), color: laneVar(4) }}
            >
              <Check size={17} strokeWidth={2.5} />
            </span>
            <span className="text-[15px] text-text" style={{ opacity: done ? 1 : 0.35, transition: "opacity 300ms ease" }}>
              Lossless: every row is back, exactly as imported.
            </span>
          </div>
        </div>
      </div>
    </section>
  )
}

const COMMAND = "rename students to learners"

function AssistantTeaser() {
  const [ref, inView] = useInView<HTMLDivElement>({ once: false, threshold: 0.2 })
  const reduced = useReducedMotion()
  const [typed, setTyped] = useState(0)
  const [applied, setApplied] = useState(false)

  useEffect(() => {
    if (reduced || !inView) return
    let i = 0
    let timer = 0
    const run = () => {
      setApplied(false)
      i = 0
      setTyped(0)
      const type = () => {
        i += 1
        setTyped(i)
        if (i < COMMAND.length) timer = window.setTimeout(type, 55 + Math.random() * 50)
        else
          timer = window.setTimeout(() => {
            setApplied(true)
            timer = window.setTimeout(run, 3600)
          }, 650)
      }
      timer = window.setTimeout(type, 700)
    }
    run()
    return () => window.clearTimeout(timer)
  }, [inView, reduced])

  const shownTyped = reduced ? COMMAND.length : typed
  const shownApplied = reduced || applied

  return (
    <section className="relative border-t border-border">
      <div ref={ref} data-in={inView} className="mx-auto grid max-w-[1240px] items-center gap-14 px-4 py-24 sm:px-8 sm:py-32 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
        <div className="relative order-2 rounded-[14px] border border-border p-5 sm:p-8 lg:order-1"
          style={{ backgroundImage: "radial-gradient(var(--border-strong) 1px, transparent 1px)", backgroundSize: "18px 18px" }}
        >
          <div className="relative mx-auto h-[220px] max-w-[460px]" aria-hidden>
            <MiniTable x="4%" y={18} lane={0} title={shownApplied ? "learners" : "students"} morph={shownApplied} rows={["student_name", "phone", "batch"]} />
            <MiniTable x="58%" y={0} lane={1} title="batches" rows={["batch", "teacher"]} />
            <MiniTable x="40%" y={128} lane={3} title="payments" rows={["student_name", "month"]} />
          </div>
          <div className="relative mx-auto mt-4 flex max-w-[460px] items-center gap-3 rounded-full border border-border-strong bg-raised px-4 py-2.5 shadow-[var(--shadow-pop)]">
            <span className="size-2 shrink-0 rounded-full" style={{ background: laneVar(1) }} />
            <span className="num min-w-0 flex-1 truncate text-[13.5px] text-text">
              {COMMAND.slice(0, shownTyped)}
              {!shownApplied && <span className="ld-caret" />}
            </span>
          </div>
          <div
            className="mx-auto mt-3 w-fit rounded-full border border-border bg-surface px-3 py-1 text-[12.5px] text-muted"
            style={{ opacity: shownApplied ? 1 : 0, transform: shownApplied ? "none" : "translateY(6px)", transition: "opacity 250ms ease, transform 250ms ease" }}
          >
            1 change, undo available
          </div>
        </div>
        <div className="order-1 lg:order-2">
          <span className="ld-reveal inline-flex h-6 items-center rounded-full border px-2.5 text-[12px] font-medium"
            style={{ borderColor: laneAlpha(1, 0.4), color: laneVar(1), background: laneAlpha(1, 0.1) }}
          >
            Optional · needs a Gemini API key
          </span>
          <h2 className="ld-reveal ld-display mt-5 max-w-[14ch] text-[40px] text-text sm:text-[56px]" style={d(80)}>
            Rework the design by asking.
          </h2>
          <p className="ld-reveal mt-6 max-w-[46ch] text-[16px] leading-relaxed text-muted" style={d(160)}>
            The command bar on the design canvas and Ask AI on the Data page take plain requests. Questions get
            answered with the SQL that was run; edits like renames go through checked tools, show up on the diagram,
            and can be undone. Both use Google Gemini, so they need a Gemini API key; everything else works without
            one.
          </p>
        </div>
      </div>
    </section>
  )
}

function MiniTable({ x, y, lane, title, rows, morph = false }: { x: string; y: number; lane: number; title: string; rows: string[]; morph?: boolean }) {
  return (
    <div className="absolute w-[150px] overflow-hidden rounded-[8px] border bg-surface text-[12px]" style={{ left: x, top: y, borderColor: laneAlpha(lane, 0.55) }}>
      <div className="relative h-7 overflow-hidden px-2.5" style={{ background: laneAlpha(lane, 0.16) }}>
        <span
          key={title}
          className="num absolute inset-x-2.5 top-[5px] font-semibold"
          style={{ color: laneVar(lane), animation: morph ? "pop-in 320ms cubic-bezier(.2,.7,.2,1) both" : undefined }}
        >
          {title}
        </span>
      </div>
      {rows.map((r) => (
        <div key={r} className="num border-t border-border px-2.5 py-1 text-muted">
          {r}
        </div>
      ))}
    </div>
  )
}

const CHECK_FD = `-- How many rows break "lhs decides rhs"?
CREATE FUNCTION qlens.check_fd(p_schema text, p_table text,
                               p_lhs text[], p_rhs text)
RETURNS TABLE (row_count bigint, lhs_values bigint,
               repeated_groups bigint, violating_rows bigint) ...
  WITH c AS (SELECT lhs, rhs, count(*) AS cnt
             FROM t GROUP BY lhs, rhs),
       g AS (SELECT lhs, sum(cnt) AS n, max(cnt) AS keep
             FROM c GROUP BY lhs)
  SELECT ..., coalesce(sum(n - keep), 0) FROM g;`

const VERIFY = `-- Lossless check: rebuild the sheet from the new tables, compare both ways
SELECT
  (SELECT count(*) FROM ws_12_src._staging)  AS staging_rows,
  (SELECT count(*) FROM ws_12.original_sheet) AS reconstructed_rows,
  (SELECT count(*) FROM (
     SELECT cols FROM ws_12.original_sheet
     EXCEPT ALL
     SELECT cols FROM ws_12_src._staging) d)  AS extra_rows,
  (SELECT count(*) FROM (
     SELECT cols FROM ws_12_src._staging
     EXCEPT ALL
     SELECT cols FROM ws_12.original_sheet) d) AS missing_rows;`

const KW = /\b(CREATE|FUNCTION|RETURNS|TABLE|WITH|AS|SELECT|FROM|GROUP|BY|EXCEPT|ALL|count|sum|max|coalesce|bigint|text)\b/g

function Sql({ code }: { code: string }) {
  return (
    <pre className="scrollbar-thin overflow-x-auto p-5 text-[12.5px] leading-[1.7]">
      <code>
        {code.split("\n").map((line, i) => {
          const comment = line.trimStart().startsWith("--")
          if (comment)
            return (
              <div key={i} className="text-faint">
                {line}
              </div>
            )
          const parts = line.split(KW)
          return (
            <div key={i} className="text-text">
              {parts.map((p, j) =>
                j % 2 === 1 ? (
                  <span key={j} style={{ color: laneVar(0) }}>
                    {p}
                  </span>
                ) : (
                  <span key={j}>{p}</span>
                ),
              )}
              {line === "" && " "}
            </div>
          )
        })}
      </code>
    </pre>
  )
}

function SqlStrip() {
  return (
    <section id="sql" className="relative scroll-mt-4 border-t border-border">
      <InView className="mx-auto max-w-[1240px] px-4 py-24 sm:px-8 sm:py-32">
        <h2 className="ld-reveal ld-display max-w-[16ch] text-[40px] text-text sm:text-[56px]">SQL under the hood.</h2>
        <p className="ld-reveal mt-5 max-w-[56ch] text-[16px] leading-relaxed text-muted" style={d(100)}>
          No ORM and no black box. These are the queries QLens runs, trimmed for the page. Identifiers are quoted with
          <code className="mx-1 text-text">format('%I')</code>and values are always bound parameters.
        </p>
        <div className="mt-12 grid gap-5 lg:grid-cols-2">
          {[
            { title: "Measuring a dependency", code: CHECK_FD, lane: 1 },
            { title: "Checking the split is lossless", code: VERIFY, lane: 4 },
          ].map((b, i) => (
            <figure key={b.title} className="ld-reveal min-w-0 overflow-hidden rounded-card border border-border bg-surface" style={d(200 + i * 120)}>
              <figcaption className="flex items-center gap-2 border-b border-border px-5 py-3 text-[13px] text-muted">
                <span className="size-2 rounded-full" style={{ background: laneVar(b.lane) }} />
                {b.title}
              </figcaption>
              <Sql code={b.code} />
            </figure>
          ))}
        </div>
      </InView>
    </section>
  )
}

function ClosingCta() {
  return (
    <section className="relative isolate overflow-hidden border-t border-border">
      <GrainField lanes={[1, 0, 2]} strength={0.22} />
      <InView className="relative mx-auto flex max-w-[1240px] flex-col items-start gap-8 px-4 py-24 sm:px-8 sm:py-32">
        <h2 className="ld-reveal ld-display max-w-[14ch] text-[44px] text-text sm:text-[72px]">Bring a sheet. Leave with a schema.</h2>
        <div className="ld-reveal flex flex-wrap gap-3" style={d(120)}>
          <Link to="/signup" className={`${buttonClass("primary")} h-11 px-5 text-[15px]`}>
            Create an account
          </Link>
          <Link to="/login" className={`${buttonClass("secondary")} h-11 px-5 text-[15px]`}>
            Sign in
          </Link>
        </div>
      </InView>
    </section>
  )
}

export function LandingPage() {
  return (
    <div className="min-h-dvh bg-bg">
      <Nav />
      <main>
        <Hero />
        <HowItWorks />
        <Lossless />
        <AssistantTeaser />
        <SqlStrip />
        <ClosingCta />
      </main>
      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-[1240px] flex-col gap-3 px-4 py-10 text-[13px] text-muted sm:flex-row sm:items-center sm:justify-between sm:px-8">
          <Wordmark />
          <p>Built by Aditya Gaur &amp; Aditya Choudhary · RDBMS Lab, Manipal University Jaipur</p>
        </div>
      </footer>
    </div>
  )
}
