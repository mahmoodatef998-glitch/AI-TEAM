import { describe, expect, it } from "vitest";
import { DECOR, DOOR_W, doorX, mulberry32, pickActivity, ROOMS, roomAt, route, SPOTS, type Point } from "@/app/(app)/office/life";

const all = [...Object.values(ROOMS), ...Object.values(DECOR)];
const inside = (p: Point) => all.filter((r) => p.x > r.x + 1 && p.x < r.x + r.w - 1 && p.y > r.y + 1 && p.y < r.y + r.h - 1);

/** Sample the walked path and check it only enters rooms at the start/end, and only through doors. */
function assertWalkable(from: Point, to: Point) {
  const pts = [from, ...route(from, to)];
  const allowed = new Set([roomAt(from), roomAt(to)].filter(Boolean));
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 4));
    let prev = inside(a);
    for (let k = 1; k <= n; k++) {
      const p = { x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n };
      const now = inside(p);
      for (const r of now) expect(allowed.has(r), `walked through ${JSON.stringify(r)} at ${JSON.stringify(p)}`).toBe(true);
      // Crossing a wall (entering or leaving a room) must happen in the door opening.
      const crossed = [...now.filter((r) => !prev.includes(r)), ...prev.filter((r) => !now.includes(r))];
      for (const r of crossed) expect(Math.abs(p.x - doorX(r)), `went through a wall of ${JSON.stringify(r)}`).toBeLessThanOrEqual(DOOR_W / 2);
      prev = now;
    }
  }
  expect(pts[pts.length - 1]).toEqual(to);
}

const centre = (r: { x: number; y: number; w: number; h: number }) => ({ x: r.x + r.w / 2 + 37, y: r.y + r.h / 2 + 11 });

describe("office routing", () => {
  it("walks between every pair of rooms through doors and corridors only", () => {
    for (const a of all) for (const b of all) assertWalkable(centre(a), centre(b));
  });

  it("reaches every break spot from every room", () => {
    for (const a of all) for (const spots of Object.values(SPOTS)) for (const s of spots) assertWalkable(centre(a), s);
  });

  it("walks from a corridor to a room and back", () => {
    assertWalkable({ x: 400, y: 530 }, centre(DECOR.lounge));
    assertWalkable(centre(ROOMS.executive_office), { x: 1000, y: 750 });
  });
});

describe("office life planner", () => {
  it("never plans a visit when nobody is free to visit", () => {
    const r = mulberry32(7);
    for (let i = 0; i < 500; i++) expect(pickActivity(r, 10, false)).not.toBe("visit");
  });

  it("makes lunch more likely around midday", () => {
    const count = (h: number) => {
      const r = mulberry32(42);
      return Array.from({ length: 4000 }, () => pickActivity(r, h, true)).filter((a) => a === "lunch").length;
    };
    expect(count(13)).toBeGreaterThan(count(10) * 2);
  });
});
