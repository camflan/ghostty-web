import { describe, regressionCase } from '../../regression/core/harness/scenario';
import { freshGhostty, guarded } from '../../regression/core/harness/web';

// Runs on the explicitly selected matrix artifact; ordinary native unit tests
// must not require an unrelated legacy WASM file to exist.
// Bun only registers helper-created tests from a later file inside describe().
describe('facade capabilities', () => {
  regressionCase('facade.native-capabilities-are-explicit', (checks) => {
    const ghostty = freshGhostty();
    const terminal = ghostty.createTerminal(10, 2);
    const encoder = ghostty.createKeyEncoder();
    return guarded(
      () => {
        if (ghostty.backend === 'legacy') {
          const actions = [
            () => terminal.setCellPixelSize(8, 16),
            () => terminal.getKittyKeyboardFlags(),
            () => terminal.setDefaultCursorStyle('bar', false),
            () => encoder.syncFromTerminal(terminal),
            () => terminal.setSelectionRange({ x: 0, y: 0 }, { x: 1, y: 0 }),
            () => terminal.getSelectionRange(),
            () => terminal.clearSelection(),
            () => terminal.setColors(undefined),
            () => terminal.getSelectionText(),
          ];
          const failures = actions.map((action) => {
            try {
              action();
              return 'unexpected success';
            } catch (error) {
              return error instanceof Error &&
                error.message.includes(
                  "requires the libghostty-vt backend (this instance is 'legacy')"
                )
                ? 'unsupported'
                : String(error);
            }
          });
          checks.equal(
            'legacy-native-methods-reject',
            failures,
            actions.map(() => 'unsupported')
          );
          checks.equal('legacy-cell-shape', 'fg_default' in terminal.getLine(0)![0], false);
        } else {
          terminal.setCellPixelSize(8, 16);
          terminal.setDefaultCursorStyle('bar', false);
          encoder.syncFromTerminal(terminal);
          checks.equal(
            'native-capabilities',
            [terminal.getKittyKeyboardFlags(), terminal.getCursor().style],
            [0, 'bar']
          );
        }
      },
      () => {
        encoder.dispose();
        terminal.free();
      }
    );
  });
});
