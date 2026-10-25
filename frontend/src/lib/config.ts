import { useQuery } from "@tanstack/react-query"
import { api } from "./api"

/** GET /api/config: what the UI may offer (no login needed; the API key itself never leaves the server). */
export interface AppConfig {
  assistant_enabled: boolean
  /** the model in use; null when the assistant is off */
  assistant_model: string | null
}

const OFF: AppConfig = { assistant_enabled: false, assistant_model: null }

export const configKey = ["config"] as const

/** The server's config. Any failure (older backend, network) reads as everything optional switched off. */
export function useAppConfig(): AppConfig {
  const q = useQuery({
    queryKey: configKey,
    retry: false,
    staleTime: Infinity,
    queryFn: async () => {
      try {
        return await api<AppConfig>("/api/config")
      } catch {
        return OFF
      }
    },
  })
  return q.data ?? OFF
}

export function useAssistantEnabled(): boolean {
  return useAppConfig().assistant_enabled === true
}
