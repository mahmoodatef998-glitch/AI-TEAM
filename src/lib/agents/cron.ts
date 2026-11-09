/** Minimal 5-field cron matcher (minute hour day-of-month month day-of-week), timezone-aware. */
function matchField(field: string, value: number, min: number, max: number): boolean {
  return field.split(",").some((part) => {
    const [range, stepStr] = part.split("/");
    const step = stepStr ? Number(stepStr) : 1;
    let lo = min;
    let hi = max;
    if (range !== "*") {
      const [a, b] = range.split("-").map(Number);
      lo = a;
      hi = b ?? (stepStr ? max : a);
    }
    if (value < lo || value > hi) return false;
    return (value - lo) % step === 0;
  });
}

export function localParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", weekday: "short", hourCycle: "h23",
  }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"));
  return { year: +get("year"), month: +get("month"), day: +get("day"), hour: +get("hour"), minute: +get("minute"), weekday: wd };
}

export function cronMatches(expr: string, date: Date, timeZone: string): boolean {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) throw new Error(`Invalid cron expression: ${expr}`);
  const p = localParts(date, timeZone);
  const dowOk = matchField(f[4].replace(/\b7\b/g, "0"), p.weekday, 0, 6);
  return matchField(f[0], p.minute, 0, 59) && matchField(f[1], p.hour, 0, 23) && matchField(f[2], p.day, 1, 31) && matchField(f[3], p.month, 1, 12) && dowOk;
}

/** Most recent minute in (from, to] that matches the cron, or null. Scans at most `maxMinutes`. */
export function latestSlot(expr: string, from: Date, to: Date, timeZone: string, maxMinutes = 180): Date | null {
  const end = new Date(Math.floor(to.getTime() / 60000) * 60000);
  for (let i = 0; i < maxMinutes; i++) {
    const t = new Date(end.getTime() - i * 60000);
    if (t <= from) return null;
    if (cronMatches(expr, t, timeZone)) return t;
  }
  return null;
}
