import { useEffect, useRef, useState } from "react";
import { FileText, Download, X } from "lucide-react";
import { authFetch } from "@/lib/auth-token";
import {
  documentPath,
  isolatedDocument,
  sourceFilename,
  type DocumentScope,
  type ResearchDocumentReference,
} from "./research-detail";
import "./research-detail.css";
import { readResearchDocument } from "./research-document-read";

const PREVIEW_BYTES = 16 * 1024 * 1024;
const DOWNLOAD_BYTES = 1024 * 1024 * 1024;
function sizeLabel(value: unknown) {
  return typeof value === "number" && value >= 0
    ? `${(value / 1024 / 1024).toLocaleString(undefined, { maximumFractionDigits: 1 })} MB`
    : "Size not recorded";
}
function descriptors(input: unknown): ResearchDocumentReference[] {
  return Array.isArray(input)
    ? input.filter(
        (d): d is ResearchDocumentReference =>
          !!d &&
          typeof d === "object" &&
          typeof d.ref === "string" &&
          typeof d.label === "string" &&
          typeof d.available === "boolean",
      )
    : [];
}
interface OpenDocument {
  label: string;
  mime: string;
  text?: string;
  url?: string;
}

export function ResearchDocuments({
  server,
  scope,
  id,
  documents,
  title = "Source documents",
}: {
  server: string;
  scope: DocumentScope;
  id: string;
  documents: unknown;
  title?: string;
}) {
  // Selection-keyed child cancels a pending read and removes its Blob URL when
  // the owner record changes, including a server change with the same node ID.
  return (
    <ResearchDocumentReader
      key={`${server}:${scope}:${id}`}
      {...{ server, scope, id, documents, title }}
    />
  );
}

