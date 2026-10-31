import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import React from 'react';
import * as ReactQuery from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { frontendModules } from './helpers/frontend-module.mjs';

const status = JSON.parse(fs.readFileSync(new URL('../../tests/fixtures/paper-api-final3/native-replay/status.json',import.meta.url)));
for (const failed of [true,false]) test(`Paper identity labels retained source IDs with age during ${failed ? 'errors' : 'hours-old refocus'}`, () => {
  const now = status.generated_at_ms + (failed ? 5000 : 7200000);
  const {load} = frontendModules({
    react:{...React,useState:initial => [typeof initial === 'function' ? now : initial,() => {}],useRef:initial => ({current:initial}),useEffect() {}},
    '@tanstack/react-query':{...ReactQuery,useQuery:options => options.queryKey[0] === 'v5-profile' ? {data:{readiness:{paper_owner:{bot_name:status.bot_id,state:'AVAILABLE',reason:'fixture',generated_at:status.generated_at_ms/1000}}}} : {data:[status],isError:failed,isFetching:!failed,isPending:false,error:failed ? new Error('Refresh failed') : null}},
  },{'v5/V5Pages.tsx':['PaperIdentity']});
  const realNow = Date.now;
  Date.now = () => now;
  let html;
  try { html = renderToStaticMarkup(React.createElement(load('v5/V5Pages.tsx').PaperIdentity)); }
  finally { Date.now = realNow; }
  assert.match(html,/Last complete owner snapshot/);
  const ageSeconds = Math.floor((Math.floor(now / 1000) * 1000 - status.generated_at_ms) / 1000);
  assert.ok(html.includes(`${ageSeconds} s old`));
  assert.match(html,/not current/i);
  assert.ok(html.includes(status.snapshot_id));
  for (const field of ['source_sha256','config_sha256','recipe_sha256']) assert.ok(html.includes(status.source[field]),field);
});
