import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
const root='/home/rsi/dev/rsibot/.workspace/scratch/condor-task2-20261105/condor/frontend';
export default defineConfig({
 root,cacheDir:'/home/rsi/dev/rsibot/.workspace/scratch/condor-task2-20261105/tmp/vite',plugins:[react(),tailwindcss()],
 resolve:{dedupe:['react','react-dom'],alias:{'@':`${root}/src`,'@workspace-monitoring':`${root}/src/features/workspace-monitoring/unavailable.tsx`}},
 server:{host:'127.0.0.1',port:29498,strictPort:true,allowedHosts:['razer.tailb24ea3.ts.net'],hmr:{protocol:'wss',host:'razer.tailb24ea3.ts.net',clientPort:25443},fs:{allow:[root,`${root}/../tests`,'/home/rsi/dev/rsibot/condor/frontend/node_modules']}}
});
