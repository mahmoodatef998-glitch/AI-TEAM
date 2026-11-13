"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { requeueTaskAction, sendToEmployeeAction } from "@/app/actions";
import { Markdown } from "./markdown";

// ───────── types (mirror /api/team) ─────────
interface Member {
  id: string; code: string; name: string; title: string; color: string;
  department: string; departmentKey: string; status: string; statusDetail: string | null;
  responsibilities: string[]; unread: number; awaitingYou: boolean; openAssignments: number;
  lastMessage: { body: string; kind: string; at: string; fromYou: boolean } | null;
}
interface ChatMessage { id: string; from: "user" | "employee"; kind: string; subject: string | null; body: string; taskId: string | null; reportId: string | null; at: string }
interface ChatTask { id: string; title: string; status: string; progress: number; awaitingUser: boolean; blockedReason: string | null; error: string | null }
interface ChatReport { id: string; title: string; data: { summary?: string; body?: string; nextSteps?: string[]; assumptions?: string[] }; createdAt: string }
interface Conversation { messages: ChatMessage[]; tasks: ChatTask[]; reports: ChatReport[] }

const DEPT_ORDER = ["executive", "sales", "technical_sales", "lead_generation", "research", "marketing"];
const BUSY = new Set(["working", "researching", "writing", "analyzing", "contacting_customer", "preparing_quotation", "in_meeting"]);

function presence(m: Member) {
  if (m.awaitingYou) return { label: "Waiting for you", dot: "bg-amber-500", ring: "ring-amber-400" };
  if (BUSY.has(m.status)) return { label: "Working", dot: "bg-sky-500", ring: "ring-sky-400" };
  if (m.status === "waiting_approval") return { label: "Awaiting approval", dot: "bg-amber-500", ring: "ring-amber-400" };
  if (m.status === "error") return { label: "Needs attention", dot: "bg-red-500", ring: "ring-red-400" };
  return { label: "Available", dot: "bg-emerald-500", ring: "ring-emerald-400" };
}

function Face({ m, size = 40, showDot = true }: { m: Pick<Member, "name" | "color"> & Partial<Member>; size?: number; showDot?: boolean }) {
  const p = m.status !== undefined ? presence(m as Member) : null;
  return (
    <span className="relative inline-flex shrink-0" style={{ width: size, height: size }} aria-hidden>
      <span
        className="flex h-full w-full items-center justify-center rounded-2xl font-bold text-white shadow-sm"
        style={{ background: `linear-gradient(135deg, ${m.color}, color-mix(in srgb, ${m.color} 55%, #0f172a))`, fontSize: size * 0.42 }}
      >
        {m.name.slice(0, 1)}
      </span>
      {showDot && p && <span className={`absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-surface ${p.dot}`} />}
    </span>
  );
}

const ago = (iso: string) => {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
};
const clock = (iso: string) => new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Dubai" });
const dayLabel = (iso: string) => {
  const d = new Date(iso);
  const today = new Date();
  const y = new Date(Date.now() - 86400000);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === y.toDateString()) return "Yesterday";
  return d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
};

