import test from 'node:test';
import assert from 'node:assert/strict';
import { researchSelectionMessage } from '../src/features/research/model.ts';

test('empty results do not announce a disabled graph query as loading', () => {
  assert.equal(researchSelectionMessage('', 'available'), 'No records match these filters. Choose another filter to explore research connections.');
  assert.equal(researchSelectionMessage('', 'loading'), 'Choose a record after the knowledge library loads to explore its connections.');
  assert.equal(researchSelectionMessage('idea:1', 'available'), null);
});
