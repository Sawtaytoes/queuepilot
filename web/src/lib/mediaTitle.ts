/** Add a release year unless Plex already included that exact suffix. */
export function titleWithYear(
  title: string,
  year: number | string | null | undefined,
): string {
  if (!year) return title

  const suffix = ` (${year})`
  return title.endsWith(suffix)
    ? title
    : `${title}${suffix}`
}
