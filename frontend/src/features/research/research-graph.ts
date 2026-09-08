export interface GraphNode {
  id: string; kind: string; title: string; status: string; x: number; y: number;
}
export interface GraphEdge {
  id: string; source: string; target: string; relation: string; basis: string;
}
export interface ResearchGraphLayout {
  nodes: GraphNode[]; edges: GraphEdge[]; truncated: boolean; omittedEdges: number;
}
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

export function layoutResearchGraph(data: Record<string, unknown>, selectedId: string): ResearchGraphLayout {
  if (!Array.isArray(data.nodes) || !Array.isArray(data.edges)) throw new Error('Research graph is unavailable');
  const ids = new Set<string>();
  const nodes = data.nodes.map(value => {
    const node = record(value);
    if (typeof node.id !== 'string' || !node.id || typeof node.title !== 'string' || typeof node.kind !== 'string' || typeof node.status !== 'string' || ids.has(node.id)) {
      throw new Error('Research graph contains an invalid node identity');
    }
    ids.add(node.id);
    return {id:node.id, title:node.title, kind:node.kind, status:node.status, x:500, y:320};
  }).sort((a,b) => a.id === selectedId ? -1 : b.id === selectedId ? 1 : a.id.localeCompare(b.id)).slice(0,50);
  // Stable rings express adjacency browsing only; geometric distance is not evidence strength.
  for (let index=1; index<nodes.length; index++) {
    const ring = index <= 8 ? 1 : index <= 24 ? 2 : 3;
    const first = ring===1 ? 1 : ring===2 ? 9 : 25;
    const count = Math.min(ring===1 ? 8 : ring===2 ? 16 : 25, nodes.length-first);
    const angle = -Math.PI/3 + ((index-first)/count)*Math.PI*2 + (ring%2 ? 0 : 0.14);
    const rx = ring===1 ? 220 : ring===2 ? 330 : 420;
    const ry = ring===1 ? 155 : ring===2 ? 210 : 240;
    nodes[index].x = 500 + Math.cos(angle)*rx;
    nodes[index].y = 320 + Math.sin(angle)*ry;
  }
  const visible = new Set(nodes.map(node=>node.id));
  let omittedEdges=0;
  const edges: GraphEdge[]=[];
  for (const [index, value] of data.edges.entries()) {
    const edge=record(value);
    if (typeof edge.source!=='string' || typeof edge.target!=='string' || typeof edge.relation!=='string' || !visible.has(edge.source) || !visible.has(edge.target) || edge.resolved===false) {
      omittedEdges++; continue;
    }
    edges.push({id:typeof edge.id==='string'?edge.id:`${edge.source}:${edge.target}:${edge.relation}:${index}`,source:edge.source,target:edge.target,relation:edge.relation,basis:typeof edge.basis==='string'?edge.basis:'UNAVAILABLE'});
  }
  return {nodes,edges,truncated:data.truncated===true || data.nodes.length>50,omittedEdges};
}

export function researchKindColor(kind: string): string {
  if (['idea','idea_revision'].includes(kind)) return 'var(--color-accent)';
  if (['experiment','run'].includes(kind)) return 'var(--color-green)';
  if (['assessment','decision'].includes(kind)) return 'var(--color-yellow)';
  if (['paper','paper_version'].includes(kind)) return 'var(--color-text)';
  return 'var(--color-text-muted)';
}
