import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {NewConfigDialog} from '@/components/editor/EditorDialogs';
import '@/index.css';
const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
function Fixture(){
 const [open,setOpen]=useState(true);
 return <QueryClientProvider client={client}><p>ISOLATED PROFILE FORM · SYNTHETIC SAVE · NO LIVE ACCOUNT</p>
 <button onClick={()=>setOpen(true)}>New profile configuration</button>
 {!open && <p role="status">Configuration saved to isolated fixture</p>}
 {open && <NewConfigDialog server="fixture" controllerTypes={{generic:['rsi_modular']}} initialControllerName="rsi_modular" onClose={()=>setOpen(false)}/>}
 </QueryClientProvider>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
