import { describe, expect, it } from 'vitest';
import {
  WorkingCalendar,
  canPause,
  computeDeadline,
  orthodoxEaster,
  proposedRomanianHolidays,
  trafficLight,
  type DeadlineRule,
} from './index.js';

const cal2026 = new WorkingCalendar({ holidays: proposedRomanianHolidays(2026).map((h) => h.day) });
const working20: DeadlineRule = { dayType: 'working', days: 20, pauseMode: 'suspend', maxPauses: 10 };

describe('orthodoxEaster', () => {
  it.each([
    [2024, '2024-05-05'],
    [2025, '2025-04-20'],
    [2026, '2026-04-12'],
    [2027, '2027-05-02'],
    [2028, '2028-04-16'],
  ])('%i -> %s', (year, expected) => expect(orthodoxEaster(year)).toBe(expected));
});

describe('proposedRomanianHolidays', () => {
  it('includes the movable holidays of 2026 and merges Rusalii with 1 June', () => {
    const days = proposedRomanianHolidays(2026).map((h) => h.day);
    expect(days).toContain('2026-04-10'); // Vinerea Mare
    expect(days).toContain('2026-04-13'); // a doua zi de Paste
    expect(days).toContain('2026-05-31'); // Rusalii
    expect(days.filter((d) => d === '2026-06-01')).toHaveLength(1);
    expect(new Set(days).size).toBe(days.length);
  });
});

describe('WorkingCalendar', () => {
  it('skips weekends and holidays', () => {
    expect(cal2026.isWorkingDay('2026-10-07')).toBe(true); // Wednesday
    expect(cal2026.isWorkingDay('2026-10-10')).toBe(false); // Saturday
    expect(cal2026.isWorkingDay('2026-12-01')).toBe(false);
  });

  it('honours exceptions (recovered working Saturday, extra day off)', () => {
    const cal = new WorkingCalendar({ holidays: [], exceptions: [['2026-10-10', true], ['2026-10-09', false]] });
    expect(cal.isWorkingDay('2026-10-10')).toBe(true);
    expect(cal.isWorkingDay('2026-10-09')).toBe(false);
  });

  it('adds working days across the Christmas holidays', () => {
    // Wed 23 Dec 2026 + 3 working days: 24 (Thu), [25, 26 holidays, 27 Sun], 28 (Mon), 29 (Tue)
    expect(cal2026.addWorkingDays('2026-12-23', 3)).toBe('2026-12-29');
  });
});

describe('computeDeadline', () => {
  it('20 working days from Wed 7 Oct 2026 ends on Wed 4 Nov 2026', () => {
    expect(computeDeadline(working20, '2026-10-07', [], cal2026).dueOn).toBe('2026-11-04');
  });

  it('a 4 working-day suspension moves the deadline by 4 working days (acceptance 4.6)', () => {
    const base = computeDeadline(working20, '2026-10-07', [], cal2026).dueOn!;
    // paused Mon 12 Oct, resumed Fri 16 Oct: Mon-Thu are not counted
    const paused = computeDeadline(working20, '2026-10-07', [{ from: '2026-10-12', to: '2026-10-16' }], cal2026);
    expect(paused.dueOn).toBe(cal2026.addWorkingDays(base, 4));
    expect(paused.pausedDays).toBe(4);
  });

  it('has no due date while paused', () => {
    const s = computeDeadline(working20, '2026-10-07', [{ from: '2026-10-12', to: null }], cal2026, { today: '2026-10-14' });
    expect(s).toMatchObject({ dueOn: null, paused: true, consumed: 2, pausedDays: 3 });
  });

  it('restart mode counts the full term again from the resume day', () => {
    const rule: DeadlineRule = { ...working20, pauseMode: 'restart' };
    const s = computeDeadline(rule, '2026-10-07', [{ from: '2026-10-12', to: '2026-10-16' }], cal2026);
    expect(s.dueOn).toBe(cal2026.addWorkingDays('2026-10-15', 20));
  });

  it('calendar-day terms ending on a weekend roll to the next working day', () => {
    const rule: DeadlineRule = { dayType: 'calendar', days: 30, pauseMode: 'suspend' };
    // 7 Oct + 30 = Fri 6 Nov ; 4 Oct + 30 = Tue 3 Nov
    expect(computeDeadline(rule, '2026-10-07', [], cal2026).dueOn).toBe('2026-11-06');
    expect(computeDeadline(rule, '2026-10-04', [], cal2026).dueOn).toBe('2026-11-03');
  });

  it('applies the extension only when granted', () => {
    const rule: DeadlineRule = { dayType: 'calendar', days: 30, pauseMode: 'suspend', extensionDays: 15 };
    expect(computeDeadline(rule, '2026-10-07', [], cal2026, { extended: true }).dueOn).toBe('2026-11-23');
  });
});

describe('canPause', () => {
  it('blocks a pause beyond the cap', () => {
    expect(canPause(working20, 9, 0)).toEqual({ allowed: true });
    expect(canPause(working20, 10, 0)).toEqual({ allowed: false, reason: 'max_pauses' });
    expect(canPause({ ...working20, maxPausedDays: 15 }, 1, 15)).toEqual({ allowed: false, reason: 'max_paused_days' });
  });
});

describe('trafficLight', () => {
  it('is red after the due date, yellow close to it, green otherwise', () => {
    expect(trafficLight('2026-11-04', '2026-11-05', 2, cal2026)).toBe('red');
    expect(trafficLight('2026-11-04', '2026-11-02', 2, cal2026)).toBe('yellow');
    expect(trafficLight('2026-11-04', '2026-10-20', 2, cal2026)).toBe('green');
  });
});
