import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { BrowserRouter, Navigate, Outlet, Route, Routes, useLocation } from "react-router"
import { FullPageSpinner } from "./components/Spinner"
import { LoginPage } from "./features/auth/LoginPage"
import { SignupPage } from "./features/auth/SignupPage"
import { AnalyzePage } from "./features/analyze/AnalyzePage"
import { useMe } from "./features/auth/useAuth"
import { ImportPage } from "./features/import/ImportPage"
import { DashboardPage } from "./features/workspaces/DashboardPage"
import { StepPlaceholder } from "./features/workspaces/StepPlaceholder"
import { WorkspaceLayout } from "./features/workspaces/WorkspaceLayout"
import { ApiError } from "./lib/api"
import { STEPS } from "./lib/steps"

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

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/signup" element={<SignupPage />} />
          <Route element={<RequireAuth />}>
            <Route path="/" element={<DashboardPage />} />
            <Route path="/w/:id" element={<WorkspaceLayout />}>
              <Route index element={<Navigate to="import" replace />} />
              <Route path="import" element={<ImportPage />} />
              <Route path="analyze" element={<AnalyzePage />} />
              {STEPS.filter((s) => s.key !== "import" && s.key !== "analyze").map((s) => (
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
