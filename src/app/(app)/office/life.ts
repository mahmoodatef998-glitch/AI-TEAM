/**
 * Office layout, corridor routing and the "office life" planner.
 *
 * Positions that represent work (which room an employee is in while executing a task, the
 * waiting area during approvals) come only from real state. Office life is a separate,
 * clearly-labelled decorative layer: employees with NO active work may take breaks (coffee,
 * lunch, restroom, lounge, visiting a colleague). Real work always interrupts a break.
 */

export const W = 1200;
export const H = 960;

export type Zone =
  | "executive_office" | "meeting_room" | "operations_room" | "sales_department"
  | "lead_generation_department" | "research_department" | "marketing_department" | "waiting_area";
export type DecorZone = "pantry" | "restrooms" | "lounge";
export interface Rect { x: number; y: number; w: number; h: number }
export interface Point { x: number; y: number }

export const ROOMS: Record<Zone, Rect & { label: string; floor: number }> = {
  executive_office: { x: 20, y: 20, w: 300, h: 220, label: "Executive Office", floor: 0x3b3355 },
  meeting_room: { x: 340, y: 20, w: 360, h: 220, label: "Meeting Room", floor: 0x2f3e4f },
  operations_room: { x: 720, y: 20, w: 460, h: 220, label: "Operations · Technical Sales", floor: 0x3d3a2c },
  sales_department: { x: 20, y: 260, w: 560, h: 260, label: "Sales Department", floor: 0x23413d },
  lead_generation_department: { x: 600, y: 260, w: 280, h: 260, label: "Lead Generation", floor: 0x2b3b52 },
  research_department: { x: 900, y: 260, w: 280, h: 260, label: "Research & Intelligence", floor: 0x2f3542 },
  marketing_department: { x: 20, y: 540, w: 560, h: 200, label: "Marketing Department", floor: 0x47303a },
  waiting_area: { x: 600, y: 540, w: 580, h: 200, label: "Waiting Area · Human approval required", floor: 0x4a3f24 },
};
export const DECOR: Record<DecorZone, Rect & { label: string; floor: number }> = {
  pantry: { x: 20, y: 760, w: 560, h: 180, label: "Pantry & Café", floor: 0x3f3a33 },
  restrooms: { x: 600, y: 760, w: 200, h: 180, label: "Restrooms", floor: 0x33414a },
  lounge: { x: 820, y: 760, w: 360, h: 180, label: "Lounge", floor: 0x2e3b33 },
};
const ALL_ROOMS: Rect[] = [...Object.values(ROOMS), ...Object.values(DECOR)];

/** Horizontal corridors run between the rows of rooms (and along the top and bottom edges). */
export const CORRIDORS_Y = [10, 250, 530, 750, 950];
/** Vertical gaps that cross each row of rooms: the outer walkways plus the gaps between rooms. */
export const ROW_GAPS: number[][] = CORRIDORS_Y.slice(0, -1).map((top, i) => {
  const bottom = CORRIDORS_Y[i + 1];
  const inRow = ALL_ROOMS.filter((r) => r.y > top && r.y < bottom).sort((a, b) => a.x - b.x);
  const gaps = [10, W - 10];
  for (let k = 0; k < inRow.length - 1; k++) gaps.push((inRow[k].x + inRow[k].w + inRow[k + 1].x) / 2);
  return gaps.sort((a, b) => a - b);
});
export const DOOR_W = 34;
export const doorX = (r: Rect) => r.x + r.w / 2;

export const roomAt = (p: Point): Rect | null => ALL_ROOMS.find((r) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h) ?? null;
const nearestCorridor = (y: number) => CORRIDORS_Y.reduce((best, c) => (Math.abs(c - y) < Math.abs(best - y) ? c : best), CORRIDORS_Y[0]);

/**
 * Walk from A to B through doors and corridors (never through walls): out of A's room by its
 * top or bottom door, along the corridors (crossing rows only through gaps), in through B's door.
 */
