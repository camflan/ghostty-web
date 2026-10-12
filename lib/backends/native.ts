/**
 * libghostty-vt engine: upstream Ghostty's public C API compiled to WASM.
 *
 * Rendering reads come from one upstream RenderState per terminal. The bridge
 * keeps a decoded JS copy of the viewport (the public `GhosttyCell` shape) and
 * refreshes it lazily: a write/resize only marks the copy stale, and the next
 * read (`update()`, `getLine()`, `getCursor()`, ...) runs one native
 * `ghostty_render_state_update` and re-decodes only the rows the render state
 * reports dirty (all rows on FULL or when default colors/palette changed).
 * Rows are read in bulk via `CELLS_RAW`; styles are fetched once per
 * (row, style_id) because style ids are page-local. Dirty state accumulates in
 * the render state until `markClean()` (ghostty_render_state_clean).
 *
 * History rows, wrap flags, graphemes and hyperlink URIs outside the decoded
 * viewport are read on demand through grid references (requires a build with
 * the default `grid_introspection` feature) and never move the native viewport,
 * which stays on the active area; ghostty-web keeps its own JS scroll position.
 */
import {
  CellFlags,
  DirtyState,
  type GhosttyCell,
  type GhosttyTerminalConfig,
  type KeyEncoderOption,
  type KeyEvent,
  type RGB,
  type RenderStateColors,
  type RenderStateCursor,
} from '../types';
import { type NativeAbi, type NativeLayout, bitsOf } from './native-abi';
import type { KeyEncoderBackend, NativeMouseEvent, TerminalBackend, VtBackend } from './types';

/** Defaults the legacy engine rendered when no theme color was configured. */
const LEGACY_DEFAULT_FOREGROUND = 0xcccccc;
const LEGACY_DEFAULT_BACKGROUND = 0x000000;
const DEFAULT_SCROLLBACK_LINES = 10_000;
/** Mode 2027 (grapheme clustering) is ghostty-web's default, kept across RIS. */
const GRAPHEME_CLUSTER_MODE = 2027;
/** Largest chunk handed to one `vt_write` call; the parser state spans chunks. */
const WRITE_CHUNK = 64 * 1024;
/** `readResponse()` returns at most this many bytes per call, as the legacy engine did. */
const RESPONSE_CHUNK = 256;
/**
 * Native mouse positions and screen sizes are f32, exact for integers below
 * 2^24. The grid must stay below it; positions are clamped to it (and to
 * 65535.5 cells) so the encoder's u16 cell and i32 pixel conversions stay
 * defined. Neither bound is reachable by a real pointer.
 */
const MOUSE_PX_LIMIT = 2 ** 24;

const MOUSE_ACTIONS = {
  press: 'PRESS',
  release: 'RELEASE',
  motion: 'MOTION',
} as const satisfies Record<NativeMouseEvent['action'], keyof NativeLayout['mouseAction']>;

const MOUSE_BUTTONS = {
  left: 'LEFT',
  middle: 'MIDDLE',
  right: 'RIGHT',
  four: 'FOUR',
  five: 'FIVE',
  six: 'SIX',
  seven: 'SEVEN',
  eight: 'EIGHT',
  nine: 'NINE',
} as const satisfies Record<
  NonNullable<NativeMouseEvent['button']>,
  keyof NativeLayout['mouseButton']
>;

/** Optional presence bits added to the public config (legacy ignores them). */
type ColorPresence = {
  foreground?: boolean;
  background?: boolean;
  cursor?: boolean;
  palette?: number;
};

interface ResolvedStyle {
  /** 0xRRGGBB, or -1 for the default color */
  fg: number;
  bg: number;
  flags: number;
}

const NO_STYLE: ResolvedStyle = { fg: -1, bg: -1, flags: 0 };

export class NativeBackend implements VtBackend {
  readonly kind = 'libghostty-vt' as const;
  private readonly terminals = new Map<number, NativeTerminal>();
  private writePtyIndex = 0;
  private sizeIndex = 0;
  private callbackError: unknown = undefined;
  /** True while a vt_write is running on any terminal of this instance. */
  writing = false;

  constructor(readonly abi: NativeAbi) {}

  get memory(): WebAssembly.Memory {
    return this.abi.memory;
  }

  createTerminal(cols: number, rows: number, config?: GhosttyTerminalConfig): NativeTerminal {
    return new NativeTerminal(this, cols, rows, config);
  }

  createKeyEncoder(): NativeKeyEncoder {
    return new NativeKeyEncoder(this.abi);
  }

  /** @internal */
  register(handle: number, terminal: NativeTerminal): void {
    this.terminals.set(handle, terminal);
  }

  /** @internal */
  unregister(handle: number): void {
    this.terminals.delete(handle);
  }

  /**
   * @internal One shared WRITE_PTY trampoline per instance, dispatching on the
   * terminal handle, so the function table never grows per terminal.
   */
  writePtyCallback(): number {
    if (!this.writePtyIndex) {
      this.writePtyIndex = this.abi.addFunction(4, false, (handle, _userdata, ptr, len) => {
        // Never throw into WASM mid-parse: record and rethrow after vt_write.
        try {
          const terminal = this.terminals.get(handle);
          if (!terminal) throw new Error(`libghostty-vt: write_pty for unknown terminal ${handle}`);
          terminal.onWritePty(ptr, len);
        } catch (error) {
          this.callbackError ??= error;
        }
        return undefined;
      });
    }
    return this.writePtyIndex;
  }

  /**
   * @internal Shared SIZE trampoline: `bool (terminal, userdata, GhosttySizeReportSize*)`.
   * Declines (false) while the terminal has no real cell metrics.
   */
  sizeCallback(): number {
    if (!this.sizeIndex) {
      this.sizeIndex = this.abi.addFunction(3, true, (handle, _userdata, out) => {
        try {
          const terminal = this.terminals.get(handle);
          if (!terminal)
            throw new Error(`libghostty-vt: size query for unknown terminal ${handle}`);
          return terminal.onSize(out) ? 1 : 0;
        } catch (error) {
          this.callbackError ??= error;
          return 0;
        }
      });
    }
    return this.sizeIndex;
  }

  /** @internal Rethrow the first error recorded by a callback during the last write. */
  rethrowCallbackError(): void {
    if (this.callbackError !== undefined) {
      const error = this.callbackError;
      this.callbackError = undefined;
      throw error;
    }
  }
}

/** Persistent per-terminal scratch area for ABI out-parameters. */
class Scratch {
  readonly base: number;
  readonly size: number;
  readonly out: number;
  readonly out2: number;
  readonly iterRef: number;
  readonly cellsRef: number;
  readonly cellsView: number;
  readonly colors: number;
  readonly cursor: number;
  readonly style: number;
  readonly point: number;
  readonly gridRef: number;
  readonly mode: number;
  readonly mouseSize: number;
  readonly mousePosition: number;

  constructor(abi: NativeAbi) {
    const L = abi.layout;
    let offset = 0;
    const take = (n: number) => {
      const at = offset;
      offset += Math.ceil(n / 8) * 8;
      return at;
    };
    const rel = {
      out: take(16),
      out2: take(16),
      iterRef: take(8),
      cellsRef: take(8),
      cellsView: take(L.cellsView.size),
      colors: take(L.colors.size),
      cursor: take(L.cursor.size),
      style: take(L.style.size),
      point: take(L.point.size),
      gridRef: take(L.gridRefSize),
      mode: take(L.modeConfig.size),
      mouseSize: take(L.mouseEncoderSize.size),
      mousePosition: take(L.mousePosition.size),
    };
    this.size = offset;
    this.base = abi.alloc(offset);
    this.out = this.base + rel.out;
    this.out2 = this.base + rel.out2;
    this.iterRef = this.base + rel.iterRef;
    this.cellsRef = this.base + rel.cellsRef;
    this.cellsView = this.base + rel.cellsView;
    this.colors = this.base + rel.colors;
    this.cursor = this.base + rel.cursor;
    this.style = this.base + rel.style;
    this.point = this.base + rel.point;
    this.gridRef = this.base + rel.gridRef;
    this.mode = this.base + rel.mode;
    this.mouseSize = this.base + rel.mouseSize;
    this.mousePosition = this.base + rel.mousePosition;
  }
}

