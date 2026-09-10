import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {BrowserRouter,Routes,Route,Link} from 'react-router-dom';
import {AccountPortfolio} from '@/components/AccountPortfolio';
import {AppShell} from '@/components/layout/AppShell';
import {ServerContext} from '@/hooks/useServer';
import {AuthContext} from '@/lib/auth';
import '@/index.css';
const client=new QueryClient({defaultOptions:{queries:{retry:false,staleTime:0}}});
function Fixture(){
 const [server,setServer]=useState('fixture');const [mode,setMode]=useState('complete');
 return <QueryClientProvider client={client}><AuthContext value={{user:{id:1,username:'fixture',first_name:'Fixture',role:'admin'},token:null,recoveryReason:null,isAuthenticated:true,loginWithToken:async()=>false,loginWithTailscale:async()=>false,logout:()=>{}}}><ServerContext value={{server,setServer}}><BrowserRouter>
 <div style={{fontSize:11,padding:'6px 16px',background:'#312714',color:'#f4d28b',display:'flex',gap:16,alignItems:'center'}}><strong>LOCAL VERIFICATION FIXTURES · NOT LIVE ACCOUNT DATA</strong><label>Scenario <select aria-label="Fixture scenario" value={mode} onChange={async e=>{const next=e.target.value;setMode(next);await fetch('/__fixture/mode',{method:'POST',body:next});await client.invalidateQueries({queryKey:['portfolio-analytics']});}} style={{background:'#111827',color:'#fff'}}>{['complete','partial','gap','no-history','empty','stale','error','disconnected'].map(m=><option key={m}>{m}</option>)}</select></label></div>
 <Routes><Route element={<AppShell/>}><Route path="*" element={<AccountPortfolio/>}/><Route path="/settings" element={<p>Local fixture: <Link to="/portfolio">Return to Portfolio</Link></p>}/><Route path="/trading-visuals" element={<p>Local fixture execution destination: <Link to="/portfolio">Return to Portfolio</Link></p>}/></Route></Routes>
 </BrowserRouter></ServerContext></AuthContext></QueryClientProvider>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
