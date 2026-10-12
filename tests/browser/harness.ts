/**
 * Page-side harness for the browser regression lane (test-only; served by
 * Vite from tests/browser/harness.html). It drives the real `Terminal`
 * through `Terminal.write` — no PTY, no demo page, no production hooks.
 *
 * This is the ONLY file that reaches into ghostty-web internals (parking the
 * render loop, forcing renders, spying on renderer/bridge methods). Those
 * reach-ins are feature-detected and reported as `capabilities`; specs that
 * need one call `checks.requireCapabilities`, so a backend migration fails
 * loudly here instead of silently changing what a spec measures.
 *
 * Every wait is tied to animation frames or promises; there are no timers.
 */

import { Ghostty, GhosttyTerminal } from '../../lib/ghostty';
import type { ITheme } from '../../lib/interfaces';
import { CanvasRenderer } from '../../lib/renderer';
import { Terminal } from '../../lib/terminal';
import type {
  BufferCellInfo,
  Capture,
  CreateOptions,
  FontLock,
  HarnessApi,
  LoadedFont,
  ReadyInfo,
  TerminalEvents,
} from './support/harness-api';

const requestedEngine = new URL(location.href).searchParams.get('engine') ?? 'web-candidate';
if (requestedEngine !== 'web-pinned' && requestedEngine !== 'web-candidate') {
  throw new Error(`Unknown browser regression engine: ${requestedEngine}`);
}
const WASM_URL = requestedEngine === 'web-pinned' ? '/ghostty-vt-legacy.wasm' : '/ghostty-vt.wasm';
const SETTLE_MAX_FRAMES = 60;

interface Entry {
  term: Terminal;
  host: HTMLElement;
  events: TerminalEvents;
  resizes: number;
  viewportDecodes: number;
}

const entries = new Map<number, Entry>();
let nextId = 1;
let primaryFont: LoadedFont | undefined;
const opened: string[] = [];

function fail(code: string, detail: string): never {
  throw new Error(`${code}: ${detail}`);
}

async function sha256(bytes: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function fetchBytes(url: string, code: string): Promise<ArrayBuffer> {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) fail(code, `${url} -> HTTP ${response.status}`);
  return response.arrayBuffer();
}

/** Load and verify one vendored font. Any deviation is fatal: no fallback. */
async function loadFont(lock: FontLock & { role: string }): Promise<LoadedFont> {
  const url = new URL(`./fonts/${lock.file}`, location.href).href;
  const bytes = await fetchBytes(url, 'FONT_NOT_LOADED');
  const digest = await sha256(bytes);
  if (bytes.byteLength !== lock.bytes || digest !== lock.sha256) {
    fail('FONT_NOT_LOADED', `${lock.file} is ${bytes.byteLength} B sha256 ${digest}`);
  }
  const face = new FontFace(lock.family, bytes);
  try {
    await face.load();
  } catch (error) {
    fail('FONT_NOT_LOADED', `FontFace.load rejected: ${String(error)}`);
  }
  // FontFaceSet's setlike add() is missing from the configured TS DOM lib.
  (document.fonts as unknown as { add(face: FontFace): void }).add(face);
  await document.fonts.ready;
  const spec = `${lock.sizePx}px ${lock.family}`;
  if (face.status !== 'loaded') fail('FONT_NOT_LOADED', `face status ${face.status}`);
  if (!document.fonts.check(spec)) fail('FONT_NOT_LOADED', `document.fonts.check(${spec})`);
  const ctx = document.createElement('canvas').getContext('2d');
  if (!ctx) fail('FONT_NOT_LOADED', 'no 2D context for measurement');
  ctx.font = spec;
  const measuredAdvance = ctx.measureText('M').width;
  // Chromium reports either the unhinted table advance or its hinted integer.
  const tableAdvance = (lock.advanceUnits * lock.sizePx) / lock.unitsPerEm;
  if (
    measuredAdvance !== Math.round(tableAdvance) &&
    Math.abs(measuredAdvance - tableAdvance) > 0.01
  ) {
    fail('FONT_NOT_LOADED', `advance of M is ${measuredAdvance}, font table says ${tableAdvance}`);
  }
  return { ...lock, measuredAdvance };
}

