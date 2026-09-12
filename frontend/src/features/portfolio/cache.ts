import type { QueryClient } from '@tanstack/react-query';

/** Account replacement must never show the preceding account while refetching. */
export async function clearPortfolioAccountCache(client: QueryClient, server: string | null) {
  const queryKey = ['portfolio-analytics', server];
  await client.cancelQueries({queryKey});
  client.removeQueries({queryKey});
}
