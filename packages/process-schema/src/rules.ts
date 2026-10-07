import jsonLogic from 'json-logic-js';
import { addAmounts, compareAmounts, multiplyAmount, parseAmount, subtractAmounts } from '@flux/validators';
import type { JsonLogic } from './types.js';

// Amount operators: JSONLogic's own + and - work on floats; money must not.
const amt = (v: unknown): string => {
  if (v === null || v === undefined || v === '') return '0.00';
  if (typeof v === 'number' && !Number.isFinite(v)) throw new Error('not a number');
  return parseAmount(typeof v === 'number' ? v : String(v));
};

jsonLogic.add_operation('amount_add', (...xs: unknown[]) => addAmounts(...xs.map(amt)));
/** amount_mul: [amount, factor] -> amount × factor (quantity or rate), exact to the ban. */
jsonLogic.add_operation('amount_mul', (a: unknown, f: unknown) => {
  const n = Number(typeof f === 'number' ? f : String(f ?? '0').replace(',', '.'));
  if (!Number.isFinite(n)) throw new Error('not a number');
  return multiplyAmount(amt(a), n.toFixed(6));
});
jsonLogic.add_operation('amount_sub', (a: unknown, b: unknown) => subtractAmounts(amt(a), amt(b)));
jsonLogic.add_operation('amount_lte', (a: unknown, b: unknown) => compareAmounts(amt(a), amt(b)) <= 0);
jsonLogic.add_operation('amount_lt', (a: unknown, b: unknown) => compareAmounts(amt(a), amt(b)) < 0);
jsonLogic.add_operation('amount_gte', (a: unknown, b: unknown) => compareAmounts(amt(a), amt(b)) >= 0);
jsonLogic.add_operation('amount_eq', (a: unknown, b: unknown) => compareAmounts(amt(a), amt(b)) === 0);
/** amount_sum: [rows, columnKey] -> sum of that column over the rows. */
jsonLogic.add_operation('amount_sum', (rows: unknown, column: unknown) => {
  if (!Array.isArray(rows)) return '0.00';
  return addAmounts(...rows.map((r) => amt((r as Record<string, unknown> | null)?.[String(column)])));
});

export function evaluate(rule: JsonLogic | undefined, data: unknown): unknown {
  if (rule === undefined) return undefined;
  return jsonLogic.apply(rule as never, data);
}

export function truthy(rule: JsonLogic | undefined, data: unknown): boolean {
  if (rule === undefined) return true;
  return jsonLogic.truthy(evaluate(rule, data));
}

/** Variable names a rule reads (e.g. "fields.total_eligible"), for static checks. */
export function ruleVariables(rule: JsonLogic | undefined): string[] {
  if (rule === undefined || typeof rule === 'boolean') return [];
  return jsonLogic.uses_data(rule as never) as string[];
}
