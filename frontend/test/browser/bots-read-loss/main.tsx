import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {createRoot} from 'react-dom/client';
import {BrowserRouter} from 'react-router-dom';
import {BotsRoster} from '../../../src/components/bots/BotsRoster';
import {ServerContext} from '../../../src/hooks/useServer';
import '../../../src/index.css';

const newClient=()=>new QueryClient({defaultOptions:{queries:{retry:false,refetchOnWindowFocus:false}}});
let client=newClient();
let revision=0;
const root=createRoot(document.getElementById('root')!);
const render=()=>root.render(<QueryClientProvider key={revision} client={client}><ServerContext value={{server:'fixture',setServer:()=>{}}}><BrowserRouter><BotsRoster renderControls={()=> <button type="button">Synthetic native action</button>} renderLogs={()=>null}/></BrowserRouter></ServerContext></QueryClientProvider>);
render();
const results:string[]=[];
const settle=async(check:()=>boolean,timeout=4000)=>{const end=Date.now()+timeout;while(Date.now()<end){if(check())return true;await new Promise(resolve=>setTimeout(resolve,25));}return false;};
const card=()=>document.querySelector('[aria-label="rsi_modular_v2 roster card"]')?.textContent??'';
const check=(value:boolean,name:string)=>results.push(`${value?'PASS':'FAIL'} ${name}`);
const mode=async(value:string,fresh=false)=>{await fetch('/__fixture/mode',{method:'POST',body:value});if(fresh){client=newClient();revision+=1;render();return;}await client.invalidateQueries({queryKey:['native-position-observation']});await client.invalidateQueries({queryKey:['native-decision-observation']});await client.invalidateQueries({queryKey:['native-execution-observation']});};
async function run(){
 await mode('healthy',true);
 check(await settle(()=>card().includes('ETH-USDC')&&card().includes('Synthetic native action')),'healthy native position and card action render');
 await mode('optional-delayed',true);
 check(await settle(()=>card().includes('ETH-USDC')&&card().includes('Synthetic native action'),1500),'fresh bootstrap renders before delayed optional requests finish');
 check(await settle(()=>card().includes('Decision read unavailable.')&&card().includes('Execution-quality read unavailable.'),5000),'failed optional reads label only their panels');
 await mode('bootstrap-503');
 check(await settle(()=>card().includes('Last known inventory')&&!card().includes('Synthetic native action')),'bootstrap 503 retains timestamped history and withholds card action');
 await mode('bootstrap-403');
 check(await settle(()=>card().includes('Current position state and card controls are unavailable.')&&!card().includes('Last known inventory')&&!card().includes('Synthetic native action')),'bootstrap denial suppresses cached values and card action');
 document.getElementById('results')!.textContent=results.join('\n');
 document.body.dataset.result=results.every(row=>row.startsWith('PASS'))?'PASS':'FAIL';
}
void run();
