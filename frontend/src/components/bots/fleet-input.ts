import { displayBotName } from '@/features/trading-visuals/sources';
import type { FleetBotInput } from '@/features/bots/fleet-tiles';
import type { OwnerReads } from './BotsRoster';

export function fleetInput(reads: OwnerReads, name = displayBotName(reads.bot)): FleetBotInput {
  return { bot: reads.bot, name, status: reads.status, view: reads.view, quant: reads.quant, cycles: reads.cycles, execution: reads.execution, health: reads.health, fillTotals: reads.fillTotals ?? null };
}
