// One place that answers "which Playwright, and does its browser actually exist?".
//
// This repo has no node_modules of its own for the browser suites — it borrows a sibling's
// Playwright, which is a deliberate choice (installing a second copy would download another
// ~500 MB of browsers into a repo whose runtime image has no browser at all).
//
// What that choice cost, before this module existed: every suite hardcoded
// `createRequire('/mnt/TrueNAS-Apps/Repos/mux-magic/node_modules/')`. Playwright pins a
// browser BUILD NUMBER to each release, so the moment mux-magic's Playwright moved and
// `/opt/pw-browsers` was refreshed for a different sibling, all sixteen browser suites died
// at once with "Executable doesn't exist at .../chromium_headless_shell-1228/…" — a failure
// that says nothing about this repo and blocks every UI gate.
//
// So: try the known siblings in turn and take the first whose chromium is really on disk.
// A version mismatch now costs nothing as long as SOME sibling matches the installed
// browsers, and when none does the error names the actual problem.
//
// ---------------------------------------------------------------------------
// Why the types below are hand-written instead of `import type { Page } from 'playwright'`
//
// The same borrowing that makes the runtime lookup dynamic makes the COMPILE-TIME lookup
// impossible: there is no `playwright` under any node_modules tsc can reach from `e2e/`
// (no root manifest; the siblings live at absolute paths outside the checkout, and CI's
// `npm install playwright` happens at a different repo root than the typecheck step's cwd
// on some runners). A `paths` shim pointed at `/mnt/TrueNAS-Apps/...` would typecheck on
// the NAS and fail on GitHub, which is the worst of both.
//
// So this module declares the SLICE of the Playwright API these suites actually use, and
// every harness imports its `Page`/`Browser`/`ElementHandle` from here. Two consequences
// worth being honest about:
//   * it is structural, not the real declaration — an API that exists in Playwright but is
//     missing here is a typecheck error, and the fix is to add it here, not to cast.
//   * it is deliberately faithful on the parts that MATTER for correctness — the
//     `evaluate`/`$eval`/`$$eval` overloads, which are where the Node/browser boundary
//     lives and where the type system is actually earning its keep.
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';

// --- the API slice -----------------------------------------------------------------

/** Options accepted by every action that can time out. */
export interface TimeoutOptions {
  timeout?: number;
}

export interface ClickOptions extends TimeoutOptions {
  button?: 'left' | 'right' | 'middle';
  clickCount?: number;
  force?: boolean;
  position?: { x: number; y: number };
}

export interface WaitForSelectorOptions extends TimeoutOptions {
  state?: 'attached' | 'detached' | 'visible' | 'hidden';
}

export interface ScreenshotOptions {
  path?: string;
  fullPage?: boolean;
  clip?: { x: number; y: number; width: number; height: number };
  type?: 'png' | 'jpeg';
}

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * A callback handed to `evaluate`/`$eval`/`$$eval` is SERIALISED and run inside the page.
 * It cannot close over anything Node-side — the only channel is the explicit `arg`, which
 * is why every one of these overloads comes in a no-arg and a one-arg form rather than
 * making `arg` optional. Getting that wrong is a runtime ReferenceError in the browser,
 * not a compile error, so the split pair is the point.
 */
export interface JSHandle<T = unknown> {
  jsonValue(): Promise<T>;
  dispose(): Promise<void>;
}

