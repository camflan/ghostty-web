/**
 * BrowserSurface: the browser apprt surface's DOM subscription lifetime.
 *
 * Upstream provenance (ghostty-org/ghostty @ 246f702876b924a1cb7cade1e99274d1470302fc):
 * - GTK `src/apprt/gtk/class/surface.zig`: the apprt surface owns the toolkit event sources
 *   that feed the core Surface (template callbacks bound at 3838-3856: focus, key, mouse,
 *   scroll, ...) and drops its signal connections in `dispose` (1877+), e.g. the scrollbar
 *   adjustment's signal group.
 * - `src/Surface.zig` `deinit` (801-825): input and render sources stop before the state
 *   they reach is released.
 *
 * Browser adaptation: DOM listeners are the toolkit event sources. This class only owns
 * their lifetime, so teardown removes every one of them in one step and nothing registered
 * after disposal can resurrect input. Event decoding stays with the existing input and
 * selection handlers; this is not a second input or clipboard API.
 */
/** Standard DOM events by name, so typed handlers (MouseEvent, ClipboardEvent, ...) fit. */
export type BrowserSurfaceEventMap = HTMLElementEventMap & DocumentEventMap & WindowEventMap;

export class BrowserSurface {
  private listeners: Array<[EventTarget, string, EventListenerOrEventListenerObject, boolean]> = [];
  private isDisposed = false;

  get disposed(): boolean {
    return this.isDisposed;
  }

  /** `addEventListener`, removed again by `dispose()`. Ignored once disposed. */
  listen<K extends keyof BrowserSurfaceEventMap>(
    target: EventTarget,
    type: K,
    listener: (event: BrowserSurfaceEventMap[K]) => void,
    options?: AddEventListenerOptions | boolean
  ): void;
  /** Custom or nonstandard event names. */
  listen(
    target: EventTarget,
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: AddEventListenerOptions | boolean
  ): void;
  listen(
    target: EventTarget,
    type: string,
    listener: EventListenerOrEventListenerObject | ((event: any) => void),
    options?: AddEventListenerOptions | boolean
  ): void {
    if (this.isDisposed) return;
    target.addEventListener(type, listener as EventListenerOrEventListenerObject, options);
    const capture = typeof options === 'boolean' ? options : options?.capture === true;
    this.listeners.push([target, type, listener, capture]);
  }

  /** Remove every listener registered through `listen`. Idempotent. */
  dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;
    const listeners = this.listeners;
    this.listeners = [];
    for (const [target, type, listener, capture] of listeners) {
      target.removeEventListener(type, listener, capture);
    }
  }
}
