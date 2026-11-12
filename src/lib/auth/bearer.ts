import { timingSafeEqual } from "node:crypto";

/** True when the request carries `Authorization: Bearer <secret>`. Constant-time comparison. */
export function hasBearerSecret(req: Request, secret: string): boolean {
  const given = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const a = Buffer.from(given);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}
