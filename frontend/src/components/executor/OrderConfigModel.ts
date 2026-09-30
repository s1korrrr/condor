import { useMemo, useReducer } from "react";
import type { ChartPriceMapping, ExecutorValidation } from "./types";

// ── State ──

export interface OrderState {
  side: 1 | 2;
  amount: number;
  execution_strategy: string;
  price: number;
  leverage: number;
  chaser_distance: number;
  chaser_refresh_threshold: number;
  position_action: string;
  activePickField: string | null;
}

export type OrderAction =
  | { type: "SET_FIELD"; field: string; value: unknown }
  | { type: "SET_CONNECTOR"; value: string }
  | { type: "SET_PAIR"; value: string };

const DEFAULTS: OrderState = {
  side: 1,
  amount: 0,
  execution_strategy: "LIMIT",
  price: 0,
  leverage: 1,
  chaser_distance: 0.0005,
  chaser_refresh_threshold: 0.001,
  position_action: "OPEN",
  activePickField: null,
};

const STORAGE_KEY = "condor_order_defaults";

const PERSISTED_FIELDS: (keyof OrderState)[] = [
  "side", "amount", "execution_strategy", "leverage",
  "chaser_distance", "chaser_refresh_threshold", "position_action",
];

function loadSavedDefaults(): OrderState {
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

function saveDefaults(state: OrderState) {
  const toSave: Record<string, unknown> = {};
  for (const key of PERSISTED_FIELDS) toSave[key] = state[key];
  localStorage.setItem(STORAGE_KEY, JSON.stringify(toSave));
}

function orderReducer(state: OrderState, action: OrderAction): OrderState {
  switch (action.type) {
    case "SET_FIELD":
      return { ...state, [action.field]: action.value };
    case "SET_CONNECTOR":
    case "SET_PAIR":
      return { ...state, price: 0 };
    default:
      return state;
  }
}

// ── Validation ──

export function useOrderValidation(state: OrderState): ExecutorValidation {
  return useMemo(() => {
    const errors: string[] = [];
    if (state.amount <= 0) errors.push("Amount required (base currency)");
    const needsPrice = state.execution_strategy === "LIMIT" || state.execution_strategy === "LIMIT_MAKER";
    if (needsPrice && state.price <= 0) errors.push("Price required for limit orders");
    if (state.execution_strategy === "LIMIT_CHASER") {
      if (state.chaser_distance <= 0) errors.push("Chaser distance required");
      if (state.chaser_refresh_threshold <= 0) errors.push("Chaser refresh threshold required");
    }
    return { valid: errors.length === 0, errors };
  }, [state]);
}

// ── Hook ──

export function useOrderConfig() {
  const [state, dispatch] = useReducer(orderReducer, undefined, loadSavedDefaults);
  const validation = useOrderValidation(state);

  const chartProps: ChartPriceMapping = useMemo(() => ({
    startPrice: state.price,
    endPrice: 0,
    limitPrice: 0,
    side: state.side,
    minSpread: 0,
    activePickField: state.activePickField === "price" ? "start" : null,
  }), [state.price, state.side, state.activePickField]);

  const buildPayload = (connector: string, pair: string, isSpot: boolean) => {
    const config: Record<string, unknown> = {
      connector_name: connector,
      trading_pair: pair,
      side: state.side,
      amount: state.amount,
      leverage: isSpot ? 1 : state.leverage,
      execution_strategy: state.execution_strategy,
    };

    if (state.execution_strategy === "LIMIT" || state.execution_strategy === "LIMIT_MAKER") {
      config.price = state.price;
    }
    if (state.execution_strategy === "LIMIT_CHASER") {
      config.chaser_config = {
        distance: state.chaser_distance,
        refresh_threshold: state.chaser_refresh_threshold,
      };
    }
    if (state.position_action !== "OPEN") {
      config.position_action = state.position_action;
    }

    return { executor_type: "order_executor" as const, config };
  };

  const save = () => saveDefaults(state);

  const handleChartPriceSet = (field: "start" | "end" | "limit", price: number) => {
    if (field === "start") {
      dispatch({ type: "SET_FIELD", field: "price", value: price });
    }
    dispatch({ type: "SET_FIELD", field: "activePickField", value: null });
  };

  return { state, dispatch, validation, chartProps, buildPayload, save, handleChartPriceSet };
}

// ── Execution strategy options ──

export const STRATEGY_OPTIONS = [
  { value: "MARKET", label: "Market" },
  { value: "LIMIT", label: "Limit" },
  { value: "LIMIT_MAKER", label: "Limit Maker" },
  { value: "LIMIT_CHASER", label: "Limit Chaser" },
];

export const POSITION_ACTION_OPTIONS = [
  { value: "OPEN", label: "Open" },
  { value: "CLOSE", label: "Close" },
];
