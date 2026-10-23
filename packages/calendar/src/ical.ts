import { randomUUID } from 'node:crypto';
import ICAL from 'ical.js';
import { tzlib_get_ical_block } from 'timezones-ical-library';
import {
  type InputTime,
  addDays,

  formatInZone,
  isValidTimeZone,
  parseInputTime,
  startOfDate,
  wallTimeIn,
  wallTimeToDate,
} from './time.js';

type Component = InstanceType<typeof ICAL.Component>;
type Time = InstanceType<typeof ICAL.Time>;

const PRODID = '-//yandex-calendar-mcp//EN';
const MAX_ITERATIONS = 50_000;

export interface EventInput {
  summary: string;
  start: string;
  end?: string;
  timezone?: string;
  location?: string;
  description?: string;
  attendees?: string[];
  rrule?: string;
  reminderMinutes?: number;
}

export interface EventPatch {
  summary?: string;
  start?: string;
  end?: string;
  timezone?: string;
  location?: string | null;
  description?: string | null;
  rrule?: string | null;
  reminderMinutes?: number | null;
}

export interface Attendee {
  email: string;
  name?: string;
  status?: string;
}

export interface EventInstance {
  uid: string;
  summary: string;
  start: string;
  end: string;
  allDay: boolean;
  location?: string;
  description?: string;
  status?: string;
  organizer?: string;
  attendees?: Attendee[];
  recurring: boolean;
  rrule?: string;
  recurrenceId?: string;
}

// ---------- reading ----------

function stripMailto(v: unknown): string {
  return String(v ?? '').replace(/^mailto:/i, '');
}

function text(c: Component, name: string): string | undefined {
  const v = c.getFirstPropertyValue(name);
  return v === null || v === undefined || v === '' ? undefined : String(v);
}

function propTzid(c: Component, name: string): string | undefined {
  const tzid = c.getFirstProperty(name)?.getParameter('tzid');
  return typeof tzid === 'string' ? tzid : undefined;
}

/** TZID parameter of a component's DTSTART, if any. */
function startTzid(c: Component): string | undefined {
  return propTzid(c, 'dtstart');
}

/** DTEND's TZID, falling back to DTSTART's for DURATION-based events. */
function endTzid(c: Component): string | undefined {
  return propTzid(c, 'dtend') ?? startTzid(c);
}

/** An event without DTEND/DURATION lasts one day (all-day) or zero time (timed), per RFC 5545. */
function endOrDefault(start: Time, end: Time | null | undefined): Time {
  if (end && end.compare(start) > 0) return end;
  if (start.isDate) return ICAL.Time.fromDateString(addDays(start.toString(), 1));
  return end ?? start;
}

/** Converts an ical.js time to an instant, using Intl for IANA zones and `fallbackTz` for floating times. */
function toInstant(t: Time, tzid: string | undefined, fallbackTz: string): Date {
  if (t.isDate) return startOfDate(t.toString(), fallbackTz);
  if (t.zone?.tzid === 'UTC') return t.toJSDate();
  const wall = { year: t.year, month: t.month, day: t.day, hour: t.hour, minute: t.minute, second: t.second };
  if (isValidTimeZone(tzid)) return wallTimeToDate(wall, tzid);
  if (tzid && t.zone && t.zone.tzid !== 'floating') return t.toJSDate();
  return wallTimeToDate(wall, fallbackTz);
}

function registerTimezones(cal: Component) {
  for (const vtz of cal.getAllSubcomponents('vtimezone')) {
    const id = vtz.getFirstPropertyValue('tzid');
    if (typeof id === 'string' && !isValidTimeZone(id) && !ICAL.TimezoneService.has(id)) {
      ICAL.TimezoneService.register(vtz);
    }
  }
}

export function parseCalendar(ics: string): Component {
  return new ICAL.Component(ICAL.parse(ics));
}

function attendees(c: Component): Attendee[] | undefined {
  const list = c.getAllProperties('attendee').map((p) => {
    const a: Attendee = { email: stripMailto(p.getFirstValue()) };
    const cn = p.getParameter('cn');
    const st = p.getParameter('partstat');
    if (typeof cn === 'string' && cn) a.name = cn;
    if (typeof st === 'string' && st) a.status = st;
    return a;
  });
  return list.length ? list : undefined;
}

