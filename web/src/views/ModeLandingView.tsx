import { ColorSchemeSwitcher } from "@charcuterie/ui"
import { Link } from "react-router"

import { schemeIcons } from "../components/SchemeIcons"

/**
 * The app entry point. QueuePilot has two different jobs, so the root route names both
 * before it opens either one.
 */
export function ModeLandingView() {
  return (
    <main className="mode-landing" id="mode-landing">
      <div className="mode-landing-scheme">
        <ColorSchemeSwitcher icons={schemeIcons} />
      </div>

      <div className="mode-landing-intro">
        <h1>QueuePilot</h1>
        <p>Choose a mode.</p>
      </div>

      <div className="mode-landing-cards">
        <Link
          className="mode-card mode-card-admin"
          id="mode-admin"
          to="/admin"
        >
          <div className="mode-card-heading">
            <AdminIcon />
            <h2>Admin</h2>
          </div>
          <p>
            Manage queues, rules, groups, and the content
            QueuePilot can choose.
          </p>
        </Link>

        <Link
          className="mode-card mode-card-watch-play"
          id="mode-watch-play"
          to="/what-to-watch-play"
        >
          <div className="mode-card-heading">
            <WatchPlayIcon />
            <h2>What to Watch/Play</h2>
          </div>
          <p>
            Choose what to watch or play, then start it.
          </p>
        </Link>
      </div>
    </main>
  )
}

function AdminIcon() {
  return (
    <svg
      aria-hidden="true"
      className="mode-card-icon"
      fill="none"
      focusable="false"
      height="36"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      viewBox="0 0 24 24"
      width="36"
    >
      <path d="M4 6h16M4 12h16M4 18h16" />
      <circle
        cx="8"
        cy="6"
        fill="currentColor"
        r="2"
        stroke="none"
      />
      <circle
        cx="16"
        cy="12"
        fill="currentColor"
        r="2"
        stroke="none"
      />
      <circle
        cx="10"
        cy="18"
        fill="currentColor"
        r="2"
        stroke="none"
      />
    </svg>
  )
}

function WatchPlayIcon() {
  return (
    <svg
      aria-hidden="true"
      className="mode-card-icon"
      fill="none"
      focusable="false"
      height="36"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      viewBox="0 0 24 24"
      width="36"
    >
      <circle cx="12" cy="12" r="9" />
      <path
        d="m10 8 6 4-6 4V8Z"
        fill="currentColor"
        stroke="none"
      />
    </svg>
  )
}
