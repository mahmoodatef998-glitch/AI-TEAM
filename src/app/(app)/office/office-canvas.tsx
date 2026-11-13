"use client";

/**
 * Virtual office (PixiJS).
 *
 * WORK = real system state only:
 *  - which room an employee is in while working comes from `ai_employees.location`, set by the
 *    agent executor when a task starts / waits for approval / completes;
 *  - coloured status bubbles come from `ai_employees.status`; "Needs you" from assignments
 *    waiting for the signed-in person's answer;
 *  - monitors light up only while the employee executes a task at their desk;
 *  - envelopes travel between employees only for internal messages sent in the last 2 minutes.
 *
 * OFFICE LIFE = a decorative layer the viewer can switch off. Employees with no active work take
 * breaks (coffee, lunch, restroom, lounge, visiting a colleague) and greet each other in the
 * corridors. Real work always interrupts a break immediately. Breaks are never shown as work.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  ACTIVITY, between, DECOR, DESK_DWELL, DOOR_W, doorX, dubaiHour, H, MAX_AWAY_SHARE, mulberry32, pickActivity,
  ROOMS, route, SPOTS, W, type Activity, type Point, type Zone,
} from "./life";

interface OfficeEmployee {
  id: string; code: string; name: string; title: string; color: string;
  status: string; location: string; homeZone: Zone; detail: string | null;
  task: { title: string; progress: number; type: string } | null;
  awaitingYou?: boolean;
}
interface OfficeState {
  now: string;
  pendingApprovals: number;
  employees: OfficeEmployee[];
  collaboration: { id: string; from: string; to: string; kind: string; subject: string | null; at: string }[];
  feed: { id: string; actorType: string; actorName: string | null; summary: string; at: string }[];
}

const STATUS_STYLE: Record<string, { color: number; label: string }> = {
  working: { color: 0x3b82f6, label: "Working" },
  researching: { color: 0x06b6d4, label: "Researching" },
  writing: { color: 0x8b5cf6, label: "Writing" },
  analyzing: { color: 0x0ea5e9, label: "Analyzing" },
  contacting_customer: { color: 0x10b981, label: "Contacting" },
  preparing_quotation: { color: 0xf97316, label: "Quotation" },
  in_meeting: { color: 0xa855f7, label: "In meeting" },
  waiting_approval: { color: 0xf59e0b, label: "Awaiting approval" },
  blocked: { color: 0xf59e0b, label: "Blocked" },
  error: { color: 0xef4444, label: "Error" },
};
const ZONE_FOR_LOCATION = (loc: string, home: Zone): Zone => (loc === "desk" ? home : (loc as Zone));

// ── "Office life" preference (per viewer, survives reloads) ──
const LIFE_KEY = "office-life";
const lifeListeners = new Set<() => void>();
function readLife(): boolean {
  try {
    const v = localStorage.getItem(LIFE_KEY);
    if (v === "on") return true;
    if (v === "off") return false;
  } catch {}
  return !(typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches);
}
function writeLife(on: boolean) {
  try {
    localStorage.setItem(LIFE_KEY, on ? "on" : "off");
  } catch {}
  lifeListeners.forEach((l) => l());
}
const subscribeLife = (l: () => void) => {
  lifeListeners.add(l);
  return () => lifeListeners.delete(l);
};

/** Desk slots (home positions) and visitor slots per room. */
function deskSlots(z: Zone, count: number) {
  const r = ROOMS[z];
  const cols = Math.min(count, Math.max(1, Math.floor((r.w - 40) / 120)));
  const rows = Math.ceil(count / cols);
  return Array.from({ length: count }, (_, i) => {
    const c = i % cols;
    const row = Math.floor(i / cols);
    const cellW = (r.w - 40) / cols;
    const cellH = Math.min(110, (r.h - 70) / Math.max(1, rows));
    return { x: r.x + 20 + cellW * c + cellW / 2, y: r.y + 70 + cellH * row + 20 };
  });
}
function visitorSlot(z: Zone, i: number) {
  const r = ROOMS[z];
  if (z === "meeting_room") {
    const angle = (i / 8) * Math.PI * 2;
    return { x: r.x + r.w / 2 + Math.cos(angle) * 120, y: r.y + 130 + Math.sin(angle) * 55 };
  }
  const cols = Math.max(1, Math.floor((r.w - 40) / 70));
  return { x: r.x + 45 + (i % cols) * 70, y: r.y + r.h - 45 - Math.floor(i / cols) * 55 };
}

