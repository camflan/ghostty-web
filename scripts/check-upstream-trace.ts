/** Validate source-to-source provenance at the build's pinned source, not a moving branch. */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import build from '../ghostty-build.json';
import trace from './upstream-trace.json';

const root = resolve(import.meta.dir, '..');
const target = build.targets['libghostty-vt'];
if (trace.pin !== target.ghosttyCommit)
  throw new Error('Native pin changed: review and update every upstream trace mapping');
const built = resolve(
  process.env.GHOSTTY_WASM_WORK_DIR ?? resolve(root, '.regression-reference/wasm-build'),
  'sources',
  trace.pin
);
const source =
  process.env.GHOSTTY_TRACE_SOURCE ?? (existsSync(built) ? built : resolve(root, 'ghostty'));
const head = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (head !== trace.pin)
  throw new Error(
    `Trace source ${head} is not pinned ${trace.pin}; build native WASM first or set GHOSTTY_TRACE_SOURCE`
  );
for (const mapping of trace.mappings) {
  const upstream = readFileSync(resolve(source, mapping.upstream), 'utf8');
  const local = readFileSync(resolve(root, mapping.target), 'utf8');
  if (!upstream.includes(mapping.symbol))
    throw new Error(`Missing upstream symbol ${mapping.upstream}: ${mapping.symbol}`);
  if (!local.includes(mapping.targetSymbol))
    throw new Error(`Missing host counterpart ${mapping.target}: ${mapping.targetSymbol}`);
}
console.log(
  `Verified ${trace.mappings.length} upstream mappings at ${trace.pin}. This checks provenance, not semantic equivalence.`
);
