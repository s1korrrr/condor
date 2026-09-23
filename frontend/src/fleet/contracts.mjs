export function fleetQueryKey({ principal, authorityId, stackId, botInstanceId, session, projection }) {
  return ['fleet', principal, authorityId, stackId, botInstanceId, session, projection]
}

export function sameNameCollision(left, right) {
  return left.displayName === right.displayName && (
    left.authorityId !== right.authorityId || left.stackId !== right.stackId || left.botInstanceId !== right.botInstanceId
  )
}

export function clearForbiddenCache(cache, previousScope, nextScope) {
  if (previousScope === nextScope) return cache
  return {}
}