/** A growable host buffer inside WASM memory. */
class GrowBuffer {
  ptr = 0;
  cap = 0;

  constructor(private readonly abi: NativeAbi) {}

  ensure(len: number): number {
    if (len > this.cap) {
      this.release();
      const cap = Math.max(64, 2 ** Math.ceil(Math.log2(len)));
      this.ptr = this.abi.alloc(cap);
      this.cap = cap;
    }
    return this.ptr;
  }

  release(): void {
    if (this.ptr) this.abi.free(this.ptr, this.cap);
    this.ptr = 0;
    this.cap = 0;
  }
}

function checkSize(cols: number, rows: number): void {
  for (const [name, value] of [
    ['cols', cols],
    ['rows', rows],
  ] as const) {
    if (!Number.isInteger(value) || value < 1 || value > 0xffff) {
      throw new RangeError(`libghostty-vt: ${name} must be an integer in 1..65535, got ${value}`);
    }
  }
}

function hasOwn<T extends object>(table: T, key: unknown): key is keyof T {
  return typeof key === 'string' && Object.prototype.hasOwnProperty.call(table, key);
}

/**
 * Clamp a finite CSS pixel coordinate into the range the native encoder
 * converts without overflow (see MOUSE_PX_LIMIT). The upper bound stays past
 * the grid edge (half a cell beyond 65535 cells), so in/out-of-view decisions
 * and clamped cells are unchanged.
 */
function clampMousePx(value: number, cell: number): number {
  return Math.max(-MOUSE_PX_LIMIT, Math.min(value, MOUSE_PX_LIMIT, 65535.5 * cell));
}

function blankCell(): GhosttyCell {
  return {
    codepoint: 0,
    fg_r: 0,
    fg_g: 0,
    fg_b: 0,
    bg_r: 0,
    bg_g: 0,
    bg_b: 0,
    flags: 0,
    width: 1,
    hyperlink_id: 0,
    grapheme_len: 0,
    fg_default: true,
    bg_default: true,
  };
}

/** Readers for the cell currently being decoded (render-state row or grid ref). */
interface CellSource {
  style(x: number): ResolvedStyle;
  graphemes(x: number): number[];
  hyperlinkId(x: number): number;
}

export class NativeTerminal implements TerminalBackend {
  private readonly abi: NativeAbi;
  private readonly L: NativeLayout;
  private handle = 0;
  private renderState = 0;
  private rowIterator = 0;
  private rowCells = 0;
  private scratch: Scratch | null = null;
  private readonly input: GrowBuffer;
  private readonly codepoints: GrowBuffer;
  private readonly uri: GrowBuffer;
  private cols: number;
  private rows: number;
  /** Real cell metrics from the host; null until known (size reports decline). */
  private cellPx: { width: number; height: number } | null = null;
  /** Dedicated mouse encoder/event used only to probe the native tracking state. */
  private mouseProbe = 0;
  private mouseProbeEvent = 0;
  /**
   * Encoder/event for real host input, created on first use. Kept apart from
   * the probe because its motion-dedup state (last reported cell) persists
   * between DOM events, and every setopt_from_terminal call clears it.
   */
  private mouseEncoder = 0;
  private mouseEvent = 0;
  private readonly mouseOut: GrowBuffer;
  /** Tracking mode/format must be re-read from the terminal (after any write). */
  private mouseModesStale = true;
  /** Geometry last applied with OPT_SIZE (which also clears dedup); null = not yet. */
  private mouseGeometry: {
    cols: number;
    rows: number;
    cellWidth: number;
    cellHeight: number;
  } | null = null;

  // ---- decoded viewport snapshot ----
  private stale = true;
  private decodeAll = true;
  private pool: GhosttyCell[] = [];
  /** Full clusters of cells with extra codepoints, keyed by `y * cols + x`. */
  private readonly clusters = new Map<number, number[]>();
  private dirty: DirtyState = DirtyState.FULL;
  private rowDirty = new Uint8Array(0);
  private readonly palette = new Uint8Array(768);
  private background = LEGACY_DEFAULT_BACKGROUND;
  private foreground = LEGACY_DEFAULT_FOREGROUND;
  private cursorColor: number | null = null;
  private cursorState: RenderStateCursor = {
    x: 0,
    y: 0,
    viewportX: -1,
    viewportY: -1,
    visible: false,
    blinking: false,
    style: 'block',
  };

  // ---- hyperlink identity: URI -> stable nonzero id ----
  private readonly linkIds = new Map<string, number>();

  // ---- replies queued by WRITE_PTY, in order ----
  private replies: Uint8Array[] = [];
  private readonly decoder = new TextDecoder();

