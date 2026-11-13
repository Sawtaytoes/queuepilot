import { describe, expect, test } from "vitest"

import {
  type GeekdoVideo,
  parseVideos,
  selectHowToPlayVideo,
} from "./videos.js"

const video = (
  overrides: Partial<GeekdoVideo>,
): GeekdoVideo => ({
  extvideoid: "aaaaaaaaaaa",
  language: "English",
  numrecommend: 0,
  title: "Some video",
  username: "someone",
  videohost: "youtube",
  ...overrides,
})

describe("parseVideos", () => {
  test("reads the shape BGG actually sends", () => {
    // Every number in this payload arrives as a string, and the username is nested under
    // `user`.
    expect(
      parseVideos({
        videos: [
          {
            extvideoid: "abc123",
            language: "English",
            numrecommend: "256",
            title: "Harbour Lantern - How To Play",
            user: { username: "Watch It Played" },
            videohost: "youtube",
          },
        ],
      }),
    ).toEqual([
      {
        extvideoid: "abc123",
        language: "English",
        numrecommend: 256,
        title: "Harbour Lantern - How To Play",
        username: "Watch It Played",
        videohost: "youtube",
      },
    ])
  })

  test("survives a game with no gallery at all", () => {
    expect(parseVideos({ videos: [] })).toEqual([])
    expect(parseVideos(null)).toEqual([])
    expect(parseVideos({})).toEqual([])
  })
})

describe("selectHowToPlayVideo", () => {
  test("prefers the named teaching channel over a better-liked stranger", () => {
    const selected = selectHowToPlayVideo([
      video({
        extvideoid: "popular",
        numrecommend: 9000,
        title: "How to play Harbour Lantern",
      }),
      video({
        extvideoid: "official",
        numrecommend: 12,
        title: "Harbour Lantern - How To Play",
        username: "Watch It Played",
      }),
    ])

    expect(selected).toEqual({
      isOfficialTeach: true,
      label: "Watch It Played",
      url: "https://www.youtube.com/watch?v=official",
    })
  })

  test("falls back to the best-liked how-to-play", () => {
    const selected = selectHowToPlayVideo([
      video({
        extvideoid: "quiet",
        numrecommend: 3,
        title: "How to play Harbour Lantern",
      }),
      video({
        extvideoid: "loud",
        numrecommend: 300,
        title: "Learn to Play Harbour Lantern",
      }),
    ])

    expect(selected).toMatchObject({
      isOfficialTeach: false,
      label: "How to play",
      url: "https://www.youtube.com/watch?v=loud",
    })
  })

  /**
   * The gallery is full of unboxings, reviews and playthroughs. Linking one of those from a
   * button labelled "How to play" is a promise broken in front of four waiting people.
   */
  test("links nothing rather than an unboxing", () => {
    expect(
      selectHowToPlayVideo([
        video({ title: "Harbour Lantern Unboxing" }),
        video({
          title: "Tabletop Review: Harbour Lantern",
        }),
      ]),
    ).toBeNull()
  })

  test("skips a teach nobody at this table can follow", () => {
    expect(
      selectHowToPlayVideo([
        video({
          language: "German",
          title: "How to play Harbour Lantern",
        }),
      ]),
    ).toBeNull()
  })

  test("takes an untagged language, because BGG often omits it", () => {
    expect(
      selectHowToPlayVideo([
        video({
          language: null,
          title: "How to play Harbour Lantern",
        }),
      ]),
    ).not.toBeNull()
  })

  test("ignores a host whose watch URL we cannot build", () => {
    expect(
      selectHowToPlayVideo([
        video({
          title: "How to play Harbour Lantern",
          username: "Watch It Played",
          videohost: "vimeo",
        }),
      ]),
    ).toBeNull()
  })
})
