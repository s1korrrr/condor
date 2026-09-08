export interface AccountObservation {
  account: string;
  connector: string;
  status: 'fresh' | 'stale' | 'missing';
  observed_at: string | null;
  valuation_available: boolean;
  balances: { token: string; total: string; available: string; value: string | null }[];
}

export interface AccountBalancesResponse {
  server: string;
  accounts: AccountObservation[];
}

export function accountFreshness(account: AccountObservation, now: number, failed = false) {
  const timestamp = account.observed_at ? Date.parse(account.observed_at) : Number.NaN;
  const age = (now - timestamp) / 1000;
  return {
    current: !failed && account.status === 'fresh' && Number.isFinite(age) && age >= 0 && age < 30,
    ageSeconds: Number.isFinite(age) && age >= 0 ? Math.floor(age) : null,
  };
}
