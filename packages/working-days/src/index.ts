/**
 * Working-day calendar and deadline computation.
 *
 * Dates are plain ISO strings (YYYY-MM-DD) handled in UTC, so results never depend on the
 * server time zone. Nothing here hard-codes a legal term: the caller passes the deadline rule
 * (from deadline_definition) and the calendar (from the holiday tables).
 */

export type IsoDate = string;

const DAY_MS = 86_400_000;

export function toDate(iso: IsoDate): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) throw new Error(`Invalid date: ${iso}`);
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso) throw new Error(`Invalid date: ${iso}`);
  return d;
}

export function toIso(d: Date): IsoDate {
  return d.toISOString().slice(0, 10);
}

export function addDays(iso: IsoDate, n: number): IsoDate {
  return toIso(new Date(toDate(iso).getTime() + n * DAY_MS));
}

export function compareIso(a: IsoDate, b: IsoDate): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Orthodox Easter Sunday (Gregorian date) - Meeus' Julian algorithm + 13 days (valid 1900-2099). */
export function orthodoxEaster(year: number): IsoDate {
  const a = year % 4;
  const b = year % 7;
  const c = year % 19;
  const d = (19 * c + 15) % 30;
  const e = (2 * a + 4 * b - d + 34) % 7;
  const month = Math.floor((d + e + 114) / 31);
  const day = ((d + e + 114) % 31) + 1;
  const julian = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return addDays(julian, 13);
}

export interface Holiday {
  day: IsoDate;
  name: string;
}

/**
 * Proposed list of Romanian public holidays for a year (Codul muncii, art. 139, as amended up to
 * 2024). It only seeds the per-year calendar; administrators review and edit it, and the
 * database calendar is the source of truth.
 */
export function proposedRomanianHolidays(year: number): Holiday[] {
  const easter = orthodoxEaster(year);
  const fixed: Array<[string, string]> = [
    ['01-01', 'Anul Nou'],
    ['01-02', 'Anul Nou'],
    ['01-06', 'Botezul Domnului - Boboteaza'],
    ['01-07', 'Soborul Sfântului Ioan Botezătorul'],
    ['01-24', 'Ziua Unirii Principatelor Române'],
    ['05-01', 'Ziua Muncii'],
    ['06-01', 'Ziua Copilului'],
    ['08-15', 'Adormirea Maicii Domnului'],
    ['11-30', 'Sfântul Apostol Andrei'],
    ['12-01', 'Ziua Națională a României'],
    ['12-25', 'Crăciunul'],
    ['12-26', 'Crăciunul'],
  ];
  const list: Holiday[] = fixed.map(([md, name]) => ({ day: `${year}-${md}`, name }));
  list.push(
    { day: addDays(easter, -2), name: 'Vinerea Mare' },
    { day: easter, name: 'Paștele' },
    { day: addDays(easter, 1), name: 'Paștele' },
    { day: addDays(easter, 49), name: 'Rusaliile' },
    { day: addDays(easter, 50), name: 'Rusaliile' },
  );
  // Several holidays can fall on the same day (e.g. Rusalii on 1 June): keep one entry per day.
  const byDay = new Map<IsoDate, Holiday>();
  for (const h of list) {
    const existing = byDay.get(h.day);
    byDay.set(h.day, existing ? { day: h.day, name: `${existing.name}; ${h.name}` } : h);
  }
  return [...byDay.values()].sort((x, y) => compareIso(x.day, y.day));
}

export interface CalendarData {
  holidays: Iterable<IsoDate>;
  /** Overrides: a weekend day worked (true) or an extra day off (false). */
  exceptions?: Iterable<[IsoDate, boolean]>;
}

export class WorkingCalendar {
  private readonly holidays: Set<IsoDate>;
  private readonly exceptions: Map<IsoDate, boolean>;

  constructor(data: CalendarData = { holidays: [] }) {
    this.holidays = new Set(data.holidays);
    this.exceptions = new Map(data.exceptions ?? []);
  }

  isWorkingDay(iso: IsoDate): boolean {
    const override = this.exceptions.get(iso);
    if (override !== undefined) return override;
    const dow = toDate(iso).getUTCDay();
    return dow !== 0 && dow !== 6 && !this.holidays.has(iso);
  }

  nextWorkingDay(iso: IsoDate): IsoDate {
    let d = iso;
    while (!this.isWorkingDay(d)) d = addDays(d, 1);
    return d;
  }

  /** The n-th working day after `start` (start itself is not counted). */
  addWorkingDays(start: IsoDate, n: number): IsoDate {
    let d = start;
    let left = n;
    while (left > 0) {
      d = addDays(d, 1);
      if (this.isWorkingDay(d)) left--;
    }
    return d;
  }

