import {createRequire} from 'node:module';
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';

const root = process.argv[2];
const require = createRequire(`${root}/frontend/package.json`);
const {Window} = require('happy-dom');
const browser = new Window({url:'https://fixture.invalid/settings'});
for (const name of ['window','document','navigator','HTMLElement','Element','Node','MutationObserver']) Object.defineProperty(globalThis,name,{value:name === 'window' ? browser : browser[name],configurable:true});
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = require('react');
const {createRoot} = require('react-dom/client');
const {QueryClient,QueryClientProvider} = require('@tanstack/react-query');
const {MemoryRouter} = require('react-router-dom');
const {frontendModules} = await import(pathToFileURL(`${root}/frontend/test/helpers/frontend-module.mjs`));
const fixtures = JSON.parse(fs.readFileSync(`${root}/tests/fixtures/v5_unbound_base_8284ffe7.json`));
const profile = fixtures.profile.body;
profile.readiness.paper_owner = {bot_name:'meridian_v5_paper',state:'FRESH',generated_at:1793275200,reason:'fixture',mode:'PAPER'};
const client = new QueryClient({defaultOptions:{queries:{retry:false,staleTime:Infinity,gcTime:Infinity}}});
client.setQueryData(['v5-profile'],profile);
client.setQueryData(['v5-settings'],{...fixtures.settings,identity:{name:'fixture',host:'razer',mode:'reports-only',execution_enabled:false},budget:{enabled:false}});
const reads = ['status','wallet','positions','executors','risk'].map(section => JSON.parse(fs.readFileSync(`${root}/tests/fixtures/paper-api-final3/native-replay/${section}.json`)));
client.setQueryData(['v5-paper-observation-health','meridian_v5_paper'],reads);
const {load} = frontendModules();
const {SettingsPage} = load('v5/V5Pages.tsx');
const failures = [];
class Boundary extends React.Component {
  state = {failed:false};
  static getDerivedStateFromError() {return {failed:true};}
  componentDidCatch(error, info) {failures.push(error); console.error(error.message,info.componentStack);}
  render() {return this.state.failed ? null : this.props.children;}
}
let now = reads[0].read_at_ms;
const originalNow = Date.now;
Date.now = () => ++now;
const container = document.createElement('div');
document.body.append(container);
const mount = createRoot(container);
try {
  await React.act(async () => {mount.render(React.createElement(Boundary,null,React.createElement(QueryClientProvider,{client},React.createElement(MemoryRouter,null,React.createElement(SettingsPage)))));});
  assert.deepEqual(failures,[]);
  assert.ok(container.textContent.includes('Workspace settings'),'Settings must render');
  console.log('PASS Settings rendered');
} finally {
  await React.act(async () => mount.unmount());
  client.clear();
  Date.now = originalNow;
  await browser.happyDOM.close();
}