export function OfficeCanvas() {
  const host = useRef<HTMLDivElement>(null);
  const stateRef = useRef<OfficeState | null>(null);
  const activityRef = useRef(new Map<string, string>());
  const [state, setState] = useState<OfficeState | null>(null);
  const [hover, setHover] = useState<{ id: string; onBreak?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const life = useSyncExternalStore(subscribeLife, readLife, () => true);
  const lifeRef = useRef(life);
  const router = useRouter();

  useEffect(() => {
    lifeRef.current = life;
  }, [life]);

  // Poll real state.
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch("/api/office/state", { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const s = (await res.json()) as OfficeState;
        if (!alive) return;
        stateRef.current = s;
        setState(s);
        setError(null);
      } catch (e) {
        if (alive) setError(`Couldn't load office state (${(e as Error).message}). Retrying…`);
      }
    };
    load();
    const t = setInterval(load, 3000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  // Render loop.
  useEffect(() => {
    let destroyed = false;
    let cleanup = () => {};
    (async () => {
      const PIXI = await import("pixi.js");
      const app = new PIXI.Application();
      await app.init({ width: W, height: H, background: 0x111827, antialias: false, resolution: Math.min(2, window.devicePixelRatio || 1), autoDensity: true });
      if (destroyed || !host.current) {
        app.destroy(true);
        return;
      }
      app.canvas.style.width = "100%";
      app.canvas.style.height = "auto";
      app.canvas.setAttribute("aria-hidden", "true");
      host.current.appendChild(app.canvas);

      // ── static layer: rooms, doors, furniture ──
      const roomsLayer = new PIXI.Container();
      app.stage.addChild(roomsLayer);
      const floorTiles = (g: import("pixi.js").Graphics, r: { x: number; y: number; w: number; h: number }) => {
        for (let yy = r.y; yy < r.y + r.h; yy += 20) for (let xx = r.x + ((yy / 20) % 2) * 20; xx < r.x + r.w; xx += 40) g.rect(xx, yy, 20, 20).fill({ color: 0xffffff, alpha: 0.025 });
      };
      const drawRoom = (r: { x: number; y: number; w: number; h: number; label: string; floor: number }) => {
        const g = new PIXI.Graphics();
        g.rect(r.x, r.y, r.w, r.h).fill(r.floor);
        floorTiles(g, r);
        g.rect(r.x, r.y, r.w, r.h).stroke({ width: 4, color: 0x64748b });
        // Doors (gaps in the wall) on the top and bottom walls, where people walk in and out.
        const dx = doorX(r);
        g.rect(dx - DOOR_W / 2, r.y - 3, DOOR_W, 6).fill(r.floor);
        g.rect(dx - DOOR_W / 2, r.y + r.h - 3, DOOR_W, 6).fill(r.floor);
        roomsLayer.addChild(g);
        const label = new PIXI.Text({ text: r.label.toUpperCase(), style: { fontFamily: "monospace", fontSize: 12, fill: 0xcbd5e1, fontWeight: "bold" } });
        label.position.set(r.x + 10, r.y + 8);
        roomsLayer.addChild(label);
      };
      for (const r of Object.values(ROOMS)) drawRoom(r);
      for (const r of Object.values(DECOR)) drawRoom(r);

      const f = new PIXI.Graphics();
      const mr = ROOMS.meeting_room;
      f.roundRect(mr.x + mr.w / 2 - 90, mr.y + 100, 180, 60, 12).fill(0x6b4f35).stroke({ width: 3, color: 0x3f2d1f });
      const wa = ROOMS.waiting_area;
      for (let i = 0; i < 5; i++) f.rect(wa.x + 25 + i * 110, wa.y + wa.h - 28, 90, 12).fill(0x7c6a46);
      // Pantry: counter + coffee machine, fridge, dining tables.
      const P = DECOR.pantry;
      f.rect(P.x + 30, P.y + 38, 200, 22).fill(0x8b7355).stroke({ width: 2, color: 0x4a3626 });
      f.rect(P.x + 44, P.y + 26, 22, 18).fill(0x1f2937).rect(P.x + 52, P.y + 31, 6, 4).fill(0xef4444);
      f.rect(P.x + 100, P.y + 30, 14, 10).fill(0xe5e7eb).rect(P.x + 150, P.y + 30, 30, 10).fill(0x94a3b8);
      f.rect(P.x + P.w - 70, P.y + 30, 40, 58).fill(0xd1d5db).stroke({ width: 2, color: 0x6b7280 }).rect(P.x + P.w - 66, P.y + 58, 3, 12).fill(0x6b7280);
      for (let t = 0; t < 3; t++) {
        const cx = P.x + 250 + t * 110;
        f.roundRect(cx - 34, P.y + 104, 68, 26, 6).fill(0xa47148).stroke({ width: 2, color: 0x5b3a1e });
        f.circle(cx - 26, P.y + 142, 6).fill(0x475569).circle(cx + 26, P.y + 142, 6).fill(0x475569);
      }
      // Restrooms: three stalls and sinks.
      const R = DECOR.restrooms;
      for (let i = 0; i < 3; i++) {
        f.rect(R.x + 18 + i * 60, R.y + 34, 46, 64).fill(0x3f5262).stroke({ width: 2, color: 0x9ca3af });
        f.circle(R.x + 41 + i * 60, R.y + 54, 7).fill(0xf8fafc);
      }
      f.rect(R.x + 30, R.y + R.h - 30, R.w - 60, 12).fill(0xcbd5e1);
      // Lounge: TV, rug, sofa, plants.
      const L = DECOR.lounge;
      f.rect(L.x + 110, L.y + 34, 130, 14).fill(0x0f172a).rect(L.x + 114, L.y + 37, 122, 8).fill(0x1d4ed8);
      f.roundRect(L.x + 60, L.y + 80, 240, 40, 8).fill({ color: 0x7c3aed, alpha: 0.25 });
      f.roundRect(L.x + 44, L.y + 140, 272, 22, 8).fill(0x6d28d9).stroke({ width: 2, color: 0x3b0764 });
      for (const [px, py] of [[L.x + 24, L.y + 40], [L.x + L.w - 24, L.y + 40], [P.x + P.w - 30, P.y + 150]]) {
        f.circle(px, py, 11).fill(0x15803d).circle(px, py + 12, 7).fill(0x7c2d12);
      }
      roomsLayer.addChild(f);

      // ── dynamic layers ──
      const deskLayer = new PIXI.Container();
      const linkLayer = new PIXI.Graphics();
      const peopleLayer = new PIXI.Container();
      const counter = new PIXI.Text({ text: "", style: { fontFamily: "monospace", fontSize: 13, fill: 0xfbbf24, fontWeight: "bold" } });
      counter.position.set(ROOMS.waiting_area.x + ROOMS.waiting_area.w - 190, ROOMS.waiting_area.y + 8);
      peopleLayer.sortableChildren = true;
      app.stage.addChild(deskLayer, linkLayer, peopleLayer, counter);

      type G = import("pixi.js").Graphics;
      type T = import("pixi.js").Text;
      interface LifeState { activity: Activity; stage: "out" | "at" | "back"; until: number; spot: Point; with?: string }
      interface Sprite {
        id: string; name: string; c: import("pixi.js").Container; bubble: G; bubbleText: T; emote: G; emoteText: T;
        x: number; y: number; path: Point[]; target: Point; phase: number; rand: () => number;
        free: boolean; life: LifeState | null; nextAt: number; emoteUntil: number; emoteLabel: string; hasStatus: boolean;
      }
      const sprites = new Map<string, Sprite>();
      const desks = new Map<string, { x: number; y: number; monitor: G }>();
      const envelopes = new Map<string, { g: G; t: number }>();
      const greeted = new Map<string, number>();

      const buildDesks = (s: OfficeState) => {
        deskLayer.removeChildren();
        desks.clear();
        const byZone = new Map<Zone, OfficeEmployee[]>();
        for (const e of s.employees) byZone.set(e.homeZone, [...(byZone.get(e.homeZone) ?? []), e]);
        for (const [z, list] of byZone) {
          const slots = deskSlots(z, list.length);
          list.forEach((e, i) => {
            const p = slots[i];
            const d = new PIXI.Graphics();
            d.rect(p.x - 34, p.y + 4, 68, 22).fill(0x8b6b4a).stroke({ width: 2, color: 0x4a3626 });
            const monitor = new PIXI.Graphics();
            monitor.rect(p.x - 12, p.y - 10, 24, 14).fill(0x1f2937).stroke({ width: 2, color: 0x0b0f17 });
            deskLayer.addChild(d, monitor);
            desks.set(e.id, { x: p.x, y: p.y + 40, monitor });
          });
        }
      };

      const avatar = (e: OfficeEmployee, skin: number) => {
        const c = new PIXI.Container();
        const body = new PIXI.Graphics();
        const color = parseInt(e.color.replace("#", ""), 16);
        body.rect(-7, -2, 14, 14).fill(color); // torso
        body.rect(-6, -14, 12, 12).fill(skin); // head
        body.rect(-6, -16, 12, 5).fill(0x2b1d14); // hair
        body.rect(-3, -9, 2, 2).fill(0x111111).rect(1, -9, 2, 2).fill(0x111111); // eyes
        body.rect(-6, 12, 5, 6).fill(0x1e293b).rect(1, 12, 5, 6).fill(0x1e293b); // legs
        c.addChild(body);
        const name = new PIXI.Text({ text: e.name, style: { fontFamily: "monospace", fontSize: 11, fill: 0xf8fafc, fontWeight: "bold" } });
        name.anchor.set(0.5, 0);
        name.position.set(0, 20);
        c.addChild(name);
        const bubble = new PIXI.Graphics();
        const bubbleText = new PIXI.Text({ text: "", style: { fontFamily: "monospace", fontSize: 10, fill: 0x0b0f17, fontWeight: "bold" } });
        bubbleText.anchor.set(0.5, 0.5);
        bubbleText.position.set(0, -30);
        const emote = new PIXI.Graphics();
        const emoteText = new PIXI.Text({ text: "", style: { fontFamily: "system-ui, 'Segoe UI Emoji', 'Apple Color Emoji', sans-serif", fontSize: 12, fill: 0x0f172a, fontWeight: "bold" } });
        emoteText.anchor.set(0.5, 0.5);
        c.addChild(bubble, bubbleText, emote, emoteText);
        c.eventMode = "static";
        c.cursor = "pointer";
        c.hitArea = new PIXI.Rectangle(-24, -40, 48, 74);
        c.on("pointertap", () => {
          const cur = stateRef.current?.employees.find((x) => x.id === e.id);
          router.push(cur?.awaitingYou ? `/team?e=${e.id}` : `/employees/${e.id}`);
        });
        c.on("pointerover", () => setHover({ id: e.id, onBreak: activityRef.current.get(e.id) }));
        c.on("pointerout", () => setHover((h) => (h?.id === e.id ? null : h)));
        return { c, bubble, bubbleText, emote, emoteText };
      };

      const goTo = (sp: Sprite, p: Point) => {
        if (sp.target.x === p.x && sp.target.y === p.y && (sp.path.length || (sp.x === p.x && sp.y === p.y))) return;
        sp.target = p;
        sp.path = route({ x: sp.x, y: sp.y }, p);
      };
      const drawEmote = (sp: Sprite, label: string) => {
        sp.emote.clear();
        sp.emoteText.text = label;
        if (!label) return;
        const y = sp.hasStatus ? -56 : -38;
        const w = Math.max(24, sp.emoteText.width + 12);
        sp.emote.roundRect(-w / 2, y - 9, w, 18, 9).fill(0xffffff).stroke({ width: 1.5, color: 0xcbd5e1 });
        sp.emote.poly([-4, y + 8, 4, y + 8, 0, y + 13]).fill(0xffffff);
        sp.emoteText.position.set(0, y);
      };

      const SKINS = [0xf1c7a1, 0xd9a273, 0xa86f47, 0xe8b88f, 0x8d5a3b];
      let lastKey = "";
      const sync = (s: OfficeState) => {
        const key = s.employees.map((e) => `${e.id}:${e.homeZone}`).join("|");
        if (key !== lastKey) {
          buildDesks(s);
          lastKey = key;
        }
        const visitorCount = new Map<Zone, number>();
        const now = performance.now();
        s.employees.forEach((e, idx) => {
          let sp = sprites.get(e.id);
          const desk = desks.get(e.id)!;
          if (!sp) {
            const a = avatar(e, SKINS[idx % SKINS.length]);
            peopleLayer.addChild(a.c);
            const rand = mulberry32(parseInt(e.id.replace(/-/g, "").slice(0, 8), 16) || idx + 1);
            sp = { ...a, id: e.id, name: e.name, x: desk.x, y: desk.y, path: [], target: { x: desk.x, y: desk.y }, phase: idx, rand, free: false, life: null, nextAt: now + between(rand, [4_000, 30_000]), emoteUntil: 0, emoteLabel: "", hasStatus: false };
            sprites.set(e.id, sp);
          }
          const st = STATUS_STYLE[e.status];
          const zone = ZONE_FOR_LOCATION(e.location, e.homeZone);
          // Free for a break only when there is no real work and nobody is waiting on them.
          sp.free = !st && !e.awaitingYou && e.location === "desk";
          if (!sp.free) {
            sp.life = null;
            if (e.location === "desk" || zone === e.homeZone) goTo(sp, { x: desk.x, y: desk.y });
            else {
              const n = visitorCount.get(zone) ?? 0;
              visitorCount.set(zone, n + 1);
              goTo(sp, visitorSlot(zone, n));
            }
          } else if (!sp.life) goTo(sp, { x: desk.x, y: desk.y });

          sp.bubble.clear();
          sp.bubbleText.text = "";
          sp.hasStatus = !!st || !!e.awaitingYou;
          const label = e.awaitingYou ? "? Needs you" : st ? (e.task ? `${st.label} ${e.task.progress}%` : st.label) : "";
          if (label) {
            const w = label.length * 6.4 + 12;
            sp.bubble.roundRect(-w / 2, -38, w, 16, 4).fill(e.awaitingYou ? 0xf59e0b : st!.color);
            sp.bubbleText.text = label;
          }
          const atDeskWorking = !!e.task && e.location === "desk";
          desk.monitor.clear().rect(desk.x - 12, desk.y - 50, 24, 14).fill(atDeskWorking ? 0x38bdf8 : 0x1f2937).stroke({ width: 2, color: 0x0b0f17 });
        });
        counter.text = s.pendingApprovals ? `${s.pendingApprovals} PENDING APPROVAL${s.pendingApprovals > 1 ? "S" : ""}` : "";
      };

      // ── office life: decide breaks for free employees ──
      const taken = (spot: Point) => [...sprites.values()].some((o) => o.life && o.life.spot.x === spot.x && o.life.spot.y === spot.y);
      const startBreak = (sp: Sprite, now: number) => {
        const deskOf = (id: string) => desks.get(id)!;
        const hosts = [...sprites.values()].filter((o) => o !== sp && o.free && !o.life && !o.path.length);
        let activity = pickActivity(sp.rand, dubaiHour(), hosts.length > 0);
        let spot: Point | null = null;
        let withId: string | undefined;
        if (activity === "visit") {
          const h = hosts[Math.floor(sp.rand() * hosts.length)];
          const d = deskOf(h.id);
          spot = { x: d.x + 46, y: d.y };
          withId = h.id;
        } else if (activity === "stroll") {
          const ys = [250, 530, 750];
          spot = { x: 40 + sp.rand() * (W - 80), y: ys[Math.floor(sp.rand() * ys.length)] };
        } else {
          const free = SPOTS[activity].filter((p) => !taken(p));
          if (free.length) spot = free[Math.floor(sp.rand() * free.length)];
          else activity = "stroll";
          if (!spot) spot = { x: 40 + sp.rand() * (W - 80), y: 530 };
        }
        sp.life = { activity, stage: "out", until: 0, spot, with: withId };
        goTo(sp, spot);
        activityRef.current.set(sp.id, ACTIVITY[activity].label);
        void now;
      };

      let synced: OfficeState | null = null;
      app.ticker.add((ticker) => {
        const s = stateRef.current;
        if (!s) return;
        if (s !== synced) {
          sync(s);
          synced = s;
        }
        const dt = ticker.deltaTime;
        const now = performance.now();
        const lifeOn = lifeRef.current;
        const freeCount = [...sprites.values()].filter((x) => x.free).length;
        let away = [...sprites.values()].filter((x) => x.life).length;

        for (const sp of sprites.values()) {
          const desk = desks.get(sp.id);
          if (!desk) continue;
          // Breaks only for free employees, only while office life is on.
          if (!sp.free || !lifeOn) {
            if (sp.life) {
              sp.life = null;
              if (sp.free) goTo(sp, { x: desk.x, y: desk.y });
            }
            activityRef.current.delete(sp.id);
          } else if (!sp.life) {
            if (now >= sp.nextAt && !sp.path.length && away < Math.max(1, Math.floor(freeCount * MAX_AWAY_SHARE))) {
              startBreak(sp, now);
              away++;
            }
          } else if (sp.life.stage === "out" && !sp.path.length) {
            sp.life.stage = "at";
            sp.life.until = now + between(sp.rand, ACTIVITY[sp.life.activity].dwell);
            if (sp.life.with) {
              const h = sprites.get(sp.life.with);
              if (h && h.free && !h.life) {
                h.emoteLabel = `👋 ${sp.name}!`;
                h.emoteUntil = now + 2_500;
              }
            }
          } else if (sp.life.stage === "at" && now >= sp.life.until) {
            sp.life.stage = "back";
            goTo(sp, { x: desk.x, y: desk.y });
          } else if (sp.life.stage === "back" && !sp.path.length) {
            sp.life = null;
            sp.nextAt = now + between(sp.rand, DESK_DWELL);
            activityRef.current.delete(sp.id);
          }

          // Walk along the route.
          const next = sp.path[0];
          let moving = false;
          if (next) {
            const dx = next.x - sp.x;
            const dy = next.y - sp.y;
            const dist = Math.hypot(dx, dy);
            if (dist <= 1.5) {
              sp.x = next.x;
              sp.y = next.y;
              sp.path.shift();
            } else {
              const step = Math.min(dist, 2.2 * dt);
              sp.x += (dx / dist) * step;
              sp.y += (dy / dist) * step;
              sp.phase += 0.25 * dt;
              moving = true;
            }
          }
          sp.c.position.set(Math.round(sp.x), Math.round(sp.y + (moving ? Math.sin(sp.phase) * 1.5 : 0)));
          sp.c.zIndex = Math.round(sp.y);
          sp.c.alpha = sp.life?.activity === "restroom" && sp.life.stage === "at" ? 0.35 : 1;
        }

        // Corridor greetings between two people walking past each other.
        if (lifeOn) {
          const walkers = [...sprites.values()].filter((x) => x.free && x.path.length);
          for (let i = 0; i < walkers.length; i++) for (let j = i + 1; j < walkers.length; j++) {
            const a = walkers[i];
            const b = walkers[j];
            if (Math.hypot(a.x - b.x, a.y - b.y) > 28) continue;
            const k = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
            if (now - (greeted.get(k) ?? -1e9) < 45_000) continue;
            greeted.set(k, now);
            a.emoteLabel = `👋 Hi ${b.name}!`;
            b.emoteLabel = `👋 Hi ${a.name}!`;
            a.emoteUntil = b.emoteUntil = now + 2_400;
          }
        }
        for (const sp of sprites.values()) {
          const label = now < sp.emoteUntil ? sp.emoteLabel : sp.life?.stage === "at" ? ACTIVITY[sp.life.activity].emote : "";
          if (label !== sp.emoteText.text) drawEmote(sp, label);
        }

        // Collaboration: a line + travelling envelope for each recent real message.
        linkLayer.clear();
        const serverNow = Date.parse(s.now);
        const live = new Set<string>();
        for (const m of s.collaboration) {
          const a = sprites.get(m.from);
          const b = sprites.get(m.to);
          if (!a || !b) continue;
          const age = (serverNow - Date.parse(m.at)) / 120_000;
          const alpha = Math.max(0.15, 0.7 - age * 0.5);
          linkLayer.moveTo(a.x, a.y - 4).lineTo(b.x, b.y - 4).stroke({ width: 2, color: m.kind === "escalation" ? 0xef4444 : 0x94a3b8, alpha });
          live.add(m.id);
          let env = envelopes.get(m.id);
          if (!env) {
            const g = new PIXI.Graphics();
            g.rect(-7, -5, 14, 10).fill(0xfef3c7).stroke({ width: 1.5, color: 0x92400e });
            g.moveTo(-7, -5).lineTo(0, 1).lineTo(7, -5).stroke({ width: 1.5, color: 0x92400e });
            g.zIndex = 10_000;
            peopleLayer.addChild(g);
            env = { g, t: 0 };
            envelopes.set(m.id, env);
          }
          env.t = (env.t + 0.008 * dt) % 1;
          env.g.position.set(a.x + (b.x - a.x) * env.t, a.y - 4 + (b.y - a.y) * env.t);
        }
        for (const [id, env] of envelopes) if (!live.has(id)) {
          env.g.destroy();
          envelopes.delete(id);
        }
      });

      cleanup = () => app.destroy(true, { children: true });
    })();
    return () => {
      destroyed = true;
      cleanup();
    };
  }, [router]);

  const hovered = state?.employees.find((e) => e.id === hover?.id);
  const hoveredBreak = hover?.onBreak;
  const active = state?.employees.filter((e) => STATUS_STYLE[e.status]) ?? [];
  const needYou = state?.employees.filter((e) => e.awaitingYou) ?? [];
  return (
    <div className="grid gap-4 2xl:grid-cols-[1fr_320px]">
      <div>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <button
            type="button"
            role="switch"
            aria-checked={life}
            onClick={() => writeLife(!life)}
            className="inline-flex items-center gap-2 rounded-full border border-border bg-surface px-3 py-1 text-sm"
          >
            <span className={`relative h-4 w-7 rounded-full transition-colors ${life ? "bg-accent" : "bg-border"}`} aria-hidden>
              <span className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-all ${life ? "left-3.5" : "left-0.5"}`} />
            </span>
            Office life
          </button>
          <span className="text-xs text-muted">
            {life ? "Idle employees take breaks and chat (decorative). Real work always takes priority." : "Showing real work only."}
          </span>
        </div>
        <div ref={host} className="overflow-hidden rounded-lg border border-border bg-[#111827]" style={{ aspectRatio: `${W} / ${H}` }} />
        <div className="mt-2 min-h-10 text-sm" aria-live="polite">
          {error ? <span className="text-danger">{error}</span> : hovered ? (
            <span>
              <strong>{hovered.name}</strong> · {hovered.title} ·{" "}
              {hovered.awaitingYou ? "Waiting for your answer (click to reply)" : STATUS_STYLE[hovered.status]?.label ?? (hoveredBreak ? `Idle — ${hoveredBreak}` : "Idle")}
              {hovered.task ? ` — ${hovered.task.title} (${hovered.task.progress}%)` : hovered.detail ? ` — ${hovered.detail}` : ""}
            </span>
          ) : <span className="text-muted">Hover an employee for details; click to open their profile. Coloured bubbles are real work; ☕ 🍽️ 🚻 🎧 💬 are breaks.</span>}
        </div>
      </div>
      <aside className="space-y-4">
        {needYou.length > 0 && (
          <section className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3">
            <h2 className="text-sm font-semibold">Waiting for you ({needYou.length})</h2>
            <ul className="mt-2 space-y-1.5 text-xs">
              {needYou.map((e) => <li key={e.id}><Link href={`/team?e=${e.id}`} className="font-medium text-accent hover:underline">{e.name}</Link> has a question for you</li>)}
            </ul>
          </section>
        )}
        <section className="rounded-lg border border-border bg-surface p-3">
          <h2 className="text-sm font-semibold">Busy now ({active.length})</h2>
          {active.length === 0 ? <p className="mt-1 text-xs text-muted">Nobody is working on a task right now. Give someone a task in <Link href="/team" className="text-accent hover:underline">Team chat</Link>.</p> : (
            <ul className="mt-2 space-y-1.5 text-xs">{active.map((e) => <li key={e.id}><Link href={`/employees/${e.id}`} className="font-medium text-accent hover:underline">{e.name}</Link> · {STATUS_STYLE[e.status].label}{e.task ? ` — ${e.task.title}` : e.detail ? ` — ${e.detail}` : ""}</li>)}</ul>
          )}
        </section>
        <section className="rounded-lg border border-border bg-surface p-3">
          <h2 className="text-sm font-semibold">Live activity</h2>
          <ul className="mt-2 max-h-[420px] space-y-1.5 overflow-auto text-xs">
            {(state?.feed ?? []).map((f) => <li key={f.id}><span className="text-muted">{new Date(f.at).toLocaleTimeString("en-GB", { timeZone: "Asia/Dubai" })}</span> {f.summary}</li>)}
          </ul>
        </section>
        <section className="sr-only">
          <h2>All employees</h2>
          <ul>{state?.employees.map((e) => <li key={e.id}>{e.name}, {e.title}: {e.awaitingYou ? "waiting for your answer" : STATUS_STYLE[e.status]?.label ?? "Idle"} in {e.location.replace(/_/g, " ")}</li>)}</ul>
        </section>
      </aside>
    </div>
  );
}
