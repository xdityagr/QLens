# QLens frontend

React 19 + Vite 8 + TypeScript + Tailwind 4. Talks to the FastAPI backend through `/api` (proxied to `http://localhost:8000` in dev).

```sh
npm install
npm run dev        # real backend must be running on :8000
npm run dev:mock   # fake auth + workspaces API, no backend needed (demo: riya@example.com / qlens-demo)
npm test           # vitest
npm run build      # type-check + production build (the mock is not included)
```

Design tokens live in `src/styles/tokens.css`; lane colours are read through `src/lib/lanes.ts`.
