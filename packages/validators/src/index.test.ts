import { describe, expect, it } from 'vitest';
import {
  addAmounts,
  checkCui,
  checkIban,
  checkSmisCode,
  compareAmounts,
  formatAmount,
  formatDate,
  parseAmount,
  parseDate,
  subtractAmounts,
} from './index.js';

describe('checkCui', () => {
  it.each(['1590082', 'RO1590082', '18547290'])('accepts %s', (c) => expect(checkCui(c).ok).toBe(true));
  it.each(['1590083', '1', 'ABC', ''])('rejects %s', (c) => expect(checkCui(c).ok).toBe(false));
});

describe('checkIban', () => {
  it('accepts a valid Romanian IBAN, with or without spaces', () => {
    expect(checkIban('RO49AAAA1B31007593840000').ok).toBe(true);
    expect(checkIban('ro49 aaaa 1b31 0075 9384 0000').ok).toBe(true);
  });
  it('rejects wrong check digits and wrong length', () => {
    expect(checkIban('RO48AAAA1B31007593840000').ok).toBe(false);
    expect(checkIban('RO49AAAA1B3100759384000').ok).toBe(false);
  });
});

describe('checkSmisCode', () => {
  it('accepts 5-7 digits only', () => {
    expect(checkSmisCode('302345').ok).toBe(true);
    expect(checkSmisCode('30A345').ok).toBe(false);
  });
});

describe('amounts', () => {
  it('parses Romanian and canonical formats', () => {
    expect(parseAmount('1.234,56')).toBe('1234.56');
    expect(parseAmount('1234,5')).toBe('1234.50');
    expect(parseAmount('1234.56')).toBe('1234.56');
    expect(parseAmount('1.234.567')).toBe('1234567.00');
    expect(parseAmount(0.1 + 0.2)).toBe('0.30');
    expect(() => parseAmount('12,345,6')).toThrow();
  });
  it('adds without floating point errors', () => {
    expect(addAmounts('0.10', '0.20', null)).toBe('0.30');
    expect(subtractAmounts('100.00', '100.01')).toBe('-0.01');
    expect(compareAmounts('10.00', '9.99')).toBe(1);
  });
  it('formats for display', () => {
    expect(formatAmount('1234567.5')).toBe('1.234.567,50');
    expect(formatAmount('-0.01')).toBe('-0,01');
  });
});

describe('dates', () => {
  it('formats and parses dd.mm.yyyy', () => {
    expect(formatDate('2026-10-07')).toBe('07.10.2026');
    expect(parseDate('7.10.2026')).toBe('2026-10-07');
  });
});
