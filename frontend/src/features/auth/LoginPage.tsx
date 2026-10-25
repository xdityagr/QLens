import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useState, type FormEvent } from "react"
import { Link, Navigate, useLocation, useNavigate } from "react-router"
import { Button } from "../../components/Button"
import { Field } from "../../components/Field"
import { FullPageSpinner } from "../../components/Spinner"
import { ApiError, authApi } from "../../lib/api"
import { AuthShell } from "./AuthShell"
import { FormError, MockHint } from "./bits"
import { ME_KEY, useMe } from "./useAuth"

export function LoginPage() {
  const { data: me, isPending } = useMe()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const from = (useLocation().state as { from?: string } | null)?.from ?? "/"
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")

  const login = useMutation({
    mutationFn: () => authApi.login(email.trim(), password),
    onSuccess: (user) => {
      qc.setQueryData(ME_KEY, user)
      navigate(from, { replace: true })
    },
  })

  if (isPending) return <FullPageSpinner />
  if (me) return <Navigate to={from} replace />

  const error =
    login.error instanceof ApiError && login.error.code === "invalid_credentials"
      ? "That email and password don't match an account."
      : login.error?.message

  function submit(e: FormEvent) {
    e.preventDefault()
    login.mutate()
  }

  return (
    <AuthShell>
      <h1 className="text-[28px] font-medium leading-tight tracking-[-0.03em]">Sign in</h1>
      <p className="mt-1.5 text-[14.5px] text-muted">Your workspaces are waiting where you left them.</p>

      <form onSubmit={submit} className="mt-8 flex flex-col gap-4" noValidate={false}>
        <Field
          label="Email"
          type="email"
          autoComplete="email"
          required
          autoFocus
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <Field
          label="Password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <FormError message={error} />
        <Button type="submit" variant="primary" loading={login.isPending} className="mt-1 w-full">
          Sign in
        </Button>
      </form>

      <p className="mt-6 text-[14px] text-muted">
        New to QLens?{" "}
        <Link to="/signup" className="font-medium text-text underline-offset-4 hover:underline">
          Create an account
        </Link>
      </p>

      <MockHint
        onFill={(demo) => {
          setEmail(demo.email)
          setPassword(demo.password)
        }}
      />
    </AuthShell>
  )
}
