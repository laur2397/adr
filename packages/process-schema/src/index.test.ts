import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { computeCalculated, evaluate, fieldAccess, validateDefinition, validateForStep, type ProcessDefinition } from './index.js';

const p1 = JSON.parse(readFileSync(new URL('../../../examples/process-p1.json', import.meta.url), 'utf8'));

describe('validateDefinition', () => {
  it('accepts the P1 package', () => {
    const r = validateDefinition(p1);
    expect(r.ok ? [] : r.problems).toEqual([]);
  });

  it('reports schema errors', () => {
    const r = validateDefinition({ key: 'x' });
    expect(r.ok).toBe(false);
  });

  it('reports broken references and unreachable steps', () => {
    const broken = structuredClone(p1);
    broken.steps.find((s: { key: string }) => s.key === 'head_review').paths[0].to = 'nowhere';
    broken.steps.push({ key: 'orphan', type: 'end_negative', name: 'Orfan' });
    broken.steps.find((s: { key: string }) => s.key === 'evf_check').fieldAccess.unknown_field = 'editable';
    const r = validateDefinition(broken);
    expect(r.ok).toBe(false);
    const messages = r.ok ? [] : r.problems.map((p) => p.message);
    expect(messages).toEqual(
      expect.arrayContaining([
        'step "head_review" points to unknown step "nowhere"',
        'step "orphan" is not reachable from the start',
        'fieldAccess uses unknown field "unknown_field"',
      ]),
    );
  });
});

describe('forms', () => {
  const def = p1 as ProcessDefinition;
  const expenses = [
    { budget_line: 'L1', document_ref: 'F 12', requested: '1000.10', eligible: '1000.10', reason: null },
    { budget_line: 'L2', document_ref: 'F 13', requested: '0.20', eligible: '0.10', reason: null },
  ];

  it('computes row and total amounts exactly', () => {
    const fields = computeCalculated(def, { fields: { expenses, request_type: 'plata' } });
    expect(fields.total_requested).toBe('1000.30');
    expect(fields.total_eligible).toBe('1000.20');
    expect((fields.expenses as Array<Record<string, unknown>>)[1]!.non_eligible).toBe('0.10');
    expect(fields.cfpp_required).toBe(true);
  });

  it('requires a reason when an amount is reduced, and required fields at the step', () => {
    const fields = computeCalculated(def, { fields: { expenses } });
    const errors = validateForStep(def, 'evf_check', { fields });
    expect(errors.map((e) => e.message)).toEqual([
      'Rândul 2: Ați diminuat suma: completați motivul în coloana Motiv.',
      'Completați câmpul „Constatări”.',
    ]);
  });

  it('applies the field matrix, calculated fields are never editable', () => {
    const findings = def.fields.find((f) => f.key === 'findings')!;
    const total = def.fields.find((f) => f.key === 'total_eligible')!;
    expect(fieldAccess(def, 'registration', findings)).toBe('hidden');
    expect(fieldAccess(def, 'evf_check', findings)).toBe('required');
    expect(fieldAccess(def, 'evf_check', { ...total, key: 'expenses' })).toBe('visible');
  });

  it('amount operators avoid float errors', () => {
    expect(evaluate({ amount_add: ['0.1', '0.2'] }, {})).toBe('0.30');
    expect(evaluate({ amount_lte: ['0.30', { amount_add: ['0.1', '0.2'] }] }, {})).toBe(true);
  });
});
