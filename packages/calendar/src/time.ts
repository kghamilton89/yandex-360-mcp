/** Wall-clock fields in some time zone. Months are 1-based. */
export interface WallTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export type InputTime =
  | { kind: 'date'; date: string }
  | { kind: 'datetime'; instant: Date };

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(tz, f);
  }
  return f;
}

export function isValidTimeZone(tz: string | undefined): tz is string {
  if (!tz) return false;
  try {
    formatter(tz);
    return true;
  } catch {
    return false;
  }
}

export function systemTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

export function wallTimeIn(date: Date, tz: string): WallTime {
  const parts = Object.fromEntries(formatter(tz).formatToParts(date).map((p) => [p.type, p.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

/** Offset of `tz` from UTC at `date`, in minutes (e.g. +180 for Moscow). */
export function offsetMinutes(date: Date, tz: string): number {
  const w = wallTimeIn(date, tz);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60000);
}

function sameWall(a: WallTime, b: WallTime): boolean {
  return a.year === b.year && a.month === b.month && a.day === b.day && a.hour === b.hour && a.minute === b.minute && a.second === b.second;
}

/**
 * Converts a wall-clock time in `tz` to an instant. Ambiguous (DST overlap) times resolve to
 * the earlier instant; nonexistent (DST gap) times shift forward, like Temporal's "compatible".
 */
export function wallTimeToDate(w: WallTime, tz: string): Date {
  const guess = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  const first = guess - offsetMinutes(new Date(guess), tz) * 60000;
  const second = guess - offsetMinutes(new Date(first), tz) * 60000;
  const candidates = [...new Set([first, second])].sort((a, b) => a - b);
  const exact = candidates.find((c) => sameWall(wallTimeIn(new Date(c), tz), w));
  return new Date(exact ?? Math.max(...candidates));
}

const pad = (n: number, len = 2) => String(n).padStart(len, '0');

export function formatDate(w: Pick<WallTime, 'year' | 'month' | 'day'>): string {
  return `${pad(w.year, 4)}-${pad(w.month)}-${pad(w.day)}`;
}

/** ISO 8601 with the zone's offset, e.g. 2026-10-24T10:00:00+03:00. */
export function formatInZone(date: Date, tz: string): string {
  const w = wallTimeIn(date, tz);
  const off = offsetMinutes(date, tz);
  const sign = off < 0 ? '-' : '+';
  const abs = Math.abs(off);
  return `${formatDate(w)}T${pad(w.hour)}:${pad(w.minute)}:${pad(w.second)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;

/**
 * Parses a tool input: "2026-10-24" (all-day date), "2026-10-24T10:00" (wall time in `tz`)
 * or any ISO 8601 string with Z / an offset.
 */
export function parseInputTime(value: string, tz: string): InputTime {
  const v = value.trim();
  const d = DATE_RE.exec(v);
  if (d) {
    const check = new Date(Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3])));
    if (check.getUTCDate() !== Number(d[3])) throw new Error(`Invalid date: ${value}`);
    return { kind: 'date', date: v };
  }
  const l = LOCAL_RE.exec(v);
  if (l) {
    const [, y, mo, da, h, mi, s] = l;
    return {
      kind: 'datetime',
      instant: wallTimeToDate(
        { year: Number(y), month: Number(mo), day: Number(da), hour: Number(h), minute: Number(mi), second: Number(s ?? 0) },
        tz,
      ),
    };
  }
  const instant = new Date(v);
  if (Number.isNaN(instant.getTime())) throw new Error(`Invalid date/time: ${value}`);
  return { kind: 'datetime', instant };
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return formatDate({ year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() });
}

/** Midnight at the start of `date` in `tz`. */
export function startOfDate(date: string, tz: string): Date {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  return wallTimeToDate({ year, month, day, hour: 0, minute: 0, second: 0 }, tz);
}
