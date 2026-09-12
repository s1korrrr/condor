export const formatValue = (value: number | null) => value === null ? 'Unavailable' : value.toLocaleString(undefined, { maximumFractionDigits: 2, minimumFractionDigits: 2 });
export const utc = (value: string) => new Date(value).toLocaleString('en-GB', { timeZone: 'UTC', dateStyle: 'medium', timeStyle: 'medium' });
