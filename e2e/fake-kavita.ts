// A FAKE KAVITA, for driving the reading UI offline.
//
// `e2e/dev.sh` boots the app against the REAL Plex, which is fine for a Plex queue and useless
// for a reading one: a screenshot of the real instance carries the household's library into a
// public repo (AGENTS.md), and there is no reading fixture to point at instead. So this serves
// the handful of endpoints `providers/kavita-client.ts` calls, out of an invented library, and
// draws its own covers.
//
//   server/node_modules/.bin/tsx e2e/fake-kavita.ts        # listens on :18795
//
// Point the app at it with `KAVITA_API_SERVER_URL=http://127.0.0.1:18795` and any non-empty
// `KAVITA_API_KEY` — `/api/Plugin/authenticate` accepts every key, because what is being
// exercised is the queue, never the credential.
//
// The cast is invented and stays invented. Two libraries — Volumes (2) and Strips (5) — so a
// FILTERED queue over one of them has something to narrow.
import { createServer } from 'node:http';

const PORT = Number(process.env.FAKE_KAVITA_PORT || 18795);

interface Series {
  id: number;
  name: string;
  libraryId: number;
  /** 1 = image/archive, which is what both of these libraries hold. */
  format: number;
  /** The unread run this series still has, newest last. */
  unread: number;
  /** A hue for the generated cover, so the grid is not four identical rectangles. */
  hue: number;
}

const LIBRARIES = [
  { id: 2, name: 'Volumes', type: 0 },
  { id: 5, name: 'Strips', type: 0 },
];

const SERIES: Series[] = [
  { format: 1, hue: 12, id: 101, libraryId: 5, name: 'A Flame Reborn', unread: 6 },
  { format: 1, hue: 45, id: 102, libraryId: 2, name: 'The Bound Cartographer', unread: 3 },
  { format: 1, hue: 96, id: 103, libraryId: 5, name: 'Nine Lanterns', unread: 12 },
  { format: 1, hue: 152, id: 104, libraryId: 2, name: 'Salt and the Long Road', unread: 2 },
  { format: 1, hue: 205, id: 105, libraryId: 5, name: 'A Hero Who Knows His Stuff', unread: 9 },
  { format: 1, hue: 262, id: 106, libraryId: 2, name: 'Winter Court Records', unread: 4 },
  { format: 1, hue: 315, id: 107, libraryId: 5, name: 'Second Sun Rising', unread: 7 },
  { format: 1, hue: 340, id: 108, libraryId: 5, name: 'The Quiet Tenant', unread: 5 },
];

const byId = new Map(SERIES.map((s) => [s.id, s]));

/** This series' chapters, oldest first. Chapter ids are `<seriesId><nn>` so a log line names
 *  the series without a lookup. */
const chaptersOf = (s: Series) =>
  Array.from({ length: s.unread }, (_, i) => ({
    id: s.id * 100 + i + 1,
    minNumber: i + 1,
    number: String(i + 1),
    pages: 40,
    pagesRead: 0,
    title: `Chapter ${i + 1}`,
  }));

// The reading lists this instance holds — created and rebuilt by the app, exactly as the real
// one is. In memory only: restarting the fake is how you reset it.
interface List { id: number; title: string; coverImageLocked: boolean; promoted: boolean; summary: string }
const lists: List[] = [];
const listItems = new Map<number, { id: number; chapterId: number; seriesId: number; order: number; pagesRead: number; pagesTotal: number; lastReadingProgressUtc: string | null }[]>();
let nextListId = 300;
let nextItemId = 9000;

/**
 * A cover, drawn rather than stored: a flat hue with the series' initials.
 *
 * An SVG and not a PNG on purpose — it is a dozen lines instead of an encoder, and the app
 * re-serves these bytes through its own `/api/providers/:id/cover/:id` route, which is a byte
 * pipe and does not care which image format it is carrying.
 */