function ResearchDocumentReader({
  server,
  scope,
  id,
  documents,
  title,
}: {
  server: string;
  scope: DocumentScope;
  id: string;
  documents: unknown;
  title: string;
}) {
  const [opened, setOpened] = useState<OpenDocument | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  const live = useRef(true);
  const urls = useRef(new Set<string>());
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    live.current = true;
    const owned = urls.current;
    return () => {
      live.current = false;
      request.current?.abort();
      owned.forEach((url) => URL.revokeObjectURL(url));
      owned.clear();
    };
  }, []);
  const close = () => {
    request.current?.abort();
    request.current = null;
    urls.current.forEach((url) => URL.revokeObjectURL(url));
    urls.current.clear();
    setOpened(null);
    setPending(null);
    setError(null);
  };
  async function read(document: ResearchDocumentReference, download: boolean) {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setError(null);
    setPending(document.ref);
    setOpened(null);
    urls.current.forEach((url) => URL.revokeObjectURL(url));
    urls.current.clear();
    let sink: FileSystemWritableFileStream | undefined;
    const picker = (
      window as Window & {
        showSaveFilePicker?: (options: {
          suggestedName: string;
        }) => Promise<FileSystemFileHandle>;
      }
    ).showSaveFilePicker;
    const streamToDisk =
      download &&
      !!picker &&
      (document.size_bytes == null || document.size_bytes > 64 * 1024 * 1024);
    const maximum = streamToDisk
      ? Number.MAX_SAFE_INTEGER
      : download
        ? DOWNLOAD_BYTES
        : PREVIEW_BYTES;
    try {
      if (
        typeof document.size_bytes === "number" &&
        document.size_bytes > maximum
      )
        throw new Error(
          download
            ? "This large source needs a browser with streaming file downloads, such as Chrome on a secure connection."
            : "This source is too large for the inline preview. Use Download for the complete document.",
        );
      // Invoke the picker directly in the user gesture, before the first fetch.
      if (streamToDisk && picker) {
        const handle = await picker.call(window, {
          suggestedName: sourceFilename(document.filename || document.label),
        });
        if (
          !live.current ||
          request.current !== controller ||
          controller.signal.aborted
        )
          return;
        sink = await handle.createWritable();
      }
      const result = await readResearchDocument(
        authFetch,
        documentPath(server, scope, id, document.ref),
        AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(download ? 30 * 60_000 : 120_000),
        ]),
        {
          maximumBytes: maximum,
          ...(sink
            ? { write: (chunk: Uint8Array<ArrayBuffer>) => sink!.write(chunk) }
            : {}),
        },
      );
      if (
        !live.current ||
        request.current !== controller ||
        controller.signal.aborted
      ) {
        await sink?.abort();
        sink = undefined;
        return;
      }
      if (sink) {
        await sink.close();
        sink = undefined;
        return;
      }
      const { mime, blob } = result;
      if (!blob) throw new Error("The source returned no document bytes.");
      if (download) {
        const url = URL.createObjectURL(blob);
        urls.current.add(url);
        const anchor = window.document.createElement("a");
        anchor.href = url;
        const declared = result.disposition.match(/filename="?([^";]+)"?/)?.[1];
        anchor.download = sourceFilename(
          declared || document.filename || document.label,
        );
        anchor.click();
      } else if (mime === "text/html" || mime === "application/xhtml+xml") {
        const source = await blob.text();
        if (
          live.current &&
          request.current === controller &&
          !controller.signal.aborted
        )
          setOpened({
            label: document.label,
            mime: "text/html",
            text: isolatedDocument(source, document.fragment),
          });
      } else if (
        mime.startsWith("text/") ||
        [
          "application/json",
          "application/x-ndjson",
          "application/jsonl",
        ].includes(mime)
      ) {
        const source = await blob.text();
        if (
          live.current &&
          request.current === controller &&
          !controller.signal.aborted
        )
          setOpened({
            label: document.label,
            mime: "text/plain",
            text: source,
          });
      } else if (
        ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(mime)
      ) {
        const url = URL.createObjectURL(blob);
        urls.current.add(url);
        setOpened({ label: document.label, mime, url });
      } else {
        setError(
          "This file type has no inline preview. Download the complete source document.",
        );
      }
    } catch (error) {
      await sink?.abort().catch(() => undefined);
      if (
        live.current &&
        request.current === controller &&
        !controller.signal.aborted
      )
        setError(
          error instanceof Error
            ? error.message
            : "Source document could not be opened.",
        );
    } finally {
      if (live.current && request.current === controller) setPending(null);
    }
  }
  const items = descriptors(documents);
  return (
    <section className="research-documents">
      <h4>{title}</h4>
      {items.length ? (
        <ul className="research-document-list">
          {items.map((item) => (
            <li key={item.ref}>
              <div>
                <strong>{item.label}</strong>
                {item.filename && item.filename !== item.label && (
                  <small>{item.filename}</small>
                )}
                <small>
                  {sizeLabel(item.size_bytes)}
                  {item.media_type ? ` · ${item.media_type}` : ""}
                </small>
              </div>
              <div className="research-document-actions">
                <button
                  type="button"
                  onClick={() => void read(item, false)}
                  disabled={!item.available || pending === item.ref}
                  aria-label={`Open ${item.label}`}
                >
                  <FileText size={14} />
                  Open
                </button>
                <button
                  type="button"
                  onClick={() => void read(item, true)}
                  disabled={!item.available || pending === item.ref}
                  aria-label={`Download ${item.label}`}
                >
                  <Download size={14} />
                  Download
                </button>
              </div>
              {!item.available && (
                <p role="status">
                  {item.reason || "The source is not currently available."}
                </p>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="quant-muted">
          No admitted source documents were returned for this record.
        </p>
      )}
      {pending && (
        <div className="quant-notice" role="status">
          Opening source…{" "}
          <button type="button" onClick={close}>
            Cancel
          </button>
        </div>
      )}
      {error && (
        <p role="alert" className="research-read-error">
          {error}
        </p>
      )}
      {opened && (
        <div className="research-document-preview" ref={panel} tabIndex={-1}>
          <header>
            <h4>{opened.label}</h4>
            <button
              type="button"
              onClick={close}
              aria-label="Close document preview"
            >
              <X size={15} />
            </button>
          </header>
          {opened.mime === "text/html" ? (
            <>
              <p className="quant-muted">
                Isolated source preview. External resources are blocked.
              </p>
              <iframe
                title={opened.label}
                srcDoc={opened.text}
                sandbox="allow-scripts"
                referrerPolicy="no-referrer"
              />
            </>
          ) : opened.url ? (
            <img src={opened.url} alt={opened.label} />
          ) : (
            <pre>{opened.text}</pre>
          )}
        </div>
      )}
    </section>
  );
}
