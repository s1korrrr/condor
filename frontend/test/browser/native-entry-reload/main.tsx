import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {createRoot} from 'react-dom/client';
import {NativeEntryControls} from '../../../src/components/bots/NativeEntryControls';

const client=new QueryClient({defaultOptions:{queries:{retry:false,refetchOnWindowFocus:false}}});
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={client}><NativeEntryControls server="fixture" botName="v2" /></QueryClientProvider>
);
