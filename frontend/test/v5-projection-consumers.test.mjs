import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const optionIndex = new Map([['useProjectionPages', 2], ['useManifest', 0]]);

function unsafeProjectionOptions(filename, text) {
  const source = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true);
  const hooks = new Map(optionIndex);
  const namespaces = new Set();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !/(^|\/)learning-projection(?:\.[cm]?[jt]s)?$/.test(statement.moduleSpecifier.text)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
    if (bindings && ts.isNamedImports(bindings)) {
      for (const binding of bindings.elements) {
        const index = optionIndex.get((binding.propertyName ?? binding.name).text);
        if (index !== undefined) hooks.set(binding.name.text, index);
      }
    }
  }

  const violations = [];
  function visit(node) {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const index = ts.isIdentifier(callee) ? hooks.get(callee.text)
        : ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && namespaces.has(callee.expression.text)
          ? optionIndex.get(callee.name.text) : undefined;
      const options = index === undefined ? undefined : node.arguments[index];
      if (options && (!ts.isObjectLiteralExpression(options) || options.properties.some(property => {
        const name = property.name;
        return !name || ts.isComputedPropertyName(name) || name.text === 'enabled';
      }))) {
        const { line } = source.getLineAndCharacterOfPosition(options.getStart(source));
        violations.push(`${filename}:${line + 1}`);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return violations;
}

test('V5 projection consumers mount or unmount readers instead of passing enabled', () => {
  const root = fileURLToPath(new URL('../src/v5/', import.meta.url));
  const files = readdirSync(root, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() && /\.[cm]?[jt]sx?$/.test(entry.name))
    .map(entry => path.join(entry.parentPath, entry.name));
  for (const name of ['ResearchFactoryPanel.tsx', 'LearningPanel.tsx', 'DecisionLineagePanel.tsx']) {
    assert.ok(files.includes(path.join(root, name)), `Missing consumer from scan: ${name}`);
  }
  const violations = files.flatMap(file => unsafeProjectionOptions(path.relative(root, file), readFileSync(file, 'utf8')));
  assert.deepEqual(violations, [], 'Mount or unmount the projection consumer; do not pass enabled or opaque options');
});

test('projection consumer scan catches enabled, aliases and opaque options', () => {
  const source = [
    "import { useProjectionPages as usePages } from './learning-projection';",
    "import * as projection from './learning-projection';",
    "usePages('records', { record_type: 'node' }, { enabled: false });",
    "projection.useManifest({ 'enabled': false });",
    'useManifest({ ...options });',
    'useManifest({ [key]: false });',
    'useManifest({ pollMs: 30000 });',
    "useQuery({ queryKey: ['v5-auth'], enabled: false });",
  ].join('\n');
  assert.deepEqual(unsafeProjectionOptions('consumer.tsx', source), [3, 4, 5, 6].map(line => `consumer.tsx:${line}`));
});
