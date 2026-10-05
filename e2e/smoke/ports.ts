// Where the smoke's four fixture servers listen, and the instant their clocks start at.
//
// Private ports, away from every other harness's (VRT is 18951-18954). Overridable, because a
// port that answers is not proof it is ours: a concurrent run on the same host picks another.
export const SMOKE_BASE_PORT = Number(process.env.QUEUEPILOT_SMOKE_PORT ?? 18961);

/** The same instant VRT pins, so the smoke draws the season window VRT draws. */
export const SMOKE_FIXED_NOW = '2026-06-15T18:00:00.000Z';

export const smokeServers = {
  landing: `http://localhost:${SMOKE_BASE_PORT}`,
  calendar: `http://localhost:${SMOKE_BASE_PORT + 1}`,
  tonight: `http://localhost:${SMOKE_BASE_PORT + 2}`,
  boardGames: `http://localhost:${SMOKE_BASE_PORT + 3}`,
} as const;
