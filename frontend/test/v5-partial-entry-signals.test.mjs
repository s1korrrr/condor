import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {frontendModules} from './helpers/frontend-module.mjs';

for (const signal of ['emergency','paused','entry_hold','native_hold']) test(`first-load partial risk publishes received ${signal} before totals`, () => {
  const risk = JSON.parse(fs.readFileSync(new URL('../../tests/fixtures/paper-api-final3/native-replay/risk.json',import.meta.url)));
  risk.data.control_hold = null;
  risk.data.native_entry_holds = [];
  for (const [id,controller] of Object.entries(risk.data.controllers)) {
    controller.operator.emergency = signal === 'emergency';
    controller.operator.paused = signal === 'paused';
    controller.native.entry_hold = signal === 'entry_hold';
    if (signal === 'native_hold') risk.data.native_entry_holds.push({controller_id:id,reason:'v5_risk_incomplete',explanation:'Received native refusal',protected_exits:'preserved'});
  }
  const stubs = Object.fromEntries(['@/components/bots/AggregatedPnlChart','@/components/bots/ControllerBrowser','@/components/bots/DeployBotDialog','@/components/bots/PnlSparkline','@/hooks/useWebSocket','@/hooks/useRates'].map(name => [name,{}]));
  const {load} = frontendModules(stubs);
  const {PaperWorkspace} = load('pages/tabs/ActiveBotsTab.tsx');
  const html = renderToStaticMarkup(React.createElement(PaperWorkspace,{reads:[risk],complete:false,now:risk.generated_at_ms,reportAt:null,heartbeat:'Fresh',bot:risk.bot_id}));
  assert.match(html,/New acquisitions held/);
  assert.match(html,/Checking owner snapshot/);
  if (signal === 'emergency') assert.match(html,/Reported emergency halt: Yes/);
  if (signal === 'paused') assert.match(html,/Reported operator pause: Yes/);
  if (signal === 'entry_hold') assert.match(html,/Reported native entry hold: Yes/);
  if (signal === 'native_hold') assert.match(html,/Received native refusal/);
  assert.doesNotMatch(html,/Fresh complete owner wallet/);
});
