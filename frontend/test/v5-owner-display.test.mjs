import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { frontendModules } from './helpers/frontend-module.mjs';

test('owner values render rounded text, exact title and rounded tone', () => {
  const { OwnerValue } = frontendModules().load('v5/OwnerValue.tsx');
  assert.equal(renderToStaticMarkup(React.createElement(OwnerValue, {value:'-0.004', kind:'usdc'})), '<span class="owner-value" title="-0.004" data-tone="zero">0.00 USDC</span>');
  assert.equal(renderToStaticMarkup(React.createElement(OwnerValue, {value:'1.25', kind:'signed', exact:'1 + 0.25 = 1.25'})), '<span class="owner-value" title="1 + 0.25 = 1.25" data-tone="up">+1.25</span>');
  assert.equal(renderToStaticMarkup(React.createElement(OwnerValue, {value:null, kind:'signed', exact:'earlier value'})), '<span class="owner-value" data-tone="none">—</span>');
});
