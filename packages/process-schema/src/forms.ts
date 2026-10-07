import { checkCui, checkEmail, checkIban, checkSmisCode, parseAmount } from '@flux/validators';
import { evaluate, truthy } from './rules.js';
import type { ColumnDef, FieldAccess, FieldDef, ProcessDefinition, StepDef } from './types.js';

export type Row = Record<string, unknown>;
export type FieldValues = Record<string, unknown>;

export interface FieldError {
  field: string;
  row?: number;
  message: string;
}

export interface RuleContext {
  fields: FieldValues;
  project?: object | null;
  beneficiary?: object | null;
  instance?: object | null;
  user?: object | null;
}

export function findStep(def: ProcessDefinition, key: string): StepDef {
  const step = def.steps.find((s) => s.key === key);
  if (!step) throw new Error(`Unknown step ${key} in ${def.key}`);
  return step;
}

export function fieldAccess(def: ProcessDefinition, stepKey: string | null, field: FieldDef): FieldAccess {
  const explicit = stepKey ? findStep(def, stepKey).fieldAccess?.[field.key] : undefined;
  const access = explicit ?? 'visible';
  if (field.type === 'calculated' && (access === 'editable' || access === 'required')) return 'visible';
  return access;
}

export function isEditable(access: FieldAccess): boolean {
  return access === 'editable' || access === 'required';
}

const isEmpty = (v: unknown) =>
  v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);

/** Converts user input to the stored representation, or throws with a Romanian message. */
export function normalizeValue(field: { type: string; label: string }, raw: unknown): unknown {
  if (isEmpty(raw)) return null;
  switch (field.type) {
    case 'amount':
      return parseAmount(typeof raw === 'number' ? raw : String(raw));
    case 'integer': {
      const n = typeof raw === 'number' ? raw : Number(String(raw).replace(/\./g, ''));
      if (!Number.isInteger(n)) throw new Error(`„${field.label}” trebuie să fie un număr întreg.`);
      return n;
    }
    case 'percent': {
      const n = typeof raw === 'number' ? raw : Number(String(raw).replace(',', '.').replace('%', ''));
      if (!Number.isFinite(n)) throw new Error(`„${field.label}” trebuie să fie un procent.`);
      return n;
    }
    case 'boolean':
      return raw === true || raw === 'true' || raw === 'da' || raw === 1;
    case 'date': {
      const s = String(raw);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error(`„${field.label}” trebuie să fie o dată validă.`);
      return s;
    }
    case 'multichoice':
      return Array.isArray(raw) ? raw.map(String) : [String(raw)];
    case 'line_items':
      if (!Array.isArray(raw)) throw new Error(`„${field.label}” trebuie să fie un tabel.`);
      return raw;
    default:
      return typeof raw === 'string' ? raw.trim() : raw;
  }
}

export function normalizeRow(columns: ColumnDef[], row: Row): Row {
  const out: Row = {};
  for (const c of columns) {
    if (c.type === 'calculated') continue;
    out[c.key] = normalizeValue(c, row[c.key]);
  }
  return out;
}

/** Fills calculated columns and calculated fields. Order: rows first, then fields in definition order. */
export function computeCalculated(def: ProcessDefinition, ctx: RuleContext): FieldValues {
  const fields: FieldValues = { ...ctx.fields };
  for (const f of def.fields) {
    if (f.type !== 'line_items' || !f.columns) continue;
    const rows = Array.isArray(fields[f.key]) ? (fields[f.key] as Row[]) : [];
    fields[f.key] = rows.map((row) => {
      const r: Row = { ...row };
      for (const c of f.columns!) {
        if (c.type === 'calculated' && c.formula !== undefined) r[c.key] = evaluate(c.formula, { ...ctx, fields, row: r });
      }
      return r;
    });
  }
  for (const f of def.fields) {
    if (f.type === 'calculated' && f.formula !== undefined) {
      fields[f.key] = evaluate(f.formula, { ...ctx, fields });
    }
  }
  return fields;
}

function formatError(field: FieldDef, value: unknown): string | null {
  if (isEmpty(value) || typeof value !== 'string') return null;
  const check =
    field.format === 'cui' ? checkCui(value)
    : field.format === 'iban' ? checkIban(value)
    : field.format === 'smis_code' ? checkSmisCode(value)
    : field.format === 'email' ? checkEmail(value)
    : null;
  if (check && !check.ok) return check.message;
  if (field.pattern && !new RegExp(field.pattern).test(value)) return `„${field.label}” nu are formatul cerut.`;
  return null;
}

function rangeError(field: FieldDef, value: unknown): string | null {
  if (typeof value !== 'number') return null;
  if (field.min !== undefined && value < field.min) return `„${field.label}” trebuie să fie cel puțin ${field.min}.`;
  if (field.max !== undefined && value > field.max) return `„${field.label}” trebuie să fie cel mult ${field.max}.`;
  return null;
}

/**
 * Validates the values visible at a step: required fields are filled, formats are right and row
 * rules hold. `fields` must already contain calculated values (see computeCalculated).
 */
export function validateForStep(def: ProcessDefinition, stepKey: string, ctx: RuleContext): FieldError[] {
  const errors: FieldError[] = [];
  for (const f of def.fields) {
    const access = fieldAccess(def, stepKey, f);
    if (access === 'hidden') continue;
    const value = ctx.fields[f.key];
    if (access === 'required' && isEmpty(value)) {
      errors.push({ field: f.key, message: `Completați câmpul „${f.label}”.` });
      continue;
    }
    const fmt = formatError(f, value) ?? rangeError(f, value);
    if (fmt) errors.push({ field: f.key, message: fmt });
    if (f.type === 'line_items' && Array.isArray(value)) {
      value.forEach((row, i) => {
        for (const v of f.rowValidations ?? []) {
          if (!truthy(v.rule, { ...ctx, row })) errors.push({ field: f.key, row: i, message: `Rândul ${i + 1}: ${v.message}` });
        }
      });
    }
  }
  return errors;
}
