/**
 * Calendrier : heure de Paris, jours ouvrés français (fériés calculés, Pâques compris),
 * créneaux d'envoi et délai de 48 h ouvrées (le temps ne court que les jours ouvrés).
 */

export interface Slot {
  days: number[]; // 1 = lundi … 7 = dimanche
  start: string; // "08:00"
  end: string;
  use: string; // "premier_contact" | "relance"
}

export interface ScheduleConfig {
  timezone: string;
  slots: Slot[];
  extra_holidays: string[]; // "AAAA-MM-JJ"
}

const TZ = "Europe/Paris";

export interface LocalParts {
  y: number;
  m: number;
  d: number;
  hh: number;
  mm: number;
  weekday: number; // 1 = lundi … 7 = dimanche
}

const fmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  weekday: "short",
  hourCycle: "h23",
});
const WD: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

export function parisParts(date: Date): LocalParts {
  const p = Object.fromEntries(fmt.formatToParts(date).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, hh: +p.hour, mm: +p.minute, weekday: WD[p.weekday] };
}

/** Heure locale de Paris → instant UTC (gère l'heure d'été). */
export function parisToUtc(y: number, m: number, d: number, hh = 0, mm = 0): Date {
  let guess = Date.UTC(y, m - 1, d, hh, mm);
  for (let i = 0; i < 3; i++) {
    const p = parisParts(new Date(guess));
    const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm);
    const diff = asUtc - Date.UTC(y, m - 1, d, hh, mm);
    if (diff === 0) break;
    guess -= diff;
  }
  return new Date(guess);
}

const pad = (n: number) => String(n).padStart(2, "0");
export const dayKey = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;

/** Dimanche de Pâques (algorithme grégorien anonyme). */
export function easter(y: number): { m: number; d: number } {
  const a = y % 19;
  const b = Math.floor(y / 100);
  const c = y % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return { m: month, d: day };
}

function shift(y: number, m: number, d: number, days: number): string {
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return dayKey(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

/** Jours fériés français de l'année (métropole). */
export function frenchHolidays(y: number): Set<string> {
  const e = easter(y);
  return new Set([
    dayKey(y, 1, 1),
    shift(y, e.m, e.d, 1), // lundi de Pâques
    dayKey(y, 5, 1),
    dayKey(y, 5, 8),
    shift(y, e.m, e.d, 39), // Ascension
    shift(y, e.m, e.d, 50), // lundi de Pentecôte
    dayKey(y, 7, 14),
    dayKey(y, 8, 15),
    dayKey(y, 11, 1),
    dayKey(y, 11, 11),
    dayKey(y, 12, 25),
  ]);
}

export function isBusinessDay(p: Pick<LocalParts, "y" | "m" | "d" | "weekday">, extra: string[] = []): boolean {
  if (p.weekday >= 6) return false;
  const k = dayKey(p.y, p.m, p.d);
  return !frenchHolidays(p.y).has(k) && !extra.includes(k);
}

/** Minuit (heure de Paris) du jour suivant. */
function nextParisMidnight(date: Date): Date {
  const p = parisParts(date);
  const t = new Date(Date.UTC(p.y, p.m - 1, p.d + 1));
  return parisToUtc(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate(), 0, 0);
}

/** Ajoute des heures ouvrées : le temps ne court que pendant les jours ouvrés (48 h ouvrées = 2 jours ouvrés). */
export function addBusinessHours(start: Date, hours: number, extra: string[] = []): Date {
  let cursor = new Date(start);
  let remaining = hours * 3_600_000;
  for (let guard = 0; guard < 400 && remaining > 0; guard++) {
    const p = parisParts(cursor);
    const midnight = nextParisMidnight(cursor);
    if (!isBusinessDay(p, extra)) {
      cursor = midnight;
      continue;
    }
    const available = midnight.getTime() - cursor.getTime();
    if (remaining <= available) return new Date(cursor.getTime() + remaining);
    remaining -= available;
    cursor = midnight;
  }
  return cursor;
}

const toMin = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

/** Premier instant ≥ `after` situé dans un créneau d'usage `use`, un jour ouvré. */
export function nextSlot(after: Date, use: string, cfg: ScheduleConfig): Date {
  const slots = cfg.slots.filter((s) => s.use === use || (use === "relance" && s.use === "premier_contact"));
  const own = cfg.slots.filter((s) => s.use === use);
  const candidates = own.length ? own : slots;
  let cursor = new Date(after);
  for (let day = 0; day < 30; day++) {
    const p = parisParts(cursor);
    if (isBusinessDay(p, cfg.extra_holidays)) {
      const nowMin = day === 0 ? p.hh * 60 + p.mm : 0;
      const today = candidates
        .filter((s) => s.days.includes(p.weekday))
        .map((s) => ({ start: toMin(s.start), end: toMin(s.end) }))
        .filter((s) => s.end > nowMin)
        .sort((a, b) => a.start - b.start);
      if (today.length) {
        const s = today[0];
        const minute = Math.max(s.start, nowMin);
        if (day === 0 && minute === nowMin) return new Date(Math.max(after.getTime(), cursor.getTime()));
        return parisToUtc(p.y, p.m, p.d, Math.floor(minute / 60), minute % 60);
      }
    }
    cursor = nextParisMidnight(cursor);
  }
  return cursor;
}

export function isInSlot(date: Date, use: string, cfg: ScheduleConfig): boolean {
  return nextSlot(date, use, cfg).getTime() === date.getTime();
}

/** Date lisible en français, heure de Paris. */
export function frDate(date: Date): string {
  return date.toLocaleString("fr-FR", { timeZone: TZ, weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });
}
