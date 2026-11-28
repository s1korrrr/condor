import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import * as ReactQuery from '@tanstack/react-query';
import * as Router from 'react-router-dom';
import { Window } from 'happy-dom';
import { frontendModules } from './helpers/frontend-module.mjs';

const browser = new Window({ url: 'https://fixture.invalid/' });
for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node']) {
  Object.defineProperty(globalThis, name, { value: name === 'window' ? browser : browser[name], configurable: true });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import('react-dom/client');
after(() => browser.happyDOM.close());

const { SessionDetailPage } = frontendModules({
  '@tanstack/react-query': ReactQuery, 'react-router-dom': Router,
}).load('v5/V5Pages.tsx');
const sessionId = 'loop-session';
const sessionPath = `/api/v5/sessions/${sessionId}`;
const queryKey = ['v5-session', sessionId];
const running = { id: sessionId, loop_id: 'report-loop', status: 'RUNNING', journal: 'Before stop' };
const stopped = { ...running, status: 'STOPPED', journal: 'Confirmed stop' };

for (const [label, response] of [
  ['404 session_not_found', () => Response.json({ detail: { code: 'session_not_found' } }, { status: 404 })],
  ['200 RUNNING', () => Response.json(running)],
]) {
  test(`SessionDetailPage ignores pre-stop ${label} and accepts a post-stop read`, async (context) => {
    let resolvePoll;
    const pendingPoll = new Promise(resolve => { resolvePoll = resolve; });
    let detailReads = 0;
    let stops = 0;
    context.mock.method(globalThis, 'fetch', async (url, options) => {
      if (url === `${sessionPath}/stop`) {
        assert.equal(options.method, 'POST');
        stops += 1;
        return Response.json(stopped);
      }
      assert.equal(url, sessionPath);
      detailReads += 1;
      if (detailReads === 1) return Response.json(running);
      if (detailReads === 2) return pendingPoll;
      assert.equal(stops, 1);
      return Response.json({ ...stopped, journal: 'Fresh read after stop' });
    });
    const client = new ReactQuery.QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
    const container = document.body.appendChild(document.createElement('div'));
    const root = createRoot(container);
    const element = React.createElement;
    const flush = () => new Promise(resolve => setTimeout(resolve, 0));
    const status = () => container.querySelector('.v5-page-heading .v5-status')?.textContent;
    const journal = () => container.querySelector('.v5-journal')?.textContent;
    try {
      await React.act(async () => {
        root.render(element(ReactQuery.QueryClientProvider, { client }, element(Router.MemoryRouter, { initialEntries: [`/sessions/${sessionId}`] },
          element(Router.Routes, null, element(Router.Route, { path: '/sessions/:id', element: element(SessionDetailPage) })),
        )));
      });
      await React.act(flush);
      assert.equal(status(), 'RUNNING');

      let poll;
      await React.act(async () => {
        poll = client.refetchQueries({ queryKey });
        await flush();
      });
      assert.equal(detailReads, 2, 'detail GET must be pending before stop');
      await React.act(async () => {
        container.querySelector('.v5-session-stop button').click();
        await flush();
      });
      assert.equal(stops, 1);
      assert.equal(status(), 'STOPPED');
      assert.equal(journal(), 'Confirmed stop');

      await React.act(async () => {
        resolvePoll(response());
        await poll;
        await flush();
      });
      assert.equal(status(), 'STOPPED');
      assert.equal(journal(), 'Confirmed stop');
      assert.doesNotMatch(container.textContent, /Data is unavailable/);

      await React.act(async () => {
        await client.refetchQueries({ queryKey });
        await flush();
      });
      assert.equal(detailReads, 3);
      assert.equal(status(), 'STOPPED');
      assert.equal(journal(), 'Fresh read after stop');
    } finally {
      resolvePoll(Response.json(running));
      await React.act(async () => root.unmount());
      client.clear();
      container.remove();
    }
  });
}