/** Load every font listed in fonts/font.json; a 'primary' role is required. */
async function loadFonts(): Promise<Record<string, LoadedFont>> {
  const response = await fetch(new URL('./fonts/font.json', location.href), {
    cache: 'no-store',
  });
  if (!response.ok) fail('FONT_NOT_LOADED', `font.json -> HTTP ${response.status}`);
  const manifest = (await response.json()) as { fonts: (FontLock & { role: string })[] };
  const loaded: Record<string, LoadedFont> = {};
  for (const lock of manifest.fonts) loaded[lock.role] = await loadFont(lock);
  const families = new Set(Object.values(loaded).map((f) => f.family));
  if (families.size !== manifest.fonts.length)
    fail('FONT_NOT_LOADED', 'font families must be unique');
  if (!loaded.primary) fail('FONT_NOT_LOADED', "font.json has no 'primary' role");
  return loaded;
}

function detectCapabilities(): string[] {
  const caps: string[] = [];
  const terminalProto = Terminal.prototype as unknown as Record<string, unknown>;
  const rendererProto = CanvasRenderer.prototype as unknown as Record<string, unknown>;
  const bridgeProto = GhosttyTerminal.prototype as unknown as Record<string, unknown>;
  if (typeof terminalProto.cancelRenderLoop === 'function') caps.push('park-render-loop');
  if (typeof rendererProto.render === 'function') caps.push('forced-render');
  if (typeof rendererProto.resize === 'function') caps.push('renderer-resize-spy');
  if (typeof bridgeProto.getViewport === 'function') caps.push('viewport-decode-spy');
  if (typeof rendererProto.renderLine === 'function') caps.push('renderer-row-mutant');
  return caps;
}

const ready: Promise<ReadyInfo> = (async () => {
  const fonts = await loadFonts();
  primaryFont = fonts.primary;
  const wasm = await fetchBytes(WASM_URL, 'WASM_NOT_LOADED');
  const detected = (await Ghostty.load(WASM_URL)).backend;
  const expected = requestedEngine === 'web-pinned' ? 'legacy' : 'libghostty-vt';
  if (detected !== expected)
    fail('WRONG_BACKEND', `requested ${requestedEngine}, loaded ${detected}`);
  return {
    font: fonts.primary,
    fonts,
    wasm: { url: WASM_URL, sha256: await sha256(wasm), bytes: wasm.byteLength, backend: detected },
    dpr: window.devicePixelRatio,
    userAgent: navigator.userAgent,
    capabilities: detectCapabilities(),
  };
})();
// Specs always await `ready` explicitly (negative controls expect rejection);
// this handled branch only stops a duplicate unhandled-rejection page error.
ready.catch(() => undefined);

function get(id: number): Entry {
  const entry = entries.get(id);
  if (!entry) fail('NO_TERMINAL', String(id));
  return entry;
}

function renderer(entry: Entry): CanvasRenderer {
  const r = entry.term.renderer;
  if (!r) fail('NOT_OPEN', 'terminal has no renderer');
  return r;
}

function context(entry: Entry): CanvasRenderingContext2D {
  const ctx = renderer(entry).getCanvas().getContext('2d');
  if (!ctx) fail('NO_CONTEXT', 'canvas has no 2D context');
  return ctx;
}

async function canvasHash(entry: Entry): Promise<string> {
  const canvas = renderer(entry).getCanvas();
  const { width, height } = canvas;
  const pixels = context(entry).getImageData(0, 0, width, height).data;
  // Snapshot owned bytes before awaiting the browser's standard digest API.
  // This is a readiness barrier, not the visual comparator (which compares pixels).
  const digest = await sha256(new Uint8Array(pixels).buffer);
  return `${width}x${height}:${digest}`;
}

