import { Ajv2020 } from 'ajv/dist/2020.js';
import schema from '../process-definition.schema.json' with { type: 'json' };
import { ruleVariables } from './rules.js';
import type { Action, JsonLogic, ProcessDefinition, StepDef } from './types.js';

export interface DefinitionProblem {
  path: string;
  message: string;
}

const ajv = new Ajv2020({ allErrors: true, strict: false });
const validateSchema = ajv.compile(schema);

function outgoing(step: StepDef): string[] {
  return [
    ...(step.paths ?? []).map((p) => p.to),
    ...(step.branches ?? []).map((b) => b.to),
    ...(step.next ? [step.next] : []),
  ];
}

/**
 * Validates a process definition: JSON Schema first, then the cross references the schema
 * cannot express (paths to existing steps, reachable steps, known fields, documents, deadlines).
 */
export function validateDefinition(input: unknown): { ok: true; definition: ProcessDefinition } | { ok: false; problems: DefinitionProblem[] } {
  if (!validateSchema(input)) {
    return {
      ok: false,
      problems: (validateSchema.errors ?? []).map((e) => ({ path: e.instancePath || '/', message: e.message ?? 'invalid' })),
    };
  }
  const def = input as unknown as ProcessDefinition;
  const problems: DefinitionProblem[] = [];
  const add = (path: string, message: string) => problems.push({ path, message });

  const unique = (keys: string[], what: string) => {
    const seen = new Set<string>();
    for (const k of keys) {
      if (seen.has(k)) add(what, `duplicate key "${k}"`);
      seen.add(k);
    }
    return seen;
  };
  const steps = new Map(def.steps.map((s) => [s.key, s]));
  unique(def.steps.map((s) => s.key), '/steps');
  const fields = unique(def.fields.map((f) => f.key), '/fields');
  const documents = unique((def.documents ?? []).map((d) => d.key), '/documents');
  const deadlines = unique((def.deadlines ?? []).map((d) => d.key), '/deadlines');
  const checklists = unique((def.checklists ?? []).map((c) => c.key), '/checklists');

  const starts = def.steps.filter((s) => s.type === 'start');
  if (starts.length !== 1) add('/steps', `exactly one start step is required (found ${starts.length})`);
  if (!def.steps.some((s) => s.type === 'end_positive' || s.type === 'end_negative')) add('/steps', 'at least one end step is required');

  const checkRuleVars = (rule: JsonLogic | undefined, where: string) => {
    for (const v of ruleVariables(rule)) {
      const [scope, name] = v.split('.');
      if (scope === 'fields' && name && !fields.has(name)) add(where, `rule uses unknown field "${name}"`);
    }
  };
  const checkActions = (actions: Action[] | undefined, where: string) => {
    (actions ?? []).forEach((a, i) => {
      const p = `${where}/${i}`;
      if (typeof a.document === 'string' && !documents.has(a.document)) add(p, `unknown document "${a.document}"`);
      if (typeof a.deadline === 'string' && !deadlines.has(a.deadline)) add(p, `unknown deadline "${a.deadline}"`);
      if (a.type === 'set_field' && typeof a.field === 'string' && !fields.has(a.field)) add(p, `unknown field "${a.field}"`);
      if (a.type === 'start_subflow' && typeof a.subflow !== 'string') add(p, 'start_subflow needs "subflow"');
      for (const key of ['principal', 'dueDate', 'reason', 'accessories']) {
        if (a.type === 'create_debt' && typeof a[key] === 'string' && !fields.has(a[key] as string)) add(p, `create_debt.${key} uses unknown field "${a[key]}"`);
      }
      if (a.type === 'update_project') {
        for (const f of Object.values((a.set as Record<string, string>) ?? {})) if (!fields.has(f)) add(p, `update_project uses unknown field "${f}"`);
      }
      checkRuleVars(a.when, p);
    });
  };

  def.steps.forEach((s, i) => {
    const p = `/steps/${i}`;
    for (const to of outgoing(s)) if (!steps.has(to)) add(p, `step "${s.key}" points to unknown step "${to}"`);
    const isEnd = s.type === 'end_positive' || s.type === 'end_negative';
    if (!isEnd && outgoing(s).length === 0) add(p, `step "${s.key}" has no way out`);
    if (isEnd && outgoing(s).length > 0) add(p, `end step "${s.key}" must not have outgoing paths`);
    for (const f of Object.keys(s.fieldAccess ?? {})) if (!fields.has(f)) add(p, `fieldAccess uses unknown field "${f}"`);
    if (s.checklist && !checklists.has(s.checklist)) add(p, `unknown checklist "${s.checklist}"`);
    if (s.deadline && !deadlines.has(s.deadline)) add(p, `unknown deadline "${s.deadline}"`);
    if (s.assignment?.rule === 'previous_actor' && (!s.assignment.step || !steps.has(s.assignment.step))) {
      add(p, 'previous_actor assignment needs an existing "step"');
    }
    if (s.type === 'decision' && (s.paths ?? []).some((x) => x.visibleWhen === undefined)) {
      add(p, 'every path of a decision step needs a visibleWhen condition');
    }
    (s.branches ?? []).forEach((b, j) => checkRuleVars(b.when, `${p}/branches/${j}`));
    (s.paths ?? []).forEach((path, j) => {
      const pp = `${p}/paths/${j}`;
      checkRuleVars(path.visibleWhen, pp);
      for (const v of path.validations ?? []) checkRuleVars(v.rule, pp);
      for (const d of path.requiresSignatures ?? []) if (!documents.has(d)) add(pp, `unknown document "${d}"`);
      if (path.requiresChecklistComplete && !checklists.has(path.requiresChecklistComplete)) {
        add(pp, `unknown checklist "${path.requiresChecklistComplete}"`);
      }
      checkActions(path.actions, `${pp}/actions`);
    });
    checkActions(s.onEnter, `${p}/onEnter`);
    checkActions(s.onExit, `${p}/onExit`);
  });

  (def.deadlines ?? []).forEach((d, i) => {
    for (const k of [d.startsAt, ...(d.stopsAt ?? [])]) if (k && !steps.has(k)) add(`/deadlines/${i}`, `unknown step "${k}"`);
    checkRuleVars(d.when, `/deadlines/${i}`);
  });
  (def.separationOfDuties ?? []).forEach((r, i) => {
    for (const k of r.steps) if (!steps.has(k)) add(`/separationOfDuties/${i}`, `unknown step "${k}"`);
  });
  for (const k of def.conflictOfInterest?.steps ?? []) if (!steps.has(k)) add('/conflictOfInterest', `unknown step "${k}"`);
  if (def.invoiceCheck) {
    const list = def.fields.find((f) => f.key === def.invoiceCheck!.list && f.type === 'line_items');
    if (!list) add('/invoiceCheck', `"${def.invoiceCheck.list}" is not a line_items field`);
    for (const col of [def.invoiceCheck.supplier, def.invoiceCheck.number, def.invoiceCheck.date, def.invoiceCheck.amount]) {
      if (col && list && !list.columns?.some((c) => c.key === col)) add('/invoiceCheck', `unknown column "${col}"`);
    }
  }
  def.fields.forEach((f, i) => {
    if (f.type === 'line_items' && !f.columns?.length) add(`/fields/${i}`, 'line_items needs columns');
    if (f.type === 'calculated' && f.formula === undefined) add(`/fields/${i}`, 'calculated field needs a formula');
    if ((f.type === 'choice' || f.type === 'multichoice') && !f.nomenclature) add(`/fields/${i}`, 'choice field needs a nomenclature');
    checkRuleVars(f.formula, `/fields/${i}`);
  });

  if (starts[0]) {
    const seen = new Set<string>();
    const stack = [starts[0].key];
    while (stack.length) {
      const k = stack.pop()!;
      if (seen.has(k)) continue;
      seen.add(k);
      const s = steps.get(k);
      if (s) stack.push(...outgoing(s));
    }
    for (const s of def.steps) if (!seen.has(s.key)) add('/steps', `step "${s.key}" is not reachable from the start`);
  }

  return problems.length ? { ok: false, problems } : { ok: true, definition: def };
}