  constructor(
    private readonly backend: NativeBackend,
    cols: number,
    rows: number,
    config?: GhosttyTerminalConfig
  ) {
    checkSize(cols, rows);
    this.abi = backend.abi;
    this.L = this.abi.layout;
    this.cols = cols;
    this.rows = rows;
    this.input = new GrowBuffer(this.abi);
    this.codepoints = new GrowBuffer(this.abi);
    this.uri = new GrowBuffer(this.abi);
    this.mouseOut = new GrowBuffer(this.abi);
    const ex = this.abi.exports;
    try {
      this.handle = this.abi.newHandle(ex.ghostty_terminal_new, 'ghostty_terminal_new', cols, rows);
      this.backend.register(this.handle, this);
      this.renderState = this.abi.newHandle(
        ex.ghostty_render_state_new,
        'ghostty_render_state_new'
      );
      this.rowIterator = this.abi.newHandle(
        ex.ghostty_render_state_row_iterator_new,
        'ghostty_render_state_row_iterator_new'
      );
      this.rowCells = this.abi.newHandle(
        ex.ghostty_render_state_row_cells_new,
        'ghostty_render_state_row_cells_new'
      );
      this.scratch = new Scratch(this.abi);
      const view = this.abi.view();
      view.setUint32(this.scratch.iterRef, this.rowIterator, true);
      view.setUint32(this.scratch.cellsRef, this.rowCells, true);
      this.configure(config);
      this.set('WRITE_PTY', this.backend.writePtyCallback());
      this.set('SIZE', this.backend.sizeCallback());
      this.allocatePool();
    } catch (error) {
      this.release();
      throw error;
    }
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  write(bytes: Uint8Array): void {
    if (this.backend.writing) {
      throw new Error('libghostty-vt: reentrant write while another write is in progress');
    }
    const ex = this.abi.exports;
    this.backend.writing = true;
    try {
      for (let start = 0; start < bytes.length; start += WRITE_CHUNK) {
        const chunk = bytes.subarray(start, Math.min(bytes.length, start + WRITE_CHUNK));
        const ptr = this.input.ensure(chunk.length);
        this.abi.bytes().set(chunk, ptr);
        ex.ghostty_terminal_vt_write(this.handle, ptr, chunk.length);
        // DECCOLM can resize upstream's grid while parsing PTY output. The web
        // host owns the canvas/PTY dimensions, so restore them before exposing
        // a render snapshot whose row sizes would disagree with our cell pool.
        const out = this.scratch!.out;
        this.getData('COLS', out);
        const cols = this.abi.view().getUint16(out, true);
        this.getData('ROWS', out);
        const rows = this.abi.view().getUint16(out, true);
        if (cols !== this.cols || rows !== this.rows) {
          this.nativeResize(this.cols, this.rows);
          this.decodeAll = true;
        }
      }
    } finally {
      this.backend.writing = false;
      this.stale = true;
      // Any write may change mouse modes (set/reset, RIS, ...); re-read them
      // before the next mouse event. Dedup survives between writes.
      this.mouseModesStale = true;
    }
    this.backend.rethrowCallbackError();
  }

  resize(cols: number, rows: number): void {
    checkSize(cols, rows);
    this.nativeResize(cols, rows);
    this.cols = cols;
    this.rows = rows;
    this.stale = true;
    this.allocatePool();
  }

  free(): void {
    this.release();
  }

  /** Native resize with the host's cell metrics, or 0 x 0 (unknown) before they are set. */
  private nativeResize(cols: number, rows: number): void {
    this.abi.check(
      this.abi.exports.ghostty_terminal_resize(
        this.handle,
        cols,
        rows,
        this.cellPx?.width ?? 0,
        this.cellPx?.height ?? 0
      ) as number,
      'ghostty_terminal_resize'
    );
    this.stale = true;
    // Replies (mode 2048 reports) and callback errors raised during the resize.
    this.backend.rethrowCallbackError();
  }

  /**
   * Set the real cell size in pixels (rounded to integers). Until this is
   * called, XTWINOPS 14/16/18 t and mode 2048 reports are declined rather than
   * sent with invented pixel values. A change re-applies the current size
   * natively, which (like any native resize) ends a synchronized-output hold
   * and sends a mode 2048 report when that mode is on.
   */
  setCellPixelSize(widthPx: number, heightPx: number): void {
    const width = Math.round(widthPx);
    const height = Math.round(heightPx);
    for (const [name, value] of [
      ['width', width],
      ['height', height],
    ] as const) {
      if (!Number.isFinite(value) || value < 1 || value > 0xffff) {
        throw new RangeError(`libghostty-vt: cell ${name} must be 1..65535 px, got ${value}`);
      }
    }
    if (this.cellPx?.width === width && this.cellPx.height === height) return;
    this.cellPx = { width, height };
    this.nativeResize(this.cols, this.rows);
  }

  /** @internal SIZE effect: fill a GhosttySizeReportSize, or decline without metrics. */
  onSize(out: number): boolean {
    if (!this.cellPx) return false;
    const S = this.L.sizeReport;
    const view = this.abi.view();
    view.setUint16(out + S.rows, this.rows, true);
    view.setUint16(out + S.columns, this.cols, true);
    view.setUint32(out + S.cell_width, this.cellPx.width, true);
    view.setUint32(out + S.cell_height, this.cellPx.height, true);
    return true;
  }

  getKittyKeyboardFlags(): number {
    const s = this.scratch!;
    this.getData('KITTY_KEYBOARD_FLAGS', s.out);
    return this.abi.bytes()[s.out];
  }

  /**
   * Native default cursor (OPT_DEFAULT_CURSOR_STYLE/BLINK). Applied immediately
   * while the program hasn't chosen a cursor with DECSCUSR; otherwise kept for
   * the next RIS or DECSCUSR 0.
   */
  setDefaultCursorStyle(style: 'block' | 'underline' | 'bar', blink: boolean): void {
    if (style !== 'block' && style !== 'underline' && style !== 'bar') {
      throw new RangeError(`libghostty-vt: unknown cursor style ${String(style)}`);
    }
    const T = this.L.terminalCursorStyle;
    const value = style === 'block' ? T.BLOCK : style === 'underline' ? T.UNDERLINE : T.BAR;
    const s = this.scratch!;
    this.abi.view().setInt32(s.out, value, true);
    this.set('DEFAULT_CURSOR_STYLE', s.out);
    this.abi.bytes()[s.out] = blink ? 1 : 0;
    this.set('DEFAULT_CURSOR_BLINK', s.out);
    this.stale = true;
  }

  /** @internal Handle for same-instance integrations (key encoder sync). */
  get nativeHandle(): number {
    return this.handle;
  }

  /** @internal */
  get owner(): NativeBackend {
    return this.backend;
  }

  private release(): void {
    const ex = this.abi.exports;
    if (this.handle) this.backend.unregister(this.handle);
    if (this.mouseProbeEvent) ex.ghostty_mouse_event_free(this.mouseProbeEvent);
    if (this.mouseProbe) ex.ghostty_mouse_encoder_free(this.mouseProbe);
    this.mouseProbe = this.mouseProbeEvent = 0;
    if (this.mouseEvent) ex.ghostty_mouse_event_free(this.mouseEvent);
    if (this.mouseEncoder) ex.ghostty_mouse_encoder_free(this.mouseEncoder);
    this.mouseEncoder = this.mouseEvent = 0;
    this.mouseOut.release();
    if (this.rowCells) ex.ghostty_render_state_row_cells_free(this.rowCells);
    if (this.rowIterator) ex.ghostty_render_state_row_iterator_free(this.rowIterator);
    if (this.renderState) ex.ghostty_render_state_free(this.renderState);
    if (this.handle) ex.ghostty_terminal_free(this.handle);
    if (this.scratch) this.abi.free(this.scratch.base, this.scratch.size);
    this.input.release();
    this.codepoints.release();
    this.uri.release();
    this.rowCells = this.rowIterator = this.renderState = this.handle = 0;
    this.scratch = null;
    this.replies = [];
  }

  // ==========================================================================
  // Render state
  // ==========================================================================

  update(): DirtyState {
    this.ensureFresh();
    return this.dirty;
  }

  getCursor(): RenderStateCursor {
    this.ensureFresh();
    return { ...this.cursorState };
  }

  getColors(): RenderStateColors {
    this.ensureFresh();
    return {
      background: rgbOf(this.background),
      foreground: rgbOf(this.foreground),
      cursor: this.cursorColor === null ? null : rgbOf(this.cursorColor),
    };
  }

  isRowDirty(y: number): boolean {
    this.ensureFresh();
    if (this.dirty === DirtyState.FULL) return true;
    if (this.dirty === DirtyState.NONE) return false;
    return this.rowDirty[y] === 1;
  }

  markClean(): void {
    this.abi.check(
      this.abi.exports.ghostty_render_state_clean(this.renderState) as number,
      'ghostty_render_state_clean'
    );
    this.dirty = DirtyState.NONE;
    this.rowDirty.fill(0);
  }

  getViewport(): GhosttyCell[] {
    this.ensureFresh();
    return this.pool;
  }

  // ==========================================================================
  // Modes and screens
  // ==========================================================================

  isAlternateScreen(): boolean {
    const s = this.scratch!;
    this.getData('ACTIVE_SCREEN', s.out);
    return this.abi.view().getInt32(s.out, true) === this.L.screen.ALTERNATE;
  }

  /**
   * Whether the terminal's active mouse event mode reports anything. Mode bits
   * alone are not enough (resetting 1002 after 1000 turns reporting off while
   * bit 1000 stays set), so this asks a dedicated, private mouse encoder
   * configured from the terminal whether a left press at cell (0, 0) would be
   * encoded. The probe's output is never sent anywhere.
   */
  hasMouseTracking(): boolean {
    const abi = this.abi;
    const ex = abi.exports;
    const L = this.L;
    if (!this.mouseProbe) {
      this.mouseProbe = abi.newHandle(ex.ghostty_mouse_encoder_new, 'ghostty_mouse_encoder_new');
      this.mouseProbeEvent = abi.newHandle(ex.ghostty_mouse_event_new, 'ghostty_mouse_event_new');
      ex.ghostty_mouse_event_set_action(this.mouseProbeEvent, L.mouseAction.PRESS);
      ex.ghostty_mouse_event_set_button(this.mouseProbeEvent, L.mouseButton.LEFT);
    }
    ex.ghostty_mouse_encoder_setopt_from_terminal(this.mouseProbe, this.handle);
    const s = this.scratch!;
    // A NULL/0-byte buffer counts the bytes the event would need.
    const result = ex.ghostty_mouse_encoder_encode(
      this.mouseProbe,
      this.mouseProbeEvent,
      0,
      0,
      s.out2
    ) as number;
    if (result === L.result.SUCCESS) return false;
    if (result === L.result.OUT_OF_SPACE) return abi.view().getUint32(s.out2, true) > 0;
    abi.check(result, 'ghostty_mouse_encoder_encode');
    return false;
  }

  // ==========================================================================
  // Mouse input
  // ==========================================================================

  /**
   * Encode a host mouse event with the persistent native encoder: tracking
   * mode and format come from the terminal, motion is deduplicated per cell
   * (TRACK_LAST_CELL), out-of-view events are dropped or clamped natively.
   * Returns an owned copy of the raw bytes; empty when nothing is reported.
   */
  encodeMouseEvent(event: NativeMouseEvent): Uint8Array {
    const abi = this.abi;
    const ex = abi.exports;
    const L = this.L;
    // Validate everything before touching (or lazily creating) native state.
    if (!hasOwn(MOUSE_ACTIONS, event.action)) {
      throw new RangeError(`libghostty-vt: unknown mouse action ${String(event.action)}`);
    }
    if (event.button !== null && !hasOwn(MOUSE_BUTTONS, event.button)) {
      throw new RangeError(`libghostty-vt: unknown mouse button ${String(event.button)}`);
    }
    const { cellWidth, cellHeight } = event;
    for (const [name, value] of [
      ['cellWidth', cellWidth],
      ['cellHeight', cellHeight],
    ] as const) {
      if (!Number.isInteger(value) || value < 1) {
        throw new RangeError(
          `libghostty-vt: mouse ${name} must be a positive integer, got ${value}`
        );
      }
    }
    if (this.cols * cellWidth >= MOUSE_PX_LIMIT || this.rows * cellHeight >= MOUSE_PX_LIMIT) {
      throw new RangeError(
        `libghostty-vt: mouse grid ${this.cols}x${cellWidth} by ${this.rows}x${cellHeight} px exceeds ${MOUSE_PX_LIMIT} px`
      );
    }
    if (!Number.isFinite(event.x) || !Number.isFinite(event.y)) {
      throw new RangeError(
        `libghostty-vt: mouse position must be finite, got ${event.x}, ${event.y}`
      );
    }
    const x = clampMousePx(event.x, cellWidth);
    const y = clampMousePx(event.y, cellHeight);

    this.ensureMouseEncoder();
    this.syncMouseEncoder(cellWidth, cellHeight);
    const encoder = this.mouseEncoder;
    const ev = this.mouseEvent;
    const s = this.scratch!;
    abi.bytes()[s.out] = event.anyButtonPressed ? 1 : 0;
    ex.ghostty_mouse_encoder_setopt(encoder, L.mouseEncoderOption.ANY_BUTTON_PRESSED, s.out);
    ex.ghostty_mouse_event_set_action(ev, L.mouseAction[MOUSE_ACTIONS[event.action]]);
    if (event.button === null) ex.ghostty_mouse_event_clear_button(ev);
    else ex.ghostty_mouse_event_set_button(ev, L.mouseButton[MOUSE_BUTTONS[event.button]]);
    ex.ghostty_mouse_event_set_mods(ev, event.mods & 0xffff);
    const P = L.mousePosition;
    const view = abi.view();
    view.setFloat32(s.mousePosition + P.x, x, true);
    view.setFloat32(s.mousePosition + P.y, y, true);
    ex.ghostty_mouse_event_set_position(ev, s.mousePosition);

    // A failed (OUT_OF_SPACE) encode restores the dedup cell natively, so one
    // retry with the reported size encodes the same event exactly once.
    let ptr = this.mouseOut.ensure(64);
    let result = ex.ghostty_mouse_encoder_encode(encoder, ev, ptr, this.mouseOut.cap, s.out2);
    let len = abi.view().getUint32(s.out2, true);
    if (result === L.result.OUT_OF_SPACE && len > this.mouseOut.cap) {
      ptr = this.mouseOut.ensure(len);
      result = ex.ghostty_mouse_encoder_encode(encoder, ev, ptr, this.mouseOut.cap, s.out2);
      len = abi.view().getUint32(s.out2, true);
    }
    abi.check(result as number, 'ghostty_mouse_encoder_encode');
    return abi.bytes().slice(ptr, ptr + len);
  }

  /** Clear the input encoder's last reported cell; no-op before the first mouse event. */
  resetMouseEncoder(): void {
    if (this.mouseEncoder) this.abi.exports.ghostty_mouse_encoder_reset(this.mouseEncoder);
  }

  /** Create the input encoder/event pair, all or nothing. */
  private ensureMouseEncoder(): void {
    if (this.mouseEncoder) return;
    const abi = this.abi;
    const ex = abi.exports;
    const encoder = abi.newHandle(ex.ghostty_mouse_encoder_new, 'ghostty_mouse_encoder_new');
    let event = 0;
    try {
      event = abi.newHandle(ex.ghostty_mouse_event_new, 'ghostty_mouse_event_new');
      const s = this.scratch!;
      abi.bytes()[s.out] = 1;
      ex.ghostty_mouse_encoder_setopt(encoder, this.L.mouseEncoderOption.TRACK_LAST_CELL, s.out);
    } catch (error) {
      if (event) ex.ghostty_mouse_event_free(event);
      ex.ghostty_mouse_encoder_free(encoder);
      throw error;
    }
    this.mouseEncoder = encoder;
    this.mouseEvent = event;
    this.mouseModesStale = true;
    this.mouseGeometry = null;
  }

  /**
   * Bring the input encoder up to date. Both steps clear native dedup, so each
   * runs only when needed: modes after a write, OPT_SIZE when the grid or cell
   * metrics changed.
   */
  private syncMouseEncoder(cellWidth: number, cellHeight: number): void {
    const ex = this.abi.exports;
    if (this.mouseModesStale) {
      ex.ghostty_mouse_encoder_setopt_from_terminal(this.mouseEncoder, this.handle);
      this.mouseModesStale = false;
    }
    const g = this.mouseGeometry;
    if (
      g?.cols === this.cols &&
      g.rows === this.rows &&
      g.cellWidth === cellWidth &&
      g.cellHeight === cellHeight
    ) {
      return;
    }
    const S = this.L.mouseEncoderSize;
    const at = this.scratch!.mouseSize;
    this.abi.bytes().fill(0, at, at + S.size); // zero padding
    const view = this.abi.view();
    view.setUint32(at, S.size, true); // sized struct: leading size_t (u32 on wasm32)
    view.setUint32(at + S.screen_width, this.cols * cellWidth, true);
    view.setUint32(at + S.screen_height, this.rows * cellHeight, true);
    view.setUint32(at + S.cell_width, cellWidth, true);
    view.setUint32(at + S.cell_height, cellHeight, true);
    ex.ghostty_mouse_encoder_setopt(this.mouseEncoder, this.L.mouseEncoderOption.SIZE, at);
    this.mouseGeometry = { cols: this.cols, rows: this.rows, cellWidth, cellHeight };
  }

  /** Unknown modes report false (the native API answers INVALID_VALUE for them). */
  getMode(mode: number, isAnsi: boolean): boolean {
    // GhosttyMode packs the number into 15 bits; larger values are not modes.
    if (!Number.isInteger(mode) || mode < 0 || mode > 0x7fff) return false;
    const s = this.scratch!;
    const M = this.L.modeConfig;
    const view = this.abi.view();
    view.setUint16(s.mode + M.mode, (mode & 0x7fff) | (isAnsi ? 0x8000 : 0), true);
    view.setUint8(s.mode + M.value, 0);
    const result = this.abi.exports.ghostty_terminal_get(
      this.handle,
      this.L.terminalData.MODE,
      s.mode
    ) as number;
    if (result === this.L.result.INVALID_VALUE) return false;
    this.abi.check(result, `terminal_get MODE ${mode}`);
    return this.abi.bytes()[s.mode + M.value] !== 0;
  }

  // ==========================================================================
  // History and on-demand cell data (grid references; never moves the viewport)
  // ==========================================================================

  getScrollbackLength(): number {
    const s = this.scratch!;
    this.getData('SCROLLBACK_ROWS', s.out);
    return this.abi.view().getUint32(s.out, true);
  }

  getScrollbackLine(offset: number): GhosttyCell[] | null {
    if (!this.validHistory(offset)) return null;
    // Default colors and palette come from the render state, as in the legacy engine.
    this.ensureFresh();
    const ex = this.abi.exports;
    const s = this.scratch!;
    const tag = this.L.pointTag.HISTORY;
    const styles = new Map<number, ResolvedStyle>();
    const source: CellSource = {
      style: (x) => {
        this.gridRef(tag, x, offset);
        return this.readStyle((ptr) => ex.ghostty_grid_ref_style(s.gridRef, ptr) as number);
      },
      graphemes: (x) => {
        this.gridRef(tag, x, offset);
        return this.refGraphemes();
      },
      hyperlinkId: (x) => this.linkId(tag, x, offset),
    };
    const cells: GhosttyCell[] = [];
    for (let x = 0; x < this.cols; x++) {
      this.gridRef(tag, x, offset);
      this.abi.check(ex.ghostty_grid_ref_cell(s.gridRef, s.out) as number, 'grid_ref_cell');
      const view = this.abi.view();
      const cell = blankCell();
      this.decodeCell(
        view.getUint32(s.out, true),
        view.getUint32(s.out + 4, true),
        x,
        cell,
        styles,
        source,
        null
      );
      cells.push(cell);
    }
    return cells;
  }

  isRowWrapped(row: number): boolean {
    if (!Number.isInteger(row) || row < 0 || row >= this.rows) return false;
    const ex = this.abi.exports;
    const s = this.scratch!;
    this.gridRef(this.L.pointTag.ACTIVE, 0, row);
    this.abi.check(ex.ghostty_grid_ref_row(s.gridRef, s.out) as number, 'grid_ref_row');
    const raw = this.abi.view().getBigUint64(s.out, true);
    this.abi.check(
      ex.ghostty_row_get(raw, this.L.rowFlag.WRAP_CONTINUATION, s.out2) as number,
      'row_get WRAP_CONTINUATION'
    );
    return this.abi.bytes()[s.out2] !== 0;
  }

  getHyperlinkUri(row: number, col: number): string | null {
    if (!this.validActive(row, col)) return null;
    this.gridRef(this.L.pointTag.ACTIVE, col, row);
    return this.refUri() || null;
  }

  getScrollbackHyperlinkUri(offset: number, col: number): string | null {
    if (!this.validHistory(offset) || !this.validCol(col)) return null;
    this.gridRef(this.L.pointTag.HISTORY, col, offset);
    return this.refUri() || null;
  }

  /** Full cluster (base codepoint first); empty when the cell holds no text. */
  getGrapheme(row: number, col: number): number[] | null {
    if (!this.validActive(row, col)) return null;
    this.ensureFresh();
    const index = row * this.cols + col;
    const cluster = this.clusters.get(index);
    if (cluster) return [...cluster];
    const codepoint = this.pool[index].codepoint;
    return codepoint ? [codepoint] : [];
  }

  getScrollbackGrapheme(offset: number, col: number): number[] | null {
    if (!this.validHistory(offset) || !this.validCol(col)) return null;
    this.gridRef(this.L.pointTag.HISTORY, col, offset);
    return this.refGraphemes();
  }

  // ==========================================================================
  // Replies (WRITE_PTY effect)
  // ==========================================================================

  /** @internal Copy reply bytes immediately; they are only valid during the callback. */
  onWritePty(ptr: number, len: number): void {
    if (len > 0) this.replies.push(this.abi.bytes().slice(ptr, ptr + len));
  }

  hasResponse(): boolean {
    return this.replies.length > 0;
  }

  /**
   * Pending reply bytes in order, at most 256 bytes per call like the legacy
   * engine, never splitting a UTF-8 sequence across calls.
   */
  readResponse(): string | null {
    if (this.replies.length === 0) return null;
    let pending: Uint8Array;
    if (this.replies.length === 1) pending = this.replies[0];
    else {
      pending = new Uint8Array(this.replies.reduce((n, r) => n + r.length, 0));
      let at = 0;
      for (const r of this.replies) {
        pending.set(r, at);
        at += r.length;
      }
    }
    let end = Math.min(RESPONSE_CHUNK, pending.length);
    if (end < pending.length) {
      // Cut before the lead byte of a sequence the chunk boundary would split
      // (continuation bytes are 10xxxxxx; valid UTF-8 has at most 3 of them).
      let cut = end;
      while (cut > end - 4 && cut > 0 && (pending[cut] & 0xc0) === 0x80) cut--;
      if (cut > 0 && (pending[cut] & 0xc0) !== 0x80) end = cut;
    }
    this.replies = end < pending.length ? [pending.slice(end)] : [];
    return this.decoder.decode(pending.subarray(0, end));
  }

  // ==========================================================================
  // Configuration
  // ==========================================================================

  private configure(config: GhosttyTerminalConfig | undefined): void {
    const s = this.scratch!;
    const view = () => this.abi.view();

    // Follow upstream physical-line budgets, not an exact xterm.js cap. Whole
    // pages are pruned, so the retained count varies; zero keeps no history.
    const limit = config?.scrollbackLimit ?? DEFAULT_SCROLLBACK_LINES;
    if (typeof limit !== 'number' || Number.isNaN(limit) || limit < 0) {
      throw new RangeError(`libghostty-vt: invalid scrollbackLimit ${limit}`);
    }
    view().setUint32(s.out, 0, true);
    if (limit === 0) {
      this.set('SCROLLBACK_MAX_BYTES', s.out);
      this.set('SCROLLBACK_MAX_LINES', s.out);
    } else {
      // The line limit replaces the native 10 kB default byte limit.
      this.set('SCROLLBACK_MAX_BYTES', 0);
      if (limit >= 0xffffffff) this.set('SCROLLBACK_MAX_LINES', 0);
      else {
        view().setUint32(s.out, Math.floor(limit), true);
        this.set('SCROLLBACK_MAX_LINES', s.out);
      }
    }

    // Colors: presence bits when given, else the documented 0 = default.
    const presence = (config as { colorPresence?: ColorPresence } | undefined)?.colorPresence;
    const present = (flag: boolean | undefined, value: number | undefined) =>
      flag ?? (value !== undefined && value !== 0);
    const setRgb = (
      option: 'COLOR_FOREGROUND' | 'COLOR_BACKGROUND' | 'COLOR_CURSOR',
      rgb: number
    ) => {
      this.writeRgb(s.out, rgb);
      this.set(option, s.out);
    };
    setRgb(
      'COLOR_FOREGROUND',
      present(presence?.foreground, config?.fgColor)
        ? (config?.fgColor ?? 0)
        : LEGACY_DEFAULT_FOREGROUND
    );
    setRgb(
      'COLOR_BACKGROUND',
      present(presence?.background, config?.bgColor)
        ? (config?.bgColor ?? 0)
        : LEGACY_DEFAULT_BACKGROUND
    );
    if (present(presence?.cursor, config?.cursorColor)) {
      setRgb('COLOR_CURSOR', config?.cursorColor ?? 0);
    }
    const overrides: [number, number][] = [];
    for (let i = 0; i < 16; i++) {
      const value = config?.palette?.[i];
      const set = presence?.palette !== undefined ? ((presence.palette >> i) & 1) === 1 : !!value;
      if (set) overrides.push([i, value ?? 0]);
    }
    if (overrides.length > 0) {
      const table = this.abi.alloc(768);
      try {
        this.getData('COLOR_PALETTE_DEFAULT', table);
        for (const [i, rgb] of overrides) this.writeRgb(table + i * 3, rgb);
        this.set('COLOR_PALETTE', table);
      } finally {
        this.abi.free(table, 768);
      }
    }

    // Grapheme clustering on by default, and restored by RIS.
    const M = this.L.modeConfig;
    view().setUint16(s.mode + M.mode, GRAPHEME_CLUSTER_MODE, true);
    view().setUint8(s.mode + M.value, 1);
    this.set('MODE_DEFAULT', s.mode);
  }

  // ==========================================================================
  // Snapshot refresh
  // ==========================================================================

  private allocatePool(): void {
    const total = this.cols * this.rows;
    if (this.pool.length !== total) {
      this.pool = Array.from({ length: total }, blankCell);
    }
    this.rowDirty = new Uint8Array(this.rows);
    this.clusters.clear();
    this.decodeAll = true;
  }

  private ensureFresh(): void {
    if (this.stale) this.refresh();
  }

  private refresh(): void {
    const abi = this.abi;
    const ex = abi.exports;
    const L = this.L;
    const s = this.scratch!;
    const rs = this.renderState;
    abi.check(ex.ghostty_render_state_update(rs, this.handle) as number, 'render_state_update');

    abi.check(ex.ghostty_render_state_get(rs, L.renderData.DIRTY, s.out) as number, 'DIRTY');
    const nativeDirty = abi.view().getInt32(s.out, true);
    if (nativeDirty === L.dirty.FULL) this.dirty = DirtyState.FULL;
    else if (nativeDirty === L.dirty.PARTIAL) this.dirty = DirtyState.PARTIAL;
    else if (nativeDirty === L.dirty.FALSE) this.dirty = DirtyState.NONE;
    else throw new Error(`libghostty-vt: unknown render dirty state ${nativeDirty}`);

    // Colors (sized struct): defaults, cursor color and the 256-color palette.
    const C = L.colors;
    abi.view().setUint32(s.colors, C.size, true);
    abi.check(ex.ghostty_render_state_get(rs, L.renderData.COLORS, s.colors) as number, 'COLORS');
    const bytes = abi.bytes();
    const background = this.readRgb(s.colors + C.background);
    const foreground = this.readRgb(s.colors + C.foreground);
    const palette = bytes.subarray(s.colors + C.palette, s.colors + C.palette + 768);
    let colorsChanged = background !== this.background || foreground !== this.foreground;
    for (let i = 0; i < 768 && !colorsChanged; i++) colorsChanged = palette[i] !== this.palette[i];
    if (colorsChanged) {
      this.background = background;
      this.foreground = foreground;
      this.palette.set(palette);
    }
    this.cursorColor = bytes[s.colors + C.cursor_has_value]
      ? this.readRgb(s.colors + C.cursor)
      : null;

    // Cursor: active-area position plus render-state visibility and style.
    const K = L.cursor;
    abi.view().setUint32(s.cursor, K.size, true);
    abi.check(ex.ghostty_render_state_get(rs, L.renderData.CURSOR, s.cursor) as number, 'CURSOR');
    const view = abi.view();
    const inViewport = view.getUint8(s.cursor + K.viewport_has_value) !== 0;
    const visualStyle = view.getInt32(s.cursor + K.visual_style, true);
    const cursor = this.cursorState;
    cursor.viewportX = inViewport ? view.getUint16(s.cursor + K.viewport_x, true) : -1;
    cursor.viewportY = inViewport ? view.getUint16(s.cursor + K.viewport_y, true) : -1;
    cursor.visible = view.getUint8(s.cursor + K.visible) !== 0;
    cursor.blinking = view.getUint8(s.cursor + K.blinking) !== 0;
    cursor.style =
      visualStyle === L.cursorStyle.BAR
        ? 'bar'
        : visualStyle === L.cursorStyle.UNDERLINE
          ? 'underline'
          : 'block';
    this.getData('CURSOR_X', s.out);
    cursor.x = abi.view().getUint16(s.out, true);
    this.getData('CURSOR_Y', s.out);
    cursor.y = abi.view().getUint16(s.out, true);

    // Rows: decode only what the render state reports dirty.
    const all = this.decodeAll || colorsChanged || this.dirty === DirtyState.FULL;
    abi.check(
      ex.ghostty_render_state_get(rs, L.renderData.ROW_ITERATOR, s.iterRef) as number,
      'ROW_ITERATOR'
    );
    let y = 0;
    while (ex.ghostty_render_state_row_iterator_next(this.rowIterator)) {
      if (y >= this.rows)
        throw new Error('libghostty-vt: render state has more rows than the terminal');
      abi.check(
        ex.ghostty_render_state_row_get(this.rowIterator, L.rowData.DIRTY, s.out) as number,
        'row DIRTY'
      );
      const rowDirty = abi.bytes()[s.out] !== 0;
      this.rowDirty[y] = rowDirty ? 1 : 0;
      if (all || rowDirty) this.decodeRow(y);
      y++;
    }
    if (y !== this.rows) {
      throw new Error(`libghostty-vt: render state has ${y} rows, terminal has ${this.rows}`);
    }
    this.decodeAll = false;
    this.stale = false;
  }

  private decodeRow(y: number): void {
    const abi = this.abi;
    const ex = abi.exports;
    const L = this.L;
    const s = this.scratch!;
    const it = this.rowIterator;
    abi.check(
      ex.ghostty_render_state_row_get(it, L.rowData.CELLS_RAW, s.cellsView) as number,
      'CELLS_RAW'
    );
    let view = abi.view();
    const ptr = view.getUint32(s.cellsView + L.cellsView.ptr, true);
    const len = view.getUint32(s.cellsView + L.cellsView.len, true);
    if (len !== this.cols) {
      throw new Error(
        `libghostty-vt: row ${y} has ${len} cells, terminal has ${this.cols} columns`
      );
    }
    let cellsReady = false;
    const select = (x: number) => {
      if (!cellsReady) {
        abi.check(
          ex.ghostty_render_state_row_get(it, L.rowData.CELLS, s.cellsRef) as number,
          'CELLS'
        );
        cellsReady = true;
      }
      abi.check(
        ex.ghostty_render_state_row_cells_select(this.rowCells, x) as number,
        'row_cells_select'
      );
    };
    const source: CellSource = {
      style: (x) => {
        select(x);
        return this.readStyle(
          (out) =>
            ex.ghostty_render_state_row_cells_get(this.rowCells, L.cellsData.STYLE, out) as number
        );
      },
      graphemes: (x) => {
        select(x);
        abi.check(
          ex.ghostty_render_state_row_cells_get(
            this.rowCells,
            L.cellsData.GRAPHEMES_LEN,
            s.out2
          ) as number,
          'GRAPHEMES_LEN'
        );
        const n = abi.view().getUint32(s.out2, true);
        if (n === 0) return [];
        const buf = this.codepoints.ensure(n * 4);
        abi.check(
          ex.ghostty_render_state_row_cells_get(
            this.rowCells,
            L.cellsData.GRAPHEMES_BUF,
            buf
          ) as number,
          'GRAPHEMES_BUF'
        );
        const v = abi.view();
        return Array.from({ length: n }, (_, i) => v.getUint32(buf + i * 4, true));
      },
      hyperlinkId: (x) => this.linkId(L.pointTag.VIEWPORT, x, y),
    };
    const styles = new Map<number, ResolvedStyle>();
    const base = y * this.cols;
    for (let x = 0; x < this.cols; x++) {
      // The cells view stays valid until the next update; memory may have grown.
      view = abi.view();
      const at = ptr + x * 8;
      this.clusters.delete(base + x);
      this.decodeCell(
        view.getUint32(at, true),
        view.getUint32(at + 4, true),
        x,
        this.pool[base + x],
        styles,
        source,
        base + x
      );
    }
  }

  /**
   * Decode one packed cell into the public shape. `styles` caches styles by
   * page-local style id and must be scoped to a single row.
   */
  private decodeCell(
    lo: number,
    hi: number,
    x: number,
    cell: GhosttyCell,
    styles: Map<number, ResolvedStyle>,
    source: CellSource,
    clusterIndex: number | null
  ): void {
    const L = this.L;
    const C = L.cell;
    const tag = bitsOf(lo, hi, C.contentTag);
    const styleId = bitsOf(lo, hi, C.styleId);
    let style = NO_STYLE;
    if (styleId !== 0) {
      let cached = styles.get(styleId);
      if (!cached) {
        cached = source.style(x);
        styles.set(styleId, cached);
      }
      style = cached;
    }
    let codepoint = 0;
    let bg = style.bg;
    let graphemeLen = 0;
    if (tag === L.contentTag.CODEPOINT) codepoint = bitsOf(lo, hi, C.codepoint);
    else if (tag === L.contentTag.CODEPOINT_GRAPHEME) {
      codepoint = bitsOf(lo, hi, C.graphemeCodepoint);
      const cluster = source.graphemes(x);
      if (cluster.length > 1) {
        graphemeLen = cluster.length - 1;
        if (clusterIndex !== null) this.clusters.set(clusterIndex, cluster);
      }
    } else if (tag === L.contentTag.BG_COLOR_PALETTE) {
      bg = this.paletteRgb(bitsOf(lo, hi, C.paletteIndex));
    } else if (tag === L.contentTag.BG_COLOR_RGB) {
      bg = (bitsOf(lo, hi, C.r) << 16) | (bitsOf(lo, hi, C.g) << 8) | bitsOf(lo, hi, C.b);
    }
    const fgDefault = style.fg < 0;
    const bgDefault = bg < 0;
    const fg = fgDefault ? this.foreground : style.fg;
    if (bgDefault) bg = this.background;
    const wide = bitsOf(lo, hi, C.wide);
    cell.codepoint = codepoint;
    cell.fg_r = (fg >> 16) & 0xff;
    cell.fg_g = (fg >> 8) & 0xff;
    cell.fg_b = fg & 0xff;
    cell.bg_r = (bg >> 16) & 0xff;
    cell.bg_g = (bg >> 8) & 0xff;
    cell.bg_b = bg & 0xff;
    cell.flags = style.flags;
    cell.width = wide === L.wide.WIDE ? 2 : wide === L.wide.NARROW ? 1 : 0;
    cell.hyperlink_id = bitsOf(lo, hi, C.hyperlink) ? source.hyperlinkId(x) : 0;
    cell.grapheme_len = graphemeLen;
    cell.fg_default = fgDefault;
    cell.bg_default = bgDefault;
  }

  /** Query a GhosttyStyle into scratch and resolve its colors and flags. */
  private readStyle(query: (out: number) => number): ResolvedStyle {
    const abi = this.abi;
    const S = this.L.style;
    const ptr = this.scratch!.style;
    abi.view().setUint32(ptr, S.size, true);
    abi.check(query(ptr), 'style');
    const view = abi.view();
    const flag = (offset: number, bit: number) => (view.getUint8(ptr + offset) ? bit : 0);
    return {
      fg: this.styleColor(ptr + S.fg_color),
      bg: this.styleColor(ptr + S.bg_color),
      flags:
        flag(S.bold, CellFlags.BOLD) |
        flag(S.italic, CellFlags.ITALIC) |
        (view.getInt32(ptr + S.underline, true) !== this.L.underline.NONE
          ? CellFlags.UNDERLINE
          : 0) |
        flag(S.strikethrough, CellFlags.STRIKETHROUGH) |
        flag(S.inverse, CellFlags.INVERSE) |
        flag(S.invisible, CellFlags.INVISIBLE) |
        flag(S.blink, CellFlags.BLINK) |
        flag(S.faint, CellFlags.FAINT),
    };
  }

  /** A GhosttyStyleColor at `at` as 0xRRGGBB, or -1 when unset (default color). */
  private styleColor(at: number): number {
    const S = this.L.style;
    const T = this.L.styleColorTag;
    const view = this.abi.view();
    const tag = view.getInt32(at + S.colorTag, true);
    if (tag === T.NONE) return -1;
    if (tag === T.PALETTE) return this.paletteRgb(view.getUint8(at + S.colorPalette));
    if (tag === T.RGB) return this.readRgb(at + S.colorRgb);
    throw new Error(`libghostty-vt: unknown style color tag ${tag}`);
  }

  // ==========================================================================
  // Helpers
  // ==========================================================================

  private set(option: keyof NativeLayout['terminalOption'], value: number): void {
    this.abi.check(
      this.abi.exports.ghostty_terminal_set(
        this.handle,
        this.L.terminalOption[option],
        value
      ) as number,
      `terminal_set ${option}`
    );
  }

  private getData(data: keyof NativeLayout['terminalData'], out: number): void {
    this.abi.check(
      this.abi.exports.ghostty_terminal_get(this.handle, this.L.terminalData[data], out) as number,
      `terminal_get ${data}`
    );
  }

  private writeRgb(at: number, rgb: number): void {
    const R = this.L.rgb;
    const bytes = this.abi.bytes();
    bytes[at + R.r] = (rgb >> 16) & 0xff;
    bytes[at + R.g] = (rgb >> 8) & 0xff;
    bytes[at + R.b] = rgb & 0xff;
  }

  private readRgb(at: number): number {
    const R = this.L.rgb;
    const bytes = this.abi.bytes();
    return (bytes[at + R.r] << 16) | (bytes[at + R.g] << 8) | bytes[at + R.b];
  }

  private paletteRgb(index: number): number {
    const p = this.palette;
    return (p[index * 3] << 16) | (p[index * 3 + 1] << 8) | p[index * 3 + 2];
  }

  private validCol(col: number): boolean {
    return Number.isInteger(col) && col >= 0 && col < this.cols;
  }

  private validActive(row: number, col: number): boolean {
    return Number.isInteger(row) && row >= 0 && row < this.rows && this.validCol(col);
  }

  private validHistory(offset: number): boolean {
    return Number.isInteger(offset) && offset >= 0 && offset < this.getScrollbackLength();
  }

  /** Resolve a point into the scratch grid ref; coordinates are pre-validated. */
  private gridRef(tag: number, x: number, y: number): void {
    const s = this.scratch!;
    const P = this.L.point;
    const view = this.abi.view();
    this.abi.bytes().fill(0, s.point, s.point + P.size);
    view.setInt32(s.point + P.tag, tag, true);
    view.setUint16(s.point + P.value + P.x, x, true);
    view.setUint32(s.point + P.value + P.y, y, true);
    view.setUint32(s.gridRef, this.L.gridRefSize, true);
    this.abi.check(
      this.abi.exports.ghostty_terminal_grid_ref(this.handle, s.point, s.gridRef) as number,
      `grid_ref (${x}, ${y})`
    );
  }

  /** Graphemes of the scratch grid ref (empty when the cell has no text). */
  private refGraphemes(): number[] {
    const abi = this.abi;
    const s = this.scratch!;
    let cap = 16;
    for (;;) {
      const buf = this.codepoints.ensure(cap * 4);
      const result = abi.exports.ghostty_grid_ref_graphemes(s.gridRef, buf, cap, s.out2) as number;
      const n = abi.view().getUint32(s.out2, true);
      if (result === this.L.result.OUT_OF_SPACE && n > cap) {
        cap = n;
        continue;
      }
      abi.check(result, 'grid_ref_graphemes');
      const view = abi.view();
      return Array.from({ length: n }, (_, i) => view.getUint32(buf + i * 4, true));
    }
  }

  /** Hyperlink URI of the scratch grid ref ('' when the cell has no link). */
  private refUri(): string {
    const abi = this.abi;
    const s = this.scratch!;
    let cap = Math.max(this.uri.cap, 256);
    for (;;) {
      const buf = this.uri.ensure(cap);
      const result = abi.exports.ghostty_grid_ref_hyperlink_uri(
        s.gridRef,
        buf,
        cap,
        s.out2
      ) as number;
      const n = abi.view().getUint32(s.out2, true);
      if (result === this.L.result.OUT_OF_SPACE && n > cap) {
        cap = n;
        continue;
      }
      abi.check(result, 'grid_ref_hyperlink_uri');
      return abi.readString(buf, n);
    }
  }

  /**
   * Stable nonzero id per URI. The native API exposes no hyperlink identity, so
   * distinct OSC 8 links sharing a URI (different `id=`) share one id.
   */
  private linkId(tag: number, x: number, y: number): number {
    this.gridRef(tag, x, y);
    const uri = this.refUri();
    if (!uri) return 0;
    let id = this.linkIds.get(uri);
    if (id === undefined) {
      id = this.linkIds.size + 1;
      this.linkIds.set(uri, id);
    }
    return id;
  }
}

function rgbOf(value: number): RGB {
  return { r: (value >> 16) & 0xff, g: (value >> 8) & 0xff, b: value & 0xff };
}

export class NativeKeyEncoder implements KeyEncoderBackend {
  private encoder: number;

