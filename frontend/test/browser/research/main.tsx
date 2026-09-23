import {createRoot} from 'react-dom/client';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {BrowserRouter,Routes,Route} from 'react-router-dom';
import {ServerContext} from '@/hooks/useServer';
import {Research} from '@/pages/Research';
import '@/index.css';

const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={client}>
    <ServerContext value={{server:'fixture',setServer:()=>{}}}>
      <BrowserRouter>
        <p style={{padding:'6px 16px',background:'#312714',color:'#f4d28b'}}>LOCAL RESEARCH VERIFICATION · FIXTURE DATA · NO LIVE ACCOUNT</p>
        <Routes><Route path="/research" element={<Research/>}/></Routes>
      </BrowserRouter>
    </ServerContext>
  </QueryClientProvider>
);
