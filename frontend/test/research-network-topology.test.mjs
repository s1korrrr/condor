import test from 'node:test';
import assert from 'node:assert/strict';
import { mount } from '../src/features/research/lab-network-engine.js';

function dom() {
  let canvasAvailable = true;
  class Element {
    children = []; style = {}; listeners = {}; textContent = ''; value = '';
    constructor(tag) { this.tag = tag; this.ownerDocument = document; }
    append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }
    prepend(...children) { this.children.unshift(...children); }
    replaceChildren(...children) { this.children = []; this.append(...children); }
    get firstChild() { return this.children[0]; }
    setAttribute(key, value) { this[key] = value; }
    addEventListener(type, fn) { this.listeners[type] = fn; }
    removeEventListener(type) { delete this.listeners[type]; }
    getContext(type) { return type === '2d' && canvasAvailable ? {} : null; }
    getBoundingClientRect() { return { width: 800, height: 600 }; }
    focus() {}
    remove() { this.parent.children = this.parent.children.filter(child => child !== this); }
  }
  const media = { matches: true, addEventListener() {}, removeEventListener() {} };
  const document = { createElement: tag => new Element(tag), documentElement: {}, defaultView: {
    matchMedia: () => media, getComputedStyle: () => ({ getPropertyValue: () => '' }),
    MutationObserver: class { observe() {} disconnect() {} }, ResizeObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame: () => 1, cancelAnimationFrame() {},
    addEventListener() {}, removeEventListener() {},
  } };
  const target = new Element('div');
  const all = () => { const found = []; function walk(node) { found.push(node); node.children.forEach(walk); } walk(target); return found; };
  return { target, all, setCanvasAvailable(value) { canvasAvailable = value; }, text: () => all().map(node => node.textContent).join('\n') };
}
const data = {nodes:[['a','idea','Alpha'],['b','experiment','Beta'],['c','report','Hidden report']],edges:[[0,1,'uses_idea','recorded']],total_nodes:3,total_edges:3,unresolved_edges:2};

test('hidden external selection remains explicit; reveal and topology controls preserve selection and counts', () => {
  const page = dom(), selected = [], modes = [];
  const handle = mount(page.target, data, {onSelect: id => selected.push(id), onTopologyChange: mode => modes.push(mode)});
  handle.select('c');
  assert.match(page.text(), /Selected record is hidden/);
  assert.match(page.text(), /2 catalog unresolved edges/);
  page.all().find(node => node.textContent === 'Reveal in all indexed nodes').listeners.click();
  assert.deepEqual(modes, ['all']); assert.deepEqual(selected, ['c']);
  assert.match(page.text(), /0 incident relationships/);
  handle.setTopology('dependencies');
  assert.match(page.text(), /Selected record is hidden/);
  assert.equal(handle.focus('c'), true);
  assert.deepEqual(modes, ['all','dependencies','all']);
  assert.equal(handle.focus('missing'), false);
  handle.destroy(); assert.equal(page.target.children.length, 0);
});

test('hidden catalog search result reveals and selects using Canvas fallback', () => {
  const page = dom(), modes = [], selected = [];
  const handle = mount(page.target, data, {onSelect: id => selected.push(id), onTopologyChange: mode => modes.push(mode)});
  handle.setFilters({ query: 'Hidden report', kind: '' });
  const result = page.all().find(node => node.tag === 'button' && node.textContent.includes('Hidden by current topology'));
  assert.ok(result); result.listeners.click();
  assert.deepEqual(selected, ['c']); assert.deepEqual(modes, ['all']);
  assert.match(page.text(), /Canvas fallback/);
  handle.destroy();
});

test('revealing a hidden record carries its focus target across a controlled remount', () => {
  const page = dom(), transitions = [];
  let handle = mount(page.target, data, {
    onTopologyChange: (mode, focusId) => transitions.push({ mode, focusId }),
  });
  handle.select('c');
  page.all().find(node => node.textContent === 'Reveal in all indexed nodes').listeners.click();
  assert.deepEqual(transitions, [{ mode: 'all', focusId: 'c' }]);
  const next = transitions[0];
  handle.destroy();
  const cameras = [];
  handle = mount(page.target, data, {initialTopology: next.mode, initialSelected: next.focusId, onCamera: camera => cameras.push(camera)});
  assert.equal(handle.focus(next.focusId), true);
  assert.ok(cameras.at(-1).scale >= 1.5);
  assert.match(page.text(), /Hidden report/);
  handle.destroy();
});

test('manual topology changes carry no focus target while external hidden focus does', () => {
  const page = dom(), transitions = [];
  const handle = mount(page.target, data, {onTopologyChange: (mode, focusId) => transitions.push({mode, focusId})});
  handle.setTopology('linked');
  assert.equal(handle.focus('c'), true);
  assert.deepEqual(transitions, [{mode:'linked',focusId:undefined},{mode:'all',focusId:'c'}]);
  handle.destroy();
});


test('failed topology renderer keeps the previous graph usable and reports recovery', () => {
  const page = dom(), errors = [], modes = [];
  const handle = mount(page.target, data, {onError: error => errors.push(error), onTopologyChange: mode => modes.push(mode)});
  page.setCanvasAvailable(false);
  assert.doesNotThrow(() => handle.setTopology('all'));
  assert.equal(page.target.children.length, 2);
  assert.match(page.text(), /Canvas 2D renderer unavailable/);
  assert.match(page.text(), /2 catalog unresolved edges/);
  assert.deepEqual(modes, []);
  page.setCanvasAvailable(true);
  handle.setTopology('all');
  assert.deepEqual(modes, ['all']);
  assert.equal(errors.at(-1), null);
  assert.equal(page.target.children.length, 1);
  handle.destroy();
  assert.equal(page.target.children.length, 0);
});
