import { Link } from 'react-router-dom';
import { useServerCapabilities } from '@/hooks/useServerCapabilities';
import '@/features/research/workspace.css';

export function WorkspaceTools() {
  const {access,unavailableReason,refetch}=useServerCapabilities();
  return <div className="quant-workspace"><header className="quant-heading"><div><h1>Workspace tools</h1><p>Connections, execution services and automation.</p></div><button onClick={()=>void refetch()}>Refresh status</button></header>
    {unavailableReason?<div role="alert" className="quant-notice">{unavailableReason}</div>:null}
    <div className="quant-tools-list"><section className="quant-panel"><header className="quant-panel-heading"><h2>Available data</h2></header>
      <div className="quant-tool-row"><div><strong>Portfolio & connections</strong><p>Exchange balances from your saved account connections.</p></div>{access.portfolioRead?<Link to="/portfolio">Open Portfolio</Link>:<span>Unavailable</span>}</div>
      <div className="quant-tool-row"><div><strong>Trading Visuals</strong><p>Price charts, recorded activity and bot-reported positions.</p></div><Link to="/trading-visuals">Open visuals</Link></div>
      <div className="quant-tool-row"><div><strong>Research OS</strong><p>Knowledge graph, research results and evidence lineage.</p></div><Link to="/research">Open Research</Link></div>
      <div className="quant-tool-row"><div><strong>Server settings</strong><p>Inspect selected server connections and account setup.</p></div><Link to="/settings">Open Settings</Link></div>
    </section><section className="quant-panel"><header className="quant-panel-heading"><h2>Execution & automation</h2></header>
      <div className="quant-tool-row"><div><strong>Manual order entry · {access.manualTrading?'Available':access.online?'Disabled':'Unavailable'}</strong><p>{!access.online?'Verify the server connection and capabilities to determine availability.':access.manualTrading?'Order entry is supported by the selected server.':access.native?'Native monitoring has no order-entry service. Connecting API keys does not activate it.':'Order entry is disabled for the selected server.'}</p></div>{access.manualTrading?<Link to="/trade">Open Trade</Link>:null}</div>
      <div className="quant-tool-row"><div><strong>Executor management · {access.executors?'Available':'Read-only records'}</strong><p>{access.executors?'Create and manage executors through the selected server.':'Existing records remain in Trading Visuals → Activity → Executors. Creation and cancellation require an execution service.'}</p></div><Link to={access.executors?'/executors':'/trading-visuals'}>{access.executors?'Open Executors':'View records'}</Link></div>
      <div className="quant-tool-row"><div><strong>Bot lifecycle · {access.botStop?'Controls available':access.botRead?'Monitoring':'Unavailable'}</strong><p>{!access.online?'Verify the selected server before using bot lifecycle controls.':access.botStop?'The server advertises lifecycle control.':'Bot controls require verified owner capabilities. Recorded observations remain available.'}</p></div>{access.botRead?<Link to="/bots">Open Bots</Link>:null}</div>
      <div className="quant-tool-row"><div><strong>Agents & routines · {access.online&&access.full?'Workspace tools':access.native?'Inactive here':'Unavailable'}</strong><p>{!access.online?'Verify the server profile before opening automation tools.':access.native?'Agent conversations and routines are not enabled for native monitoring. Research browsing works independently.':'Open the agent workspace or existing routine runs.'}</p></div>{access.online&&access.full?<Link to="/agents">Open Agents</Link>:null}</div>
    </section></div>
  </div>;
}