function describe(
  item: Component,
  master: Component,
  start: Date,
  end: Date,
  allDay: boolean,
  startDate: Time,
  endDate: Time,
  tz: string,
  recurrenceId?: string,
): EventInstance {
  const rrule = master.getFirstPropertyValue('rrule');
  const ev: EventInstance = {
    uid: text(master, 'uid') ?? '',
    summary: text(item, 'summary') ?? '(no title)',
    start: allDay ? startDate.toString() : formatInZone(start, tz),
    // All-day ends are exclusive in iCalendar; expose the inclusive last day.
    end: allDay ? addDays(endDate.toString(), -1) : formatInZone(end, tz),
    allDay,
    recurring: Boolean(rrule) || Boolean(recurrenceId),
  };
  const location = text(item, 'location');
  const description = text(item, 'description');
  const status = text(item, 'status');
  const organizer = item.getFirstPropertyValue('organizer');
  const att = attendees(item);
  if (location) ev.location = location;
  if (description) ev.description = description;
  if (status) ev.status = status;
  if (organizer) ev.organizer = stripMailto(organizer);
  if (att) ev.attendees = att;
  if (rrule) ev.rrule = String(rrule);
  if (recurrenceId) ev.recurrenceId = recurrenceId;
  return ev;
}

/**
 * Expands one calendar object (a VCALENDAR with a master VEVENT and optional overrides)
 * into the instances that overlap [rangeStart, rangeEnd).
 */
export function expandEvents(ics: string, rangeStart: Date, rangeEnd: Date, tz: string): EventInstance[] {
  const cal = parseCalendar(ics);
  registerTimezones(cal);
  const vevents = cal.getAllSubcomponents('vevent');
  const masters = vevents.filter((v) => !v.hasProperty('recurrence-id'));
  const overrides = vevents.filter((v) => v.hasProperty('recurrence-id'));
  const out: EventInstance[] = [];
  const overlaps = (s: Date, e: Date) => s < rangeEnd && (e > rangeStart || (e.getTime() === s.getTime() && s >= rangeStart));

  // Overrides whose master is not in this object are reported as standalone instances.
  const standalone = masters.length ? [] : overrides;
  for (const master of [...masters, ...standalone]) {
    const event = new ICAL.Event(master, {
      exceptions: masters.includes(master) ? overrides.filter((o) => text(o, 'uid') === text(master, 'uid')) : [],
    });
    if (!event.startDate) continue;

    if (!masters.includes(master) || !event.isRecurring()) {
      const startDate = event.startDate;
      const endDate = endOrDefault(startDate, event.endDate);
      const s = toInstant(startDate, startTzid(master), tz);
      const e = toInstant(endDate, endTzid(master), tz);
      const rid = master.getFirstPropertyValue('recurrence-id');
      if (overlaps(s, e)) {
        out.push(describe(master, master, s, e, startDate.isDate, startDate, endDate, tz, rid ? String(rid) : undefined));
      }
      continue;
    }

    const it = event.iterator();
    for (let i = 0, next = it.next(); next && i < MAX_ITERATIONS; i++, next = it.next()) {
      const details = event.getOccurrenceDetails(next);
      const item = details.item.component;
      const allDay = details.startDate.isDate;
      const s = toInstant(details.startDate, startTzid(item), tz);
      if (s >= rangeEnd && toInstant(next, startTzid(master), tz) >= rangeEnd) break;
      const e = toInstant(details.endDate, endTzid(item), tz);
      if (overlaps(s, e)) {
        out.push(describe(item, master, s, e, allDay, details.startDate, details.endDate, tz, details.recurrenceId.toString()));
      }
    }
  }
  return out;
}

// ---------- writing ----------

function vtimezone(tz: string): Component | undefined {
  if (tz === 'UTC') return undefined;
  const block = tzlib_get_ical_block(tz);
  if (!Array.isArray(block) || typeof block[0] !== 'string' || !block[0].startsWith('BEGIN:VTIMEZONE')) return undefined;
  return new ICAL.Component(ICAL.parse(block[0]));
}

function ensureTimezone(cal: Component, tz: string): boolean {
  const exists = cal.getAllSubcomponents('vtimezone').some((v) => v.getFirstPropertyValue('tzid') === tz);
  if (exists) return true;
  const vtz = vtimezone(tz);
  if (!vtz) return false;
  cal.addSubcomponent(vtz);
  return true;
}

