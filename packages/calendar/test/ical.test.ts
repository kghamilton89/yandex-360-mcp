import { describe, expect, it } from 'vitest';
import { buildEvent, expandEvents, patchEvent, resolveRange } from '../src/ical.js';

const range = (a: string, b: string) => [new Date(a), new Date(b)] as const;

describe('buildEvent', () => {
  it('writes TZID times with a VTIMEZONE and reads them back', () => {
    const { ics, uid } = buildEvent(
      { summary: 'Standup, daily', start: '2026-10-24T10:00', end: '2026-10-24T10:30', location: 'Room; 1', reminderMinutes: 15 },
      'Europe/Moscow',
    );
    expect(ics).toContain('DTSTART;TZID=Europe/Moscow:20261024T100000');
    expect(ics).toContain('BEGIN:VTIMEZONE');
    expect(ics).toContain('SUMMARY:Standup\\, daily');
    expect(ics).toContain('TRIGGER:-PT15M');
    const [ev] = expandEvents(ics, ...range('2026-10-24T00:00:00Z', '2026-10-25T00:00:00Z'), 'Europe/Moscow');
    expect(ev).toMatchObject({ uid, summary: 'Standup, daily', start: '2026-10-24T10:00:00+03:00', end: '2026-10-24T10:30:00+03:00', allDay: false, location: 'Room; 1', recurring: false });
  });

  it('reports times in the display zone', () => {
    const { ics } = buildEvent({ summary: 'x', start: '2026-10-24T10:00' }, 'Europe/Moscow');
    const [ev] = expandEvents(ics, ...range('2026-10-24T00:00:00Z', '2026-10-25T00:00:00Z'), 'Europe/Berlin');
    expect(ev?.start).toBe('2026-10-24T09:00:00+02:00');
    expect(ev?.end).toBe('2026-10-24T10:00:00+02:00');
  });

  it('handles all-day events with inclusive end dates', () => {
    const { ics } = buildEvent({ summary: 'Vacation', start: '2026-10-24', end: '2026-10-26' }, 'Europe/Moscow');
    expect(ics).toContain('DTSTART;VALUE=DATE:20261024');
    expect(ics).toContain('DTEND;VALUE=DATE:20261027');
    const [ev] = expandEvents(ics, ...range('2026-10-25T12:00:00Z', '2026-10-25T13:00:00Z'), 'Europe/Moscow');
    expect(ev).toMatchObject({ start: '2026-10-24', end: '2026-10-26', allDay: true });
    expect(expandEvents(ics, ...range('2026-10-27T00:00:00+03:00', '2026-10-28T00:00:00+03:00'), 'Europe/Moscow')).toHaveLength(0);
  });

  it('adds organizer and attendees', () => {
    const { ics } = buildEvent({ summary: 'Sync', start: '2026-10-24T10:00', attendees: ['a@x.com'] }, 'UTC', 'me@yandex.ru');
    expect(ics).toContain('ORGANIZER:mailto:me@yandex.ru');
    expect(ics.replace(/\r?\n /g, '')).toMatch(/ATTENDEE;.*:mailto:a@x.com/);
    expect(ics).toContain('DTSTART:20261024T100000Z');
  });

  it('keeps local time for weekly events across DST', () => {
    const { ics } = buildEvent({ summary: 'Weekly', start: '2026-10-26T09:00', rrule: 'FREQ=WEEKLY;COUNT=3' }, 'America/New_York');
    const evs = expandEvents(ics, ...range('2026-10-01T00:00:00Z', '2026-12-01T00:00:00Z'), 'America/New_York');
    expect(evs.map((e) => e.start)).toEqual([
      '2026-10-26T09:00:00-04:00',
      '2026-11-02T09:00:00-05:00',
      '2026-11-09T09:00:00-05:00',
    ]);
    expect(evs[0]).toMatchObject({ recurring: true, rrule: 'FREQ=WEEKLY;COUNT=3' });
  });

  it('validates ranges', () => {
    expect(() => resolveRange('2026-10-24T10:00', '2026-10-24T09:00', 'UTC')).toThrow(/after start/);
    expect(() => resolveRange('2026-10-24', '2026-10-24T09:00', 'UTC')).toThrow(/end date/);
    expect(() => resolveRange('2026-10-24T10:00', '2026-10-25', 'UTC')).toThrow(/end time/);
    expect(() => buildEvent({ summary: 'x', start: '2026-10-24T10:00', timezone: 'Mars/Olympus' }, 'UTC')).toThrow(/time zone/);
  });
});

