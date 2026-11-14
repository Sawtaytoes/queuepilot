import { useEffect } from "react"
import { useLocation, useNavigate } from "react-router"

/**
 * A path that MOVED, rewritten to its new address while the page it moved to is already on
 * screen.
 *
 * REPLACES the entry rather than pushing one: a pushed redirect makes Back land on the old
 * path, which redirects forward again and the button reads as dead. Search and hash are
 * carried across — no legacy route uses one today, and dropping them silently is the kind of
 * thing a later route would inherit.
 */
export function useCanonicalPath(canonical: string): void {
  const navigate = useNavigate()
  const { hash, pathname, search } = useLocation()

  useEffect(() => {
    if (pathname === canonical) return

    navigate(canonical + search + hash, { replace: true })
  }, [canonical, hash, navigate, pathname, search])
}