function setTime(cal: Component, ev: Component, name: 'dtstart' | 'dtend', value: InputTime, tz: string) {
  ev.removeAllProperties(name);
  const prop = new ICAL.Property(name, ev);
  if (value.kind === 'date') {
    prop.resetType('date');
    prop.setValue(ICAL.Time.fromDateString(value.date));
  } else if (tz !== 'UTC' && ensureTimezone(cal, tz)) {
    const w = wallTimeIn(value.instant, tz);
    prop.setValue(
      ICAL.Time.fromData({ year: w.year, month: w.month, day: w.day, hour: w.hour, minute: w.minute, second: w.second, isDate: false }),
    );
    prop.setParameter('tzid', tz);
  } else {
    prop.setValue(ICAL.Time.fromJSDate(value.instant, true));
  }
  ev.addProperty(prop);
}

function utcNow(): Time {
  return ICAL.Time.fromJSDate(new Date(), true);
}

function setText(ev: Component, name: string, value: string | null | undefined) {
  if (value === undefined) return;
  if (value === null || value === '') ev.removeAllProperties(name);
  else ev.updatePropertyWithValue(name, value);
}

function setReminder(ev: Component, minutes: number | null | undefined) {
  if (minutes === undefined) return;
  for (const a of ev.getAllSubcomponents('valarm')) ev.removeSubcomponent(a);
  if (minutes === null) return;
  const alarm = new ICAL.Component('valarm');
  alarm.updatePropertyWithValue('action', 'DISPLAY');
  alarm.updatePropertyWithValue('description', 'Reminder');
  const trigger = new ICAL.Property('trigger', alarm);
  trigger.setValue(ICAL.Duration.fromSeconds(-minutes * 60));
  alarm.addProperty(trigger);
  ev.addSubcomponent(alarm);
}

function setRrule(ev: Component, rrule: string | null | undefined) {
  if (rrule === undefined) return;
  ev.removeAllProperties('rrule');
  if (rrule === null || rrule === '') return;
  ev.addPropertyWithValue('rrule', ICAL.Recur.fromString(rrule.replace(/^RRULE:/i, '')));
}

/** Resolves start/end inputs into iCalendar values (all-day ends become exclusive). */
export function resolveRange(startInput: string, endInput: string | undefined, tz: string): { start: InputTime; end: InputTime } {
  const start = parseInputTime(startInput, tz);
  if (start.kind === 'date') {
    let lastDay = start.date;
    if (endInput) {
      const end = parseInputTime(endInput, tz);
      if (end.kind !== 'date') throw new Error('An all-day event needs an end date (YYYY-MM-DD), not a time');
      lastDay = end.date;
    }
    if (lastDay < start.date) throw new Error('End date is before start date');
    return { start, end: { kind: 'date', date: addDays(lastDay, 1) } };
  }
  const end = endInput ? parseInputTime(endInput, tz) : { kind: 'datetime' as const, instant: new Date(start.instant.getTime() + 3600_000) };
  if (end.kind !== 'datetime') throw new Error('A timed event needs an end time, not a date');
  if (end.instant <= start.instant) throw new Error('End must be after start');
  return { start, end };
}

export function buildEvent(input: EventInput, defaultTz: string, organizer?: string): { uid: string; ics: string } {
  const tz = input.timezone ?? defaultTz;
  if (!isValidTimeZone(tz)) throw new Error(`Unknown time zone: ${tz}`);
  const { start, end } = resolveRange(input.start, input.end, tz);

  const cal = new ICAL.Component('vcalendar');
  cal.updatePropertyWithValue('prodid', PRODID);
  cal.updatePropertyWithValue('version', '2.0');
  cal.updatePropertyWithValue('calscale', 'GREGORIAN');

  const ev = new ICAL.Component('vevent');
  const uid = randomUUID();
  const now = utcNow();
  ev.updatePropertyWithValue('uid', uid);
  ev.updatePropertyWithValue('dtstamp', now);
  ev.updatePropertyWithValue('created', now);
  ev.updatePropertyWithValue('last-modified', now);
  ev.updatePropertyWithValue('sequence', 0);
  ev.updatePropertyWithValue('summary', input.summary);
  setTime(cal, ev, 'dtstart', start, tz);
  setTime(cal, ev, 'dtend', end, tz);
  setText(ev, 'location', input.location);
  setText(ev, 'description', input.description);
  setRrule(ev, input.rrule);

  if (input.attendees?.length) {
    if (organizer) ev.addPropertyWithValue('organizer', `mailto:${organizer}`);
    for (const email of input.attendees) {
      const p = ev.addPropertyWithValue('attendee', `mailto:${email}`);
      p.setParameter('role', 'REQ-PARTICIPANT');
      p.setParameter('partstat', 'NEEDS-ACTION');
      p.setParameter('rsvp', 'TRUE');
    }
  }
  setReminder(ev, input.reminderMinutes);

  cal.addSubcomponent(ev);
  return { uid, ics: cal.toString() };
}

