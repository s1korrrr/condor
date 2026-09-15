/** Legacy links keep their selected source, bot, period and document anchor. */
export function capitalDestination(search: string, hash = '', section?: 'holdings') {
  const query = new URLSearchParams(search);
  if (section) query.set('view', section);
  return `/capital${query.size ? `?${query}` : ''}${hash}`;
}
