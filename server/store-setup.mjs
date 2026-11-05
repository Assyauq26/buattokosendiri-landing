import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { Resolver } from "node:dns/promises";
import { BlockList, isIPv4 } from "node:net";

const reserved = new BlockList();
for (const [address, bits] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 3],
]) reserved.addSubnet(address, bits);
reserved.addAddress("43.173.41.24");

export function isStoreIpv4(address) {
  return typeof address === "string" && isIPv4(address) && !reserved.check(address);
}

export function validAdminPassword(password, confirmation) {
  return typeof password === "string" && password === confirmation &&
    [...password].length >= 12 && Buffer.byteLength(password) <= 72 && !password.includes("\0") &&
    [/[a-z]/, /[A-Z]/, /\d/, /[^a-zA-Z0-9]/].filter((group) => group.test(password)).length >= 3;
}

export async function checkStoreDns(domain, address) {
  async function lookup(server) {
    const resolver = new Resolver({ timeout: 2200, tries: 2 });
    resolver.setServers([server]);
    const records = await Promise.allSettled([resolver.resolve4(domain), resolver.resolve6(domain)]);
    return records.map((record) => {
      if (record.status === "fulfilled") return record.value;
      if (["ENODATA", "ENOTFOUND"].includes(record.reason.code)) return [];
      throw record.reason;
    });
  }
  try {
    const records = await Promise.all([lookup("1.1.1.1"), lookup("8.8.8.8")]);
    if (records.some(([, aaaa]) => aaaa.length)) return "ipv6";
    if (records.every(([a]) => a.length && a.every((value) => value === address))) return "ready";
    return "pending";
  } catch {
    return "unavailable";
  }
}

export function installerPasswordVault(secret) {
  const key = Buffer.from(hkdfSync("sha256", secret, "btos-platform", "admin-bootstrap-password-v1", 32));
  return {
    seal(storeId, password) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(Buffer.from(storeId));
      const encrypted = Buffer.concat([cipher.update(password, "utf8"), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64url");
    },
    open(storeId, sealed) {
      const data = Buffer.from(sealed, "base64url");
      const cipher = createDecipheriv("aes-256-gcm", key, data.subarray(0, 12));
      cipher.setAAD(Buffer.from(storeId));
      cipher.setAuthTag(data.subarray(12, 28));
      return Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString("utf8");
    },
  };
}
