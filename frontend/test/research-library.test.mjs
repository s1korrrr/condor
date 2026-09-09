import test from 'node:test';
import assert from 'node:assert/strict';
import { researchPage, clearResearchSelection, researchPreview } from '../src/features/research/library.ts';

test('pagination reaches records past ten thousand and stops at actual total', () => {
  assert.equal(researchPage(9980, 30017).nextOffset, 10000);
  assert.equal(researchPage(10000, 30017).nextOffset, 10020);
  assert.deepEqual(researchPage(30000, 30017), {first:30001,last:30017,nextOffset:null,boundaryReached:false});
  assert.equal(researchPage(1000000, 1000040).boundaryReached, true);
  assert.equal(researchPage(1000000, 1000040).nextOffset, null);
  assert.equal(researchPage(0, 0).first, 0);
});
test('changing filters clears explicit selection but preserves search and unrelated parameters', () => {
  const original = new URLSearchParams('q=RSI&id=spot-record&other=kept');
  assert.equal(clearResearchSelection(original).toString(), 'q=RSI&other=kept');
  assert.equal(original.get('id'), 'spot-record');
});
test('native preview explicitly describes truncated long payload without changing source data', () => {
  const data={hypothesis:'x'.repeat(25000)};
  const preview=researchPreview(data);
  assert.equal(preview.text.length,20000);
  assert.equal(preview.truncated,true);
  assert.equal(preview.totalCharacters,JSON.stringify(data,null,2).length);
  assert.equal(data.hypothesis.length,25000);
  assert.equal(researchPreview({value:3}).truncated,false);
});
