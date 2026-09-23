export async function fetchFleetBots(read) {
  return read('/fleet/v1/bots')
}

export async function fetchFleetSnapshot(read, botKey) {
  return read(`/fleet/v1/bots/${encodeURIComponent(botKey)}/snapshot`)
}
