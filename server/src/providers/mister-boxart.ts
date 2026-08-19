// Box art for MiSTer games, from the libretro thumbnail archive.
//
// mrext serves NO artwork. Its only image concept is screenshots you took yourself
// (`GET /screenshots`), so a MiSTer queue drew as a grid of grey rectangles beside Plex
// posters and Steam library art (reported live, 2026-08-17).
//
// The archive at thumbnails.libretro.com is keyed on **No-Intro ROM names** — the exact
// naming convention this household's ROM share already follows, because `games-ingest`
// symlinks 1G1R collections into place rather than renaming anything. So the path a queue
// entry already stores contains everything a thumbnail URL needs:
//
//   /media/fat/games/SNES/Games/Super Mario World (USA).zip/Super Mario World (USA).sfc
//                    ^^^^                                   ^^^^^^^^^^^^^^^^^^^^^^^
//                    system                                 the No-Intro name
//
//   -> https://thumbnails.libretro.com/Nintendo - Super Nintendo Entertainment System
//          /Named_Boxarts/Super Mario World (USA).png
//
// MEASURED against this library before being built: 47 of 48 sampled games across SNES, NES,
// GBA, Genesis, N64, Master System, Game Boy and PlayStation had box art. The archive is
// public and needs no credential.
//
// WHY THE MAP IS HAND-WRITTEN AND PARTIAL. The two vocabularies do not line up: the MiSTer
// has 102 systems, the archive has 123 folders, and the overlap is neither a prefix match nor
// a slug match (`Genesis` -> `Sega - Mega Drive - Genesis`, `C16` -> `Commodore - Plus-4`).
// A fuzzy matcher would quietly hand back the wrong console's art, which is worse than no
// art at all — a grey tile is honest. So an unmapped system returns NO candidates and the
// tile stays blank, exactly as it does today.

/**
 * MiSTer system id -> libretro thumbnail folder.
 *
 * Only the systems that HOLD GAMES here, plus the obvious neighbours. Computers with tape
 * libraries (ZX Spectrum, Amiga, ao486…) are deliberately sparse: their naming conventions
 * are not No-Intro, so a "hit" would be luck rather than a match.
 */
export const LIBRETRO_SYSTEM: Record<string, string | undefined> = {
  // Nintendo
  NES: 'Nintendo - Nintendo Entertainment System',
  FDS: 'Nintendo - Family Computer Disk System',
  SNES: 'Nintendo - Super Nintendo Entertainment System',
  Nintendo64: 'Nintendo - Nintendo 64',
  Gameboy: 'Nintendo - Game Boy',
  Gameboy2P: 'Nintendo - Game Boy',
  SuperGameboy: 'Nintendo - Game Boy',
  GameboyColor: 'Nintendo - Game Boy Color',
  GBA: 'Nintendo - Game Boy Advance',
  GBA2P: 'Nintendo - Game Boy Advance',
  PokemonMini: 'Nintendo - Pokemon Mini',
  // Sega
  Genesis: 'Sega - Mega Drive - Genesis',
  MegaCD: 'Sega - Mega-CD - Sega CD',
  Sega32X: 'Sega - 32X',
  MasterSystem: 'Sega - Master System - Mark III',
  GameGear: 'Sega - Game Gear',
  SG1000: 'Sega - SG-1000',
  Saturn: 'Sega - Saturn',
  // Sony / NEC / SNK
  PSX: 'Sony - PlayStation',
  TurboGrafx16: 'NEC - PC Engine - TurboGrafx 16',
  TurboGrafx16CD: 'NEC - PC Engine CD - TurboGrafx-CD',
  SuperGrafx: 'NEC - PC Engine SuperGrafx',
  NeoGeo: 'SNK - Neo Geo',
  NeoGeoCD: 'SNK - Neo Geo CD',
  // Atari
  Atari2600: 'Atari - 2600',
  Atari5200: 'Atari - 5200',
  Atari7800: 'Atari - 7800',
  Atari800: 'Atari - 8-bit',
  AtariLynx: 'Atari - Lynx',
  // the rest of the cartridge era
  WonderSwan: 'Bandai - WonderSwan',
  WonderSwanColor: 'Bandai - WonderSwan Color',
  ColecoVision: 'Coleco - ColecoVision',
  Intellivision: 'Mattel - Intellivision',
  Vectrex: 'GCE - Vectrex',
  Odyssey2: 'Magnavox - Odyssey2',
  ChannelF: 'Fairchild - Channel F',
  Arcadia: 'Emerson - Arcadia 2001',
  AdventureVision: 'Entex - Adventure Vision',
  CasioPV1000: 'Casio - PV-1000',
  CreatiVision: 'VTech - CreatiVision',
  SuperVision: 'Watara - Supervision',
  MSX: 'Microsoft - MSX',
  C64: 'Commodore - 64',
  VIC20: 'Commodore - VIC-20',
  // Not a typo: the MiSTer's C16 core covers the C16/plus4 family, which libretro files
  // under Plus-4.
  C16: 'Commodore - Plus-4',
  CDI: 'Philips - CD-i',
};

/**
 * The image kinds to try, in order of what a poster tile actually wants.
 *
 * Box art first because it is the thing that reads as a poster at 160px. A title screen is
 * the next best identifier, and an in-game snap is the last resort — many older systems have
 * snaps for everything and boxarts for very little.
 */
const KINDS = ['Named_Boxarts', 'Named_Titles', 'Named_Snaps'] as const;

/** The archive's host. Public, no credential — see this file's header. */
const BASE = 'https://thumbnails.libretro.com';

/**
 * Every candidate URL for one game, best first. Empty for an unmapped system, which is the
 * deliberate "no art" answer rather than a guess.
 *
 * The name is used VERBATIM apart from URL-encoding: the archive's filenames are the
 * No-Intro names character for character, including the `(USA) (Rev 1)` tails, and
 * "helpfully" stripping a region or a revision is how a title stops matching.
 */
export function boxartUrls(system: string, title: string): string[] {
  const folder = LIBRETRO_SYSTEM[system];
  const name = String(title || '').trim();
  if (!folder || !name) return [];
  // `&` is legal in a No-Intro name ("Sonic & Knuckles") and must be encoded; `encodeURIComponent`
  // also escapes the path separator, so each segment is encoded on its own.
  return KINDS.map((kind) => (
    `${BASE}/${encodeURIComponent(folder)}/${kind}/${encodeURIComponent(name)}.png`
  ));
}