export interface ElementHandle<T extends Element = Element> extends JSHandle<T> {
  click(options?: ClickOptions): Promise<void>;
  hover(options?: TimeoutOptions): Promise<void>;
  fill(value: string, options?: TimeoutOptions): Promise<void>;
  check(options?: TimeoutOptions): Promise<void>;
  focus(): Promise<void>;
  textContent(): Promise<string | null>;
  innerText(): Promise<string>;
  inputValue(): Promise<string>;
  getAttribute(name: string): Promise<string | null>;
  boundingBox(): Promise<BoundingBox | null>;
  isVisible(): Promise<boolean>;
  isHidden(): Promise<boolean>;
  isChecked(): Promise<boolean>;
  scrollIntoViewIfNeeded(options?: TimeoutOptions): Promise<void>;
  $<E extends Element = Element>(selector: string): Promise<ElementHandle<E> | null>;
  $$<E extends Element = Element>(selector: string): Promise<ElementHandle<E>[]>;
  evaluate<R>(fn: (element: T) => R | Promise<R>): Promise<R>;
  evaluate<R, A>(fn: (element: T, arg: A) => R | Promise<R>, arg: A): Promise<R>;
}

/** The filtering form of `locator(selector, { hasText })` — how the suites pick a button
 * out of a menu by its label instead of by a positional nth(). */
export interface LocatorOptions {
  hasText?: string | RegExp;
  hasNotText?: string | RegExp;
  has?: Locator;
  hasNot?: Locator;
}

export interface Locator {
  click(options?: ClickOptions): Promise<void>;
  hover(options?: TimeoutOptions): Promise<void>;
  fill(value: string, options?: TimeoutOptions): Promise<void>;
  check(options?: TimeoutOptions): Promise<void>;
  count(): Promise<number>;
  first(): Locator;
  last(): Locator;
  nth(index: number): Locator;
  locator(selector: string, options?: LocatorOptions): Locator;
  getByRole(role: string, options?: { name?: string; exact?: boolean }): Locator;
  textContent(options?: TimeoutOptions): Promise<string | null>;
  innerText(options?: TimeoutOptions): Promise<string>;
  inputValue(options?: TimeoutOptions): Promise<string>;
  allInnerTexts(): Promise<string[]>;
  allTextContents(): Promise<string[]>;
  getAttribute(name: string, options?: TimeoutOptions): Promise<string | null>;
  boundingBox(options?: TimeoutOptions): Promise<BoundingBox | null>;
  isVisible(options?: TimeoutOptions): Promise<boolean>;
  isHidden(options?: TimeoutOptions): Promise<boolean>;
  isChecked(options?: TimeoutOptions): Promise<boolean>;
  scrollIntoViewIfNeeded(options?: TimeoutOptions): Promise<void>;
  elementHandle(options?: TimeoutOptions): Promise<ElementHandle | null>;
  elementHandles(): Promise<ElementHandle[]>;
  waitFor(options?: WaitForSelectorOptions): Promise<void>;
  screenshot(options?: ScreenshotOptions): Promise<Buffer>;
  evaluate<R>(fn: (element: Element) => R | Promise<R>): Promise<R>;
  evaluate<R, A>(fn: (element: Element, arg: A) => R | Promise<R>, arg: A): Promise<R>;
}

export interface Keyboard {
  press(key: string, options?: { delay?: number }): Promise<void>;
  type(text: string, options?: { delay?: number }): Promise<void>;
  down(key: string): Promise<void>;
  up(key: string): Promise<void>;
  insertText(text: string): Promise<void>;
}

export interface Mouse {
  click(x: number, y: number, options?: ClickOptions): Promise<void>;
  move(x: number, y: number, options?: { steps?: number }): Promise<void>;
  down(options?: ClickOptions): Promise<void>;
  up(options?: ClickOptions): Promise<void>;
  wheel(deltaX: number, deltaY: number): Promise<void>;
}

export interface ConsoleMessage {
  type(): string;
  text(): string;
  location(): { url: string; lineNumber: number; columnNumber: number };
}

export interface Dialog {
  type(): string;
  message(): string;
  accept(promptText?: string): Promise<void>;
  dismiss(): Promise<void>;
}

export interface Request {
  url(): string;
  method(): string;
  postData(): string | null;
  resourceType(): string;
}

