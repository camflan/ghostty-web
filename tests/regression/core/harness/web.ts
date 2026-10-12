/**
 * Test-only adapter for the ghostty-web engine (pinned or candidate WASM at the
 * repository root). Uses only public classes: `Ghostty`, `GhosttyTerminal`,
 * `Terminal`, `KeyEncoder`. No production exports are added.
 *
 * Every helper creates a FRESH WebAssembly instance unless a shared `Ghostty`
 * is passed explicitly: the pinned build recycles un-zeroed page memory between
 * terminals of one instance (RT-01 family), so sharing would let one test's
 * screen leak into another.
 */
import { Ghostty, type GhosttyTerminal, type ITheme, Terminal } from '../../../../lib/index';
import type { GhosttyCell, GhosttyTerminalConfig } from '../../../../lib/types';
import { assertBridgeBackend, engineIdentity } from './identity';

const instances = new WeakMap<Ghostty, WebAssembly.Instance>();

/** No-op host imports for whatever function imports the loaded ABI declares. */
function hostImports(module: WebAssembly.Module): WebAssembly.Imports {
  const imports: Record<string, Record<string, () => void>> = {};
  for (const entry of WebAssembly.Module.imports(module)) {
    if (entry.kind !== 'function') {
      throw new Error(`Unsupported WASM import ${entry.module}.${entry.name} (${entry.kind})`);
    }
    // The legacy build logs unimplemented sequences through env.log; keep output quiet.
    imports[entry.module] ??= {};
    imports[entry.module][entry.name] = () => {};
  }
  return imports;
}

/**
 * A brand-new WASM instance (own linear memory) wrapped in the public `Ghostty`
 * class. The bridge's reported backend must match the binary's ABI.
 */
export function freshGhostty(): Ghostty {
  const { module, backend } = engineIdentity();
  const instance = new WebAssembly.Instance(module, hostImports(module));
  // The facade (lib/backends/types.ts GhosttyLoadOptions) refuses a mismatching
  // engine itself; the pre-facade constructor ignores the extra argument.
  const GhosttyWithOptions = Ghostty as unknown as new (
    instance: WebAssembly.Instance,
    options: { backend: typeof backend }
  ) => Ghostty;
  const ghostty = new GhosttyWithOptions(instance, { backend });
  assertBridgeBackend('Ghostty', (ghostty as { backend?: unknown }).backend, backend);
  instances.set(ghostty, instance);
  return ghostty;
}

/** Check a terminal created by the bridge against the loaded ABI. */
export function assertTerminalBackend(term: GhosttyTerminal): GhosttyTerminal {
  assertBridgeBackend(
    'GhosttyTerminal',
    (term as { backend?: unknown }).backend,
    engineIdentity().backend
  );
  return term;
}

/** Linear memory of an instance created by freshGhostty() (bridge-independent). */
export function wasmMemory(ghostty: Ghostty): WebAssembly.Memory {
  const memory = instances.get(ghostty)?.exports.memory;
  if (!(memory instanceof WebAssembly.Memory)) {
    throw new Error('wasmMemory() needs a Ghostty created by freshGhostty()');
  }
  return memory;
}

// ---------------------------------------------------------------------------
// Bytes
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();

export function utf8(data: string | Uint8Array): Uint8Array {
  return typeof data === 'string' ? encoder.encode(data) : data;
}

