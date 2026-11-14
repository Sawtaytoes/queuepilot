import { useParams } from "react-router"
import { canonicalWatchPlayPath } from "../lib/routePaths"
import { useCanonicalPath } from "./useCanonicalPath"
import { WatchPlayPage } from "./WatchPlayPage"

export function LegacyWatchPlayPage() {
  const { step } = useParams()

  useCanonicalPath(canonicalWatchPlayPath(step))

  return <WatchPlayPage />
}
