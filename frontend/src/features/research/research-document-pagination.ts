const SOURCE_PAGE_SIZE = 20;

export function researchDocumentPage<T>(
  items: readonly T[],
  requestedPage: number,
) {
  const lastPage = Math.max(0, Math.ceil(items.length / SOURCE_PAGE_SIZE) - 1);
  const page = Math.min(Math.max(0, requestedPage), lastPage);
  const offset = page * SOURCE_PAGE_SIZE;
  return {
    items: items.slice(offset, offset + SOURCE_PAGE_SIZE),
    first: items.length ? offset + 1 : 0,
    last: Math.min(offset + SOURCE_PAGE_SIZE, items.length),
    previous: page > 0 ? page - 1 : null,
    next: page < lastPage ? page + 1 : null,
    paginated: items.length > SOURCE_PAGE_SIZE,
  };
}
