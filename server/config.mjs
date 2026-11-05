import { readFileSync } from "node:fs";
export function config(env = process.env) {
  const origin = env.APP_ORIGIN || "https://buattokosendiri.web.id";
  const local = env.LOCAL_DEVELOPMENT === "1";
  const url = new URL(origin);
  if (
    url.origin !== origin ||
    (!local && origin !== "https://buattokosendiri.web.id") ||
    (local && !["localhost", "127.0.0.1"].includes(url.hostname))
  )
    throw Error("Invalid platform origin");
  if (!env.DATABASE_URL || (env.AUTH_SECRET || "").length < 32)
    throw Error("DATABASE_URL and AUTH_SECRET (32+ characters) required");
  const releases = env.RELEASE_MANIFEST
    ? JSON.parse(readFileSync(env.RELEASE_MANIFEST, "utf8"))
    : [];
  for (const r of releases) {
    if (
      !/^v\d+\.\d+\.\d+$/.test(r.version) ||
      !/^[a-f0-9]{40}$/.test(r.sha) ||
      r.repository !== "Assyauq26/buattokoonline" ||
      r.approved !== true
    )
      throw Error("Only explicitly approved pinned releases are accepted");
  }
  return {
    origin,
    local,
    secret: env.AUTH_SECRET,
    database: env.DATABASE_URL,
    resendKey: env.RESEND_API_KEY,
    resendFrom: env.RESEND_FROM,
    releases,
    port: Number(env.PORT || 8080),
    host: env.BIND_HOST || "127.0.0.1",
    trustProxy: env.TRUST_PROXY === "1",
  };
}
