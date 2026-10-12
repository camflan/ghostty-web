/**
 * Internal backend contract behind the public `Ghostty`, `GhosttyTerminal`
 * and `KeyEncoder` facades (lib/ghostty.ts).
 *
 * Two engines implement it:
 *  - `legacy`: the pinned Ghostty core plus ghostty-web's custom WASM patch
 *    (patches/legacy/ghostty-wasm-api.patch), see ./legacy.ts;
 *  - `libghostty-vt`: the upstream libghostty-vt C ABI, discovered through
 *    `ghostty_type_json()`, see ./native.ts.
 *
 * Not part of the public package API; the facades keep the public shapes.
 */
import type {
  DirtyState,
  GhosttyCell,
  GhosttyTerminalConfig,
  KeyEncoderOption,
  KeyEvent,
  Mods,
  RenderStateColors,
  RenderStateCursor,
} from '../types';

/**
 * One terminal-to-host effect, in the order the native parser produced it
 * (libghostty-vt only). `reply` chunks are the same ≤256-byte, UTF-8-safe
 * strings `readResponse()` returns; a bell or title splits them at its position.
 */
export type NativeHostEvent =
  | { readonly type: 'reply'; readonly data: string }
  /** One BEL (0x07) executed by the parser; never an OSC/DCS terminator. */
  | { readonly type: 'bell' }
  /** OSC 0/2 set the title (also an unchanged or empty one); copied when it happened. */
  | { readonly type: 'title'; readonly title: string };

/**
 * One host pointer event for the native mouse encoder (libghostty-vt only).
 * The encoder decides from the terminal's current modes whether and how the
 * event is reported (tracking mode, format, motion dedup, out-of-view drops).
 */
export interface NativeMouseEvent {
  action: 'press' | 'release' | 'motion';
  /** `null` = motion without a pressed button. `four`..`seven` are wheel buttons. */
  button: 'left' | 'middle' | 'right' | 'four' | 'five' | 'six' | 'seven' | 'eight' | 'nine' | null;
  /** CSS pixels relative to the canvas origin; negative or beyond the grid is allowed. */
  x: number;
  y: number;
  /** Integer CSS cell metrics; the grid is `cols * cellWidth` x `rows * cellHeight`, unpadded. */
  cellWidth: number;
  cellHeight: number;
  mods: Mods;
  /**
   * Whether a physical button is held after this DOM event (true for a press,
   * false for the release of the last button). Wheel events are not held buttons.
   */
  anyButtonPressed: boolean;
}

/**
 * A cell in the active screen's SCREEN space: `x` is the column, `y` counts
 * rows from the oldest retained history row (history rows first, then the
 * active area). This is the same row space as ghostty-web's absolute buffer
 * rows on the active screen.
 */
export interface ScreenPoint {
  x: number;
  y: number;
}

/** Terminal-owned selection endpoints; `start` is the anchor and may follow `end`. */
export interface ScreenSelection {
  start: ScreenPoint;
  end: ScreenPoint;
}

/** Identity of the engine behind a facade. */
export type BackendKind = 'legacy' | 'libghostty-vt';

export const BACKEND_KINDS: readonly BackendKind[] = ['legacy', 'libghostty-vt'];

/** Options accepted by `new Ghostty(instance, options)` and `Ghostty.load(path, options)`. */
export interface GhosttyLoadOptions {
  /**
   * Require a specific engine. Detection still runs; a mismatch throws instead
   * of silently using the other engine.
   */
  backend?: BackendKind;
}

/** Raw instance exports, as handed to the public constructors. */
export type RawExports = WebAssembly.Exports & { memory: WebAssembly.Memory };

/** One loaded WASM instance. Shared by every terminal/encoder created from it. */
export interface VtBackend {
  readonly kind: BackendKind;
  readonly memory: WebAssembly.Memory;
  createTerminal(cols: number, rows: number, config?: GhosttyTerminalConfig): TerminalBackend;
  createKeyEncoder(): KeyEncoderBackend;
}

/**
 * One terminal. The facade owns lifecycle checks (use-after-free), size
 * bookkeeping, empty-write elision and the methods derivable from these.
 */
export interface TerminalBackend {
  /** `bytes.length > 0` is guaranteed by the facade. */
  write(bytes: Uint8Array): void;
  /** Called only when the size actually changes. */
  resize(cols: number, rows: number): void;
  /** Called at most once. */
  free(): void;

  update(): DirtyState;
  getCursor(): RenderStateCursor;
  getColors(): RenderStateColors;
  isRowDirty(y: number): boolean;
  markClean(): void;
  /** Reusable row-major pool of `cols * rows` cells (do not retain across calls). */
  getViewport(): GhosttyCell[];

  isAlternateScreen(): boolean;
  hasMouseTracking(): boolean;
  getMode(mode: number, isAnsi: boolean): boolean;

