import {createServer} from 'vite';
const server=await createServer({configFile:'/home/rsi/dev/rsibot/.workspace/scratch/condor-task2-20261105/fixture-vite.mts',configLoader:'runner'});
await server.listen();
try {await import('./capture.mjs');} catch(error) {if(error.exitCode===75){console.error(error.message);process.exitCode=75;}else throw error;} finally {await server.close();}
