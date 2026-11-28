import type { PaperRead } from './contracts';
import { paperCoherentRead, paperReadFailureMessage, paperSectionError } from './policy';
import { parsePaperReadText } from './paper-json';

export async function readMarketPaper(bot: string, signal: AbortSignal): Promise<PaperRead[]> {
  const prefix = '/api/v1/servers/rsibot-v5/';
  return paperCoherentRead(`${prefix}bots/${encodeURIComponent(bot)}/native/status`, [
    { section: 'positions', path: `${prefix}fleet/holdings`, paginate: true },
    { section: 'decisions', path: `${prefix}bots/${encodeURIComponent(bot)}/decisions` },
  ], async (path, section) => {
    signal.throwIfAborted();
    const response = await fetch(`/api/v5/dashboard/read?${new URLSearchParams({ path })}`, { credentials: 'include', cache: 'no-store', signal: AbortSignal.any([signal, AbortSignal.timeout(14_000)]) });
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      throw Object.assign(new Error(paperReadFailureMessage(response.status, body)), { status: response.status });
    }
    const read = parsePaperReadText(await response.text()) as PaperRead;
    signal.throwIfAborted();
    if (!read || read.section !== section || read.bot_id !== bot || paperSectionError(read)) throw new Error(`${section} owner read failed validation.`);
    return read;
  });
}
