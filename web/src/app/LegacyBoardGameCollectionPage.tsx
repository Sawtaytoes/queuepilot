import { useParams } from "react-router"
import { canonicalCollectionPath } from "../lib/routePaths"
import { BoardGameCollectionPage } from "./BoardGameCollectionPage"
import { useCanonicalPath } from "./useCanonicalPath"

export function LegacyBoardGameCollectionPage() {
  const params = useParams()

  useCanonicalPath(canonicalCollectionPath(params["*"]))

  return <BoardGameCollectionPage />
}