export interface Response {
  url(): string;
  status(): number;
  ok(): boolean;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

/** The `page.on(...)` events these suites listen for, each with its real payload. */
export interface PageEvents {
  console: ConsoleMessage;
  dialog: Dialog;
  pageerror: Error;
  request: Request;
  requestfailed: Request;
  response: Response;
  crash: Page;
  close: Page;
  /** A real document load. `routing-test` counts these to prove a click routed
   *  CLIENT-side — a link that navigates the document still lands on the right
   *  URL, so the URL alone cannot tell the two apart. */
  load: Page;
}

export interface Page {
  goto(url: string, options?: TimeoutOptions & { waitUntil?: string }): Promise<Response | null>;
  reload(options?: TimeoutOptions & { waitUntil?: string }): Promise<Response | null>;
  /** The browser's own Back. Only meaningful since routing moved to real paths
   *  (2026-08-16) — under the hash router there was no history stack to walk. */
  goBack(options?: TimeoutOptions & { waitUntil?: string }): Promise<Response | null>;
  goForward(options?: TimeoutOptions & { waitUntil?: string }): Promise<Response | null>;
  close(): Promise<void>;
  content(): Promise<string>;
  title(): Promise<string>;
  url(): string;
  setViewportSize(size: { width: number; height: number }): Promise<void>;
  screenshot(options?: ScreenshotOptions): Promise<Buffer>;
  addInitScript<A>(fn: (arg: A) => void, arg: A): Promise<void>;
  addInitScript(fn: () => void): Promise<void>;

  click(selector: string, options?: ClickOptions): Promise<void>;
  hover(selector: string, options?: TimeoutOptions): Promise<void>;
  fill(selector: string, value: string, options?: TimeoutOptions): Promise<void>;
  check(selector: string, options?: TimeoutOptions): Promise<void>;
  uncheck(selector: string, options?: TimeoutOptions): Promise<void>;
  focus(selector: string, options?: TimeoutOptions): Promise<void>;
  textContent(selector: string, options?: TimeoutOptions): Promise<string | null>;
  innerText(selector: string, options?: TimeoutOptions): Promise<string>;
  inputValue(selector: string, options?: TimeoutOptions): Promise<string>;
  getAttribute(selector: string, name: string, options?: TimeoutOptions): Promise<string | null>;

  locator(selector: string, options?: LocatorOptions): Locator;
  getByRole(role: string, options?: { name?: string | RegExp; exact?: boolean }): Locator;
  getByText(text: string | RegExp, options?: { exact?: boolean }): Locator;
  getByTestId(testId: string): Locator;

  $<E extends Element = Element>(selector: string): Promise<ElementHandle<E> | null>;
  $$<E extends Element = Element>(selector: string): Promise<ElementHandle<E>[]>;

  waitForSelector<E extends Element = Element>(
    selector: string,
    options?: WaitForSelectorOptions,
  ): Promise<ElementHandle<E> | null>;
  waitForTimeout(milliseconds: number): Promise<void>;
  waitForLoadState(state?: string, options?: TimeoutOptions): Promise<void>;
  waitForFunction<R>(fn: () => R, arg?: undefined, options?: TimeoutOptions): Promise<JSHandle<R>>;
  waitForFunction<R, A>(fn: (arg: A) => R, arg: A, options?: TimeoutOptions): Promise<JSHandle<R>>;

  // The browser boundary. `E` defaults to HTMLElement (Playwright's own default is
  // `HTMLElement | SVGElement`); a call site that needs `.value` narrows it explicitly —
  // `page.$eval<string, HTMLInputElement>(sel, (i) => i.value)` — rather than casting.
  $eval<R, E extends Element = HTMLElement>(
    selector: string,
    fn: (element: E) => R | Promise<R>,
  ): Promise<R>;
  $eval<R, A, E extends Element = HTMLElement>(
    selector: string,
    fn: (element: E, arg: A) => R | Promise<R>,
    arg: A,
  ): Promise<R>;
  $$eval<R, E extends Element = HTMLElement>(
    selector: string,
    fn: (elements: E[]) => R | Promise<R>,
  ): Promise<R>;
  $$eval<R, A, E extends Element = HTMLElement>(
    selector: string,
    fn: (elements: E[], arg: A) => R | Promise<R>,
    arg: A,
  ): Promise<R>;
  evaluate<R>(fn: () => R | Promise<R>): Promise<R>;
  evaluate<R, A>(fn: (arg: A) => R | Promise<R>, arg: A): Promise<R>;

