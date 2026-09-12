import { useEffect, useRef, useState } from "react";
import {
  mount,
  type Camera,
  type NetworkHandle,
  type NetworkTopology,
} from "./lab-network-engine";
import type { LabNetwork } from "./lab-network-data";

export function ResearchNetwork({
  data,
  selected,
  query,
  kind,
  focus,
  topology,
  onTopology,
  onSelect,
  onFilters,
  cameraStore,
  cameraKey,
}: {
  data: LabNetwork;
  selected: string;
  query: string;
  kind: string;
  focus: string;
  topology: NetworkTopology;
  onTopology(topology: NetworkTopology, focusId?: string): void;
  onSelect(id: string): void;
  onFilters(query: string, kind: string): void;
  cameraStore: Map<string, Camera>;
  cameraKey: string;
}) {
  const target = useRef<HTMLDivElement>(null),
    engine = useRef<NetworkHandle | null>(null);
  const callbacks = useRef({ onSelect, onFilters, onTopology });
  const [error, setError] = useState("");
  useEffect(() => {
    callbacks.current = { onSelect, onFilters, onTopology };
  }, [onSelect, onFilters, onTopology]);
  useEffect(() => {
    if (!target.current) return;
    let disposed = false;
    try {
      const view = mount(target.current, data, {
        initialTopology: topology,
        onTopologyChange: (mode, focusId) => callbacks.current.onTopology(mode, focusId),
        initialCamera: cameraStore.get(cameraKey),
        onSelect: (id) => callbacks.current.onSelect(id),
        onClear: () => callbacks.current.onSelect(""),
        onFilterChange: (value) =>
          callbacks.current.onFilters(value.query, value.kind),
        onCamera: (camera) => cameraStore.set(cameraKey, camera),
      });
      engine.current = view;
      queueMicrotask(() => {
        if (!disposed) setError("");
      });
      return () => {
        disposed = true;
        view.destroy();
        engine.current = null;
      };
    } catch (failure) {
      queueMicrotask(() => {
        if (!disposed)
          setError(
            failure instanceof Error
              ? failure.message
              : "Network renderer unavailable",
          );
      });
      return () => {
        disposed = true;
      };
    }
  }, [data, cameraKey, cameraStore, topology]);
  useEffect(() => {
    engine.current?.select(selected || null);
  }, [selected, data, cameraKey, cameraStore, topology]);
  useEffect(() => {
    engine.current?.setFilters({ query, kind });
  }, [query, kind, data, cameraKey, cameraStore, topology]);
  useEffect(() => {
    if (focus && selected) engine.current?.focus(selected);
  }, [focus, selected, data, cameraKey, cameraStore, topology]);
  return (
    <div className="lab-network-host">
      {error && (
        <p className="quant-notice" role="alert">
          {error}. Reload the graph view to retry.
        </p>
      )}
      <div ref={target} />
    </div>
  );
}
