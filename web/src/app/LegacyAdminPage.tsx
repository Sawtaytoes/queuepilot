import { ROUTE_PATHS } from "../lib/routePaths"
import { ModeLandingPage } from "./ModeLandingPage"
import { useCanonicalPath } from "./useCanonicalPath"

export function LegacyAdminPage() {
  useCanonicalPath(ROUTE_PATHS.home)

  return <ModeLandingPage />
}
