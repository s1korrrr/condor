export const TASKS = {
  market_context: 'Market analyst',
  source_quality: 'Source auditor',
  decision_review: 'Decision reviewer',
};

export function reportPresentation(report, now) {
  const result = report.record?.result;
  const requested = result?.requested_at_ms;
  const received = result?.received_at_ms;
  if ((requested && requested > now) || (received && received > now)) return 'future';
  if (result?.expires_at_ms && result.expires_at_ms <= now) return 'expired';
  return 'historical';
}

export function selectReports(reports, task, status, now) {
  return reports.filter(report => {
    if (task !== 'all' && report.task_id !== task) return false;
    if (status === 'all') return true;
    if (reportPresentation(report, now) !== 'historical') return false;
    return report.record?.result?.status === status || report.record?.result?.advice?.assessment === status;
  }).sort((left, right) => {
    const time = report => {
      if (reportPresentation(report, now) === 'future') return 0;
      return report.record?.result?.received_at_ms ?? report.record?.result?.requested_at_ms ?? 0;
    };
    return time(right) - time(left);
  });
}
