# ghostty-web

[![NPM Version](https://img.shields.io/npm/v/ghostty-web)](https://npmjs.com/package/ghostty-web) [![NPM Downloads](https://img.shields.io/npm/dw/ghostty-web)](https://npmjs.com/package/ghostty-web) [![npm bundle size](https://img.shields.io/bundlephobia/minzip/ghostty-web)](https://npmjs.com/package/ghostty-web) [![license](https://img.shields.io/github/license/coder/ghostty-web)](./LICENSE)

[Ghostty](https://github.com/ghostty-org/ghostty) for the web with [xterm.js](https://github.com/xtermjs/xterm.js) API compatibility — giving you a proper VT100 implementation in the browser.

- Migrate from xterm by changing your import: `@xterm/xterm` → `ghostty-web`
- WASM-compiled parser from Ghostty—the same code that runs the native app
- Zero runtime dependencies, ~828 KiB uncompressed upstream WASM bundle

Originally created for [Mux](https://github.com/coder/mux) (a desktop app for isolated, parallel agentic development), but designed to be used anywhere.

## Try It

- [Live Demo](https://ghostty.ondis.co) on an ephemeral VM (thank you to Greg from [disco.cloud](https://disco.cloud) for hosting).

- On your computer:

  ```bash
  npx @ghostty-web/demo@next
  ```

  This starts a loopback-only HTTP server with a real shell on `http://127.0.0.1:8080`. The demo protects `/ws` with a per-run same-origin token and rejects cross-origin WebSocket handshakes. Works best on Linux and macOS.

  To intentionally bind somewhere else, set `HOST=<host>`. If you serve the demo through extra hostnames or a wildcard bind such as `HOST=0.0.0.0`, also set `GHOSTTY_ALLOWED_HOSTS=host1,host2`. Avoid remote exposure unless you understand the risk: the demo starts a real local shell.

![ghostty](https://github.com/user-attachments/assets/aceee7eb-d57b-4d89-ac3d-ee1885d0187a)

## Comparison with xterm.js

xterm.js is everywhere—VS Code, Hyper, countless web terminals. But it has fundamental issues:

| Issue                                    | xterm.js                                                         | ghostty-web                |
| ---------------------------------------- | ---------------------------------------------------------------- | -------------------------- |
| **Complex scripts** (Devanagari, Arabic) | Rendering issues                                                 | ✓ Proper grapheme handling |
| **XTPUSHSGR/XTPOPSGR**                   | [Not supported](https://github.com/xtermjs/xterm.js/issues/2570) | ✓ Full support             |

xterm.js reimplements terminal emulation in JavaScript. Every escape sequence, every edge case, every Unicode quirk—all hand-coded. Ghostty's emulator is the same battle-tested code that runs the native Ghostty app.

## Installation

```bash
npm install ghostty-web
```

## Usage

ghostty-web aims to be API-compatible with the xterm.js API.

```javascript
import { init, Terminal } from 'ghostty-web';

await init();

const term = new Terminal({
  fontSize: 14,
  theme: {
    background: '#1a1b26',
    foreground: '#a9b1d6',
  },
});

term.open(document.getElementById('terminal'));
term.onData((data) => websocket.send(data));
websocket.onmessage = (e) => term.write(e.data);
```

For a comprehensive client <-> server example, refer to the [demo](./demo/index.html#L141).

## Scrollback behavior

`scrollback` is Ghostty's **approximate physical-line budget** (default 10000).
Ghostty allocates and prunes whole pages, so the history actually retained varies
with terminal width and content; it is not an exact xterm.js line cap or a minimum
retention guarantee. `scrollback: 0` disables history. Buffer APIs report the rows
actually retained. Exact xterm-style retention is deferred rather than emulated
with a hidden JavaScript clamp.

## Mouse input

The native backend uses Ghostty's mouse encoder for application tracking. Hold
Shift while starting a drag to select locally instead; without tracking, normal
history scrolling and the existing alternate-screen wheel behavior are retained.

`onData` remains a UTF-8 string channel, not a binary API. SGR, URXVT, SGR-pixels
and UTF8 mouse reports are lossless. Classic X10 reports containing invalid UTF-8
high-bit bytes are withheld rather than corrupted; full raw-byte X10 transport
remains unsupported. See the [migration notes](./docs/migration-libghostty-vt.md)
for scope and remaining limitations.

## Development

ghostty-web builds the upstream **libghostty-vt C/WASM API** without a production
patch. Exact source revisions, compiler versions, hashes and size budgets live in
[`ghostty-build.json`](./ghostty-build.json). The current target requires **Zig 0.16.0**
and Bun. Builds use isolated owned directories and never modify the submodule checkout.

```bash
bun install --frozen-lockfile
bun run build
```

The previous custom-ABI engine is retained temporarily for regression comparison and
explicit rollback, not selected silently. It requires **Zig 0.15.2** and the archived
[legacy patch](./patches/legacy/ghostty-wasm-api.patch):

```bash
# When both versions are installed, set their executable paths:
export ZIG_0_16_BIN=/path/to/zig-0.16.0/zig
export ZIG_0_15_BIN=/path/to/zig-0.15.2/zig
bun run build:wasm:all
bun run test:regression:matrix --legacy ./ghostty-vt-legacy.wasm --candidate ./ghostty-vt.wasm
```

An explicit WASM path can require its backend:

```typescript
import { Ghostty, Terminal } from 'ghostty-web';

const ghostty = await Ghostty.load('/ghostty-vt.wasm', { backend: 'libghostty-vt' });
const term = new Terminal({ ghostty });
console.log(ghostty.backend); // 'libghostty-vt'; mismatched/malformed ABIs throw
```

`Ghostty`, `GhosttyTerminal`, `KeyEncoder` and the public cell/enumeration shapes remain
compatible facades. Native layouts and enums are checked against the WASM's type manifest.
Legacy public numeric key values are translated by semantic name on the native path.
The default npm payload contains the native WASM only; hosts that need rollback can build
and serve `ghostty-vt-legacy.wasm` separately and pass `{ backend: 'legacy' }`.

See [the regression guide](./tests/README.md) for the short native/legacy CI gates and
[the migration notes](./docs/migration-libghostty-vt.md) for behavior changes and limitations.

At Coder we're big fans of Ghostty, so kudos to that team for all the amazing work.

## License

[MIT](./LICENSE)
