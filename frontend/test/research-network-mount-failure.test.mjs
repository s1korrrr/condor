import test from 'node:test';
import assert from 'node:assert/strict';
import { mount } from '../src/features/research/lab-network-engine.js';

function unavailableCanvas(context) {
  const resources = { observers: 0, listeners: 0, frames: 0 };
  class Element {
    children = [];
    style = {};
    constructor() { this.ownerDocument = document; }
    append(...children) { this.children.push(...children); }
    prepend(...children) { this.children.unshift(...children); }
    get firstChild() { return this.children[0]; }
    setAttribute() {}
    addEventListener() { resources.listeners++; }
    removeEventListener() { resources.listeners--; }
    getContext() { return context(); }
  }
  const document = {
    createElement: () => new Element(),
    documentElement: {},
    defaultView: {
      matchMedia: () => ({ matches: false }),
      getComputedStyle: () => ({ getPropertyValue: () => '' }),
      MutationObserver: class {
        observe() { resources.observers++; }
        disconnect() { resources.observers--; }
      },
      requestAnimationFrame() { resources.frames++; return resources.frames; },
      cancelAnimationFrame() { resources.frames--; },
    },
  };
  return { target: new Element(), resources };
}

for (const [name, context] of [
  ['returns no context', () => null],
  ['throws while acquiring a context', () => { throw new Error('Canvas is unavailable'); }],
]) {
  test(`failed network mount ${name} without retaining DOM or browser resources`, () => {
    const { target, resources } = unavailableCanvas(context);
    assert.throws(() => mount(target, { nodes: [], edges: [] }), /Canvas.*unavailable/);
    assert.equal(target.children.length, 0, 'failed mount must not leave its shell attached');
    assert.deepEqual(resources, { observers: 0, listeners: 0, frames: 0 });
  });
}
