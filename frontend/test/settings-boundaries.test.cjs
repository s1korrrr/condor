// Read-only fixture: real deployed TSX and handlers, isolated I/O; no browser or network.
const fs = require('node:fs');
const path = require('node:path');
const {createRequire} = require('node:module');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const test = require('node:test');
const ownerRequire = createRequire(root + '/package.json');
const React = ownerRequire('react');
const jsx = ownerRequire('react/jsx-runtime');
const {renderToStaticMarkup} = ownerRequire('react-dom/server');
const ts = ownerRequire('typescript');
const nativeAccess = {native:true,online:true,accounts:true,accountManagement:true,portfolioRead:true,manualTrading:false,executors:false,deployment:false,botRead:true,botStop:false,controllerMutation:false};
function textOf(value) {return typeof value==='string'||typeof value==='number'?String(value):Array.isArray(value)?value.map(textOf).join(''):React.isValidElement(value)?textOf(value.props.children):'';}
function render(file, symbol, props={}, {queries={}, search='', access=nativeAccess, apiResult={}, stateOverrides={}, allowed=false}={}) {
 const modules=new Map(), buttons=[], mutations=[], mutationFns=[], queriesSeen=[], apiCalls=[], stateWrites=[];
 let stateIndex=0;
 function load(filename) {
  if(modules.has(filename))return modules.get(filename).exports;
  const module={exports:{}};modules.set(filename,module);
  const source=ts.transpileModule(fs.readFileSync(filename,'utf8'),{fileName:filename,compilerOptions:{esModuleInterop:true,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText;
  const localRequire=id=>{
   if(id==='react/jsx-runtime')return {...jsx,jsx:(type,props,...rest)=>{if(type==='button')buttons.push({...props,text:textOf(props.children)});return jsx.jsx(type,props,...rest)},jsxs:(type,props,...rest)=>{if(type==='button')buttons.push({...props,text:textOf(props.children)});return jsx.jsxs(type,props,...rest)}};
   if(id==='react')return Object.keys(stateOverrides).length?{...React,useState(initial){const idx=stateIndex++;return [idx in stateOverrides?stateOverrides[idx]:typeof initial==='function'?initial():initial,value=>stateWrites.push({idx,value})];}}:React;
   if(id==='@tanstack/react-query')return {
    useQuery(options){queriesSeen.push(options.queryKey);return {isLoading:false,isPending:false,isFetching:false,isError:false,refetch:async()=>{},...(queries[options.queryKey[0]]??{})};},
    useQueryClient:()=>({invalidateQueries:async()=>{},prefetchQuery:async()=>{},setQueryData:()=>{},fetchQuery:async()=>{}}),
    useMutation(options){mutationFns.push(options.mutationFn);const m={options,isPending:false,isError:false,error:null,mutate:(...args)=>{const promise=Promise.resolve().then(()=>options.mutationFn(...args));mutations.push(promise);return promise},reset:()=>{}};return m;},
   };
   if(id==='@/hooks/useDeploymentPolicy')return {useDeploymentPolicy:()=>({settingsMutation:allowed, accountManagement:true, isLoading:false,isError:false, refetch:async()=>{}})};
   if(id==='@/hooks/useServerCapabilities')return {useServerCapabilities:()=>({access,data:{status:'online',profile:'native',capabilities:{}},isLoading:false,isError:false,refetch:async()=>{}})};
   if(id==='@/hooks/useServer')return {useServer:()=>({server:'native-ok-rsi'})};
   if(id==='@/lib/auth')return {useAuth:()=>({logout:()=>{}})};
   if(id==='@/lib/api')return {api:new Proxy({}, {get:(_,name)=>(...args)=>{apiCalls.push({name,args});return Promise.resolve(apiResult)}})};
   if(id==='react-router-dom')return {Link:({children,to})=>React.createElement('a',{href:to},children),useSearchParams:()=>[new URLSearchParams(search),()=>{}],useNavigate:()=>()=>{}};
   if(id==='recharts')return new Proxy({}, {get:()=>()=>null});
   if(id.includes('CodeEditor'))return {CodeEditor:()=>null};
   if(id.includes('ControllerPnlChart'))return {ControllerPnlChart:()=>null};
   if(id.includes('ConnectHyperliquid'))return {ConnectHyperliquid:()=>null};
   if(id.endsWith('.css'))return {};
   if(id.startsWith('@/')||id.startsWith('.')){
    const base=id.startsWith('@/')?path.join(root,'src',id.slice(2)):path.resolve(path.dirname(filename),id);
    const target=[base,base+'.ts',base+'.tsx'].find(p=>fs.existsSync(p)&&fs.statSync(p).isFile());
    if(!target)throw new Error('No module '+id+' from '+filename);return load(target);
   }
   return ownerRequire(id);
  };
  new Function('require','module','exports',source)(localRequire,module,module.exports);
  return module.exports;
 }
 const View=load(path.join(root,'src',file))[symbol];
 const html=renderToStaticMarkup(React.createElement(View,props));
 return {html,buttons,mutations,mutationFns,queriesSeen,apiCalls,stateWrites};
}

const failed = {isError:true,error:new Error('Fixture upstream failure'),data:undefined};
for(const [symbol,key,falseText] of [
 ['ServersSettings','settings-servers','0 servers'],
 ['CustomProvidersSettings','custom-providers','No endpoints yet'],
 ['VoiceSettings','voice-settings','Save Voice Settings'],
 ['GatewaySettings','gateway-status','Gateway Stopped'],
]) test(`${symbol}: failed read remains unknown with retry`,()=>{
 const r=render(`components/settings/${symbol}.tsx`,symbol,{}, {queries:{[key]:failed}});
 assert.ok(!r.html.includes(falseText)); assert.match(r.html,/unavailable/i);assert.ok(r.buttons.some(b=>b.text.includes('Retry')));
});
test('gateway failed logs are unavailable, not empty',()=>{
 const r=render('components/settings/GatewaySettings.tsx','GatewaySettings',{}, {queries:{'gateway-status':{data:{running:false}},'gateway-logs':failed},stateOverrides:{0:true}});
 assert.ok(!r.html.includes('No logs available'));assert.match(r.html,/logs.*unavailable/i);
});
test('unknown settings tab resolves to Servers',()=>{
 const r=render('pages/Settings.tsx','Settings',{}, {search:'tab=invalid',queries:{'settings-servers':{data:[]}}});
 assert.ok(r.queriesSeen.some(k=>k[0]==='settings-servers'));
});
const cases=[
 ['ServersSettings',{'settings-servers':{data:[{name:'local',host:'localhost',port:8000,permission:'owner'}]}},{},'Set as default'],
 ['VoiceSettings',{'voice-settings':{data:{voice:{whisper_model:'base',language:null,auto_send:true},available_models:{base:'Base'},available_languages:{en:'English'}}}},{},'Save Voice Settings'],
 ['GatewaySettings',{'gateway-status':{data:{running:true}}},{},'Restart'],
 ['GatewaySettings',{'gateway-status':{data:{running:false}}},{2:true},'Pull'],
 ['CustomProvidersSettings',{'custom-providers':{data:{providers:[{name:'fixture',base_url:'http://localhost'}]}}},{1:'fixture'},'Forget'],
];
for(const [symbol,queries,stateOverrides,label] of cases) test(`${symbol}: denied ${label} is disabled and handler cannot send`,async()=>{
 const r=render(`components/settings/${symbol}.tsx`,symbol,{}, {queries,stateOverrides});
 const button=r.buttons.find(b=>(b.title||b.text).trim()===label);assert.ok(button,`missing ${label}`);assert.equal(button.disabled,true);
 button.onClick();await Promise.allSettled(r.mutations);assert.deepEqual(r.apiCalls,[]);
});
test('full deployment retains enabled setting write',async()=>{
 const r=render('components/settings/ServersSettings.tsx','ServersSettings',{}, {allowed:true,queries:{'settings-servers':{data:[{name:'local',host:'localhost',port:8000,permission:'owner'}]}}});
 const button=r.buttons.find(b=>b.title==='Set as default');assert.ok(!button.disabled);button.onClick();await Promise.all(r.mutations);assert.equal(r.apiCalls[0].name,'setDefaultServer');
});

for (const [symbol,queries,stateOverrides,count] of [
 ['ServersSettings',{'settings-servers':{data:[]}},{},4],
 ['GatewaySettings',{'gateway-status':{data:{running:false}}},{},4],
 ['CustomProvidersSettings',{'custom-providers':{data:{providers:[]}}},{0:true},2],
 ['VoiceSettings',{'voice-settings':{data:{voice:{whisper_model:'base',language:null,auto_send:true},available_models:{},available_languages:{}}}},{},1],
]) test(`${symbol}: every mutation function rejects denied policy before I/O`,async()=>{
 const r=render(`components/settings/${symbol}.tsx`,symbol,{}, {queries,stateOverrides});
 assert.equal(r.mutationFns.length,count);
 for(const fn of r.mutationFns) await assert.rejects(Promise.resolve().then(()=>fn({name:'local'})),/unavailable/);
 assert.deepEqual(r.apiCalls,[]);
});
