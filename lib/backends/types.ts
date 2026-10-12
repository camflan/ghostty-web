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
  /** Native focus report for the current mode-1004 state; returns owned bytes. */
  encodeFocus?(focused: boolean): Uint8Array;
}

export interface KeyEncoderBackend {
  setOption(option: KeyEncoderOption, value: boolean | number): void;
  encode(event: KeyEvent): Uint8Array;
  /** Called at most once. */
  dispose(): void;
  /** libghostty-vt only: copy key-encoding modes/flags from a terminal of the same instance. */
  syncFromTerminal?(terminal: TerminalBackend): void;
}
