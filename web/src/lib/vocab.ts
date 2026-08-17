import type { ProviderVocabulary } from "./types"

/**
 * Plex's words, used wherever a caller has no set in hand.
 *
 * The fallback rather than a hardcoded string, so a component that forgets to
 * pass the vocabulary renders exactly what it rendered before providers had one
 * — a visible-but-wrong noun on a reading tile, never `undefined`.
 */
export const PLEX_WORDS: ProviderVocabulary = {
  done: "watched",
  member: "show",
  name: "Plex",
  startIcon: "▶",
  unit: "episode",
  unitShort: "eps",
  units: "episodes",
  verb: "Play",
}

function memberPlural(member: string): string {
  if (member === "series" || member.endsWith("s"))
    return member

  return `${member}s`
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * The whole-word swaps from Plex's vocabulary to `vocab`.
 *
 * Longest first so "episodes" wins over "episode" and "unwatched" wins over
 * "watched". Identity pairs are dropped — applying Plex's own words is a no-op.
 */
export function replacementTable(
  vocab: ProviderVocabulary,
): [string, string][] {
  const plex = PLEX_WORDS
  const fromName = plex.name ?? "Plex"
  const toName = vocab.name || fromName
  const pairs: [string, string][] = [
    [plex.units, vocab.units],
    [plex.unit, vocab.unit],
    [`un${plex.done}`, `un${vocab.done}`],
    [plex.done, vocab.done],
    [plex.verb, vocab.verb],
    [`${plex.member}s`, memberPlural(vocab.member)],
    [plex.member, vocab.member],
    [fromName, toName],
  ]

  // Play → Read also rewrites Playback → Reading. "Playback" is not "Play", so
  // a word-boundary on the verb would leave it sitting on a reading queue.
  if (
    plex.verb.toLowerCase() !== vocab.verb.toLowerCase()
  ) {
    pairs.push([`${plex.verb}back`, `${vocab.verb}ing`])
  }

  return pairs
    .filter(
      ([from, to]) =>
        Boolean(from) &&
        Boolean(to) &&
        from.toLowerCase() !== to.toLowerCase(),
    )
    .sort((a, b) => b[0].length - a[0].length)
}

function transferCase(
  match: string,
  replacement: string,
): string {
  if (match.length > 1 && match === match.toUpperCase()) {
    return replacement.toUpperCase()
  }

  const first = match[0]

  if (first && first === first.toUpperCase()) {
    return (
      replacement.charAt(0).toUpperCase() +
      replacement.slice(1)
    )
  }

  return (
    replacement.charAt(0).toLowerCase() +
    replacement.slice(1)
  )
}

/** "an episode" → "an chapter" is unreadable; pick a/an from the new word. */
function articleFor(word: string): "a" | "an" {
  return /^[aeiou]/i.test(word) ? "an" : "a"
}

function repairArticles(text: string): string {
  return text.replace(
    /\b(an?)\s+(\w+)/gi,
    (all, art: string, word: string) => {
      const want = articleFor(word)

      if (art.toLowerCase() === want) return all

      return transferCase(art, want) + all.slice(art.length)
    },
  )
}

/**
 * Apply a provider's vocabulary to copy that was authored in Plex words.
 *
 * Copy is written once. A provider that is not Plex swaps the words its
 * vocabulary names — episode→chapter, watched→read, Plex→Kavita — so a new
 * backend is one map entry, not a second set of sentences.
 *
 * Identity on Plex's own words: applying `PLEX_WORDS` is a no-op.
 *
 * Do not run this over a title or any other string the user (or the backend)
 * supplied — `\bPlay\b` would rewrite "The Play". It is for OUR copy only.
 */
export function applyVocab(
  text: string,
  vocab: ProviderVocabulary | null | undefined,
): string {
  const words = vocab ?? PLEX_WORDS
  const table = replacementTable(words)

  if (!text || !table.length) return text

  const pattern = new RegExp(
    `\\b(${table.map(([from]) => escapeRe(from)).join("|")})\\b`,
    "gi",
  )
  const byLower = new Map(
    table.map(([from, to]) => [from.toLowerCase(), to]),
  )

  return repairArticles(
    text.replace(pattern, (match) => {
      const to = byLower.get(match.toLowerCase())

      return to ? transferCase(match, to) : match
    }),
  )
}

/** The vocabulary a set carries, or Plex's words when the set is unknown. */
export function vocabForSet(
  sets:
    | { id: string; vocabulary?: ProviderVocabulary }[]
    | undefined,
  setId: string | null | undefined,
): ProviderVocabulary {
  return (
    (setId &&
      sets?.find((s) => s.id === setId)?.vocabulary) ||
    PLEX_WORDS
  )
}
