import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
let mode='healthy';
export default defineConfig({root,plugins:[react(),{name:'isolated-bot-read-fixture',configureServer(server){server.middlewares.use(async(req,res,next)=>{
 const url=new URL(req.url,'http://localhost');
 const json=(body,status=200)=>{res.statusCode=status;res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');res.end(JSON.stringify(body));};
 if(url.pathname==='/__fixture/mode'){let body='';for await(const chunk of req)body+=chunk;mode=body;return json({mode});}
 if(url.pathname==='/api/v1/servers')return json([{name:'fixture',host:'127.0.0.1',port:18296,online:true,permission:'read'}]);
 if(url.pathname==='/api/v1/trading-visuals/sources')return json({sources:[{server:'fixture',bot:'rsi_modular_v2'}]});
 if(url.pathname==='/api/v1/trading-visuals/bootstrap'){
  if(mode==='bootstrap-503')return json({detail:'synthetic transport outage'},503);
  if(mode==='bootstrap-403')return json({detail:'synthetic denial'},403);
  return json({runtime_status:{bot_name:'rsi_modular_v2',updated_at:new Date().toISOString(),controllers:[{controller_id:'eth',pair:'ETH-USDC',price_quote:2500,state:'HOLDING',custom_info:{episode:{enabled:true,base:'0.04',cost:'99',cost_known:true}}}],positions_held:[],active_executors:[],active_orders:[],active_orders_status:{complete:true}},monitoring:{bot_name:'rsi_modular_v2',stale_threshold_seconds:30}});
 }
 if(url.pathname==='/api/v1/trading-visuals/quant-events'||url.pathname==='/api/v1/trading-visuals/quant-execution'){
  if(mode==='optional-delayed'){await new Promise(resolve=>setTimeout(resolve,2500));return json({detail:'synthetic optional outage'},503);}
  return url.pathname.endsWith('quant-events')?json({data:{decisions:[]}}):json({histogram:{bins:[],sample_count:0,excluded_count:0}});
 }
 if(url.pathname.startsWith('/api/'))return json({detail:'No native API or command authority in this fixture'},404);
 if(url.pathname==='/bots')req.url='/test/browser/bots-read-loss/index.html';
 next();
});}}],resolve:{alias:{'@':path.join(root,'src'),'@workspace-monitoring':path.join(root,'src/features/workspace-monitoring/unavailable.tsx')},dedupe:['react','react-dom','react-router-dom','@tanstack/react-query']},server:{host:'127.0.0.1',port:18296,strictPort:true}});
