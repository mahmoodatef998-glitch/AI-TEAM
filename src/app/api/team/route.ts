import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { getConversation, markConversationRead, teamOverview } from "@/lib/domain/assignments";

/**
 * Team chat snapshot for the signed-in person: the roster (status, unread, waiting-for-you)
 * and, when `?employee=` is given, the conversation with that employee (which is then marked read).
 */
export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const db = getDb();
  const employeeId = new URL(req.url).searchParams.get("employee");
  if (employeeId && !/^[0-9a-f-]{36}$/i.test(employeeId)) return NextResponse.json({ error: "bad employee id" }, { status: 400 });
  if (employeeId) await markConversationRead(db, user.id, employeeId);
  const [team, conversation] = await Promise.all([
    teamOverview(db, user.id),
    employeeId ? getConversation(db, user.id, employeeId) : Promise.resolve(null),
  ]);
  return NextResponse.json({ team, conversation }, { headers: { "cache-control": "no-store" } });
}
