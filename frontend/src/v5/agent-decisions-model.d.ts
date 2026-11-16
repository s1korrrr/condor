import type { V5TaskReport } from './contracts';
export const TASKS: Record<string, string>;
export function reportPresentation(report: V5TaskReport, now: number): 'future' | 'expired' | 'historical' | 'withheld';
export function selectReports(reports: V5TaskReport[], task: string, status: string, now: number): V5TaskReport[];
