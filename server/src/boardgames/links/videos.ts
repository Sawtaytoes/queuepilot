/**
 * "How do we play this?" — answered from BoardGameGeek's own video gallery.
 *
 * One teaching channel is singled out by name, because many of its videos are the
 * publisher-endorsed teach. BGG's `instructional` gallery carries a `user.username` on every
 * entry, so "is this that channel's video" is an exact string equality rather than a guess at a
 * title.
 *
 * It is not, however, common. In a sample of a real collection only about a quarter of games
 * had a video from that channel, while roughly three quarters had *some* how-to-play video. So
 * the fallback is the point — a button that is missing three times in four is a button nobody
 * looks for. The card labels the two cases differently, because the named channel is a promise
 * about quality and a generic teach is not.
 *
 * Same host and the same manners as `enrich/geekdo.ts`: one request per second, everything
 * cached to disk.
 */

/**
 * Exactly how the channel's account is named on BGG.
 *
 * A public channel name, and load-bearing: it is compared for equality against the payload's
 * `user.username`, so it cannot be paraphrased.
 */
const WATCH_IT_PLAYED = 'Watch It Played';

const HOW_TO_PLAY = /\b(?:how|learn)\s*(?:to|2)\s*play\b|\bhow\s*it\s*works\b/i;

export interface GeekdoVideo {
  title: string;
  username: string | null;
  /** `youtube`, `vimeo`, … */
  videohost: string | null;
  /** The id ON that host, which is what makes a watchable URL. */
  extvideoid: string | null;
  language: string | null;
  /** BGG's thumbs-up count. The only quality signal on offer. */
  numrecommend: number;
}

export interface SelectedVideo {
  /** What the button says — and it must not overclaim. */
  label: string;
  url: string;
  isOfficialTeach: boolean;
}

interface RawVideo {
  title?: unknown;
  user?: { username?: unknown } | null;
  videohost?: unknown;
  extvideoid?: unknown;
  language?: unknown;
  numrecommend?: unknown;
}

export const parseVideos = (payload: unknown): GeekdoVideo[] => {
  if (typeof payload !== 'object' || payload === null) return [];

  const list = (payload as Record<string, unknown>).videos;
  if (!Array.isArray(list)) return [];

  return list.map((video: RawVideo) => ({
    extvideoid: typeof video.extvideoid === 'string' ? video.extvideoid : null,
    language: typeof video.language === 'string' ? video.language : null,
    // BGG sends every number in this payload as a string.
    numrecommend: Number(video.numrecommend ?? 0) || 0,
    title: typeof video.title === 'string' ? video.title : '',
    username: typeof video.user?.username === 'string' ? video.user.username : null,
    videohost: typeof video.videohost === 'string' ? video.videohost : null,
  }));
};

const isWatchable = (video: GeekdoVideo): boolean =>
  // YouTube only, deliberately: it is the one host whose watch URL can be built from an id
  // without another API call, and the named teaching channel publishes there.
  video.videohost === 'youtube' && video.extvideoid !== null && video.extvideoid !== '';

// A tutorial in a language nobody at this table reads is not a tutorial. `null` passes: a
// handful of BGG entries carry no language at all, and dropping those loses real teaches.
const isReadable = (video: GeekdoVideo): boolean =>
  video.language === null || video.language === 'English';

const watchUrl = (video: GeekdoVideo): string =>
  `https://www.youtube.com/watch?v=${video.extvideoid}`;

/**
 * Pick the one video to link, or nothing.
 *
 * Nothing is a perfectly good answer: a "How to play" button that opens a five-year-old
 * unboxing is worse than no button, because you only find out after clicking it in front of
 * four waiting people.
 */
export const selectHowToPlayVideo = (videos: GeekdoVideo[]): SelectedVideo | null => {
  const usable = videos.filter((video) => isWatchable(video) && isReadable(video));

  const official = usable
    .filter((video) => video.username === WATCH_IT_PLAYED)
    .sort((a, b) => b.numrecommend - a.numrecommend)[0];

  if (official)
    return {
      isOfficialTeach: true,
      label: WATCH_IT_PLAYED,
      url: watchUrl(official),
    };

  const [best] = usable
    .filter((video) => HOW_TO_PLAY.test(video.title))
    .sort((a, b) => b.numrecommend - a.numrecommend);

  return best
    ? {
        isOfficialTeach: false,
        label: 'How to play',
        url: watchUrl(best),
      }
    : null;
};

export const fetchInstructionalVideos = async (bggId: number): Promise<unknown> => {
  const url =
    'https://api.geekdo.com/api/videos' +
    `?objectid=${bggId}&objecttype=thing&gallery=instructional` +
    // `hot` puts the well-recommended videos in the first page, so one page of 50 is enough to
    // find the best teach.
    '&pageid=1&showcount=50&sort=hot&nosession=1&ajax=1';

  const response = await fetch(url, {
    headers: {
      accept: 'application/json',
      'user-agent': 'board-game-picker/0.1 (self-hosted collection picker)',
    },
  });

  if (!response.ok) throw new Error(`geekdo videos ${bggId} → HTTP ${response.status}`);

  return await response.json();
};
