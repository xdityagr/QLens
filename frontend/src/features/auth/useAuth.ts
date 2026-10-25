import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "react-router"
import { ApiError, authApi } from "../../lib/api"
import type { UserOut } from "../../lib/types"

export const ME_KEY = ["auth", "me"] as const

/** Current user, or null when signed out. Other errors still surface as errors. */
export function useMe() {
  return useQuery<UserOut | null>({
    queryKey: ME_KEY,
    queryFn: async () => {
      try {
        return await authApi.me()
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null
        throw e
      }
    },
    staleTime: 5 * 60_000,
    retry: false,
  })
}

export function useLogout() {
  const qc = useQueryClient()
  const navigate = useNavigate()
  return useMutation({
    mutationFn: authApi.logout,
    onSettled: () => {
      qc.clear()
      qc.setQueryData(ME_KEY, null)
      navigate("/login", { replace: true })
    },
  })
}
