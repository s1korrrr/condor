import path from 'node:path';
import {fileURLToPath} from 'node:url';
import react from '@vitejs/plugin-react';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
let commandId='';
let posts=0;
let postIds=[];
let accepted=0;
let acknowledged=false;
let responseMode='duplicate';

export default {
  root,
  plugins:[react(),{name:'native-entry-reload-fixture',configureServer(server){
    server.middlewares.use((request,response,next)=>{
      if(request.url==='/fixture/reset' && request.method==='POST'){
        commandId='';
        posts=0;
        postIds=[];
        accepted=0;
        acknowledged=false;
        responseMode='duplicate';
        response.writeHead(204);
        response.end();
        return;
      }
      if(request.url==='/fixture/receipt'){
        response.writeHead(200,{'Content-Type':'application/json'});
        response.end(JSON.stringify({commandId,posts,postIds,accepted,acknowledged}));
        return;
      }
      if(request.url==='/fixture/ack' && request.method==='POST'){
        acknowledged=true;
        response.writeHead(204);
        response.end();
        return;
      }
      if(request.url==='/fixture/mode/response-lost' && request.method==='POST'){
        responseMode='response-lost';
        response.writeHead(204);
        response.end();
        return;
      }
      if(request.url==='/fixture/mode/connection-lost' && request.method==='POST'){
        responseMode='connection-lost';
        response.writeHead(204);
        response.end();
        return;
      }
      if(!request.url?.startsWith('/api/')) return next();
      response.setHeader('Content-Type','application/json');
      response.setHeader('Cache-Control','no-store');
      if(request.method==='GET' && request.url.endsWith('/native/entries/status')){
        response.writeHead(200);
        response.end(JSON.stringify({status:'success',command_allowed:true,verified_at:Date.now()/1000,
          data:{bot_name:'v2',bot_status:'running',controllers:[{controller_id:'fixture-controller',
            entry_paused:acknowledged,last_command_id:acknowledged?commandId:'',updated_at:Date.now()/1000}]}}));
        return;
      }
      if(request.method==='POST' && request.url.endsWith('/native/entries/pause')){
        let body='';
        request.on('data',chunk=>{body+=chunk;});
        request.on('end',()=>{
          const submittedId=JSON.parse(body).command_id;
          posts+=1;
          postIds.push(submittedId);
          if(submittedId===commandId){
            response.writeHead(409);
            response.end(JSON.stringify({detail:'Command already submitted; inspect native effective state before retrying'}));
            return;
          }
          commandId=submittedId;
          accepted+=1;
          if(responseMode==='connection-lost'){
            response.destroy();
            return;
          }
          if(responseMode==='response-lost'){
            response.writeHead(202,{'Content-Type':'application/json'});
            response.write('{"status":');
            response.destroy();
            return;
          }
          response.writeHead(409);
          response.end(JSON.stringify({detail:'Command already submitted; inspect native effective state before retrying'}));
        });
        return;
      }
      response.writeHead(503);
      response.end(JSON.stringify({detail:'Fixture has no other native command authority'}));
    });
  }}],
  resolve:{alias:{'@':path.join(root,'src')},dedupe:['react','react-dom','@tanstack/react-query']},
  server:{host:'127.0.0.1',port:18319,strictPort:true,proxy:{}},
};
