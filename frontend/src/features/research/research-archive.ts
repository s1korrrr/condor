export function archiveState(params: URLSearchParams) {
  const rawOffset = params.get('archive_offset') ?? '0';
  const offset = /^\d+$/.test(rawOffset) && Number(rawOffset) <= 1_000_000 ? Number(rawOffset) : 0;
  const view = params.get('archive_view') ?? 'explore';
  return {
    view: ['explore', 'coverage', 'next'].includes(view) ? view : 'explore',
    q: params.get('archive_q') ?? '', kind: params.get('archive_kind') ?? '',
    family: params.get('archive_family') ?? '', lane: params.get('archive_lane') ?? '',
    status: params.get('archive_status') ?? '', offset, record: params.get('archive_record') ?? '',
  };
}
export function updateArchiveParams(params: URLSearchParams, changes: Record<string, string>, reset = true) {
  const next = new URLSearchParams(params);
  for (const [key, value] of Object.entries(changes)) {
    if (!['view', 'q', 'kind', 'family', 'lane', 'status', 'offset', 'record'].includes(key)) continue;
    if (value) next.set(`archive_${key}`, value); else next.delete(`archive_${key}`);
  }
  if (reset) { next.delete('archive_offset'); next.delete('archive_record'); }
  return next;
}
