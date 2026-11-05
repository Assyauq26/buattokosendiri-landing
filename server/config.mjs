import { readFileSync } from "node:fs";
import { isIP } from "node:net";
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
  const installerTestEmails = (env.INSTALLER_TEST_EMAILS || "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
  if (installerTestEmails.some((email) => !/^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(email)))
    throw Error("Invalid installer test account allowlist");
  const sellerPilotOnly = env.SELLER_PILOT_ONLY === "1";
  if (sellerPilotOnly && !installerTestEmails.length)
    throw Error("Pilot requires a test account allowlist");
  const trustedProxyIp = env.TRUST_PROXY === "1" ? env.TRUST_PROXY_IP : undefined;
  if (env.TRUST_PROXY === "1" && !isIP(trustedProxyIp || ""))
    throw Error("TRUST_PROXY_IP must identify the reverse proxy");
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
    installerTestEmails,
    sellerPilotOnly,
    port: Number(env.PORT || 8080),
    host: env.BIND_HOST || "127.0.0.1",
    trustedProxyIp,
  };
}
