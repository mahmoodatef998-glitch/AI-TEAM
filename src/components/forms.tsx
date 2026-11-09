"use client";

import { createContext, startTransition, useActionState, useContext, type FormEvent, type ReactNode } from "react";
import type { ActionState } from "@/app/actions";

const PendingContext = createContext(false);

/**
 * Form bound to a server action. Submits via a transition instead of the `action` prop so the
 * user's input is NOT reset when the action returns a validation error.
 */
export function ActionForm({
  action,
  children,
  className = "space-y-3",
}: {
  action: (s: ActionState, f: FormData) => Promise<ActionState>;
  children: ReactNode;
  className?: string;
}) {
  const [state, formAction, pending] = useActionState(action, null);
  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const submitter = (e.nativeEvent as SubmitEvent).submitter as HTMLElement | null;
    const data = new FormData(e.currentTarget, submitter);
    startTransition(() => formAction(data));
  };
  return (
    <PendingContext.Provider value={pending}>
      <form onSubmit={onSubmit} className={className} aria-busy={pending}>
        {children}
        {state?.error && <p role="alert" className="text-sm text-danger">{state.error}</p>}
        {state?.ok && <p role="status" className="text-sm text-ok">{state.ok}</p>}
      </form>
    </PendingContext.Provider>
  );
}

export function Submit({ children, variant = "primary" }: { children: ReactNode; variant?: "primary" | "secondary" | "danger" }) {
  const pending = useContext(PendingContext);
  const cls = variant === "primary" ? "btn" : variant === "danger" ? "btn-danger" : "btn-secondary";
  return (
    <button type="submit" className={cls} disabled={pending}>
      {pending ? "Working…" : children}
    </button>
  );
}

export function Field({ label, name, children, hint }: { label: string; name?: string; children?: ReactNode; hint?: string }) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      {children ?? <input name={name} className="field" />}
      {hint && <span className="mt-0.5 block text-xs text-muted">{hint}</span>}
    </label>
  );
}
