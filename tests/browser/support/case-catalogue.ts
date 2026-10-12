/**
 * Static (AST) catalogue of every browser case declaration, independent of
 * which suite registers it. Used by `manifest.scope-catalogue-matches`, the
 * suite contract tests and `inventory.ts`; it never executes spec code.
 *
 * Rules enforced here:
 * - cases are declared only through `rtest(id, …)` (scoped regression cases) or
 *   `controlTest(id, …)` (direct, required-only controls);
 * - ids are string literals, or a template listed in DYNAMIC_CASE_IDS;
 * - no direct `test(…)`/`base(…)` registrations and no skip/fail/fixme/only
 *   modifiers anywhere in browser specs;
 * - every spec file has exactly one gap entry that only imports it.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { DYNAMIC_CASE_IDS } from './suite';

export const BROWSER_DIR = fileURLToPath(new URL('..', import.meta.url));
export const GAP_DIR = fileURLToPath(new URL('../../gaps/browser', import.meta.url));

export interface DeclaredCase {
  id: string;
  kind: 'case' | 'control';
  /** Spec file relative to tests/browser. */
  file: string;
  /** Template the id was expanded from, for dynamic ids. */
  template?: string;
}

const MODIFIERS = new Set(['skip', 'fail', 'fixme', 'only', 'slow']);
const DIRECT = new Set(['test', 'base', 'negative', 'it']);

function walk(dir: string, suffix: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return walk(path, suffix);
      return entry.name.endsWith(suffix) ? [path] : [];
    })
    .sort();
}

export function specFiles(): string[] {
  return walk(BROWSER_DIR, '.pw.ts');
}

function calleeName(call: ts.CallExpression): { name?: string; object?: string } {
  const e = call.expression;
  if (ts.isIdentifier(e)) return { name: e.text };
  if (ts.isPropertyAccessExpression(e)) {
    const object = ts.isIdentifier(e.expression) ? e.expression.text : undefined;
    return { name: e.name.text, object };
  }
  return {};
}

export function declaredCases(): DeclaredCase[] {
  const cases: DeclaredCase[] = [];
  for (const path of specFiles()) {
    const file = relative(BROWSER_DIR, path);
    const source = ts.createSourceFile(
      file,
      readFileSync(path, 'utf8'),
      ts.ScriptTarget.Latest,
      true
    );
    const fail = (node: ts.Node, message: string): never => {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart());
      throw new Error(`${file}:${line + 1}: ${message}`);
    };
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const { name, object } = calleeName(node);
        if (object && DIRECT.has(object) && name && MODIFIERS.has(name)) {
          fail(node, `${object}.${name}() is not allowed; use scope.json, never a runtime waiver`);
        }
        const first = node.arguments[0];
        if (!object && name && DIRECT.has(name) && first && ts.isStringLiteralLike(first)) {
          fail(
            node,
            `direct ${name}('${first.text}') bypasses suite scope; use rtest or controlTest`
          );
        }
        if (!object && (name === 'rtest' || name === 'controlTest')) {
          const kind = name === 'rtest' ? 'case' : 'control';
          if (first && ts.isStringLiteralLike(first)) {
            cases.push({ id: first.text, kind, file });
          } else if (first && ts.isTemplateExpression(first)) {
            const template = first.getText(source).slice(1, -1);
            const ids = DYNAMIC_CASE_IDS[template];
            if (!ids) fail(node, `dynamic id \`${template}\` is not listed in DYNAMIC_CASE_IDS`);
            for (const id of ids) cases.push({ id, kind, file, template });
          } else {
            fail(node, `${name} needs a literal id`);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  const seen = new Set<string>();
  for (const entry of cases) {
    if (seen.has(entry.id)) throw new Error(`Duplicate browser case id: ${entry.id}`);
    seen.add(entry.id);
  }
  return cases;
}

/** Gap entries mirror the spec files one-to-one and only import their mirror. */
export function assertGapEntriesMirrorSpecs(): void {
  const specs = specFiles().map((path) => relative(BROWSER_DIR, path).replace(/\.pw\.ts$/, ''));
  const entries = walk(GAP_DIR, '.gap.ts').map((path) =>
    relative(GAP_DIR, path).replace(/\.gap\.ts$/, '')
  );
  if (JSON.stringify(entries) !== JSON.stringify(specs)) {
    throw new Error(
      `Gap entries ${JSON.stringify(entries)} must mirror browser specs ${JSON.stringify(specs)}`
    );
  }
  for (const name of entries) {
    const source = readFileSync(join(GAP_DIR, `${name}.gap.ts`), 'utf8');
    const imports = [...source.matchAll(/^import\s+'([^']+)';$/gm)].map((m) => m[1]);
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '')
      .replace(/^import\s+'[^']+';$/gm, '')
      .trim();
    if (JSON.stringify(imports) !== JSON.stringify([`../../browser/${name}.pw`]) || code) {
      throw new Error(`${name}.gap.ts must contain only: import '../../browser/${name}.pw';`);
    }
  }
}
