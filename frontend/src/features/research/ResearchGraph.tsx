import { useId, useMemo, useState } from "react";
import { layoutResearchGraph, researchKindColor } from "./research-graph";
import type { GraphNode, ResearchGraphLayout } from "./research-graph";

export interface ResearchGraphProps {
  data: Record<string, unknown>;
  selectedId: string;
  onSelect: (id: string) => void;
}

export function ResearchGraph({
  data,
  selectedId,
  onSelect,
}: ResearchGraphProps) {
  const markerId = useId().replace(/:/g, "");
  const [activeId, setActiveId] = useState<string | null>(null);
  const result = useMemo<{
    graph: ResearchGraphLayout | null;
    error: string | null;
  }>(() => {
    try {
      return { graph: layoutResearchGraph(data, selectedId), error: null };
    } catch {
      return {
        graph: null,
        error: "The source did not return a usable research neighborhood.",
      };
    }
  }, [data, selectedId]);
  if (!result.graph) return <p role="status">{result.error}</p>;
  const { nodes, edges, truncated, omittedEdges } = result.graph;
  if (!nodes.length)
    return (
      <p role="status">
        No nodes were recorded for this research neighborhood.
      </p>
    );
  const lookup = new Map<string, GraphNode>(
    nodes.map((node) => [node.id, node]),
  );
  const active = lookup.get(activeId ?? selectedId) ?? nodes[0];
  const kinds = [...new Set<string>(nodes.map((node) => node.kind))];
  return (
    <section aria-label="Research knowledge network" style={{ minWidth: 0 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          gap: 12,
          flexWrap: "wrap",
          alignItems: "baseline",
          marginBottom: 8,
        }}
      >
        <div>
          <strong>Knowledge connections</strong>
          <span
            style={{
              marginLeft: 12,
              color: "var(--color-text-muted)",
              fontSize: 12,
            }}
          >
            {nodes.length} nodes · {edges.length} recorded relations
          </span>
        </div>
        <span style={{ fontSize: 12, color: "var(--color-text-muted)" }}>
          Select a node to explore its neighborhood
        </span>
      </div>
      <div
        style={{
          overflowX: "auto",
          background: "var(--chart-bg)",
          border: "1px solid var(--color-border)",
          borderRadius: 12,
        }}
      >
        <svg
          viewBox="0 0 1000 650"
          role="group"
          aria-label="Directed research graph. Tab to nodes and press Enter to select."
          style={{
            width: "100%",
            minWidth: 600,
            display: "block",
            maxHeight: 620,
          }}
        >
          <defs>
            <marker
              id={markerId}
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="5"
              markerHeight="5"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--color-text-muted)" />
            </marker>
          </defs>
          {[155, 210, 240].map((radius) => (
            <ellipse
              key={radius}
              cx="500"
              cy="320"
              rx={radius === 155 ? 220 : radius === 210 ? 330 : 420}
              ry={radius}
              fill="none"
              stroke="var(--chart-grid)"
              strokeDasharray="2 8"
              aria-hidden="true"
            />
          ))}
          {edges.map((edge, index) => {
            const from = lookup.get(edge.source)!,
              to = lookup.get(edge.target)!;
            const dx = to.x - from.x,
              dy = to.y - from.y,
              length = Math.hypot(dx, dy) || 1;
            const x1 = from.x + (dx / length) * 29,
              y1 = from.y + (dy / length) * 29,
              x2 = to.x - (dx / length) * 34,
              y2 = to.y - (dy / length) * 34;
            const highlighted =
              edge.source === active.id || edge.target === active.id;
            const offset = ((index % 3) - 1) * 12;
            const mx = (x1 + x2) / 2 - (dy / length) * offset,
              my = (y1 + y2) / 2 + (dx / length) * offset;
            return (
              <g key={`${edge.id}:${index}`}>
                <path
                  d={
                    edge.source === edge.target
                      ? `M ${from.x - 18} ${from.y - 22} C ${from.x - 85} ${from.y - 105}, ${from.x + 85} ${from.y - 105}, ${from.x + 18} ${from.y - 22}`
                      : `M ${x1} ${y1} Q ${mx} ${my} ${x2} ${y2}`
                  }
                  fill="none"
                  stroke={
                    highlighted
                      ? "var(--color-accent)"
                      : "var(--color-text-muted)"
                  }
                  strokeWidth={highlighted ? 2 : 1.2}
                  opacity={highlighted ? 0.85 : 0.36}
                  strokeDasharray={
                    edge.basis === "EXPLICIT" ? undefined : "5 5"
                  }
                  markerEnd={`url(#${markerId})`}
                >
                  <title>{`${edge.source} → ${edge.target}: ${edge.relation} · ${edge.basis}`}</title>
                </path>
                {highlighted && edges.length <= 16 && (
                  <text
                    x={mx}
                    y={my - 7}
                    textAnchor="middle"
                    fill="var(--color-text-muted)"
                    fontSize="11"
                    paintOrder="stroke"
                    stroke="var(--chart-bg)"
                    strokeWidth="5"
                    strokeLinejoin="round"
                  >
                    {edge.relation.replaceAll("_", " ")}
                  </text>
                )}
              </g>
            );
          })}
          {nodes.map((node) => {
            const selected = node.id === selectedId,
              focused = node.id === activeId;
            const color = researchKindColor(node.kind);
            return (
              <g
                key={node.id}
                transform={`translate(${node.x} ${node.y})`}
                role="button"
                tabIndex={0}
                aria-label={`${node.title}. ${node.kind}. ${node.status}. Open research node ${node.id}`}
                aria-pressed={selected}
                onClick={() => onSelect(node.id)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onSelect(node.id);
                  }
                }}
                onFocus={() => setActiveId(node.id)}
                onBlur={() => setActiveId(null)}
                onMouseEnter={() => setActiveId(node.id)}
                onMouseLeave={() => setActiveId(null)}
                style={{ cursor: "pointer", outline: "none" }}
              >
                <title>{`${node.title} · ${node.kind} · ${node.status}`}</title>
                <circle r="38" fill="transparent" />
                {(selected || focused) && (
                  <circle
                    r={focused ? 37 : 33}
                    fill="none"
                    stroke={focused ? "var(--color-text)" : color}
                    strokeWidth={focused ? 2 : 1}
                    opacity={focused ? 1 : 0.6}
                  />
                )}
                <circle
                  r={selected ? 25 : 19}
                  fill="var(--color-surface)"
                  stroke={color}
                  strokeWidth={selected ? 3 : 2}
                />
                <circle r={selected ? 8 : 5} fill={color} />
                {(nodes.length <= 16 || selected || focused) && (
                  <text
                    y="53"
                    textAnchor={
                      node.x < 160 ? "start" : node.x > 840 ? "end" : "middle"
                    }
                    fill="var(--color-text)"
                    fontSize={selected ? 15 : 12}
                    fontWeight={selected ? 600 : 400}
                    paintOrder="stroke"
                    stroke="var(--chart-bg)"
                    strokeWidth="4"
                  >
                    {node.title.length > 29
                      ? `${node.title.slice(0, 27)}…`
                      : node.title}
                  </text>
                )}
                {(nodes.length <= 16 || selected || focused) && (
                  <text
                    y="70"
                    textAnchor={
                      node.x < 160 ? "start" : node.x > 840 ? "end" : "middle"
                    }
                    fill="var(--color-text-muted)"
                    fontSize="10"
                  >
                    {node.kind.replaceAll("_", " ")}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      </div>
      <div
        aria-live="polite"
        style={{
          marginTop: 12,
          minHeight: 44,
          display: "flex",
          gap: 10,
          alignItems: "baseline",
          flexWrap: "wrap",
        }}
      >
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: researchKindColor(active.kind),
            flexShrink: 0,
          }}
        />
        <strong style={{ fontSize: 13 }}>{active.title}</strong>
        <span style={{ fontSize: 12, color: "var(--color-text-muted)" }}>
          {active.kind.replaceAll("_", " ")} · {active.status}
        </span>
      </div>
      <div
        style={{
          display: "flex",
          gap: 14,
          flexWrap: "wrap",
          fontSize: 11,
          color: "var(--color-text-muted)",
        }}
      >
        {kinds.map((kind) => (
          <span key={kind}>
            <span
              aria-hidden="true"
              style={{
                display: "inline-block",
                width: 7,
                height: 7,
                borderRadius: "50%",
                background: researchKindColor(kind),
                marginRight: 5,
              }}
            />
            {kind.replaceAll("_", " ")}
          </span>
        ))}
      </div>
      <p
        style={{
          fontSize: 12,
          color: "var(--color-text-muted)",
          marginTop: 10,
        }}
      >
        {truncated
          ? "Bounded neighborhood; more connections exist in the source. "
          : ""}
        {omittedEdges
          ? `${omittedEdges} relations have no resolved endpoints in this view. `
          : ""}
        {!edges.length
          ? "No resolved relations are recorded in this view. "
          : ""}
        Arrows show recorded direction. Solid lines are explicit links; dashed
        lines use another recorded basis. Position and color do not indicate
        economic support.
      </p>
    </section>
  );
}

export default ResearchGraph;
