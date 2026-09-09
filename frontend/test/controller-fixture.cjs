// Read-only fixture: real deployed TSX and handlers, isolated I/O; no browser or network.
const fs = require('node:fs');
const path = require('node:path');
const {createRequire} = require('node:module');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const ownerRequire = createRequire(root + '/package.json');
const React = ownerRequire('react');
const jsx = ownerRequire('react/jsx-runtime');
const {renderToStaticMarkup} = ownerRequire('react-dom/server');
const ts = ownerRequire('typescript');
const nativeAccess = {native:true,online:true,accounts:true,accountManagement:true,portfolioRead:true,manualTrading:false,executors:false,deployment:false,botRead:true,botStop:false,controllerMutation:false};
function textOf(value) {return typeof value==='string'||typeof value==='number'?String(value):Array.isArray(value)?value.map(textOf).join(''):React.isValidElement(value)?textOf(value.props.children):'';}
function render(file, symbol, props={}, {queries={}, search='', access=nativeAccess, apiResult={}, stateOverrides={}}={}) {
 const modules=new Map(), buttons=[], mutations=[], queriesSeen=[], apiCalls=[], stateWrites=[];
 let stateIndex=0;
 function load(filename) {
  if(modules.has(filename))return modules.get(filename).exports;
  const module={exports:{}};modules.set(filename,module);
  const source=ts.transpileModule(fs.readFileSync(filename,'utf8'),{fileName:filename,compilerOptions:{esModuleInterop:true,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText;
  const localRequire=id=>{
   if(id==='react/jsx-runtime')return {...jsx,jsx:(type,props,...rest)=>{if(type==='button')buttons.push({...props,text:textOf(props.children)});return jsx.jsx(type,props,...rest)},jsxs:(type,props,...rest)=>{if(type==='button')buttons.push({...props,text:textOf(props.children)});return jsx.jsxs(type,props,...rest)}};
   if(id==='react')return Object.keys(stateOverrides).length?{...React,useState(initial){const idx=stateIndex++;return [idx in stateOverrides?stateOverrides[idx]:typeof initial==='function'?initial():initial,value=>stateWrites.push({idx,value})];}}:React;
   if(id==='@tanstack/react-query')return {
    useQuery(options){queriesSeen.push(options);return {isLoading:false,isPending:false,isFetching:false,isError:false,refetch:async()=>{},...(queries[options.queryKey[0]]??{})};},
    useQueryClient:()=>({invalidateQueries:async()=>{},prefetchQuery:async()=>{},setQueryData:()=>{},fetchQuery:async()=>{}}),
    useMutation(options){const m={options,isPending:false,isError:false,error:null,mutate:(...args)=>{const promise=Promise.resolve().then(()=>options.mutationFn(...args));mutations.push(promise);return promise},reset:()=>{}};return m;},
   };
   if(id==='@/hooks/useServerCapabilities')return {useServerCapabilities:()=>({access,data:{status:'online',profile:'native',capabilities:{}},isLoading:false,isError:false,refetch:async()=>{}})};
   if(id==='@/hooks/useServer')return {useServer:()=>({server:'native-ok-rsi'})};
   if(id==='@/lib/auth')return {useAuth:()=>({logout:()=>{}})};
   if(id==='@/lib/api')return {api:new Proxy({}, {get:(_,name)=>(...args)=>{apiCalls.push({name,args});return Promise.resolve(apiResult)}})};
   if(id==='react-router-dom')return {Link:({children,to})=>React.createElement('a',{href:to},children),useSearchParams:()=>[new URLSearchParams(search),()=>{}],useNavigate:()=>()=>{}};
   if(id==='recharts')return new Proxy({}, {get:()=>()=>null});
   if(id.includes('CodeEditor'))return {CodeEditor:()=>null};

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
 return {html,buttons,mutations,queriesSeen,apiCalls,stateWrites};
}
module.exports={render};
