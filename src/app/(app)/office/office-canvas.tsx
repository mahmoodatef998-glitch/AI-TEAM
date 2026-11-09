"use client";

/**
 * Virtual office (PixiJS). A visual representation of REAL system state only:
 *  - each employee's position comes from `ai_employees.location`, which the agent executor sets
 *    when a task starts / waits for approval / completes;
 *  - status bubbles come from `ai_employees.status`;
 *  - monitors light up only while the employee is executing a task at their desk;
 *  - envelopes travel between employees only for internal messages sent in the last 2 minutes.
 * No movement or activity is generated client-side.
 */
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

type Zone =
  | "executive_office" | "meeting_room" | "operations_room" | "sales_department"
  | "lead_generation_department" | "research_department" | "marketing_department" | "waiting_area";

interface OfficeEmployee {
  id: string; code: string; name: string; title: string; color: string;
  status: string; location: string; homeZone: Zone; detail: string | null;
  task: { title: string; progress: number; type: string } | null;
}
interface OfficeState {
  now: string;
  pendingApprovals: number;
  employees: OfficeEmployee[];
  collaboration: { id: string; from: string; to: string; kind: string; subject: string | null; at: string }[];
  feed: { id: string; actorType: string; actorName: string | null; summary: string; at: string }[];
}

