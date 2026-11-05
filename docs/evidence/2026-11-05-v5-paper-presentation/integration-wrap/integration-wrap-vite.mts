import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
const scratch='/home/rsi/dev/rsibot/.workspace/scratch/condor-task2-20261105';
const root=`${scratch}/integration/frontend`;
export default defineConfig({root,cacheDir:`${scratch}/tmp/vite-integration-wrap`,plugins:[react(),tailwindcss()],
 resolve:{dedupe:['react','react-dom'],alias:{'@':`${root}/src`,'@workspace-monitoring':`${root}/src/features/workspace-monitoring/unavailable.tsx`}},
 server:{host:'127.0.0.1',port:29498,strictPort:true,fs:{allow:[root,`${root}/../tests`,'/home/rsi/dev/rsibot/.worktrees/condor-candle-store-warm-summary/frontend/node_modules']}}
});