function TaskPill({ t }: { t: ChatTask | undefined }) {
  if (!t) return null;
  const map: Record<string, [string, string]> = {
    queued: ["In the queue", "bg-slate-500/15 text-muted"],
    running: [`Working · ${t.progress}%`, "bg-sky-500/15 text-sky-700 dark:text-sky-300"],
    blocked: t.awaitingUser ? ["Waiting for your answer", "bg-amber-500/15 text-amber-700 dark:text-amber-300"] : ["Blocked", "bg-red-500/15 text-red-700 dark:text-red-300"],
    completed: ["Done", "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"],
    failed: ["Failed", "bg-red-500/15 text-red-700 dark:text-red-300"],
    cancelled: ["Cancelled", "bg-slate-500/15 text-muted"],
    waiting_approval: ["Awaiting approval", "bg-amber-500/15 text-amber-700 dark:text-amber-300"],
  };
  const [label, cls] = map[t.status] ?? [t.status, "bg-slate-500/15 text-muted"];
  return <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${cls}`}>{label}</span>;
}

function ReportCard({ r, author }: { r: ChatReport | undefined; author: Member }) {
  const [open, setOpen] = useState(false);
  if (!r) return null;
  return (
    <div className="mt-2 overflow-hidden rounded-xl border border-emerald-500/30 bg-surface">
      <div className="flex items-center gap-2 bg-gradient-to-r from-emerald-500/15 to-transparent px-3 py-2">
        <span className="text-base" aria-hidden>✅</span>
        <div className="min-w-0">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-300">Task complete · report</div>
          <div dir="auto" className="truncate text-sm font-semibold">{r.title}</div>
        </div>
      </div>
      <div className="space-y-2 px-3 py-2 text-sm">
        {r.data.summary && <p dir="auto">{r.data.summary}</p>}
        {!!r.data.nextSteps?.length && (
          <div>
            <div className="text-xs font-semibold text-muted">Next steps</div>
            <ul dir="auto" className="mt-1 space-y-1">
              {r.data.nextSteps.map((s, i) => (
                <li key={i} className="flex gap-2"><span className="mt-0.5 h-3.5 w-3.5 shrink-0 rounded border border-border" aria-hidden />{s}</li>
              ))}
            </ul>
          </div>
        )}
        {open && r.data.body && <div className="border-t border-border pt-2"><Markdown source={r.data.body} /></div>}
        {open && !!r.data.assumptions?.length && (
          <div className="rounded-md bg-amber-500/10 px-2 py-1.5 text-xs">
            <span className="font-semibold">{author.name} assumed: </span>
            <span dir="auto">{r.data.assumptions.join(" · ")}</span>
          </div>
        )}
        <div className="flex gap-3 pt-1 text-xs">
          <button type="button" onClick={() => setOpen((o) => !o)} className="font-medium text-accent hover:underline" aria-expanded={open}>
            {open ? "Hide full report" : "Read full report"}
          </button>
          <Link href="/reports" className="text-muted hover:text-text">All reports</Link>
        </div>
      </div>
    </div>
  );
}

function Typing({ name }: { name: string }) {
  return (
    <span className="inline-flex items-center gap-1" aria-label={`${name} is working`}>
      {[0, 1, 2].map((i) => (
        <span key={i} className="h-1.5 w-1.5 animate-bounce rounded-full bg-current motion-reduce:animate-none" style={{ animationDelay: `${i * 150}ms` }} />
      ))}
    </span>
  );
}

export function TeamChat({ userName, canWrite }: { userName: string; canWrite: boolean }) {
  const params = useSearchParams();
  const router = useRouter();
  const selectedId = params.get("e");
  const [team, setTeam] = useState<Member[] | null>(null);
  const [conv, setConv] = useState<Conversation | null>(null);
  const [convFor, setConvFor] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  // Drafts and errors are kept per person, so switching conversations never loses what you typed.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [sendError, setSendError] = useState<{ for: string; msg: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const refresh = useRef<() => Promise<void>>(async () => {});
  const draft = selectedId ? drafts[selectedId] ?? "" : "";
  const setDraft = useCallback((v: string) => selectedId && setDrafts((d) => ({ ...d, [selectedId]: v })), [selectedId]);

  // Poll the real state every 3 s.
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch(`/api/team${selectedId ? `?employee=${selectedId}` : ""}`, { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const j = (await res.json()) as { team: Member[]; conversation: Conversation | null };
        if (!alive) return;
        setTeam(j.team);
        setConv(j.conversation);
        setConvFor(selectedId);
        setLoadError(null);
      } catch (e) {
        if (alive) setLoadError(`Couldn't refresh the chat (${(e as Error).message}). Retrying…`);
      }
    };
    refresh.current = load;
    load();
    const t = setInterval(load, 3000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [selectedId]);
  const load = () => refresh.current();

  const member = team?.find((m) => m.id === selectedId) ?? null;
  const conversation = convFor === selectedId ? conv : null;
  const lastCount = useRef(0);
  useEffect(() => {
    const n = conversation?.messages.length ?? 0;
    if (n !== lastCount.current) scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: lastCount.current ? "smooth" : "auto" });
    lastCount.current = n;
  }, [conversation?.messages.length]);
  useEffect(() => {
    lastCount.current = 0;
  }, [selectedId]);

  const taskById = useMemo(() => new Map((conversation?.tasks ?? []).map((t) => [t.id, t])), [conversation]);
  const reportById = useMemo(() => new Map((conversation?.reports ?? []).map((r) => [r.id, r])), [conversation]);
  const openQuestion = useMemo(() => {
    const t = conversation?.tasks.find((x) => x.awaitingUser);
    if (!t) return null;
    const q = [...(conversation?.messages ?? [])].reverse().find((m) => m.taskId === t.id && m.kind === "information_request");
    return q ? { task: t, question: q.body } : null;
  }, [conversation]);
  const active = (conversation?.tasks ?? []).filter((t) => t.status === "queued" || t.status === "running");
  const stuck = (conversation?.tasks ?? []).filter((t) => (t.status === "blocked" && !t.awaitingUser) || t.status === "failed");

  const groups = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const list = (team ?? []).filter((m) => !q || `${m.name} ${m.title} ${m.department}`.toLowerCase().includes(q));
    const by = new Map<string, Member[]>();
    for (const m of list) by.set(m.departmentKey, [...(by.get(m.departmentKey) ?? []), m]);
    return [...by.entries()].sort((a, b) => DEPT_ORDER.indexOf(a[0]) - DEPT_ORDER.indexOf(b[0]));
  }, [team, filter]);

  const send = () => {
    const text = draft.trim();
    if (!text || !selectedId || pending) return;
    setSendError(null);
    const to = selectedId;
    startTransition(async () => {
      const r = await sendToEmployeeAction(to, text);
      if (r?.error) setSendError({ for: to, msg: r.error });
      else {
        setDrafts((d) => ({ ...d, [to]: "" }));
        await load();
      }
    });
  };
  const retry = (taskId: string) =>
    startTransition(async () => {
      await requeueTaskAction(taskId);
      await load();
    });
  const select = (id: string | null) => router.replace(id ? `/team?e=${id}` : "/team", { scroll: false });

  const working = team?.filter((m) => BUSY.has(m.status)).length ?? 0;
  const waiting = team?.filter((m) => m.awaitingYou).length ?? 0;

  // ───────── roster ─────────
  const roster = (
    <aside className={`flex min-h-0 flex-col border-border bg-surface md:w-80 md:border-r ${selectedId ? "hidden md:flex" : "flex"}`}>
      <div className="border-b border-border p-3">
        <div className="flex items-baseline justify-between">
          <h1 className="text-base font-semibold">Team chat</h1>
          <span className="text-xs text-muted">{working} working · {waiting} waiting for you</span>
        </div>
        <label className="sr-only" htmlFor="team-filter">Find someone</label>
        <input id="team-filter" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Find someone…" className="field mt-2" />
      </div>
      <nav aria-label="Team" className="min-h-0 flex-1 overflow-y-auto p-2">
        {!team && <p className="p-3 text-sm text-muted">Loading the team…</p>}
        {groups.map(([key, members]) => (
          <div key={key} className="mb-2">
            <div className="px-2 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wider text-muted">{members[0].department}</div>
            {members.map((m) => {
              const p = presence(m);
              const preview = m.lastMessage ? `${m.lastMessage.fromYou ? "You: " : ""}${m.lastMessage.body}` : m.statusDetail ?? m.title;
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => select(m.id)}
                  aria-current={m.id === selectedId ? "true" : undefined}
                  className={`flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left transition-colors ${m.id === selectedId ? "bg-accent/10" : "hover:bg-surface-2"}`}
                >
                  <Face m={m} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-semibold">{m.name}</span>
                      {m.lastMessage && <span className="shrink-0 text-[11px] text-muted">{ago(m.lastMessage.at)}</span>}
                    </span>
                    <span className="flex items-center justify-between gap-2">
                      <span dir="auto" className="truncate text-xs text-muted">{preview}</span>
                      {m.awaitingYou ? (
                        <span className="shrink-0 rounded-full bg-amber-500 px-1.5 text-[10px] font-bold text-white" title={p.label}>?</span>
                      ) : m.unread > 0 ? (
                        <span className="shrink-0 rounded-full bg-accent px-1.5 text-[10px] font-bold text-accent-fg">{m.unread}</span>
                      ) : BUSY.has(m.status) ? (
                        <span className="shrink-0 text-sky-500"><Typing name={m.name} /></span>
                      ) : null}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        ))}
      </nav>
    </aside>
  );

  // ───────── empty state (nobody selected) ─────────
  const welcome = (
    <section className="hidden flex-1 flex-col items-center justify-center gap-6 p-8 text-center md:flex">
      <div className="flex -space-x-3">
        {(team ?? []).slice(0, 7).map((m) => <span key={m.id} className="rounded-2xl ring-4 ring-surface"><Face m={m} size={48} showDot={false} /></span>)}
      </div>
      <div className="max-w-md">
        <h2 className="text-xl font-semibold">Your team is ready, {userName.split(" ")[0]}.</h2>
        <p className="mt-2 text-sm text-muted">Pick someone and give them a task. They will ask if they need anything, and send you a report when they are done.</p>
      </div>
      {waiting > 0 && (
        <button type="button" className="btn" onClick={() => select(team!.find((m) => m.awaitingYou)!.id)}>
          {waiting} {waiting === 1 ? "person is" : "people are"} waiting for your answer
        </button>
      )}
    </section>
  );

  // ───────── conversation ─────────
  let lastDay = "";
  const thread = member && (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex items-center gap-3 border-b border-border bg-surface px-4 py-3">
        <div className="md:hidden">
          <button type="button" onClick={() => select(null)} className="btn-secondary px-2" aria-label="Back to the team">←</button>
        </div>
        <Face m={member} size={44} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-base font-semibold">{member.name}</h2>
            <span className="text-xs text-muted">· {presence(member).label}</span>
          </div>
          <div className="truncate text-xs text-muted">{member.title} · {member.department}</div>
        </div>
        <div className="hidden sm:block">
          <Link href={`/employees/${member.id}`} className="btn-secondary text-xs">Profile</Link>
        </div>
      </header>

      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto bg-surface-2 px-4 py-4" aria-live="polite">
        {!conversation && <p className="text-center text-sm text-muted">Loading…</p>}
        {conversation && conversation.messages.length === 0 && (
          <div className="mx-auto mt-8 max-w-md text-center">
            <Face m={member} size={64} showDot={false} />
            <h3 className="mt-3 text-lg font-semibold">Brief {member.name}</h3>
            <p className="mt-1 text-sm text-muted">{member.title}. Give a clear task; {member.name} will ask if anything is missing and report back here.</p>
            {canWrite && (
              <div className="mt-4 flex flex-wrap justify-center gap-2">
                {member.responsibilities.slice(0, 4).map((r) => (
                  <button key={r} type="button" onClick={() => { setDraft(r); input.current?.focus(); }} className="rounded-full border border-border bg-surface px-3 py-1 text-xs hover:border-accent hover:text-accent">
                    {r}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        <ol className="mx-auto max-w-3xl space-y-3">
          {conversation?.messages.map((m) => {
            const day = dayLabel(m.at);
            const sep = day !== lastDay ? ((lastDay = day), <li key={`d-${m.id}`} className="py-1 text-center text-[11px] font-medium text-muted">{day}</li>) : null;
            const t = m.taskId ? taskById.get(m.taskId) : undefined;
            const mine = m.from === "user";
            return [
              sep,
              <li key={m.id} className={`flex gap-2 ${mine ? "justify-end" : "justify-start"}`}>
                {!mine && <Face m={member} size={30} showDot={false} />}
                <div className={`max-w-[85%] sm:max-w-[75%] ${mine ? "items-end" : "items-start"} flex flex-col`}>
                  {m.kind === "information_request" ? (
                    <div className="rounded-2xl rounded-tl-sm border border-amber-500/40 bg-amber-500/10 px-3 py-2">
                      <div className="text-[11px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300">❓ Needs your input</div>
                      <p dir="auto" className="mt-0.5 whitespace-pre-wrap text-sm">{m.body}</p>
                    </div>
                  ) : m.kind === "report" ? (
                    <div className="w-full min-w-64">
                      <ReportCard r={m.reportId ? reportById.get(m.reportId) : undefined} author={member} />
                    </div>
                  ) : (
                    <div className={`rounded-2xl px-3 py-2 text-sm shadow-sm ${mine ? "rounded-tr-sm bg-accent text-accent-fg" : "rounded-tl-sm bg-surface"}`}>
                      {m.kind === "task_assignment" && <div className={`mb-0.5 text-[11px] font-semibold uppercase tracking-wide ${mine ? "opacity-80" : "text-muted"}`}>📋 New task</div>}
                      <p dir="auto" className="whitespace-pre-wrap">{m.body}</p>
                    </div>
                  )}
                  <div className="mt-1 flex items-center gap-2 text-[11px] text-muted">
                    <span>{clock(m.at)}</span>
                    {m.kind === "task_assignment" && <TaskPill t={t} />}
                  </div>
                </div>
              </li>,
            ];
          })}
          {active.map((t) => (
            <li key={`w-${t.id}`} className="flex items-center gap-2 text-xs text-muted">
              <Face m={member} size={30} showDot={false} />
              <div className="rounded-2xl rounded-tl-sm bg-surface px-3 py-2 shadow-sm">
                <div className="flex items-center gap-2 text-sky-600 dark:text-sky-300">
                  <Typing name={member.name} />
                  <span dir="auto">{t.status === "queued" ? `${member.name} will start “${t.title}” shortly` : `${member.name} is working on “${t.title}”`}</span>
                </div>
                {t.status === "running" && (
                  <div className="mt-1.5 h-1 w-48 overflow-hidden rounded-full bg-border">
                    <div className="h-full rounded-full bg-sky-500 transition-all" style={{ width: `${Math.max(5, t.progress)}%` }} />
                  </div>
                )}
              </div>
            </li>
          ))}
          {stuck.map((t) => (
            <li key={`s-${t.id}`} className="mx-auto max-w-xl rounded-xl border border-red-500/30 bg-red-500/5 px-3 py-2 text-sm">
              <div className="font-semibold text-red-700 dark:text-red-300">{member.name} couldn’t finish “{t.title}”</div>
              <p className="mt-0.5 text-xs text-muted">{t.blockedReason ?? t.error}</p>
              {canWrite && <button type="button" onClick={() => retry(t.id)} disabled={pending} className="btn-secondary mt-2 text-xs">Try again</button>}
            </li>
          ))}
        </ol>
      </div>

      {canWrite ? (
        <form
          className="border-t border-border bg-surface p-3"
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
        >
          {openQuestion && (
            <div className="mb-2 flex items-start gap-2 rounded-lg bg-amber-500/10 px-3 py-2 text-xs">
              <span aria-hidden>↩</span>
              <span dir="auto"><span className="font-semibold">Answering {member.name}:</span> {openQuestion.question}</span>
            </div>
          )}
          <div className="flex items-end gap-2">
            <label htmlFor="team-draft" className="sr-only">{openQuestion ? `Answer ${member.name}` : `Give ${member.name} a task`}</label>
            <textarea
              id="team-draft"
              ref={input}
              dir="auto"
              rows={1}
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                e.target.style.height = "auto";
                e.target.style.height = `${Math.min(e.target.scrollHeight, 160)}px`;
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  send();
                }
              }}
              placeholder={openQuestion ? `Answer ${member.name}…` : `Give ${member.name} a task…`}
              className="field max-h-40 min-h-10 min-w-0 flex-1 resize-none py-2"
            />
            <button type="submit" className="btn h-10 shrink-0 px-4" disabled={pending || !draft.trim()}>
              {pending ? "Sending…" : openQuestion ? "Answer" : "Assign"}
            </button>
          </div>
          {sendError?.for === selectedId && <p role="alert" className="mt-1 text-xs text-danger">{sendError.msg}</p>}
          <p className="mt-1 text-[11px] text-muted">Enter to send · Shift+Enter for a new line</p>
        </form>
      ) : (
        <p className="border-t border-border bg-surface p-3 text-xs text-muted">Your role can read conversations but not assign tasks.</p>
      )}
    </section>
  );

  return (
    <div className="-mx-4 -my-6 flex h-[calc(100dvh-7.5rem)] flex-col lg:-mx-8 lg:h-dvh">
      {loadError && <p className="bg-red-500/10 px-4 py-1 text-xs text-danger">{loadError}</p>}
      <div className="flex min-h-0 flex-1">
        {roster}
        {member ? thread : selectedId && team ? <p className="flex-1 p-8 text-sm text-muted">That person isn’t on the team.</p> : welcome}
      </div>
    </div>
  );
}