const W = 1200;
const H = 760;
const ROOMS: Record<Zone, { x: number; y: number; w: number; h: number; label: string; floor: number }> = {
  executive_office: { x: 20, y: 20, w: 300, h: 220, label: "Executive Office", floor: 0x3b3355 },
  meeting_room: { x: 340, y: 20, w: 360, h: 220, label: "Meeting Room", floor: 0x2f3e4f },
  operations_room: { x: 720, y: 20, w: 460, h: 220, label: "Operations · Technical Sales", floor: 0x3d3a2c },
  sales_department: { x: 20, y: 260, w: 560, h: 260, label: "Sales Department", floor: 0x23413d },
  lead_generation_department: { x: 600, y: 260, w: 280, h: 260, label: "Lead Generation", floor: 0x2b3b52 },
  research_department: { x: 900, y: 260, w: 280, h: 260, label: "Research & Intelligence", floor: 0x2f3542 },
  marketing_department: { x: 20, y: 540, w: 560, h: 200, label: "Marketing Department", floor: 0x47303a },
  waiting_area: { x: 600, y: 540, w: 580, h: 200, label: "Waiting Area · Human approval required", floor: 0x4a3f24 },
};
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
  const [state, setState] = useState<OfficeState | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

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

      // ── static layer: rooms ──
      const roomsLayer = new PIXI.Container();
      app.stage.addChild(roomsLayer);
      for (const [key, r] of Object.entries(ROOMS) as [Zone, (typeof ROOMS)[Zone]][]) {
        const g = new PIXI.Graphics();
        g.rect(r.x, r.y, r.w, r.h).fill(r.floor);
        for (let yy = r.y; yy < r.y + r.h; yy += 20) for (let xx = r.x + ((yy / 20) % 2) * 20; xx < r.x + r.w; xx += 40) g.rect(xx, yy, 20, 20).fill({ color: 0xffffff, alpha: 0.025 });
        g.rect(r.x, r.y, r.w, r.h).stroke({ width: 4, color: 0x64748b });
        roomsLayer.addChild(g);
        const label = new PIXI.Text({ text: r.label.toUpperCase(), style: { fontFamily: "monospace", fontSize: 12, fill: 0xcbd5e1, fontWeight: "bold" } });
        label.position.set(r.x + 10, r.y + 8);
        roomsLayer.addChild(label);
        if (key === "meeting_room") {
          const t = new PIXI.Graphics();
          t.roundRect(r.x + r.w / 2 - 90, r.y + 100, 180, 60, 12).fill(0x6b4f35).stroke({ width: 3, color: 0x3f2d1f });
          roomsLayer.addChild(t);
        }
        if (key === "waiting_area") {
          const b = new PIXI.Graphics();
          for (let i = 0; i < 5; i++) b.rect(r.x + 25 + i * 110, r.y + r.h - 28, 90, 12).fill(0x7c6a46);
          roomsLayer.addChild(b);
        }
      }

      // ── dynamic layers ──
      const deskLayer = new PIXI.Container();
      const linkLayer = new PIXI.Graphics();
      const peopleLayer = new PIXI.Container();
      const counter = new PIXI.Text({ text: "", style: { fontFamily: "monospace", fontSize: 13, fill: 0xfbbf24, fontWeight: "bold" } });
      counter.position.set(ROOMS.waiting_area.x + ROOMS.waiting_area.w - 190, ROOMS.waiting_area.y + 8);
      peopleLayer.sortableChildren = true;
      app.stage.addChild(deskLayer, linkLayer, peopleLayer, counter);

      interface Sprite { c: import("pixi.js").Container; body: import("pixi.js").Graphics; bubble: import("pixi.js").Graphics; bubbleText: import("pixi.js").Text; x: number; y: number; tx: number; ty: number; phase: number }
      const sprites = new Map<string, Sprite>();
      const desks = new Map<string, { x: number; y: number; monitor: import("pixi.js").Graphics }>();
      const envelopes = new Map<string, { g: import("pixi.js").Graphics; t: number }>();

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
        c.addChild(bubble, bubbleText);
        c.eventMode = "static";
        c.cursor = "pointer";
        c.hitArea = new PIXI.Rectangle(-24, -40, 48, 74);
        c.on("pointertap", () => router.push(`/employees/${e.id}`));
        c.on("pointerover", () => setHover(e.id));
        c.on("pointerout", () => setHover((h) => (h === e.id ? null : h)));
        return { c, body, bubble, bubbleText };
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
        s.employees.forEach((e, idx) => {
          let sp = sprites.get(e.id);
          const desk = desks.get(e.id)!;
          if (!sp) {
            const a = avatar(e, SKINS[idx % SKINS.length]);
            peopleLayer.addChild(a.c);
            sp = { ...a, x: desk.x, y: desk.y, tx: desk.x, ty: desk.y, phase: idx };
            sprites.set(e.id, sp);
          }
          const zone = ZONE_FOR_LOCATION(e.location, e.homeZone);
          if (e.location === "desk" || zone === e.homeZone) {
            sp.tx = desk.x;
            sp.ty = desk.y;
          } else {
            const n = visitorCount.get(zone) ?? 0;
            visitorCount.set(zone, n + 1);
            const v = visitorSlot(zone, n);
            sp.tx = v.x;
            sp.ty = v.y;
          }
          const st = STATUS_STYLE[e.status];
          sp.bubble.clear();
          sp.bubbleText.text = "";
          if (st) {
            const label = e.task ? `${st.label} ${e.task.progress}%` : st.label;
            const w = label.length * 6.4 + 12;
            sp.bubble.roundRect(-w / 2, -38, w, 16, 4).fill(st.color);
            sp.bubbleText.text = label;
          }
          const atDeskWorking = !!e.task && e.location === "desk";
          desk.monitor.clear().rect(desk.x - 12, desk.y - 50, 24, 14).fill(atDeskWorking ? 0x38bdf8 : 0x1f2937).stroke({ width: 2, color: 0x0b0f17 });
        });
        counter.text = s.pendingApprovals ? `${s.pendingApprovals} PENDING APPROVAL${s.pendingApprovals > 1 ? "S" : ""}` : "";
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
        for (const sp of sprites.values()) {
          const dx = sp.tx - sp.x;
          const dy = sp.ty - sp.y;
          const dist = Math.hypot(dx, dy);
          const moving = dist > 1.5;
          if (moving) {
            const step = Math.min(dist, 2.2 * dt);
            sp.x += (dx / dist) * step;
            sp.y += (dy / dist) * step;
            sp.phase += 0.25 * dt;
          }
          sp.c.position.set(Math.round(sp.x), Math.round(sp.y + (moving ? Math.sin(sp.phase) * 1.5 : 0)));
          sp.c.zIndex = Math.round(sp.y);
        }
        // Collaboration: a line + travelling envelope for each recent real message.
        linkLayer.clear();
        const now = Date.parse(s.now);
        const live = new Set<string>();
        for (const m of s.collaboration) {
          const a = sprites.get(m.from);
          const b = sprites.get(m.to);
          if (!a || !b) continue;
          const age = (now - Date.parse(m.at)) / 120_000;
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

  const hovered = state?.employees.find((e) => e.id === hover);
  const active = state?.employees.filter((e) => STATUS_STYLE[e.status]) ?? [];
  return (
    <div className="grid gap-4 2xl:grid-cols-[1fr_320px]">
      <div>
        <div ref={host} className="overflow-hidden rounded-lg border border-border bg-[#111827]" style={{ aspectRatio: `${W} / ${H}` }} />
        <div className="mt-2 min-h-10 text-sm" aria-live="polite">
          {error ? <span className="text-danger">{error}</span> : hovered ? (
            <span><strong>{hovered.name}</strong> · {hovered.title} · {STATUS_STYLE[hovered.status]?.label ?? "Idle"}{hovered.task ? ` — ${hovered.task.title} (${hovered.task.progress}%)` : hovered.detail ? ` — ${hovered.detail}` : ""}</span>
          ) : <span className="text-muted">Hover an employee for details; click to open their profile. Positions update from live task state every 3 s.</span>}
        </div>
      </div>
      <aside className="space-y-4">
        <section className="rounded-lg border border-border bg-surface p-3">
          <h2 className="text-sm font-semibold">Busy now ({active.length})</h2>
          {active.length === 0 ? <p className="mt-1 text-xs text-muted">Everyone is idle at their desk. Work starts when tasks are queued and the worker runs.</p> : (
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
          <ul>{state?.employees.map((e) => <li key={e.id}>{e.name}, {e.title}: {STATUS_STYLE[e.status]?.label ?? "Idle"} in {e.location.replace(/_/g, " ")}</li>)}</ul>
        </section>
      </aside>
    </div>
  );
}
