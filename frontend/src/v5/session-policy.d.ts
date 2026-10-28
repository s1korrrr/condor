export function confirmLogout(request: () => Promise<void>, confirmed: () => void, failed: () => void): Promise<boolean>;
export function clearSessionCache(client: {clear(): void; setQueryData(key: string[], data: {authenticated: boolean}): unknown; removeQueries(filters: {predicate: (query: {queryKey: readonly unknown[]}) => boolean}): unknown}): void;
