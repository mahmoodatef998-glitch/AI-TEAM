"use client";

import { startTransition, useActionState, type FormEvent } from "react";
import { loginAction } from "@/app/actions";

export function LoginForm() {
  const [state, action, pending] = useActionState(loginAction, null);
  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    startTransition(() => action(data)); // keeps the typed email if sign-in fails
  };
  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <label className="block">
        <span className="label">Email</span>
        <input name="email" type="email" autoComplete="username" required className="field" />
      </label>
      <label className="block">
        <span className="label">Password</span>
        <input name="password" type="password" autoComplete="current-password" required className="field" />
      </label>
      {state?.error && <p role="alert" className="text-sm text-danger">{state.error}</p>}
      <button type="submit" className="btn w-full" disabled={pending}>{pending ? "Signing in…" : "Sign in"}</button>
    </form>
  );
}
