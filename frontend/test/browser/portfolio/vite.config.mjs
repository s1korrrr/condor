import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import {fixturePayload} from './fixture.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
let mode='complete';
export default defineConfig({root,plugins:[react(),tailwindcss(),{name:'portfolio-local-fixture',configureServer(server){server.middlewares.use(async(req,res,next)=>{
 const url=new URL(req.url,'http://localhost');
 const json=(payload,status=200)=>{res.statusCode=status;res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');res.end(JSON.stringify(payload));};
 if(url.pathname==='/__fixture/mode'){let body='';for await(const chunk of req)body+=chunk;mode=body;return json({mode});}
 if(url.pathname==='/api/v1/servers')return json(['fixture','fixture-other'].map(name=>({name,host:'fixture',port:0,online:true,permission:'read'})));
 if(url.pathname.endsWith('/status'))return json({status:'online',profile:'native',capabilities:{accounts:true,account_management:false,portfolio_read:true,native_status:true}});
 if(url.pathname==='/api/v1/settings/credentials')return json({credentials:[{account_name:'master_account',connector_name:'okx'}]});
 if(url.pathname.endsWith('/bots'))return json({bots:[],controllers:[]});
 if(url.pathname.endsWith('/portfolio/analytics'))return mode==='error'?json({detail:'Fixture request failure'},502):json(fixturePayload(mode,url.pathname.split('/')[4],url.searchParams.get('range')??'1W'));
 if(url.pathname.startsWith('/api/'))return json({detail:'Unconfigured fixture endpoint'},404);
 if(url.pathname==='/portfolio'||url.pathname==='/settings'||url.pathname==='/trading-visuals')req.url='/test/browser/portfolio/index.html';
 next();
});}}],resolve:{alias:{'@':path.join(root,'src'),'@workspace-monitoring':path.join(root,'src/features/workspace-monitoring/unavailable.tsx')},dedupe:['react','react-dom','react-router-dom','@tanstack/react-query']},server:{host:'127.0.0.1',port:18190,strictPort:true}});