  keyboard: Keyboard;
  mouse: Mouse;

  on<K extends keyof PageEvents>(event: K, handler: (payload: PageEvents[K]) => void): Page;
  off<K extends keyof PageEvents>(event: K, handler: (payload: PageEvents[K]) => void): Page;
}

export interface BrowserContext {
  newPage(): Promise<Page>;
  close(): Promise<void>;
  addInitScript<A>(fn: (arg: A) => void, arg: A): Promise<void>;
  addInitScript(fn: () => void): Promise<void>;
  addCookies(cookies: unknown[]): Promise<void>;
  pages(): Page[];
}

export interface NewContextOptions {
  viewport?: { width: number; height: number } | null;
  colorScheme?: 'light' | 'dark' | 'no-preference';
  ignoreHTTPSErrors?: boolean;
  deviceScaleFactor?: number;
  reducedMotion?: 'reduce' | 'no-preference';
  locale?: string;
  storageState?: unknown;
}

export interface Browser {
  newPage(options?: NewContextOptions): Promise<Page>;
  newContext(options?: NewContextOptions): Promise<BrowserContext>;
  close(): Promise<void>;
  contexts(): BrowserContext[];
  isConnected(): boolean;
}

export interface LaunchOptions {
  headless?: boolean;
  args?: string[];
  channel?: string;
  executablePath?: string;
  slowMo?: number;
  timeout?: number;
  devtools?: boolean;
}

export interface BrowserType {
  launch(options?: LaunchOptions): Promise<Browser>;
  executablePath(): string;
  name(): string;
}

export interface PlaywrightModule {
  chromium: BrowserType;
  firefox: BrowserType;
  webkit: BrowserType;
}

// --- the lookup ---------------------------------------------------------------------

const ROOTS = [
  // This repo's OWN node_modules first, when it has one. The sibling-borrowing below is
  // for the NAS sandbox, where those absolute paths exist; in CI they do not, and Node
  // resolves a nonexistent `/mnt/...` prefix by walking up to `/`, never reaching the
  // checkout — so `npm install playwright` at the repo root (which ci.yml does, and which
  // its comment already assumed worked) was in fact unreachable from here.
  new URL('../node_modules/', import.meta.url).pathname,
  '/mnt/TrueNAS-Apps/Repos/mux-magic/node_modules/',
  '/mnt/TrueNAS-Apps/Repos/castkit/node_modules/',
  '/mnt/TrueNAS-Apps/Repos/charcuterie/node_modules/',
  '/mnt/TrueNAS-Apps/Repos/gallery-downloader/node_modules/',
];

function resolve(): PlaywrightModule {
  const tried: string[] = [];
  for (const root of ROOTS) {
    let pw: PlaywrightModule;
    try {
      // The one unavoidable assertion in this file: `createRequire` returns `any` by
      // construction (it is a runtime lookup of a package tsc cannot see), and the shape
      // it yields is asserted by the interfaces above. Everything downstream is typed.
      pw = createRequire(root)('playwright') as PlaywrightModule;
    } catch {
      continue; // sibling not checked out / no playwright installed
    }
    let exe = '';
    try {
      exe = pw.chromium.executablePath();
    } catch {
      continue;
    }
    if (existsSync(exe)) return pw;
    tried.push(`${root} -> ${exe}`);
  }
  throw new Error(
    'no usable Playwright found. Install browsers for one of:\n  ' + tried.join('\n  '),
  );
}

const playwright = resolve();

export const { chromium } = playwright;
export default playwright;
