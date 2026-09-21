export function toFleetRow(snapshot) {
  const identity = snapshot.identity || {}
  return {
    botKey: snapshot.bot_key,
    authorityId: identity.authority_id,
    stackId: identity.stack_id,
    botInstanceId: identity.bot_instance_id,
    displayName: snapshot.display_name || snapshot.descriptor?.presentation?.display_name,
    executionMode: snapshot.execution_mode || snapshot.descriptor?.execution_mode,
    stackGeneration: snapshot.stack_generation || snapshot.descriptor?.stack_generation,
    identityVerified: snapshot.identity_verified === true,
    reasonCode: snapshot.reason_code || null,
    queryKey: [identity.authority_id, identity.stack_id, identity.bot_instance_id, snapshot.catalogue_revision],
  }
}

export function clearForbiddenCache(cache, previousScope, nextScope) {
  if (previousScope === nextScope) return cache
  return {}
}
