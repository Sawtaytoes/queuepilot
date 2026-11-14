import { ROUTE_PATHS } from "../lib/routePaths"
import { QueuesPage } from "./QueuesPage"
import { useCanonicalPath } from "./useCanonicalPath"

export function LegacyChannelsPage() {
  useCanonicalPath(ROUTE_PATHS.queues.replace("/*", ""))

  return <QueuesPage />
}