function toBinary(pixels: Uint8ClampedArray): string {
  let binary = '';
  for (let i = 0; i < pixels.length; i += 0x8000) {
    binary += String.fromCharCode(...pixels.subarray(i, i + 0x8000));
  }
  return binary;
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function emptyEvents(): TerminalEvents {
  return {
    data: [],
    titles: [],
    bells: 0,
    resizes: [],
    cursorMoves: 0,
    selectionChanges: 0,
    scrolls: [],
  };
}

const api: HarnessApi = {
  ready,

  async create(options: CreateOptions): Promise<number> {
    await ready;
    const lock = primaryFont;
    if (!lock) fail('NOT_READY', 'font lock missing');
    // A fresh WASM instance per terminal: lifecycle defects (e.g. RT-01)
    // must not leak between cases.
    const ghostty = await Ghostty.load(WASM_URL);
    const host = document.createElement('div');
    host.className = 'host';
    const hosts = document.getElementById('hosts');
    if (!hosts) fail('NO_HOSTS', '#hosts missing from harness.html');
    hosts.appendChild(host);
    const term = new Terminal({
      ghostty,
      cols: options.cols,
      rows: options.rows,
      // Defaults only fill gaps; caller-supplied font options always win.
      fontFamily: options.fontFamily ?? `${lock.family}, monospace`,
      fontSize: options.fontSize ?? lock.sizePx,
      cursorBlink: options.cursorBlink ?? false,
      cursorStyle: options.cursorStyle ?? 'block',
      theme: (options.theme ?? {}) as ITheme,
      ...(options.scrollback === undefined ? {} : { scrollback: options.scrollback }),
      ...(options.smoothScrollDuration === undefined
        ? {}
        : { smoothScrollDuration: options.smoothScrollDuration }),
    });
    term.open(host);
    const entry: Entry = { term, host, events: emptyEvents(), resizes: 0, viewportDecodes: 0 };
    term.onData((d) => entry.events.data.push(d));
    term.onTitleChange((t) => entry.events.titles.push(t));
    term.onBell(() => entry.events.bells++);
    term.onResize((size) => entry.events.resizes.push(size));
    term.onCursorMove(() => entry.events.cursorMoves++);
    term.onSelectionChange(() => entry.events.selectionChanges++);
    term.onScroll((y) => entry.events.scrolls.push(y));
    const id = nextId++;
    entries.set(id, entry);
    return id;
  },

  write(id, data) {
    get(id).term.write(data);
  },

  async settle(id) {
    const entry = get(id);
    let previous = await canvasHash(entry);
    for (let frame = 1; frame <= SETTLE_MAX_FRAMES; frame++) {
      await nextFrame();
      const current = await canvasHash(entry);
      if (current === previous) return frame;
      previous = current;
    }
    fail('UNSTABLE_FRAME', `canvas still changing after ${SETTLE_MAX_FRAMES} frames`);
  },

  park(id) {
    const term = get(id).term as unknown as {
      cancelRenderLoop(): void;
      animationFrameId?: number;
    };
    term.cancelRenderLoop();
    // startRenderLoop() returns early while an id is set; resize() clears it.
    term.animationFrameId = -1;
  },

  render(id, force, viewportY) {
    const entry = get(id);
    const term = entry.term;
    if (!term.wasmTerm) fail('NOT_OPEN', 'terminal has no WASM terminal');
    renderer(entry).render(term.wasmTerm, force, viewportY ?? term.getViewportY(), term, 0);
  },

  capture(id): Capture {
    const entry = get(id);
    const r = renderer(entry);
    const canvas = r.getCanvas();
    const metrics = r.getMetrics();
    const pixels = context(entry).getImageData(0, 0, canvas.width, canvas.height).data;
    const binary = toBinary(pixels);
    return {
      width: canvas.width,
      height: canvas.height,
      cellWidth: metrics.width,
      cellHeight: metrics.height,
      dpr: window.devicePixelRatio,
      cols: entry.term.cols,
      rows: entry.term.rows,
      rgba: btoa(binary),
    };
  },

  events(id) {
    return get(id).events;
  },

  clearEvents(id) {
    get(id).events = emptyEvents();
  },

  cellCenter(id, row, col) {
    const entry = get(id);
    const r = renderer(entry);
    const rect = r.getCanvas().getBoundingClientRect();
    return {
      x: rect.left + (col + 0.5) * r.charWidth,
      y: rect.top + (row + 0.5) * r.charHeight,
    };
  },

  spyResize(id) {
    const entry = get(id);
    const r = renderer(entry);
    const original = r.resize.bind(r);
    entry.resizes = 0;
    r.resize = (cols: number, rows: number) => {
      entry.resizes++;
      original(cols, rows);
    };
  },

  resizeCount(id) {
    return get(id).resizes;
  },

  spyViewportDecode(id) {
    const entry = get(id);
    const wasm = entry.term.wasmTerm;
    if (!wasm) fail('NOT_OPEN', 'terminal has no WASM terminal');
    entry.viewportDecodes = 0;
    if (wasm.backend === 'libghostty-vt') {
      // The native public getter returns a cached pool; count actual snapshot
      // refreshes, not cheap cache reads. This test-only reach-in is explicit.
      const impl = (wasm as unknown as { impl: { refresh?: () => void } }).impl;
      if (typeof impl?.refresh !== 'function') fail('NO_CAPABILITY', 'native snapshot refresh spy');
      const refresh = impl.refresh.bind(impl);
      impl.refresh = () => {
        entry.viewportDecodes++;
        refresh();
      };
    } else {
      const original = wasm.getViewport.bind(wasm);
      wasm.getViewport = () => {
        entry.viewportDecodes++;
        return original();
      };
    }
  },

  viewportDecodeCount(id) {
    return get(id).viewportDecodes;
  },

  skipNextRowRedraw(id, row) {
    // Negative-control mutant: drop exactly one redraw of `row`.
    const r = renderer(get(id)) as unknown as {
      renderLine(line: unknown, y: number, cols: number): void;
    };
    const original = r.renderLine.bind(r);
    let armed = true;
    r.renderLine = (line, y, cols) => {
      if (armed && y === row) {
        armed = false;
        return;
      }
      original(line, y, cols);
    };
  },

  spyWindowOpen() {
    opened.length = 0;
    window.open = ((url?: string | URL) => {
      opened.push(String(url));
      return null;
    }) as typeof window.open;
  },

  openedUrls() {
    return [...opened];
  },

  selection(id) {
    return get(id).term.getSelection();
  },

  paste(id, text) {
    get(id).term.paste(text);
  },

  resize(id, cols, rows) {
    get(id).term.resize(cols, rows);
  },

  scrollbackLength(id) {
    return get(id).term.getScrollbackLength();
  },

  mode(id, mode) {
    return get(id).term.getMode(mode);
  },

  hostChildCount(id) {
    return get(id).host.childElementCount;
  },

  dispose(id) {
    const entry = get(id);
    entry.term.dispose();
    entries.delete(id);
    const remaining = entry.host.childElementCount;
    entry.host.remove();
    return remaining;
  },

  disposeAll() {
    for (const [id, entry] of entries) {
      entry.term.dispose();
      entry.host.remove();
      entries.delete(id);
    }
  },

  // --- Options: only the public `terminal.options` proxy is used. ---

  setOptions(id, options) {
    const target = get(id).term.options as unknown as Record<string, unknown>;
    if (options.disableStdin !== undefined) target.disableStdin = options.disableStdin;
    if (options.fontFamily !== undefined) target.fontFamily = options.fontFamily;
    if (options.fontSize !== undefined) target.fontSize = options.fontSize;
    if (options.theme !== undefined) target.theme = options.theme;
  },

  cellMetrics(id) {
    return renderer(get(id)).getMetrics();
  },

  glyphOracle(request) {
    // Independent of the renderer: the requested font drawn at integer CSS
    // positions, at the page DPR, with nothing else on the canvas.
    const dpr = window.devicePixelRatio;
    const style = request.fontStyle ? `${request.fontStyle} ` : '';
    const font = `${style}${request.fontSize}px ${request.fontFamily}`;
    const probe = document.createElement('canvas').getContext('2d');
    if (!probe) fail('NO_CONTEXT', 'oracle measurement context');
    probe.font = font;
    const pad = Math.ceil(request.fontSize / 2);
    const advance = probe.measureText(request.text).width;
    const cssWidth = Math.ceil(advance) + 2 * pad;
    const cssHeight = 2 * request.fontSize + 2 * pad;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(cssWidth * dpr);
    canvas.height = Math.round(cssHeight * dpr);
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) fail('NO_CONTEXT', 'oracle context');
    ctx.scale(dpr, dpr);
    ctx.fillStyle = request.background;
    ctx.fillRect(0, 0, cssWidth, cssHeight);
    ctx.font = font;
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    ctx.fillStyle = request.foreground;
    ctx.fillText(request.text, pad, pad + request.fontSize);
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    return {
      width: canvas.width,
      height: canvas.height,
      cellWidth: cssWidth,
      cellHeight: cssHeight,
      dpr,
      cols: 1,
      rows: 1,
      rgba: btoa(toBinary(pixels)),
      originX: pad,
      baselineY: pad + request.fontSize,
      advance,
    };
  },

  // --- Viewport, scrolling and selection: public Terminal API only. ---

  viewport(id) {
    const term = get(id).term;
    return {
      viewportY: term.getViewportY(),
      scrollbackLength: term.getScrollbackLength(),
      rows: term.rows,
      cols: term.cols,
    };
  },

  canvasRect(id) {
    const rect = renderer(get(id)).getCanvas().getBoundingClientRect();
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  },

  scrollLines(id, amount) {
    get(id).term.scrollLines(amount);
  },

  scrollPages(id, amount) {
    get(id).term.scrollPages(amount);
  },

  scrollToTop(id) {
    get(id).term.scrollToTop();
  },

  scrollToBottom(id) {
    get(id).term.scrollToBottom();
  },

  scrollToLine(id, line) {
    get(id).term.scrollToLine(line);
  },

  select(id, column, row, length) {
    get(id).term.select(column, row, length);
  },

  selectLines(id, start, end) {
    get(id).term.selectLines(start, end);
  },

  selectAll(id) {
    get(id).term.selectAll();
  },

  clearSelection(id) {
    get(id).term.clearSelection();
  },

  hasSelection(id) {
    return get(id).term.hasSelection();
  },

  selectionPosition(id) {
    const range = get(id).term.getSelectionPosition();
    return range
      ? { start: { x: range.start.x, y: range.start.y }, end: { x: range.end.x, y: range.end.y } }
      : undefined;
  },

  bufferLineText(id, y, trimRight = true) {
    return get(id).term.buffer.active.getLine(y)?.translateToString(trimRight);
  },

  bufferCell(id, y, x): BufferCellInfo | undefined {
    const cell = get(id).term.buffer.active.getLine(y)?.getCell(x);
    if (!cell) return undefined;
    return {
      chars: cell.getChars(),
      width: cell.getWidth(),
      fgColor: cell.getFgColor(),
      bgColor: cell.getBgColor(),
      fgColorMode: cell.getFgColorMode(),
      bgColorMode: cell.getBgColorMode(),
    };
  },

  scrollbarState(id) {
    // Test-only reach-in; fails loudly if the private fields disappear.
    const term = get(id).term as unknown as {
      scrollbarOpacity?: unknown;
      scrollbarVisible?: unknown;
    };
    if (typeof term.scrollbarOpacity !== 'number' || typeof term.scrollbarVisible !== 'boolean') {
      fail('NO_CAPABILITY', 'scrollbar-state: private scrollbar fields not found');
    }
    return { opacity: term.scrollbarOpacity, visible: term.scrollbarVisible };
  },
};

window.__ghosttyRegression = api;