const RECURRING = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//test//EN
BEGIN:VEVENT
UID:series-1
DTSTART;TZID=Europe/Moscow:20261019T110000
DTEND;TZID=Europe/Moscow:20261019T120000
RRULE:FREQ=DAILY;COUNT=5
EXDATE;TZID=Europe/Moscow:20261021T110000
SUMMARY:Daily
END:VEVENT
BEGIN:VEVENT
UID:series-1
RECURRENCE-ID;TZID=Europe/Moscow:20261022T110000
DTSTART;TZID=Europe/Moscow:20261022T150000
DTEND;TZID=Europe/Moscow:20261022T153000
SUMMARY:Daily (moved)
END:VEVENT
END:VCALENDAR`;

describe('expandEvents', () => {
  it('applies EXDATE and overrides', () => {
    const evs = expandEvents(RECURRING, ...range('2026-10-01T00:00:00Z', '2026-11-01T00:00:00Z'), 'Europe/Moscow');
    expect(evs.map((e) => [e.start, e.summary])).toEqual([
      ['2026-10-19T11:00:00+03:00', 'Daily'],
      ['2026-10-20T11:00:00+03:00', 'Daily'],
      ['2026-10-22T15:00:00+03:00', 'Daily (moved)'],
      ['2026-10-23T11:00:00+03:00', 'Daily'],
    ]);
    expect(evs[2]?.recurrenceId).toBeDefined();
  });

  it('limits to the requested range', () => {
    const evs = expandEvents(RECURRING, ...range('2026-10-20T00:00:00+03:00', '2026-10-21T00:00:00+03:00'), 'Europe/Moscow');
    expect(evs).toHaveLength(1);
    expect(evs[0]?.start).toBe('2026-10-20T11:00:00+03:00');
  });

  it('handles non-IANA TZIDs with an embedded VTIMEZONE', () => {
    const ics = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//test//EN
BEGIN:VTIMEZONE
TZID:Russian Standard Time
BEGIN:STANDARD
DTSTART:16010101T000000
TZOFFSETFROM:+0300
TZOFFSETTO:+0300
END:STANDARD
END:VTIMEZONE
BEGIN:VEVENT
UID:win-1
DTSTART;TZID=Russian Standard Time:20261024T100000
DTEND;TZID=Russian Standard Time:20261024T110000
SUMMARY:Outlook event
END:VEVENT
END:VCALENDAR`;
    const [ev] = expandEvents(ics, ...range('2026-10-24T00:00:00Z', '2026-10-25T00:00:00Z'), 'UTC');
    expect(ev?.start).toBe('2026-10-24T07:00:00+00:00');
  });

  it('treats a missing DTEND on a date as one day', () => {
    const ics = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//test//EN
BEGIN:VEVENT
UID:bday
DTSTART;VALUE=DATE:20261024
SUMMARY:Birthday
END:VEVENT
END:VCALENDAR`;
    const [ev] = expandEvents(ics, ...range('2026-10-24T12:00:00Z', '2026-10-24T13:00:00Z'), 'UTC');
    expect(ev).toMatchObject({ start: '2026-10-24', end: '2026-10-24', allDay: true });
  });
});

describe('patchEvent', () => {
  it('moves start keeping duration, bumps sequence, edits fields', () => {
    const { ics } = buildEvent({ summary: 'Call', start: '2026-10-24T10:00', end: '2026-10-24T10:45', location: 'Zoom' }, 'Europe/Moscow');
    const out = patchEvent(ics, { start: '2026-10-25T14:00', location: null, summary: 'Call (moved)', reminderMinutes: 10 }, 'Europe/Moscow');
    const [ev] = expandEvents(out, ...range('2026-10-25T00:00:00Z', '2026-10-26T00:00:00Z'), 'Europe/Moscow');
    expect(ev).toMatchObject({ summary: 'Call (moved)', start: '2026-10-25T14:00:00+03:00', end: '2026-10-25T14:45:00+03:00' });
    expect(ev?.location).toBeUndefined();
    expect(out).toContain('SEQUENCE:1');
    expect(out).toContain('TRIGGER:-PT10M');
  });

  it('changes only the end', () => {
    const { ics } = buildEvent({ summary: 'Call', start: '2026-10-24T10:00' }, 'Europe/Moscow');
    const out = patchEvent(ics, { end: '2026-10-24T12:00' }, 'Europe/Moscow');
    const [ev] = expandEvents(out, ...range('2026-10-24T00:00:00Z', '2026-10-25T00:00:00Z'), 'Europe/Moscow');
    expect(ev).toMatchObject({ start: '2026-10-24T10:00:00+03:00', end: '2026-10-24T12:00:00+03:00' });
  });

  it('shifts multi-day all-day events keeping length', () => {
    const { ics } = buildEvent({ summary: 'Trip', start: '2026-10-24', end: '2026-10-26' }, 'UTC');
    const out = patchEvent(ics, { start: '2026-11-01' }, 'UTC');
    const [ev] = expandEvents(out, ...range('2026-11-01T00:00:00Z', '2026-11-05T00:00:00Z'), 'UTC');
    expect(ev).toMatchObject({ start: '2026-11-01', end: '2026-11-03', allDay: true });
  });

  it('removes recurrence and keeps overrides parseable', () => {
    const out = patchEvent(RECURRING, { rrule: null }, 'Europe/Moscow');
    expect(out).not.toContain('RRULE');
    const evs = expandEvents(out, ...range('2026-10-01T00:00:00Z', '2026-11-01T00:00:00Z'), 'Europe/Moscow');
    expect(evs[0]?.start).toBe('2026-10-19T11:00:00+03:00');
  });
});