export function hex(data: string | Uint8Array): string {
  return [...utf8(data)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** One hex string per emitted chunk, as the transport would see it (UTF-8 encoded). */
export function hexChunks(chunks: readonly (string | Uint8Array)[]): string[] {
  return chunks.map(hex);
}

// ---------------------------------------------------------------------------
// Screen observation (GhosttyTerminal level)
// ---------------------------------------------------------------------------

export interface Observation {
  lines: string[];
  cursor: { x: number; y: number };
}

function cellText(term: GhosttyTerminal, y: number, x: number, cell: GhosttyCell): string {
  if (cell.width === 0) return ''; // spacer cell of a wide character
  if (cell.codepoint === 0) return ' ';
  if (cell.grapheme_len > 0) return term.getGraphemeString(y, x);
  return String.fromCodePoint(cell.codepoint);
}

/** Visible rows as text (wide-char spacers removed, trailing blanks trimmed). */
export function visibleLines(term: GhosttyTerminal): string[] {
  const lines: string[] = [];
  for (let y = 0; y < term.rows; y++) {
    const cells = term.getLine(y) ?? [];
    lines.push(
      cells
        .map((cell, x) => cellText(term, y, x, cell))
        .join('')
        .replace(/ +$/, '')
    );
  }
  return lines;
}

export function cellsOf(term: GhosttyTerminal, y: number): Array<[number, number]> {
  return (term.getLine(y) ?? []).map((cell) => [cell.codepoint, cell.width]);
}

export function observe(term: GhosttyTerminal): Observation {
  const cursor = term.getCursor();
  return { lines: visibleLines(term), cursor: { x: cursor.x, y: cursor.y } };
}

export interface RawSession {
  ghostty: Ghostty;
  term: GhosttyTerminal;
  write(data: string | Uint8Array): void;
  observe(): Observation;
  free(): void;
}

/** A bare `GhosttyTerminal` on a fresh (or explicitly shared) instance. */
export function rawSession(
  cols: number,
  rows: number,
  ghostty = freshGhostty(),
  config?: GhosttyTerminalConfig
): RawSession {
  const term = assertTerminalBackend(ghostty.createTerminal(cols, rows, config));
  return {
    ghostty,
    term,
    write: (data) => term.write(data),
    observe: () => observe(term),
    free: () => term.free(),
  };
}

// ---------------------------------------------------------------------------
// Full Terminal (DOM) sessions
// ---------------------------------------------------------------------------

export interface WebSession {
  term: Terminal;
  container: HTMLElement;
  ghostty: Ghostty;
  /** Every `onData` payload, in order. */
  data: string[];
  titles: string[];
  bells: number;
  dispose(): void;
}

export interface OpenOptions {
  cols?: number;
  rows?: number;
  scrollback?: number;
  disableStdin?: boolean;
  theme?: ITheme;
  ghostty?: Ghostty;
}

export function openTerminal(options: OpenOptions = {}): WebSession {
  const ghostty = options.ghostty ?? freshGhostty();
  const term = new Terminal({
    ghostty,
    cols: options.cols ?? 20,
    rows: options.rows ?? 4,
    ...(options.scrollback === undefined ? {} : { scrollback: options.scrollback }),
    ...(options.disableStdin === undefined ? {} : { disableStdin: options.disableStdin }),
    ...(options.theme === undefined ? {} : { theme: options.theme }),
  });
  // This test-only adapter must fail loudly when a migration changes its hook,
  // rather than silently allowing animation frames to race semantic assertions.
  const control = term as unknown as { cancelRenderLoop?: () => void };
  if (typeof control.cancelRenderLoop !== 'function') {
    throw new Error(
      'Core test adapter requires cancelRenderLoop; update the adapter for this backend'
    );
  }
  const container = document.createElement('div');
  document.body.appendChild(container);
  term.open(container);
  control.cancelRenderLoop();
  wasmTerm(term); // the opened terminal's backend must match the loaded ABI
  const session: WebSession = {
    term,
    container,
    ghostty,
    data: [],
    titles: [],
    bells: 0,
    dispose() {
      term.dispose();
      container.remove();
    },
  };
  term.onData((d) => session.data.push(d));
  term.onTitleChange((t) => session.titles.push(t));
  term.onBell(() => {
    session.bells++;
  });
  return session;
}

// ---------------------------------------------------------------------------
// Teardown that never masks or swallows errors
// ---------------------------------------------------------------------------

function rethrowAfterTeardown(error: unknown, teardown: () => void): never {
  try {
    teardown();
  } catch (teardownError) {
    // Preserve both failures; neither the assertion nor cleanup error may be swallowed.
    throw new AggregateError([error, teardownError], 'Test body failed and teardown also failed');
  }
  throw error;
}

/**
 * Run `body`, then `teardown`. Unlike `try/finally`, a throwing teardown cannot
 * replace the body's error, and a teardown failure after a passing body fails
 * the test instead of being ignored.
 */
export function guarded<T>(body: () => T, teardown: () => void): T {
  let result: T;
  try {
    result = body();
  } catch (error) {
    rethrowAfterTeardown(error, teardown);
  }
  if (result instanceof Promise) {
    teardown();
    throw new Error('guarded() body returned a Promise; use guardedAsync()');
  }
  teardown();
  return result;
}

export async function guardedAsync<T>(
  body: () => T | Promise<T>,
  teardown: () => void
): Promise<T> {
  let result: T;
  try {
    result = await body();
  } catch (error) {
    rethrowAfterTeardown(error, teardown);
  }
  teardown();
  return result;
}

/** Run `body` with a session that is always disposed, without masking body errors. */
export function withTerminal<T>(
  options: OpenOptions,
  body: (session: WebSession) => T | Promise<T>
): Promise<T> {
  const session = openTerminal(options);
  return guardedAsync(
    () => body(session),
    () => session.dispose()
  );
}

export function wasmTerm(term: Terminal): GhosttyTerminal {
  const inner = (term as unknown as { wasmTerm?: GhosttyTerminal }).wasmTerm;
  if (!inner) throw new Error('terminal is not open');
  return assertTerminalBackend(inner);
}

export function bufferLines(term: Terminal, trimRight = true): string[] {
  const buffer = term.buffer.active;
  const lines: string[] = [];
  for (let y = 0; y < buffer.length; y++) {
    lines.push(buffer.getLine(y)?.translateToString(trimRight) ?? '<missing>');
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Synthetic DOM input (happy-dom: no default actions, IME or platform keymaps)
// ---------------------------------------------------------------------------

export function keydown(target: EventTarget, init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

export function keyup(target: EventTarget, init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keyup', { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

/** Dispatch a mouse event at the centre (or `fraction`) of a 1-based cell. */
export function mouseAt(
  session: WebSession,
  type: string,
  col: number,
  row: number,
  init: MouseEventInit = {},
  fraction = 0.5
): MouseEvent {
  const renderer = (
    session.term as unknown as { renderer: { charWidth: number; charHeight: number } }
  ).renderer;
  const event = new MouseEvent(type, {
    clientX: (col - 1 + fraction) * renderer.charWidth,
    clientY: (row - 1 + 0.5) * renderer.charHeight,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  session.container.dispatchEvent(event);
  return event;
}

export function wheelAt(session: WebSession, col: number, row: number, deltaY: number): WheelEvent {
  const renderer = (
    session.term as unknown as { renderer: { charWidth: number; charHeight: number } }
  ).renderer;
  const canvas = (session.term as unknown as { canvas: HTMLCanvasElement }).canvas;
  const event = new WheelEvent('wheel', {
    clientX: (col - 1 + 0.5) * renderer.charWidth,
    clientY: (row - 1 + 0.5) * renderer.charHeight,
    deltaY,
    deltaMode: 0,
    bubbles: true,
    cancelable: true,
  });
  canvas.dispatchEvent(event);
  return event;
}

// ---------------------------------------------------------------------------
// Resource accounting (listeners, timers, animation frames)
// ---------------------------------------------------------------------------

export interface ListenerTracker {
  /** Listeners on `container`, `document` or `window` added and not removed since tracking began. */
  live(): string[];
  restore(): void;
}

/**
 * Track listeners added to `container`, `document` and `window`. Keys include
 * the capture flag, because removeEventListener only matches the same flag.
 * (Canvas/textarea listeners are released with their removed elements.)
 */
export function trackListeners(container: EventTarget): ListenerTracker {
  let proto: object | null = document;
  while (proto && !Object.hasOwn(proto, 'addEventListener')) proto = Object.getPrototypeOf(proto);
  if (!proto) throw new Error('EventTarget prototype not found');
  const target = proto as EventTarget;
  const add = target.addEventListener;
  const remove = target.removeEventListener;
  const live = new Set<string>();
  const ids = new Map<unknown, number>();
  const name = (t: EventTarget) =>
    t === document ? 'document' : t === container ? 'container' : t === window ? 'window' : null;
  const key = (t: EventTarget, type: string, listener: unknown, options: unknown) => {
    if (!ids.has(listener)) ids.set(listener, ids.size);
    const capture =
      typeof options === 'boolean' ? options : !!(options as AddEventListenerOptions)?.capture;
    return `${name(t)}:${type}:${capture ? 'capture' : 'bubble'}:${ids.get(listener)}`;
  };
  target.addEventListener = function (this: EventTarget, type: string, l: any, o?: any) {
    const once = typeof o === 'object' && o !== null && o.once === true;
    if (name(this) && !once) live.add(key(this, type, l, o));
    return add.call(this, type, l, o);
  };
  target.removeEventListener = function (this: EventTarget, type: string, l: any, o?: any) {
    live.delete(key(this, type, l, o));
    return remove.call(this, type, l, o);
  };
  return {
    live: () => [...live].map((k) => k.replace(/:\d+$/, '')).sort(),
    restore() {
      target.addEventListener = add;
      target.removeEventListener = remove;
    },
  };
}

export interface TimerTracker {
  /** Timers/frames scheduled since tracking began that have neither fired nor been cancelled. */
  pending(): string[];
  restore(): void;
}

export function trackTimers(): TimerTracker {
  const g = globalThis as unknown as Record<string, (...args: any[]) => unknown>;
  const original = {
    setTimeout: g.setTimeout,
    clearTimeout: g.clearTimeout,
    setInterval: g.setInterval,
    clearInterval: g.clearInterval,
    requestAnimationFrame: g.requestAnimationFrame,
    cancelAnimationFrame: g.cancelAnimationFrame,
  };
  const pending = new Map<unknown, string>();
  const schedule =
    (kind: string, fn: (...args: any[]) => unknown, oneShot: boolean) =>
    (callback: (...args: any[]) => void, ...rest: unknown[]) => {
      const ref: { handle?: unknown } = {};
      const wrapped = (...args: any[]) => {
        if (oneShot) pending.delete(ref.handle);
        callback(...args);
      };
      ref.handle = fn(wrapped, ...rest);
      pending.set(ref.handle, kind);
      return ref.handle;
    };
  const cancel = (fn: (...args: any[]) => unknown) => (handle: unknown) => {
    pending.delete(handle);
    return fn(handle);
  };
  g.setTimeout = schedule('timeout', original.setTimeout, true);
  g.setInterval = schedule('interval', original.setInterval, false);
  g.requestAnimationFrame = schedule('animation-frame', original.requestAnimationFrame, true);
  g.clearTimeout = cancel(original.clearTimeout);
  g.clearInterval = cancel(original.clearInterval);
  g.cancelAnimationFrame = cancel(original.cancelAnimationFrame);
  return {
    pending: () => [...pending.values()].sort(),
    restore() {
      Object.assign(g, original);
    },
  };
}
