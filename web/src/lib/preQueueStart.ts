import type {
  ChannelMember,
  PendingItem,
  SearchHit,
  StartPoint,
} from "./types"

/** Dress an item that is not in a queue yet as the entry consumed by StartModal. */
export function asPreQueueStartEntry(
  item: Pick<
    PendingItem | SearchHit,
    "childCount" | "ratingKey" | "title" | "type" | "year"
  >,
  start: StartPoint | null,
): ChannelMember {
  return {
    childCount:
      item.type === "collection"
        ? (item.childCount ?? null)
        : null,
    cover: null,
    index: -1,
    nextEp: null,
    ratingKey: item.ratingKey,
    resolved: true,
    start,
    title: item.title,
    type: item.type,
    year: item.year ?? null,
  }
}
