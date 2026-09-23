import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
const revision='fixture-revision';
const network={
 revision,node_fields:['id','kind','title','family','lane'],
 nodes:[['idea:one','idea','Fixture idea','rsi','SPOT'],['run:one','run','Fixture run','rsi','SPOT'],['report:hidden','report','Hidden report','rsi','SPOT']],
 edge_fields:['source','target','relation','basis'],edges:[[0,1,'tested','EXPLICIT']],
 total_nodes:3,total_edges:2,unresolved_edges:1,
 stats:{kinds:[{key:'idea',count:1},{key:'run',count:1},{key:'report',count:1}],families:[{key:'rsi',count:3}],lanes:[{key:'SPOT',count:3}],relations:[{key:'tested',count:1},{key:'unresolved',count:1}]},
};
let requests=[];
export default defineConfig({root,plugins:[react(),tailwindcss(),{name:'research-local-fixture',configureServer(server){server.middlewares.use((req,res,next)=>{
 const url=new URL(req.url,'http://localhost');
 const json=(payload,status=200)=>{res.statusCode=status;res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');res.end(JSON.stringify(payload));};
 if(url.pathname==='/__fixture/requests')return json(requests);
 if(url.pathname.startsWith('/api/v1/research/')){
   const endpoint=url.pathname.split('/').at(-1);
   requests.push({endpoint,server:url.searchParams.get('server'),authorized:req.headers.authorization==='Bearer fixture-token'});
   if(req.headers.authorization!=='Bearer fixture-token')return json({detail:'Unauthorized'},401);
   if(url.searchParams.get('server')!=='fixture')return json({detail:'Unknown server'},404);
   const id=url.searchParams.get('id');
   const selected=network.nodes.find(node=>node[0]===id);
   if(endpoint==='node'&&!selected)return json({detail:'Unknown fixture node'},404);
   const data=endpoint==='overview'?{revision,counts:{ideas:1},facets:{},freshness:{state:'CURRENT',pending_events:0},limitations:[]}:endpoint==='network'?network:{revision,node:{id:selected?.[0],kind:selected?.[1],title:selected?.[2],family:selected?.[3],lane:selected?.[4],data:{}},relations_page:{items:[],total:0,limit:25,offset:0},edges:[],related:[],usage:{}};
   if(!['overview','network','node'].includes(endpoint))return json({detail:'Unconfigured fixture endpoint'},404);
   return json({data,source:{owner:'research_os',server:'fixture',fetched_at:new Date().toISOString(),read_only:true}});
 }
 if(url.pathname==='/research')req.url='/test/browser/research/index.html';
 next();
 });}}],resolve:{alias:{'@':path.join(root,'src'),'@workspace-monitoring':path.join(root,'src/features/workspace-monitoring/unavailable.tsx')},dedupe:['react','react-dom','react-router-dom','@tanstack/react-query']},server:{host:'127.0.0.1',port:18191,strictPort:true}});
