export async function readResearchDocument(
  fetcher: (path: string, init: RequestInit) => Promise<Response>, path: string, signal: AbortSignal,
  options: { maximumBytes: number; write?: (chunk: Uint8Array<ArrayBuffer>) => Promise<void> },
) {
  signal.throwIfAborted();
  const response = await fetcher(path, { signal, cache: 'no-store' });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(typeof body.detail === 'string' ? body.detail : `Source document unavailable (${response.status})`);
  }
  const length = response.headers.get('content-length');
  const expected = length !== null && /^\d+$/.test(length) ? Number(length) : null;
  if (expected !== null && expected > options.maximumBytes) {
    await response.body?.cancel();
    throw new Error('This source is too large for the selected delivery method. Use a streaming download for the complete document.');
  }
  if (!response.body) throw new Error('The source returned no document body.');
  const reader = response.body.getReader(), chunks: Uint8Array<ArrayBuffer>[] = [];
  let bytes = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const part = await reader.read(); if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > options.maximumBytes) throw new Error('Source document exceeded the delivery size limit. Download the complete source with streaming support.');
      const chunk = new Uint8Array(part.value);
      if (options.write) await options.write(chunk); else chunks.push(chunk);
    }
    signal.throwIfAborted();
    if (expected !== null && !response.headers.get('content-encoding') && bytes !== expected) throw new Error('The source document response was incomplete. Retry before using the downloaded evidence.');
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally { reader.releaseLock(); }
  const mime = (response.headers.get('content-type') || 'application/octet-stream').split(';')[0].toLowerCase();
  return { mime, blob: options.write ? null : new Blob(chunks, { type: mime }), disposition: response.headers.get('content-disposition') || '', bytes };
}
