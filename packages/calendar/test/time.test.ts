import { describe, expect, it } from 'vitest';
import { addDays, formatInZone, offsetMinutes, parseInputTime, wallTimeToDate } from '../src/time.js';

describe('time helpers', () => {
  it('computes offsets', () => {
    expect(offsetMinutes(new Date('2026-07-01T00:00:00Z'), 'Europe/Moscow')).toBe(180);
    expect(offsetMinutes(new Date('2026-07-01T00:00:00Z'), 'America/New_York')).toBe(-240);
    expect(offsetMinutes(new Date('2026-12-01T00:00:00Z'), 'America/New_York')).toBe(-300);
    expect(offsetMinutes(new Date('2026-07-01T00:00:00Z'), 'Asia/Kolkata')).toBe(330);
  });
  it('converts wall time to instants on both sides of DST', () => {
    const w = { year: 2026, month: 3, day: 7, hour: 9, minute: 0, second: 0 };
    expect(wallTimeToDate(w, 'America/New_York').toISOString()).toBe('2026-03-07T14:00:00.000Z');
    expect(wallTimeToDate({ ...w, day: 9 }, 'America/New_York').toISOString()).toBe('2026-03-09T13:00:00.000Z');
  });
  it('shifts nonexistent DST-gap times forward', () => {
    const d = wallTimeToDate({ year: 2026, month: 3, day: 8, hour: 2, minute: 30, second: 0 }, 'America/New_York');
    expect(formatInZone(d, 'America/New_York')).toBe('2026-03-08T03:30:00-04:00');
  });
  it('resolves ambiguous fall-back times to the earlier instant', () => {
    const d = wallTimeToDate({ year: 2026, month: 11, day: 1, hour: 1, minute: 30, second: 0 }, 'America/New_York');
    expect(formatInZone(d, 'America/New_York')).toBe('2026-11-01T01:30:00-04:00');
  });
  it('formats with offset', () => {
    expect(formatInZone(new Date('2026-10-24T07:00:00Z'), 'Europe/Moscow')).toBe('2026-10-24T10:00:00+03:00');
    expect(formatInZone(new Date('2026-10-24T07:00:00Z'), 'UTC')).toBe('2026-10-24T07:00:00+00:00');
  });
  it('parses inputs', () => {
    expect(parseInputTime('2026-10-24', 'UTC')).toEqual({ kind: 'date', date: '2026-10-24' });
    expect(parseInputTime('2026-10-24T10:00', 'Europe/Moscow')).toEqual({ kind: 'datetime', instant: new Date('2026-10-24T07:00:00Z') });
    expect(parseInputTime('2026-10-24T10:00:00Z', 'Europe/Moscow')).toEqual({ kind: 'datetime', instant: new Date('2026-10-24T10:00:00Z') });
    expect(parseInputTime('2026-10-24T10:00:00-05:00', 'Europe/Moscow')).toEqual({ kind: 'datetime', instant: new Date('2026-10-24T15:00:00Z') });
    expect(() => parseInputTime('2026-02-30', 'UTC')).toThrow();
    expect(() => parseInputTime('next tuesday', 'UTC')).toThrow();
  });
  it('adds days across months', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });
});