  getScrollbackLength(): number;
  getScrollbackLine(offset: number): GhosttyCell[] | null;
  isRowWrapped(row: number): boolean;
  getHyperlinkUri(row: number, col: number): string | null;
  getScrollbackHyperlinkUri(offset: number, col: number): string | null;
  getGrapheme(row: number, col: number): number[] | null;
  getScrollbackGrapheme(offset: number, col: number): number[] | null;

  hasResponse(): boolean;
  readResponse(): string | null;

  // ---- libghostty-vt only (absent on legacy) ----
  /** Real cell metrics for size reports and the native pixel size. */
  setCellPixelSize?(widthPx: number, heightPx: number): void;
  /** Current Kitty keyboard protocol flags of the active screen. */
  getKittyKeyboardFlags?(): number;
  /** Default cursor applied now if the program hasn't chosen one, and on reset/DECSCUSR 0. */
  setDefaultCursorStyle?(style: 'block' | 'underline' | 'bar', blink: boolean): void;
  /**
   * Encode a host mouse event for the terminal's current mouse modes. Returns
   * an owned copy of the raw bytes (X10 may contain bytes >= 0x80 that are not
   * UTF-8); empty when the event is not reported.
   */
  encodeMouseEvent?(event: NativeMouseEvent): Uint8Array;
  /** Forget the last reported motion cell (the next motion is reported even in the same cell). */
  resetMouseEncoder?(): void;
  /**
   * Encode pasted UTF-8 text for the pty per the terminal's live state
   * (upstream `ghostty_terminal_paste`: unsafe controls become spaces, framed
   * per mode 2004 or LF -> CR). Host policy: unsafe text is allowed (no
   * prompt), text/plain only, never a Kitty paste event. Returns an owned
   * copy (empty for empty text); queued replies are untouched.
   */
  encodePaste?(data: Uint8Array): Uint8Array;
  /** Start queueing bells and title changes (GHOSTTY_TERMINAL_OPT_BELL/TITLE_CHANGED). Idempotent. */
  enableHostEvents?(): void;
  /**
   * Remove and return every pending reply and queued bell/title in native
   * order. Replies already taken with `readResponse()` are not repeated.
   */
  takeHostEvents?(): NativeHostEvent[];
  /** Native focus report for the current mode-1004 state; returns owned bytes. */
  encodeFocus?(focused: boolean): Uint8Array;
  /**
   * Install GHOSTTY_TERMINAL_OPT_RENDER_HOLD: from now on every render hold
   * (synchronized output, mode 2026) captures the frame it began with, inside
   * the native callback, before any later byte is parsed. Idempotent.
   */
  enableRenderHold?(): void;
  /** Id of the active render hold (a new id per hold), or 0 when none is active. */
  getRenderHold?(): number;
  /**
   * The frame captured when the active hold began, for presentation only;
   * null when no hold is active (or the native grid did not match the host
   * grid at that moment, which the post-write size restore ends anyway).
   */
  getHeldFrame?(): HeldFrameView | null;
  /** End the active hold as upstream's timeout does: mode 2026 off via OPT_MODE (no callback). */
  releaseRenderHold?(): void;
  /** Install the active screen's terminal-owned (tracked) selection; points must be valid. */
  setSelectionRange?(start: ScreenPoint, end: ScreenPoint): void;
  /** Endpoints of the active screen's selection, read now; null when there is none. */
  getSelectionRange?(): ScreenSelection | null;
  /** Remove the active screen's selection. */
  clearSelection?(): void;
  /** Copy text of the selection (plain, soft wraps unwrapped, trailing blanks trimmed); '' when none. */
  getSelectionText?(): string;
}

/**
 * A frame captured at the start of a render hold (libghostty-vt only). It has
 * the renderer's read shape (`IRenderable` in lib/renderer.ts) but is fixed:
 * cells, grapheme clusters, colors and cursor are those of the moment the hold
 * began. Live getters, the public buffer and replies are unaffected by it.
 * Dirty tracking is relative to what the renderer painted last, live or held.
 */
export interface HeldFrameView {
  readonly backend: 'libghostty-vt';
  getDimensions(): { cols: number; rows: number };
  /** Copies of one captured row, or null if out of range. */
  getLine(y: number): GhosttyCell[] | null;
  getCursor(): RenderStateCursor;
  /** The captured grapheme cluster at (row, col) (' ' when empty). */
  getGraphemeString(row: number, col: number): string;
  isRowDirty(y: number): boolean;
  needsFullRedraw(): boolean;
  /** Called by the renderer after painting this frame. */
  clearDirty(): void;
}

export interface KeyEncoderBackend {
  setOption(option: KeyEncoderOption, value: boolean | number): void;
  encode(event: KeyEvent): Uint8Array;
  /** Called at most once. */
  dispose(): void;
  /** libghostty-vt only: copy key-encoding modes/flags from a terminal of the same instance. */
  syncFromTerminal?(terminal: TerminalBackend): void;
}