/** Applies a patch to the master VEVENT of an existing calendar object (whole series for recurring events). */
export function patchEvent(ics: string, patch: EventPatch, defaultTz: string): string {
  const cal = parseCalendar(ics);
  registerTimezones(cal);
  const master = cal.getAllSubcomponents('vevent').find((v) => !v.hasProperty('recurrence-id'));
  if (!master) throw new Error('Calendar object has no master VEVENT');

  const existingTz = startTzid(master);
  const tz = patch.timezone ?? (isValidTimeZone(existingTz) ? existingTz : defaultTz);
  if (!isValidTimeZone(tz)) throw new Error(`Unknown time zone: ${tz}`);

  if (patch.start !== undefined || patch.end !== undefined || patch.timezone !== undefined) {
    const event = new ICAL.Event(master);
    const oldStart = event.startDate;
    const oldEnd = event.endDate ?? event.startDate;
    const oldAllDay = oldStart.isDate;
    const fmtOld = (t: Time, isEnd: boolean) =>
      oldAllDay
        ? isEnd
          ? addDays(t.toString(), -1)
          : t.toString()
        : formatInZone(toInstant(t, existingTz, defaultTz), tz);

    const startStr = patch.start ?? fmtOld(oldStart, false);
    let endStr = patch.end;
    if (endStr === undefined) {
      const newStart = parseInputTime(startStr, tz);
      if (patch.start === undefined || (newStart.kind === 'date') !== oldAllDay) {
        endStr = patch.start === undefined ? fmtOld(oldEnd, true) : undefined;
      } else if (newStart.kind === 'date') {
        const days = Math.round((startOfDate(oldEnd.toString(), 'UTC').getTime() - startOfDate(oldStart.toString(), 'UTC').getTime()) / 86400_000);
        endStr = addDays(newStart.date, Math.max(days, 1) - 1);
      } else {
        const durationMs = toInstant(oldEnd, existingTz, defaultTz).getTime() - toInstant(oldStart, existingTz, defaultTz).getTime();
        endStr = new Date(newStart.instant.getTime() + Math.max(durationMs, 0)).toISOString();
      }
    }
    const { start, end } = resolveRange(startStr, endStr, tz);
    master.removeAllProperties('duration');
    setTime(cal, master, 'dtstart', start, tz);
    setTime(cal, master, 'dtend', end, tz);
  }

  if (patch.summary !== undefined) master.updatePropertyWithValue('summary', patch.summary);
  setText(master, 'location', patch.location);
  setText(master, 'description', patch.description);
  setRrule(master, patch.rrule);
  setReminder(master, patch.reminderMinutes);

  const seq = Number(master.getFirstPropertyValue('sequence') ?? 0);
  master.updatePropertyWithValue('sequence', Number.isFinite(seq) ? seq + 1 : 1);
  const now = utcNow();
  master.updatePropertyWithValue('dtstamp', now);
  master.updatePropertyWithValue('last-modified', now);
  return cal.toString();
}

/** The master event of a calendar object (series-level view, no expansion). */
export function summarizeObject(ics: string, tz: string): EventInstance & { overrides: number } {
  const cal = parseCalendar(ics);
  registerTimezones(cal);
  const vevents = cal.getAllSubcomponents('vevent');
  const master = vevents.find((v) => !v.hasProperty('recurrence-id')) ?? vevents[0];
  if (!master) throw new Error('Calendar object has no VEVENT');
  const event = new ICAL.Event(master);
  const startDate = event.startDate;
  const endDate = endOrDefault(startDate, event.endDate);
  const s = toInstant(startDate, startTzid(master), tz);
  const e = toInstant(endDate, endTzid(master), tz);
  const rid = master.getFirstPropertyValue('recurrence-id');
  return {
    ...describe(master, master, s, e, startDate.isDate, startDate, endDate, tz, rid ? String(rid) : undefined),
    overrides: vevents.filter((v) => v !== master && v.hasProperty('recurrence-id')).length,
  };
}
