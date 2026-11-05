import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import postcss from 'postcss';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Window } from 'happy-dom';
import { frontendModules } from './helpers/frontend-module.mjs';

// rsibot #648 Task 1 baseline findings 2 and 3 (root #652, docs/evidence/2026-11-03-condor-v5-ui-baseline).
const css = name => postcss.parse(fs.readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8'));
const quant = css('features/quant-ops/quant-ops.css'), strip = css('components/bots/fleet-strip.css'), app = css('index.css');
const topRules = root => root.nodes.filter(node => node.type === 'rule');
const declarations = (root, selector) => Object.fromEntries(topRules(root).filter(rule => rule.selectors.includes(selector)).flatMap(rule => rule.nodes.filter(node => node.type === 'decl').map(decl => [decl.prop, decl.value])));

// Finding 2: the quant desk (Bots `data-quant-ops="bots"`, root Capital `"capital"`) must follow the light theme with the
// existing native light palette (index.css `[data-theme="light"] .condor-native`), not a new one.
test('light theme reaches the quant scope with the existing native light tokens', () => {
  const native = declarations(app, '[data-theme="light"] .condor-native');
  const appLight = declarations(app, '[data-theme="light"]');
  const light = declarations(quant, '[data-theme="light"] [data-quant-ops]');
  const expected = {
    '--q-bg': native['--color-bg'], '--q-surface': native['--color-surface'], '--q-surface-raised': native['--color-surface-hover'],
    '--q-border': native['--color-border'], '--q-text': native['--color-text'], '--q-muted': native['--color-text-muted'],
    '--q-blue': native['--color-primary'], '--q-positive': native['--color-green'], '--q-negative': native['--color-red'],
    '--q-warning': appLight['--color-yellow'],
  };
  for (const [token, value] of Object.entries(expected)) {
    assert.ok(value, `source token for ${token} exists`);
    assert.equal(light[token], value, `${token} in light theme`);
  }
});

// A hard-coded dark colour inside the quant scope bypasses the tokens, so it needs a light-theme override that uses them.
// Theme-independent by design: the primary action fill (white text on blue) and the modal backdrop scrim.
const THEME_INDEPENDENT = new Set(['[data-quant-ops] [data-panel-id="B08"]', '[data-quant-ops] .q-drawer::backdrop']);
test('every hard-coded dark surface, border or hover colour in the quant scope has a tokenised light override', () => {
  const missing = [];
  for (const root of [quant, strip]) {
    const rules = topRules(root);
    for (const rule of rules) {
      for (const selector of rule.selectors) {
        if (!selector.startsWith('[data-quant-ops') || THEME_INDEPENDENT.has(selector)) continue;
        for (const decl of rule.nodes.filter(node => node.type === 'decl' && /^(background|background-color|border-color|border-top|border)$/.test(node.prop) && /#[0-9a-f]{3,8}\b/i.test(node.value))) {
          const override = rules.some(other => other.selectors.includes(`[data-theme="light"] ${selector}`)
            && other.nodes.some(node => node.type === 'decl' && node.prop === decl.prop && !/#[0-9a-f]{3,8}\b/i.test(node.value)));
          if (!override) missing.push(`${selector} { ${decl.prop}: ${decl.value} }`);
        }
      }
    }
  }
  assert.deepEqual(missing, []);
});

test('colour-blind theme keeps its recorded dark quant surface and blue/orange pair', () => {
  const blind = declarations(quant, '[data-theme="colorblind"] [data-quant-ops]');
  assert.equal(blind['--q-positive'], '#56b4e9');
  assert.equal(blind['--q-negative'], '#e69f00');
  assert.equal(blind['--q-bg'], undefined, 'colour-blind does not retheme the surface');
});

// Finding 3: PaperWorkspace is mounted with and without the `.v5-paper-bots` page wrapper (V5 route vs the root
// fixture, and future extracted mounts). Each of its own top-level containers must wrap long owner IDs itself.
test('every PaperWorkspace top-level container wraps long controller IDs without relying on a page wrapper', () => {
  const final3 = Object.fromEntries(['status','wallet','positions','executors','fills','risk','decisions','history','operations'].map(section => [section, JSON.parse(fs.readFileSync(new URL(`../../tests/fixtures/paper-api-final3/${section}.json`, import.meta.url)))]));
  const {load} = frontendModules(Object.fromEntries(['@/components/bots/AggregatedPnlChart','@/components/bots/ControllerBrowser','@/components/bots/DeployBotDialog','@/components/bots/PnlSparkline','@/hooks/useWebSocket','@/hooks/useRates'].map(name => [name,{}])));
  const {PaperWorkspace} = load('pages/tabs/ActiveBotsTab.tsx');
  const html = renderToStaticMarkup(React.createElement(PaperWorkspace,{reads:Object.values(final3), now:final3.status.read_at_ms, reportAt:final3.status.generated_at_ms, heartbeat:'Fresh', bot:'meridian_v5_paper'}));
  assert.match(html, /modular_spot_meridian_v5_paper_bnb/, 'fixture renders the long controller IDs');
  const window = new Window();
  window.document.body.innerHTML = html;
  const wrapping = new Set(topRules(strip).filter(rule => rule.nodes.some(node => node.type === 'decl' && node.prop === 'overflow-wrap' && node.value === 'anywhere')).flatMap(rule => rule.selectors).filter(selector => /^\.[\w-]+$/.test(selector)).map(selector => selector.slice(1)));
  const containers = [...window.document.body.children];
  assert.ok(containers.length > 0);
  const unwrapped = containers.filter(element => ![...element.classList].some(name => wrapping.has(name))).map(element => `${element.tagName.toLowerCase()}.${[...element.classList].join('.') || '(no class)'}`);
  window.close();
  assert.deepEqual(unwrapped, []);
});
