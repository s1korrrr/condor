import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { frontendModules } from './helpers/frontend-module.mjs';

test('advisor dollars and qualified features retain exact titles', () => {
  const { money, FeatureGroup } = frontendModules({}, { 'v5/V5Pages.tsx': ['money', 'FeatureGroup'] }).load('v5/V5Pages.tsx');
  assert.equal(renderToStaticMarkup(money('0.001000')), '<span title="0.001000">$0.00</span>');
  const features = [{ id: 'spot.test', label: 'test', status: 'QUALIFIED', unit: 'percent', value: '-0.004' }];
  const html = renderToStaticMarkup(React.createElement(FeatureGroup, { label: 'Spot', prefix: 'spot.', features, evidence: null }));
  assert.match(html, /title="-0\.004" class="is-qualified">0\.00%<\/strong>/);
});
