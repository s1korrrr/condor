import { Sparkles } from "lucide-react";
import {
  AmountField, LeverageField, NumberField, PriceField, SectionHeader,
  SelectField, SideSelector, ValidationMessages, type FieldDispatch,
} from "./fields";
import { POSITION_ACTION_OPTIONS, STRATEGY_OPTIONS } from "./OrderConfigModel";
import type { ExecutorValidation } from "./types";
import type { OrderAction, OrderState } from "./OrderConfigModel";

// ── Panel Component ──

interface Props {
  state: OrderState;
  dispatch: React.Dispatch<OrderAction>;
  validation: ExecutorValidation;
  currentPrice: number | null;
  isSpot?: boolean;
  pair?: string;
}

export function OrderConfigPanel({ state, dispatch, validation, currentPrice, isSpot = false, pair }: Props) {
  const d = dispatch as FieldDispatch;
  const needsPrice = state.execution_strategy === "LIMIT" || state.execution_strategy === "LIMIT_MAKER";
  const isChaser = state.execution_strategy === "LIMIT_CHASER";

  return (
    <div className="flex flex-col gap-4 overflow-y-auto p-3">
      {/* Direction */}
      <SideSelector side={state.side} dispatch={d} />

      {/* Order Config */}
      <div className="space-y-2.5">
        <SectionHeader>Order</SectionHeader>
        <AmountField
          value={state.amount}
          field="amount"
          dispatch={d}
          currentPrice={currentPrice}
          step={0.001}
          pair={pair}
        />
        <SelectField
          label="Execution Strategy"
          value={state.execution_strategy}
          field="execution_strategy"
          dispatch={d}
          options={STRATEGY_OPTIONS}
        />
        <LeverageField value={state.leverage} field="leverage" dispatch={d} isSpot={isSpot} />
        {!isSpot && (
          <SelectField
            label="Position Action"
            value={state.position_action}
            field="position_action"
            dispatch={d}
            options={POSITION_ACTION_OPTIONS}
          />
        )}
      </div>

      {/* Price (for LIMIT strategies) */}
      {needsPrice && (
        <div className="space-y-2.5">
          <div className="flex items-center justify-between">
            <SectionHeader>Price</SectionHeader>
            {currentPrice && currentPrice > 0 && (
              <button
                onClick={() => d({ type: "SET_FIELD", field: "price", value: currentPrice })}
                className="flex items-center gap-1 rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-[10px] text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface-hover)]"
              >
                <Sparkles className="h-3 w-3" />
                Use current
              </button>
            )}
          </div>
          <PriceField
            label="Order Price"
            value={state.price}
            field="price"
            activePickField={state.activePickField}
            dispatch={d}
            valid={state.price > 0}
          />
        </div>
      )}

      {/* Chaser config */}
      {isChaser && (
        <div className="space-y-2.5">
          <SectionHeader>Chaser Config</SectionHeader>
          <NumberField
            label="Distance"
            value={state.chaser_distance}
            field="chaser_distance"
            dispatch={d}
            step={0.01}
            isPercent
            suffix="%"
          />
          <NumberField
            label="Refresh Threshold"
            value={state.chaser_refresh_threshold}
            field="chaser_refresh_threshold"
            dispatch={d}
            step={0.01}
            isPercent
            suffix="%"
          />
          <p className="text-[10px] text-[var(--color-text-muted)]">
            Chaser continuously adjusts limit order to chase the best price.
          </p>
        </div>
      )}

      <ValidationMessages errors={validation.errors} />
    </div>
  );
}
