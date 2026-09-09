import { useEffect, useRef, useState } from "react";
import { mount, type Camera, type NetworkHandle } from "./lab-network-engine";
import type { LabNetwork } from "./lab-network-data";

export function ResearchNetwork({
  data,
  selected,
  query,
  kind,
  focus,
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
  onSelect(id: string): void;
  onFilters(query: string, kind: string): void;
  cameraStore: Map<string, Camera>;
  cameraKey: string;
}) {
  const target = useRef<HTMLDivElement>(null),
    engine = useRef<NetworkHandle | null>(null);
  const callbacks = useRef({ onSelect, onFilters });
  const [error, setError] = useState("");
  useEffect(() => {
    callbacks.current = { onSelect, onFilters };
  }, [onSelect, onFilters]);
  useEffect(() => {
    if (!target.current) return;
    try {
      const view = mount(target.current, data, {
        initialCamera: cameraStore.get(cameraKey),
        onSelect: (id) => callbacks.current.onSelect(id),
        onClear: () => callbacks.current.onSelect(""),
        onFilterChange: (value) =>
          callbacks.current.onFilters(value.query, value.kind),
        onCamera: (camera) => cameraStore.set(cameraKey, camera),
      });
      engine.current = view;
      return () => {
        view.destroy();
        engine.current = null;
      };
    } catch (failure) {
      queueMicrotask(() =>
        setError(
          failure instanceof Error
            ? failure.message
            : "Network renderer unavailable",
        ),
      );
    }
  }, [data, cameraKey, cameraStore]);
  useEffect(() => {
    engine.current?.select(selected || null);
  }, [selected, data]);
  useEffect(() => {
    engine.current?.setFilters({ query, kind });
  }, [query, kind, data]);
  useEffect(() => {
    if (focus && selected) engine.current?.focus(selected);
  }, [focus, selected, data]);
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
