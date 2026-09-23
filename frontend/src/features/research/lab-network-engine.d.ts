import type { LabNetwork } from "./lab-network-data";
export type NetworkTopology = "dependencies" | "linked" | "all";
export function focusNetwork(data: LabNetwork, topology?: NetworkTopology): LabNetwork;
export function searchCatalog(catalog: LabNetwork, visible: LabNetwork, query: string, kind: string): { id: string; title: string; hidden: boolean }[];
export interface Camera {
  x: number;
  y: number;
  scale: number;
}
export interface NetworkHandle {
  setTopology(topology: NetworkTopology, focusId?: string): void;
  select(id: string | null): void;
  fit(): void;
  zoom(factor: number): void;
  pause(value?: boolean): void;
  focus(id: string): boolean;
  setFilters(filters: { query: string; kind: string }): void;
  destroy(): void;
}
export function mount(
  target: HTMLElement,
  data: LabNetwork,
  options?: {
    onError?(message: string | null): void;
    initialTopology?: NetworkTopology;
    onTopologyChange?(topology: NetworkTopology, focusId?: string): void;
    initialCamera?: Camera;
    initialQuery?: string;
    initialKind?: string;
    initialSelected?: string;
    onCamera?(camera: Camera): void;
    onSelect?(id: string): void;
    onClear?(): void;
    onFilterChange?(filters: { query: string; kind: string }): void;
  },
): NetworkHandle;
export function layout(data: LabNetwork): {
  positions: Float32Array;
  degree: Int32Array;
  adjacency: number[][];
  components: number;
  isolates: number;
  familyRegions: { family: string; x: number; y: number; radius: number }[];
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
};
export function worldPoint(
  point: { x: number; y: number },
  camera: Camera,
  size: { width: number; height: number },
): { x: number; y: number };
export function zoomAt(
  camera: Camera,
  factor: number,
  point: { x: number; y: number },
  size: { width: number; height: number },
): Camera;

export function colorFor(kind: string): string;