export function route(from: Point, to: Point): Point[] {
  const ra = roomAt(from);
  const rb = roomAt(to);
  if (ra && ra === rb) return [to];
  const pts: Point[] = [];
  let x = from.x;
  let cy: number;
  if (ra) {
    const up = to.y < ra.y || (to.y <= ra.y + ra.h && ra.y > 20 && Math.abs(to.y - ra.y) < Math.abs(to.y - (ra.y + ra.h)));
    x = doorX(ra);
    const wall = up ? ra.y : ra.y + ra.h;
    pts.push({ x, y: wall + (up ? 14 : -14) }, { x, y: up ? ra.y - 10 : ra.y + ra.h + 10 });
    cy = up ? ra.y - 10 : ra.y + ra.h + 10;
  } else {
    cy = nearestCorridor(from.y);
    pts.push({ x, y: cy });
  }
  let ty: number;
  let ex: number;
  if (rb) {
    const enterTop = cy <= rb.y;
    ty = enterTop ? rb.y - 10 : rb.y + rb.h + 10;
    ex = doorX(rb);
  } else {
    ty = nearestCorridor(to.y);
    ex = to.x;
  }
  let k = CORRIDORS_Y.indexOf(cy);
  const kt = CORRIDORS_Y.indexOf(ty);
  while (k !== kt) {
    const next = k < kt ? k + 1 : k - 1;
    const row = Math.min(k, next);
    const target = ex;
    const gx = ROW_GAPS[row].reduce((best, g) => (Math.abs(g - x) + Math.abs(g - target) < Math.abs(best - x) + Math.abs(best - target) ? g : best), ROW_GAPS[row][0]);
    pts.push({ x: gx, y: CORRIDORS_Y[k] }, { x: gx, y: CORRIDORS_Y[next] });
    x = gx;
    k = next;
  }
  pts.push({ x: ex, y: ty });
  if (rb) pts.push({ x: ex, y: ty < rb.y ? rb.y + 14 : rb.y + rb.h - 14 });
  pts.push(to);
  return pts.filter((p, i) => i === 0 || p.x !== pts[i - 1].x || p.y !== pts[i - 1].y);
}

// ───────── decorative spots ─────────
const P = DECOR.pantry;
const R = DECOR.restrooms;
const L = DECOR.lounge;
export const SPOTS = {
  coffee: [0, 1, 2].map((i) => ({ x: P.x + 56 + i * 58, y: P.y + 80 })),
  lunch: [0, 1, 2].flatMap((t) => [-26, 26].map((dx) => ({ x: P.x + 250 + t * 110 + dx, y: P.y + 128 }))),
  restroom: [0, 1, 2].map((i) => ({ x: R.x + 40 + i * 60, y: R.y + 82 })),
  lounge: [0, 1, 2, 3, 4].map((i) => ({ x: L.x + 70 + i * 52, y: L.y + 132 })),
};

export type Activity = "coffee" | "lunch" | "restroom" | "lounge" | "visit" | "stroll";
export const ACTIVITY: Record<Activity, { emote: string; label: string; dwell: [number, number] }> = {
  coffee: { emote: "☕", label: "getting a coffee", dwell: [7_000, 13_000] },
  lunch: { emote: "🍽️", label: "having lunch", dwell: [16_000, 26_000] },
  restroom: { emote: "🚻", label: "restroom break", dwell: [5_000, 9_000] },
  lounge: { emote: "🎧", label: "taking a break in the lounge", dwell: [10_000, 18_000] },
  visit: { emote: "💬", label: "chatting with a colleague", dwell: [8_000, 14_000] },
  stroll: { emote: "🚶", label: "stretching their legs", dwell: [1_500, 3_000] },
};
/** How long someone stays at their desk between breaks. */
export const DESK_DWELL: [number, number] = [22_000, 55_000];
/** Never more than this share of the idle team away at once. */
export const MAX_AWAY_SHARE = 0.4;

export const between = (rand: () => number, [a, b]: [number, number]) => a + rand() * (b - a);

/** Pick the next break. Lunch is more likely around midday Dubai time. */
export function pickActivity(rand: () => number, dubaiHour: number, canVisit: boolean): Activity {
  const weights: [Activity, number][] = [
    ["coffee", 3],
    ["lunch", dubaiHour >= 12 && dubaiHour < 14 ? 5 : 1],
    ["restroom", 2],
    ["lounge", 2],
    ["visit", canVisit ? 3 : 0],
    ["stroll", 1],
  ];
  const total = weights.reduce((s, [, w]) => s + w, 0);
  let r = rand() * total;
  for (const [a, w] of weights) {
    if ((r -= w) < 0) return a;
  }
  return "coffee";
}

export function dubaiHour(d = new Date()) {
  return Number(new Intl.DateTimeFormat("en-GB", { hour: "numeric", hour12: false, timeZone: "Asia/Dubai" }).format(d));
}

/** Small deterministic PRNG so each employee has their own rhythm. */
export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
