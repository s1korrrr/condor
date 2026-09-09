import type { ResearchEnvelope } from './model.ts';
export interface LabNetwork {
  revision: string; node_fields: string[]; edge_fields: string[];
  nodes: [string, string, string, string, string][];
  edges: [number, number, string, string][];
  total_nodes: number; total_edges: number; unresolved_edges: number;
  stats: Record<string, { key: string; count: number }[]>;
}
export function parseLabNetwork(value: unknown): LabNetwork {
  const data = value as LabNetwork;
  const invalid = () => { throw new Error('Research network payload is invalid or incomplete. Retry the source.'); };
  if (!data || typeof data.revision !== 'string' || !data.revision ||
      JSON.stringify(data.node_fields) !== JSON.stringify(['id', 'kind', 'title', 'family', 'lane']) ||
      JSON.stringify(data.edge_fields) !== JSON.stringify(['source', 'target', 'relation', 'basis']) ||
      !Array.isArray(data.nodes) || !Array.isArray(data.edges) ||
      !Number.isSafeInteger(data.unresolved_edges) || data.unresolved_edges < 0 ||
      data.total_nodes !== data.nodes.length || data.total_edges !== data.edges.length + data.unresolved_edges) invalid();
  const ids = new Set<string>();
  for (const node of data.nodes) {
    if (!Array.isArray(node) || node.length !== 5 || typeof node[0] !== 'string' || !node[0] || ids.has(node[0]) || node.some(v => typeof v !== 'string')) invalid();
    ids.add(node[0]);
  }
  for (const edge of data.edges) if (!Array.isArray(edge) || edge.length !== 4 ||
    !Number.isSafeInteger(edge[0]) || !Number.isSafeInteger(edge[1]) || edge[0] < 0 || edge[1] < 0 ||
    edge[0] >= data.nodes.length || edge[1] >= data.nodes.length || typeof edge[2] !== 'string' || typeof edge[3] !== 'string') invalid();
  for (const [key, total] of Object.entries({ kinds: data.total_nodes, families: data.total_nodes, lanes: data.total_nodes, relations: data.total_edges })) {
    const stats = data.stats?.[key];
    if (!Array.isArray(stats) || stats.some(item => !item || typeof item.key !== 'string' || !Number.isSafeInteger(item.count) || item.count < 0) || stats.reduce((sum, item) => sum + item.count, 0) !== total) invalid();
  }
  return data;
}
type Reader = (endpoint: string, server: string, params: Record<string, string>, signal: AbortSignal) => Promise<ResearchEnvelope>;
export async function loadConsistentLabNetwork(read: Reader, server: string, revision: string, signal: AbortSignal) {
  const network = await read('network', server, {}, signal); signal.throwIfAborted();
  const data = parseLabNetwork(network.data);
  if (data.revision === revision) return { network };
  const overview = await read('overview', server, {}, signal); signal.throwIfAborted();
  if (overview.data.revision !== data.revision) throw new Error('Research source revision changed while loading the network. Retry for a consistent snapshot.');
  return { network, overview };
}
