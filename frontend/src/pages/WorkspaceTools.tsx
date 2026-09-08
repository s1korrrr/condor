import { Link } from 'react-router-dom';
import { useServerCapabilities } from '@/hooks/useServerCapabilities';
import '@/features/research/workspace.css';

export function WorkspaceTools() {
  const {access,isError,refetch}=useServerCapabilities();
  return <div className="quant-workspace"><header className="quant-heading"><div><h1>Workspace tools</h1><p>Connections, execution services and automation.</p></div><button onClick={()=>void refetch()}>Refresh status</button></header>
    {isError?<div role="alert" className="quant-notice">Server status could not be refreshed. Open Settings to check the connection.</div>:null}
    <div className="quant-tools-list"><section className="quant-panel"><header className="quant-panel-heading"><h2>Available data</h2></header>
      <div className="quant-tool-row"><div><strong>Portfolio & connections</strong><p>Exchange balances from your saved account connections.</p></div><Link to="/portfolio">Open Portfolio</Link></div>
      <div className="quant-tool-row"><div><strong>Trading Visuals</strong><p>Price charts, recorded activity and bot-reported positions.</p></div><Link to="/trading-visuals">Open visuals</Link></div>
      <div className="quant-tool-row"><div><strong>Research OS</strong><p>Knowledge graph, research results and evidence lineage.</p></div><Link to="/research">Open Research</Link></div>
      <div className="quant-tool-row"><div><strong>Server settings</strong><p>Inspect selected server connections and account setup.</p></div><Link to="/settings">Open Settings</Link></div>
    </section><section className="quant-panel"><header className="quant-panel-heading"><h2>Execution & automation</h2></header>
      <div className="quant-tool-row"><div><strong>Manual order entry · {access.manualTrading?'Available':'Disabled'}</strong><p>{access.manualTrading?'Order entry is supported by the selected server.':'This native deployment reads balances but has no order-entry service. Connecting API keys does not activate it.'}</p></div>{access.manualTrading?<Link to="/trade">Open Trade</Link>:null}</div>
      <div className="quant-tool-row"><div><strong>Executor management · {access.executors?'Available':'Read-only records'}</strong><p>{access.executors?'Create and manage executors through the selected server.':'Existing records remain in Trading Visuals → Activity → Executors. Creation and cancellation require an execution service.'}</p></div><Link to={access.executors?'/executors':'/trading-visuals'}>{access.executors?'Open Executors':'View records'}</Link></div>
      <div className="quant-tool-row"><div><strong>Bot lifecycle · {access.botStop?'Controls available':'Monitoring'}</strong><p>{access.botStop?'The server advertises lifecycle control.':'Native processes require verified control identities before start/stop actions are enabled. Their observations remain available.'}</p></div><Link to="/bots">Open Bots</Link></div>
      <div className="quant-tool-row"><div><strong>Agents & routines · {access.native?'Inactive here':'Workspace tools'}</strong><p>{access.native?'The private web service does not run agent conversations or scheduled strategies. Research browsing works independently.':'Open the agent workspace or existing routine runs.'}</p></div>{!access.native?<Link to="/agents">Open Agents</Link>:null}</div>
    </section></div>
  </div>;
}