  constructor(private readonly abi: NativeAbi) {
    this.encoder = abi.newHandle(abi.exports.ghostty_key_encoder_new, 'ghostty_key_encoder_new');
  }

  setOption(option: KeyEncoderOption, value: boolean | number): void {
    const entry = this.abi.layout.optionMap.get(option);
    if (!entry) throw new Error(`libghostty-vt: unknown KeyEncoderOption ${option}`);
    let byte: number;
    if (typeof value === 'boolean') byte = value ? 1 : 0;
    else if (entry.kind === 'bool') byte = value ? 1 : 0;
    else if (Number.isInteger(value) && value >= 0 && value <= 0xff) byte = value;
    else throw new RangeError(`libghostty-vt: Kitty keyboard flags must be 0..255, got ${value}`);
    const ptr = this.abi.alloc(1);
    try {
      this.abi.bytes()[ptr] = byte;
      this.abi.exports.ghostty_key_encoder_setopt(this.encoder, entry.value, ptr);
    } finally {
      this.abi.free(ptr, 1);
    }
  }

  encode(event: KeyEvent): Uint8Array {
    const abi = this.abi;
    const ex = abi.exports;
    const L = abi.layout;
    const action = L.actionMap.get(event.action);
    if (action === undefined) throw new Error(`libghostty-vt: unknown KeyAction ${event.action}`);
    const key = L.keyMap.get(event.key);
    if (key === undefined) throw new Error(`libghostty-vt: unknown Key ${event.key}`);
    const ev = abi.newHandle(ex.ghostty_key_event_new, 'ghostty_key_event_new');
    const utf8 = event.utf8 ? new TextEncoder().encode(event.utf8) : null;
    let utf8Ptr = 0;
    let outPtr = 0;
    let outCap = 64;
    const lenPtr = abi.alloc(4);
    try {
      ex.ghostty_key_event_set_action(ev, action);
      ex.ghostty_key_event_set_key(ev, key);
      ex.ghostty_key_event_set_mods(ev, event.mods & 0xffff);
      if (event.consumedMods !== undefined) {
        ex.ghostty_key_event_set_consumed_mods(ev, event.consumedMods & 0xffff);
      }
      if (event.composing !== undefined)
        ex.ghostty_key_event_set_composing(ev, event.composing ? 1 : 0);
      if (event.unshiftedCodepoint !== undefined) {
        ex.ghostty_key_event_set_unshifted_codepoint(ev, event.unshiftedCodepoint);
      }
      if (utf8 && utf8.length > 0) {
        // The event borrows this memory; keep it alive until encoding completes.
        utf8Ptr = abi.alloc(utf8.length);
        abi.bytes().set(utf8, utf8Ptr);
        ex.ghostty_key_event_set_utf8(ev, utf8Ptr, utf8.length);
      }
      outPtr = abi.alloc(outCap);
      let result = ex.ghostty_key_encoder_encode(
        this.encoder,
        ev,
        outPtr,
        outCap,
        lenPtr
      ) as number;
      if (result === L.result.OUT_OF_SPACE) {
        const needed = abi.view().getUint32(lenPtr, true);
        abi.free(outPtr, outCap);
        outPtr = 0;
        outCap = needed;
        outPtr = abi.alloc(outCap);
        result = ex.ghostty_key_encoder_encode(this.encoder, ev, outPtr, outCap, lenPtr) as number;
      }
      abi.check(result, 'ghostty_key_encoder_encode');
      const written = abi.view().getUint32(lenPtr, true);
      return abi.bytes().slice(outPtr, outPtr + written);
    } finally {
      ex.ghostty_key_event_free(ev);
      if (utf8Ptr) abi.free(utf8Ptr, utf8!.length);
      if (outPtr) abi.free(outPtr, outCap);
      abi.free(lenPtr, 4);
    }
  }

  /**
   * Copy cursor-key/keypad modes, alt-escape prefix, modifyOtherKeys and Kitty
   * flags from the terminal (ghostty_key_encoder_setopt_from_terminal). This
   * also resets the macOS option-as-alt option to false.
   */
  syncFromTerminal(terminal: TerminalBackend): void {
    if (!(terminal instanceof NativeTerminal) || terminal.owner.abi !== this.abi) {
      throw new Error('libghostty-vt: syncFromTerminal needs a terminal from the same instance');
    }
    this.abi.exports.ghostty_key_encoder_setopt_from_terminal(this.encoder, terminal.nativeHandle);
  }

  dispose(): void {
    if (this.encoder) {
      this.abi.exports.ghostty_key_encoder_free(this.encoder);
      this.encoder = 0;
    }
  }
}
