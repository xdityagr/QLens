import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useState, type FormEvent } from "react"
import { Link, Navigate, useNavigate } from "react-router"
import { Button } from "../../components/Button"
import { Field } from "../../components/Field"
import { FullPageSpinner } from "../../components/Spinner"
import { ApiError, authApi } from "../../lib/api"
import { AuthShell } from "./AuthShell"
import { FormError } from "./bits"
import { ME_KEY, useMe } from "./useAuth"

export function SignupPage() {
  const { data: me, isPending } = useMe()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [name, setName] = useState("")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [touched, setTouched] = useState(false)

  const signup = useMutation({
    mutationFn: () => authApi.signup(email.trim(), password, name.trim()),
    onSuccess: (user) => {
      qc.setQueryData(ME_KEY, user)
      navigate("/", { replace: true })
    },
  })

  if (isPending) return <FullPageSpinner />
  if (me) return <Navigate to="/" replace />

  const pwTooShort = password.length > 0 && password.length < 8
  const pwTooLong = password.length > 128
  const pwError = touched && (pwTooShort || pwTooLong) ? "Use 8 to 128 characters." : null
  const err = signup.error
  const emailError = err instanceof ApiError && err.code === "email_taken" ? "An account with this email already exists." : null
  const formError = err && !emailError ? err.message : null

  function submit(e: FormEvent) {
    e.preventDefault()
    setTouched(true)
    if (password.length < 8 || password.length > 128) return
    signup.mutate()
  }

  return (
    <AuthShell>
      <h1 className="text-[28px] font-medium leading-tight tracking-[-0.03em]">Create your account</h1>
      <p className="mt-1.5 text-[14.5px] text-muted">Each workspace you make gets its own PostgreSQL schema.</p>

      <form onSubmit={submit} className="mt-8 flex flex-col gap-4">
        <Field
          label="Name"
          autoComplete="name"
          required
          autoFocus
          maxLength={80}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <Field
          label="Email"
          type="email"
          autoComplete="email"
          required
          value={email}
          error={emailError}
          onChange={(e) => setEmail(e.target.value)}
        />
        <Field
          label="Password"
          type="password"
          autoComplete="new-password"
          required
          value={password}
          hint="At least 8 characters."
          error={pwError}
          onBlur={() => setTouched(true)}
          onChange={(e) => setPassword(e.target.value)}
        />
        <FormError message={formError} />
        <Button type="submit" variant="primary" loading={signup.isPending} className="mt-1 w-full">
          Create account
        </Button>
      </form>

      <p className="mt-6 text-[14px] text-muted">
        Already have an account?{" "}
        <Link to="/login" className="font-medium text-text underline-offset-4 hover:underline">
          Sign in
        </Link>
      </p>
    </AuthShell>
  )
}
