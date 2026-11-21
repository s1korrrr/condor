import { ownerCodeWords } from "./owner-codes";
import "./bots-truth.css";

/** An owner code in plain words with the code itself in small print; an unlisted code is shown unchanged. */
export function OwnerCode({ code }: { code: unknown }) {
  const text = ownerCodeWords(code);
  if (!text) return <>Not published</>;
  return text.words ? <>{text.words} <small className="owner-code">{text.code}</small></> : <>{text.code}</>;
}
