import path from 'node:path';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
const schemas=JSON.parse(fs.readFileSync(process.env.RSI_MODULAR_SCHEMA_FIXTURE,'utf8'));
const requests=[];
export default defineConfig({root,plugins:[react(),tailwindcss(),{name:'isolated-profile-fixture',configureServer(server){server.middlewares.use(async(req,res,next)=>{
 const url=new URL(req.url,'http://127.0.0.1');
 const json=(value,status=200)=>{res.statusCode=status;res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));};
 if(url.pathname==='/__fixture/requests')return json(requests);
 if(url.pathname.endsWith('/rsi_modular/template')){const profile=url.searchParams.get('profile');requests.push({kind:'template',profile});return json(schemas[profile]??{detail:'Explicit profile required'},schemas[profile]?200:400);}
 if(url.pathname.endsWith('/controllers/configs')&&req.method==='POST'){let body='';for await(const chunk of req)body+=chunk;const config=JSON.parse(body);requests.push({kind:'save',config});return json({created:true,config_id:config.id});}
 if(url.pathname.startsWith('/api/'))return json({detail:'Unconfigured isolated fixture'},404);
 next();
});}}],resolve:{alias:{'@':path.join(root,'src')},dedupe:['react','react-dom','@tanstack/react-query']},server:{host:'127.0.0.1',port:18213,strictPort:true}});
