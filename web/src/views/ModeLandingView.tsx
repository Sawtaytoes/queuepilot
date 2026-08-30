import { ColorSchemeSwitcher } from "@charcuterie/ui"
import { Link } from "react-router"

import { PRIMARY_NAVIGATION_ITEMS } from "../components/PrimaryNavigation"
import { schemeIcons } from "../components/SchemeIcons"

const [watchPlayItem, queuesItem, ...managementItems] =
  PRIMARY_NAVIGATION_ITEMS

/** The front door answers what to do next. It does not render the work itself. */
export function ModeLandingView() {
  return (
    <main className="mode-landing" id="mode-landing">
      <div className="mode-landing-scheme">
        <ColorSchemeSwitcher icons={schemeIcons} />
      </div>

      <div className="mode-landing-intro">
        <p className="mode-landing-eyebrow">QueuePilot</p>
        <h1>What do you want to do?</h1>
        <p>
          Start something, or go directly to one management
          area.
        </p>
      </div>

      <div className="mode-primary-actions">
        <Link
          className="mode-primary-action"
          to={watchPlayItem.href}
        >
          <span className="mode-primary-icon">
            {watchPlayItem.icon}
          </span>
          <span>
            <strong>What to Watch/Play</strong>
            <small>
              Choose who is here and get one answer.
            </small>
          </span>
          <span
            aria-hidden="true"
            className="mode-action-arrow"
          >
            →
          </span>
        </Link>

        <Link
          className="mode-primary-action"
          to={queuesItem.href}
        >
          <span className="mode-primary-icon">
            {queuesItem.icon}
          </span>
          <span>
            <strong>Open a queue</strong>
            <small>
              Browse your saved picks and open one queue.
            </small>
          </span>
          <span
            aria-hidden="true"
            className="mode-action-arrow"
          >
            →
          </span>
        </Link>
      </div>

      <section
        className="mode-management"
        aria-labelledby="manage-heading"
      >
        <div className="mode-management-heading">
          <h2 id="manage-heading">Manage</h2>
          <p>Change one part of QueuePilot.</p>
        </div>

        <div className="mode-management-links">
          {[queuesItem, ...managementItems].map((item) => (
            <Link
              className="mode-management-link"
              key={item.href}
              to={item.href}
            >
              <span className="mode-management-icon">
                {item.icon}
              </span>
              <span>{item.label}</span>
              <span
                aria-hidden="true"
                className="mode-management-arrow"
              >
                ›
              </span>
            </Link>
          ))}
        </div>
      </section>
    </main>
  )
}
