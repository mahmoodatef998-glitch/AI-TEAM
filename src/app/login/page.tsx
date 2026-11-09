import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { LoginForm } from "./login-form";

export default async function LoginPage() {
  if (await getCurrentUser()) redirect("/");
  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm rounded-lg border border-border bg-surface p-6">
        <div className="mb-5">
          <div className="text-xs font-semibold uppercase tracking-wider text-accent">4U Power Generation</div>
          <h1 className="mt-1 text-lg font-semibold">AI Workforce</h1>
          <p className="mt-1 text-sm text-muted">Sign in to manage the AI sales & marketing organization.</p>
        </div>
        <LoginForm />
      </div>
    </main>
  );
}
