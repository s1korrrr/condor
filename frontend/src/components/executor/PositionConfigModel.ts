import { useMemo, useReducer } from "react";
import type { ChartPriceMapping, ExecutorValidation, ExtraLine } from "./types";
import { getThemeColors } from "@/lib/theme-colors";

// ── State ──

export interface PositionState {
  side: 1 | 2;
  amount: number;
  entry_price: number; // 0 = market order
  leverage: number;
  stop_loss: number; // decimal e.g. 0.02 = 2%, 0 = disabled
  take_profit: number;
  time_limit: number; // seconds, 0 = disabled
  trailing_stop_activation_price: number; // 0 = disabled
  trailing_stop_trailing_delta: number;
  open_order_type: number;
  take_profit_order_type: number;
  stop_loss_order_type: number;
  time_limit_order_type: number;
  activation_bounds: number; // 0 = disabled
  activePickField: string | null;
  showAdvanced: boolean;
}

export type PositionAction =
  | { type: "SET_FIELD"; field: string; value: unknown }
  | { type: "SET_CONNECTOR"; value: string }
  | { type: "SET_PAIR"; value: string };

const DEFAULTS: PositionState = {
  side: 1,
  amount: 0,
  entry_price: 0,
  leverage: 10,
  stop_loss: 0.03,
  take_profit: 0.02,
  time_limit: 0,
  trailing_stop_activation_price: 0,
  trailing_stop_trailing_delta: 0,
  open_order_type: 1,
  take_profit_order_type: 1,
  stop_loss_order_type: 1,
  time_limit_order_type: 1,
  activation_bounds: 0,
  activePickField: null,
  showAdvanced: false,
};

const STORAGE_KEY = "condor_position_defaults";

const PERSISTED_FIELDS: (keyof PositionState)[] = [
  "side", "amount", "leverage", "stop_loss", "take_profit",
  "time_limit", "trailing_stop_activation_price", "trailing_stop_trailing_delta",
  "open_order_type", "take_profit_order_type", "stop_loss_order_type",
  "time_limit_order_type", "activation_bounds",
];

function loadSavedDefaults(): PositionState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    const saved = JSON.parse(raw);
    const merged = { ...DEFAULTS };
    for (const key of PERSISTED_FIELDS) {
      if (key in saved && saved[key] !== undefined) {
        (merged as Record<string, unknown>)[key] = saved[key];
      }
    }
    return merged;
  } catch {
    return DEFAULTS;
  }
}

function saveDefaults(state: PositionState) {
  const toSave: Record<string, unknown> = {};
  for (const key of PERSISTED_FIELDS) toSave[key] = state[key];
  localStorage.setItem(STORAGE_KEY, JSON.stringify(toSave));
}

function positionReducer(state: PositionState, action: PositionAction): PositionState {
  switch (action.type) {
    case "SET_FIELD": {
      const next = { ...state, [action.field]: action.value };
      return next;
    }
    case "SET_CONNECTOR":
      return { ...state, entry_price: 0 };
    case "SET_PAIR":
      return { ...state, entry_price: 0 };
    default:
      return state;
  }
}

// ── Validation ──

export function usePositionValidation(state: PositionState): ExecutorValidation {
  return useMemo(() => {
    const errors: string[] = [];
    if (state.amount <= 0) errors.push("Amount required (base currency)");
    if (state.stop_loss === 0 && state.take_profit === 0 && state.time_limit === 0) {
      errors.push("Set at least one exit: SL, TP, or time limit");
    }
    if (state.stop_loss < 0) errors.push("Stop loss must be >= 0");
    if (state.take_profit < 0) errors.push("Take profit must be >= 0");
    if (state.stop_loss > 1) errors.push("Stop loss must be <= 100%");
    if (state.take_profit > 1) errors.push("Take profit must be <= 100%");
    return { valid: errors.length === 0, errors };
  }, [state]);
}

// ── Hook ──

export function usePositionConfig() {
  const [state, dispatch] = useReducer(positionReducer, undefined, loadSavedDefaults);
  const validation = usePositionValidation(state);

  const chartProps: ChartPriceMapping = useMemo(() => {
    const extras: ExtraLine[] = [];
    const entry = state.entry_price;
    const isLong = state.side === 1;

    if (entry > 0 && state.take_profit > 0) {
      const tpPrice = isLong ? entry * (1 + state.take_profit) : entry * (1 - state.take_profit);
      extras.push({
        price: tpPrice,
        label: `TP (${(state.take_profit * 100).toFixed(1)}%)`,
        color: getThemeColors().green,
        lineStyle: "dashed",
        lineWidth: 2,
      });
    }
    if (entry > 0 && state.stop_loss > 0) {
      const slPrice = isLong ? entry * (1 - state.stop_loss) : entry * (1 + state.stop_loss);
      extras.push({
        price: slPrice,
        label: `SL (${(state.stop_loss * 100).toFixed(1)}%)`,
        color: getThemeColors().red,
        lineStyle: "dashed",
        lineWidth: 2,
      });
    }

    return {
      startPrice: entry,
      endPrice: 0,
      limitPrice: 0,
      side: state.side,
      minSpread: 0,
      activePickField: state.activePickField === "entry_price" ? "start" : null,
      extraLines: extras,
    };
  }, [state.entry_price, state.side, state.activePickField, state.take_profit, state.stop_loss]);

  const buildPayload = (connector: string, pair: string, isSpot: boolean) => {
    const tripleBarrier: Record<string, unknown> = {
      open_order_type: state.open_order_type,
      take_profit_order_type: state.take_profit_order_type,
      stop_loss_order_type: state.stop_loss_order_type,
      time_limit_order_type: state.time_limit_order_type,
    };
    if (state.stop_loss > 0) tripleBarrier.stop_loss = state.stop_loss;
    if (state.take_profit > 0) tripleBarrier.take_profit = state.take_profit;
    if (state.time_limit > 0) tripleBarrier.time_limit = state.time_limit;
    if (state.trailing_stop_activation_price > 0 && state.trailing_stop_trailing_delta > 0) {
      tripleBarrier.trailing_stop = {
        activation_price: state.trailing_stop_activation_price,
        trailing_delta: state.trailing_stop_trailing_delta,
      };
    }

    const config: Record<string, unknown> = {
      connector_name: connector,
      trading_pair: pair,
      side: state.side,
      amount: state.amount,
      leverage: isSpot ? 1 : state.leverage,
      triple_barrier_config: tripleBarrier,
    };
    if (state.entry_price > 0) config.entry_price = state.entry_price;
    if (state.activation_bounds > 0) config.activation_bounds = state.activation_bounds;

    return { executor_type: "position_executor" as const, config };
  };

  const save = () => saveDefaults(state);

  const handleChartPriceSet = (field: "start" | "end" | "limit", price: number) => {
    if (field === "start") {
      dispatch({ type: "SET_FIELD", field: "entry_price", value: price });
    }
    dispatch({ type: "SET_FIELD", field: "activePickField", value: null });
  };

  return { state, dispatch, validation, chartProps, buildPayload, save, handleChartPriceSet };
}
