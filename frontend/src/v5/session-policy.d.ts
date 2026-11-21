type Cache = {setQueryData(key: string[], data: {authenticated: boolean}): unknown; removeQueries(filters: {predicate: (query: {queryKey: readonly unknown[]}) => boolean}): unknown};
export function confirmLogout(request: () => Promise<void>, confirmed: () => void, failed: () => void): Promise<boolean>;
export function dropSessionReads(client: Pick<Cache, "removeQueries">, clearRetained?: () => void): void;
export function clearSessionCache(client: Cache, clearRetained?: () => void): void;
export function sessionEnded(auth: {data?: {authenticated?: boolean} | null; isError?: boolean; error?: unknown}, isUnauthorized: (error: unknown) => boolean): boolean;
