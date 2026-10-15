import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const BANNED = new Set(['skip', 'todo', 'fixme', 'failing', 'fail', 'only']);
const TEST_ROOTS = new Set(['test', 'describe', 'it', 'rtest', 'base', 'lane']);

function rootName(expression: ts.Expression): string | undefined {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return rootName(expression.expression);
  return undefined;
}

function forbiddenCalls(text: string, file = 'probe.ts'): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const callee = node.expression;
      if (BANNED.has(callee.name.text) && TEST_ROOTS.has(rootName(callee) ?? '')) {
        found.push(callee.getText(source));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function sourceFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((item) => {
    const path = join(directory, item.name);
    if (item.isDirectory()) return sourceFiles(path);
    return /\.[cm]?ts$/.test(item.name) ? [path] : [];
  });
}

describe('required suite has no failure exemptions', () => {
  test('the policy detects skip, xfail, focused, and fixme declarations', () => {
    for (const name of BANNED) {
      expect(forbiddenCalls(`test.${name}('case', () => {});`)).toEqual([`test.${name}`]);
    }
    expect(
      forbiddenCalls("describe.skip('group', () => {}); test.describe.only('group', () => {});")
    ).toEqual(['describe.skip', 'test.describe.only']);
  });

  test('ordinary assertions and diagnostic strings are not mistaken for exemptions', () => {
    expect(
      forbiddenCalls(
        "test('strict', () => expect(() => broken()).toThrow()); const example = \"test.skip('bad')\";"
      )
    ).toEqual([]);
  });

  test('required tests and shared scenarios contain no test-level escape hatches', () => {
    const tests = fileURLToPath(new URL('../../', import.meta.url));
    const files = ['regression', 'browser', 'scenarios', 'gaps'].flatMap((dir) =>
      sourceFiles(join(tests, dir))
    );
    const violations = files.flatMap((file) =>
      forbiddenCalls(readFileSync(file, 'utf8'), file).map((call) => `${file}: ${call}`)
    );
    expect(files.length).toBeGreaterThan(10);
    expect(violations).toEqual([]);
  });
});
