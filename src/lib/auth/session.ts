import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getDb } from "@/lib/db";
import { sessions, users } from "@/lib/db/schema";

const COOKIE = "4u_session";
const TTL_MS = 7 * 24 * 3600_000;
export type SessionUser = Pick<typeof users.$inferSelect, "id" | "email" | "name" | "role">;
export type Role = SessionUser["role"];

const hash = (t: string) => createHash("sha256").update(t).digest("hex");

export async function createSession(userId: string) {
  const token = randomBytes(32).toString("base64url");
  await getDb().insert(sessions).values({ id: hash(token), userId, expiresAt: new Date(Date.now() + TTL_MS) });
  (await cookies()).set(COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: TTL_MS / 1000,
  });
}

export async function destroySession() {
  const store = await cookies();
  const token = store.get(COOKIE)?.value;
  if (token) await getDb().delete(sessions).where(eq(sessions.id, hash(token)));
  store.delete(COOKIE);
}

export async function getCurrentUser(): Promise<SessionUser | null> {
  const token = (await cookies()).get(COOKIE)?.value;
  if (!token) return null;
  const [row] = await getDb()
    .select({ id: users.id, email: users.email, name: users.name, role: users.role, active: users.active })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, hash(token)), gt(sessions.expiresAt, new Date())));
  if (!row || !row.active) return null;
  return { id: row.id, email: row.email, name: row.name, role: row.role };
}

/** Page guard: redirect to /login if not signed in; optionally require one of `roles`. */
export async function requireUser(roles?: Role[]): Promise<SessionUser> {
  const u = await getCurrentUser();
  if (!u) redirect("/login");
  if (roles && !roles.includes(u.role)) redirect("/?denied=1");
  return u;
}

/** Server action guard: throws instead of redirecting. */
export async function requireRole(roles?: Role[]): Promise<SessionUser> {
  const u = await getCurrentUser();
  if (!u) throw new Error("Not signed in");
  if (roles && !roles.includes(u.role)) throw new Error(`Your role (${u.role}) is not permitted to do this.`);
  return u;
}

export const WRITE_ROLES: Role[] = ["admin", "sales_manager", "sales_user", "marketing_manager"];
export const SALES_MANAGE: Role[] = ["admin", "sales_manager"];
