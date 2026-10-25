import "@fontsource-variable/jetbrains-mono"
import "@fontsource-variable/space-grotesk"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import App from "./App"
import { initTheme } from "./lib/theme"
import "./styles/globals.css"

initTheme()

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
