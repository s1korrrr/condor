export function MarkedId({ text, id }: { text: string; id: string | null | undefined }) {
  const index = id ? text.indexOf(id) : -1;
  return index < 0 || !id ? text : <>{text.slice(0, index)}<span data-display-id>{id}</span>{text.slice(index + id.length)}</>;
}
