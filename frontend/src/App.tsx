import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { BrowserRouter, Navigate, Outlet, Route, Routes, useLocation } from "react-router"
import { FullPageSpinner } from "./components/Spinner"
import { LoginPage } from "./features/auth/LoginPage"
import { SignupPage } from "./features/auth/SignupPage"
import { AnalyzePage } from "./features/analyze/AnalyzePage"
import { DataPage } from "./features/data/DataPage"
import { DesignPage } from "./features/design/DesignPage"
import { useMe } from "./features/auth/useAuth"
import { HistoryPage } from "./features/history/HistoryPage"
import { ImportPage } from "./features/import/ImportPage"
import { LandingPage } from "./features/landing/LandingPage"
import { DashboardPage } from "./features/workspaces/DashboardPage"
import { StepPlaceholder } from "./features/workspaces/StepPlaceholder"
import { WorkspaceLayout } from "./features/workspaces/WorkspaceLayout"
import { ApiError } from "./lib/api"
import { STEPS, type StepKey } from "./lib/steps"

// Steps with a real screen; the rest still get StepPlaceholder.
const BUILT = new Set<StepKey>(["import", "analyze", "design", "data", "history"])

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      // 4xx and 501 (not implemented, e.g. the mock API) won't change on a retry
      retry: (n, e) => n < 2 && !(e instanceof ApiError && ((e.status >= 400 && e.status < 500) || e.status === 501)),
    },
  },
})

function RequireAuth() {
  const { data: me, isPending } = useMe()
  const location = useLocation()
  if (isPending) return <FullPageSpinner />
  if (!me) return <Navigate to="/login" replace state={{ from: location.pathname }} />
  return <Outlet />
}

// Keeps router state (SQL handed over by History or the assistant) across the redirect.
function ToSqlTab() {
  const location = useLocation()
  return <Navigate to="../data?tab=sql" relative="path" replace state={location.state} />
}

// Signed-out visitors get the landing page at "/", signed-in users their dashboard.
function Home() {
  const { data: me, isPending } = useMe()
  if (isPending) return <FullPageSpinner />
  return me ? <DashboardPage /> : <LandingPage />
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/signup" element={<SignupPage />} />
          <Route path="/" element={<Home />} />
          <Route element={<RequireAuth />}>
            <Route path="/w/:id" element={<WorkspaceLayout />}>
              <Route index element={<Navigate to="import" replace />} />
              <Route path="import" element={<ImportPage />} />
              <Route path="analyze" element={<AnalyzePage />} />
              <Route path="design" element={<DesignPage />} />
              <Route path="data" element={<DataPage />} />
              {/* Query and Performance became the Data page's SQL tab; old links land there */}
              <Route path="query" element={<ToSqlTab />} />
              <Route path="perf" element={<ToSqlTab />} />
              <Route path="history" element={<HistoryPage />} />
              {STEPS.filter((s) => !BUILT.has(s.key)).map((s) => (
                <Route key={s.key} path={s.key} element={<StepPlaceholder step={s.key} />} />
              ))}
            </Route>
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  )
}