const coverSvg = (s: Series) => {
  const initials = s.name
    .split(/\s+/)
    .filter((w) => /^[A-Za-z]/.test(w))
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="480" viewBox="0 0 320 480">`
    + `<rect width="320" height="480" fill="hsl(${s.hue} 42% 26%)"/>`
    + `<rect x="0" y="380" width="320" height="100" fill="hsl(${s.hue} 42% 18%)"/>`
    + `<text x="160" y="230" font-family="system-ui, sans-serif" font-size="120" font-weight="700"`
    + ` fill="hsl(${s.hue} 60% 78%)" text-anchor="middle">${initials}</text>`
    + `<text x="160" y="430" font-family="system-ui, sans-serif" font-size="22"`
    + ` fill="hsl(${s.hue} 30% 82%)" text-anchor="middle">${s.libraryId === 5 ? 'Strips' : 'Volumes'}</text>`
    + `</svg>`;
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://127.0.0.1:${PORT}`);
  const send = (body: unknown, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const readBody = async (): Promise<Record<string, unknown>> => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString('utf8');
    try {
      return text ? JSON.parse(text) as Record<string, unknown> : {};
    } catch {
      return {};
    }
  };

  // Every key authenticates. The credential is not what any of these harnesses test.
  if (url.pathname === '/api/Plugin/authenticate') {
    return send({ token: 'fake-jwt', username: 'Reader' });
  }
  if (url.pathname === '/api/Library/libraries') return send(LIBRARIES);

  if (url.pathname === '/api/Series/all-v2') {
    // Kavita's SmartFilter encoding — field 19 is libraryId. The app only ever asks for one
    // library at a time, so reading the first statement is the whole of it. No statements is
    // "every series", which is what an unscoped queue asks for.
    const body = await readBody();
    const statements = Array.isArray(body.statements)
      ? body.statements as { field?: number; value?: string }[]
      : [];
    const wanted = statements.find((st) => st.field === 19)?.value;
    const rows = wanted == null
      ? SERIES
      : SERIES.filter((s) => String(s.libraryId) === String(wanted));
    return send(rows.map((s) => ({ ...s, pages: s.unread * 40, pagesRead: 0 })));
  }
  if (url.pathname.startsWith('/api/Series/series-detail')) {
    const s = byId.get(Number(url.searchParams.get('seriesId')));
    if (!s) return send({ chapters: [], specials: [], volumes: [] });
    return send({ chapters: chaptersOf(s), specials: [], unreadCount: s.unread, volumes: [] });
  }
  if (url.pathname.startsWith('/api/Series/')) {
    const s = byId.get(Number(url.pathname.split('/').pop()));
    return s ? send(s) : send(null, 404);
  }
  if (url.pathname === '/api/Reader/continue-point') {
    const s = byId.get(Number(url.searchParams.get('seriesId')));
    // seriesId NULL, exactly as the live endpoint answers — the client threads it back in.
    return s ? send({ ...chaptersOf(s)[0], seriesId: null }) : send(null, 404);
  }
  if (url.pathname === '/api/Image/series-cover') {
    const s = byId.get(Number(url.searchParams.get('seriesId')));
    if (!s) return send(null, 404);
    res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
    return res.end(coverSvg(s));
  }
  if (url.pathname === '/api/Search/search') {
    const q = (url.searchParams.get('queryString') || '').toLowerCase();
    return send({
      series: SERIES.filter((s) => s.name.toLowerCase().includes(q)),
    });
  }

  // --- reading lists -------------------------------------------------------- //
  if (url.pathname === '/api/ReadingList/lists') return send(lists);
  if (url.pathname === '/api/ReadingList/items') {
    return send(listItems.get(Number(url.searchParams.get('readingListId'))) ?? []);
  }
  if (url.pathname === '/api/ReadingList/create') {
    const body = await readBody();
    const list = {
      coverImageLocked: false,
      id: nextListId,
      promoted: false,
      summary: '',
      title: String(body.title ?? 'Untitled'),
    };
    nextListId += 1;
    lists.push(list);
    listItems.set(list.id, []);
    return send(list);
  }
  if (url.pathname === '/api/ReadingList/update-by-chapter') {
    const body = await readBody();
    const listId = Number(body.readingListId);
    const rows = listItems.get(listId) ?? [];
    rows.push({
      chapterId: Number(body.chapterId),
      id: nextItemId,
      lastReadingProgressUtc: null,
      order: rows.length,
      pagesRead: 0,
      pagesTotal: 40,
      seriesId: Number(body.seriesId),
    });
    nextItemId += 1;
    listItems.set(listId, rows);
    return send({ ok: true });
  }
  if (url.pathname === '/api/ReadingList/delete-item') {
    const body = await readBody();
    const listId = Number(body.readingListId);
    listItems.set(
      listId,
      (listItems.get(listId) ?? []).filter((r) => r.id !== Number(body.readingListItemId)),
    );
    return send({ ok: true });
  }
  if (url.pathname === '/api/ReadingList/update') {
    const body = await readBody();
    const row = lists.find((l) => l.id === Number(body.readingListId));
    if (row) {
      row.title = String(body.title ?? row.title);
      row.coverImageLocked = Boolean(body.coverImageLocked);
    }
    return send({ ok: true });
  }
  if (url.pathname === '/api/Upload/reading-list') {
    const body = await readBody();
    const row = lists.find((l) => l.id === Number(body.readingListId));
    if (row) row.coverImageLocked = true;
    return send({ ok: true });
  }
  if (url.pathname.startsWith('/api/ReadingList/remove-read')) return send({ ok: true });

  return send({ error: `fake-kavita has no route for ${url.pathname}` }, 404);
});

server.listen(PORT, () => {
  console.log(`[fake-kavita] listening on http://127.0.0.1:${PORT}`);
  console.log('[fake-kavita] libraries: 2 Volumes, 5 Strips — 8 series, all unread');
});