  /** Working days in the half-open interval (from, to]. */
  workingDaysBetween(from: IsoDate, to: IsoDate): number {
    let count = 0;
    for (let d = addDays(from, 1); compareIso(d, to) <= 0; d = addDays(d, 1)) {
      if (this.isWorkingDay(d)) count++;
    }
    return count;
  }
}

export type DayType = 'calendar' | 'working';
export type PauseMode = 'suspend' | 'restart';

export interface DeadlineRule {
  dayType: DayType;
  days: number;
  pauseMode: PauseMode;
  maxPauses?: number | null;
  maxPausedDays?: number | null;
  /** Additional days granted by an extension (e.g. OG 27/2002), added when `extended` is true. */
  extensionDays?: number | null;
  /** For calendar-day terms ending on a non-working day: move to the next working day. */
  rollToWorkingDay?: boolean;
}

export interface Pause {
  /** First day the clock is stopped. */
  from: IsoDate;
  /** Day the clock runs again (counted). Null while still paused. */
  to: IsoDate | null;
}

export interface DeadlineState {
  /** Null while paused: the due date depends on when the clock resumes. */
  dueOn: IsoDate | null;
  /** Days already consumed (in the rule's day type) up to `today`. */
  consumed: number;
  /** Days spent paused (in the rule's day type), for the cap on paused days. */
  pausedDays: number;
  paused: boolean;
}

/**
 * Computes a deadline from its start date, rule and pauses.
 *
 * - 'suspend': days inside a pause [from, to) are not counted; counting continues where it stopped.
 * - 'restart': after a pause the full term starts again from the resume day.
 */
export function computeDeadline(
  rule: DeadlineRule,
  start: IsoDate,
  pauses: Pause[],
  calendar: WorkingCalendar,
  options: { today?: IsoDate; extended?: boolean } = {},
): DeadlineState {
  const sorted = [...pauses].sort((a, b) => compareIso(a.from, b.from));
  const counts = (d: IsoDate) => rule.dayType === 'calendar' || calendar.isWorkingDay(d);
  const total = rule.days + (options.extended ? (rule.extensionDays ?? 0) : 0);
  const open = sorted.find((p) => p.to === null);

  let pausedDays = 0;
  for (const p of sorted) {
    const end = p.to ?? addDays(options.today ?? p.from, 1);
    for (let d = p.from; compareIso(d, end) < 0; d = addDays(d, 1)) if (counts(d)) pausedDays++;
  }

  let effectiveStart = start;
  let applicable = sorted;
  if (rule.pauseMode === 'restart') {
    const last = [...sorted].reverse().find((p) => p.to !== null);
    if (last?.to) {
      effectiveStart = addDays(last.to, -1); // the resume day is the first counted day
      applicable = sorted.filter((p) => compareIso(p.from, last.to!) >= 0);
    }
  }

  const isPaused = (d: IsoDate) =>
    applicable.some((p) => compareIso(d, p.from) >= 0 && (p.to === null || compareIso(d, p.to) < 0));

  const consumedUntil = (limit: IsoDate) => {
    let n = 0;
    for (let d = addDays(effectiveStart, 1); compareIso(d, limit) <= 0; d = addDays(d, 1)) {
      if (counts(d) && !isPaused(d)) n++;
    }
    return n;
  };

  const today = options.today ?? start;
  const consumed = compareIso(today, effectiveStart) > 0 ? consumedUntil(today) : 0;

  if (open) return { dueOn: null, consumed, pausedDays, paused: true };

  let d = effectiveStart;
  let left = total;
  while (left > 0) {
    d = addDays(d, 1);
    if (counts(d) && !isPaused(d)) left--;
  }
  if (rule.dayType === 'calendar' && (rule.rollToWorkingDay ?? true)) d = calendar.nextWorkingDay(d);
  return { dueOn: d, consumed, pausedDays, paused: false };
}

export type PauseCheck = { allowed: true } | { allowed: false; reason: 'max_pauses' | 'max_paused_days' };

/** Whether one more pause is allowed under the rule's caps. */
export function canPause(rule: DeadlineRule, pauseCount: number, pausedDays: number): PauseCheck {
  if (rule.maxPauses != null && pauseCount >= rule.maxPauses) return { allowed: false, reason: 'max_pauses' };
  if (rule.maxPausedDays != null && pausedDays >= rule.maxPausedDays) return { allowed: false, reason: 'max_paused_days' };
  return { allowed: true };
}

export type Traffic = 'green' | 'yellow' | 'red';

/** Visual indicator: red when overdue, yellow within `warnDays` working days, green otherwise. */
export function trafficLight(dueOn: IsoDate, today: IsoDate, warnDays: number, calendar: WorkingCalendar): Traffic {
  if (compareIso(today, dueOn) > 0) return 'red';
  return calendar.workingDaysBetween(today, dueOn) <= warnDays ? 'yellow' : 'green';
}
