export const COLLECTIONS = [
  {
    description:
      "Every board game on the shelf. Find a title, review its details, or record a play.",
    href: "/collection/board-games",
    id: "board-games",
    label: "Board Games",
    status: "Available",
  },
] as const

export type CollectionId =
  (typeof COLLECTIONS)[number]["id"]
