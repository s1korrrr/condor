export function toFleetRow(snapshot) {
  const identity = snapshot.identity || {};
  const metric = (snapshot.metrics || []).find((item) => item.metric_id === 'equity');
  return {
    authorityId: identity.authority_id,
    stackId: identity.stack_id,
    botInstanceId: identity.bot_instance_id,
    displayName: snapshot.display_name,
    executionMode: snapshot.execution_mode,
    stackGeneration: snapshot.stack_generation,
    identityVerified: snapshot.identity_verified === true,
    reasonCode: snapshot.reason_code || null,
    equity: metric ? metric.value : null,
    equityAvailable: Boolean(metric && metric.availability === 'available'),
    commandAvailable: false,
    queryKey: [identity.authority_id, identity.stack_id, identity.bot_instance_id, snapshot.catalogue_revision].join(':'),
  };
}
