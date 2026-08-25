// QueuePilot ACTIVITIES — what you want to DO, which is the only thing a queue is named for.
//
// ── The rule this file exists to hold ────────────────────────────────────────────────────
//
// A queue's type is the ACTIVITY. The provider is an ATTRIBUTE of the queue, never a heading
// over it (decision 2026-08-25-a-queue-is-people-plus-an-activity §1). You choose "Video
// Games", and then you choose a queue inside it; whether that queue is served by Steam or by
// a MiSTer is something the card tells you afterwards.
//
// ── Why the list is four items and not eight ─────────────────────────────────────────────
//
// The WP-5 mockup guessed at a finer content list — Movies, Anime, Shows, Shorts, Reading,
// Board Games, Video Games, Retro Games — and the owner rejected it, on a specific failure
// rather than on taste:
//
//   "the Older Kids queue would show up under both Shows and Shorts, but I don't think of it
//    like that in my head."
//
// A finer list forces one queue under two headings. So ANIME IS NOT A TYPE: two queues under
// `watching`, told apart by what is in them and by whose faces are on them. The same answer
// merges Retro Games into Video Games — "'Video Games' would include MiSTer and Steam and
// Switch (Eden) and Wii U (Cemu), and GameCube/Wii (Dolphin). I'd be chosing the style I
// wanna go with and then pick one from there."
//
// ── Why it is DERIVED and not migrated ───────────────────────────────────────────────────
//
// Every provider this app has serves exactly one activity, so the derivation below is a
// lookup and not a guess. That is what lets WP-5 migrate sixteen queues without writing a
// byte: nothing is stamped onto `sets.yaml`, the activity is computed on read, and the stored
// field only ever holds an override somebody typed. A stamped value would also be the WRONG
// kind of durable — it would freeze today's provider→activity opinion into the file and then
// disagree with this table the first time it moved.
//
// The one thing the derivation cannot do is split `watching` into Movies and Shows. It is not
// supposed to: they are one activity by the decision above.

/** The activities a queue can be under. Wire values — they reach `sets.yaml` when overridden
 *  and the query string when the Tonight form filters, so they are kebab-case and stable. */
export const ACTIVITIES = ['watching', 'reading', 'video-games', 'board-games'] as const;

export type Activity = (typeof ACTIVITIES)[number];

/** What each one is called on screen. "Movies & Shows" is one activity on purpose — see the
 *  header. */
export const ACTIVITY_LABELS: Readonly<Record<Activity, string>> = {
  'board-games': 'Board Games',
  reading: 'Reading',
  'video-games': 'Video Games',
  watching: 'Movies & Shows',
};

/**
 * Provider kind -> the activity it serves.
 *
 * Every kind `providers/config.ts` can emit is here. A kind that is NOT here answers
 * `watching`, which is the honest default for this household's app — every set that predates
 * a non-Plex provider is a Plex set — but it is a fallback and not a mapping, so a new
 * provider gets a row here in the same change that adds it.
 */
const ACTIVITY_BY_PROVIDER_KIND: Readonly<Record<string, Activity>> = {
  'board-game-picker': 'board-games',
  kavita: 'reading',
  mister: 'video-games',
  plex: 'watching',
  steam: 'video-games',
};

/** True when `value` is one of the four. Used to refuse an unknown activity at the API edge
 *  rather than storing it and finding out on the next read. */
export const isActivity = (value: unknown): value is Activity =>
  typeof value === 'string' && (ACTIVITIES as readonly string[]).includes(value);

/** The activity a provider serves, with no set involved. */
export const activityForProviderKind = (kind: unknown): Activity =>
  ACTIVITY_BY_PROVIDER_KIND[String(kind ?? '').trim().toLowerCase()] ?? 'watching';

/**
 * The activity a set is under: the stored override if it has one, otherwise its provider's.
 *
 * An override that is not one of the four is IGNORED rather than propagated — a typo in a
 * hand-edited `sets.yaml` should put the queue under its provider's activity, not under a
 * heading that exists nowhere and hides it from every screen.
 *
 * ⚠️ `provider_id` is the FALLBACK and it is load-bearing. `providerKindForSet()` answers `''`
 * for a provider this BUILD does not have configured — `providerDefinitions()` omits Kavita
 * when `KAVITA_URL` is unset — and a Kavita queue is a reading queue whether or not the
 * connector is up. Without this, one unset environment variable silently moves four queues
 * from Reading to Movies & Shows, which is a heading changing because a service is down. The
 * five built-in providers spell their id and their kind the same way, so the fallback is
 * exact for all of them; a second Kavita added under its own id (`my-kavita`) is the case it
 * cannot answer, and it lands on `watching` only while its connector is down.
 */
export function activityForSet(set: {
  activity?: unknown;
  provider_kind?: unknown;
  provider_id?: unknown;
}): Activity {
  if (isActivity(set.activity)) return set.activity;

  const kind = String(set.provider_kind ?? '').trim().toLowerCase();
  if (kind) return activityForProviderKind(kind);

  const id = String(set.provider_id ?? '').trim().toLowerCase();
  return activityForProviderKind(id);
}

/** The label to put on a queue card. There is no name to fall back to and that is the point:
 *  every movies queue is called "Movies", and the faces beside it are what tell them apart. */
export const activityLabel = (activity: Activity): string => ACTIVITY_LABELS[activity];
