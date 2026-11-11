const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
const id = params.get("id");
const time = value => value ? new Intl.DateTimeFormat("id-ID", {
  dateStyle: "medium", timeStyle: "short",
}).format(new Date(value)) : "Belum tercatat";
const labels = {
  queued: "Antrean", running: "Berjalan", waiting_dns: "Menunggu domain",
  failed: "Gagal", complete: "Selesai", super_admin: "Super Admin",
  operator: "Operator", support: "Support · hanya baca", requested: "Menunggu tinjauan",
  reviewed: "Ditinjau", rejected: "Ditolak", retry: "Coba ulang instalasi",
  reset: "Reset registrasi instalasi", "review-request": "Tandai sudah ditinjau",
  "reject-request": "Tolak permintaan", reinstall: "Instalasi ulang", domain: "Pindah domain",
  ownership: "Pindah pemilik", close_store: "Tutup toko", delete_account: "Hapus akun",
  uninstall: "Uninstall di VPS", purge: "Penghapusan data pusat",
  "pause-wa": "Hentikan WhatsApp tenant", "resume-wa": "Lanjutkan WhatsApp tenant",
  "release-ip": "Lepas IPv4 konfigurasi",
};
const label = value => labels[value] || value || "Belum tercatat";
let challenge, selected, actionId;

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function link(text, query) {
  const node = element("a", text);
  node.href = "/admin/?" + query;
  return node;
}
function facts(items) {
  const list = element("dl", undefined, "facts");
  for (const [name, value] of items) {
    const group = element("div");
    group.append(element("dt", name), element("dd", value ?? "Belum tercatat"));
    list.append(group);
  }
  return list;
}
function section(title, content, wide = false) {
  const panel = element("section", undefined, wide ? "panel wide" : "panel");
  panel.append(element("h2", title), content);
  return panel;
}
function history(items) {
  if (!items.length) return element("p", "Belum ada catatan.");
  const list = element("ul", undefined, "history");
  for (const value of items) list.append(element("li", value));
  return list;
}
async function api(path, body) {
  const response = await fetch("/api/platform" + path, {
    cache: "no-store",
    ...(body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
  const payload = await response.json();
  if (!response.ok) throw Object.assign(new Error(payload.error || "Permintaan gagal."), { status: response.status });
  return payload;
}
function agentStatus(row) {
  if (!row.installation_id) return "Belum terhubung";
  if (row.revoked_at) return "Dicabut";
  return Date.now() - Date.parse(row.last_seen) > 90000 ? "Heartbeat terlambat" : "Heartbeat terbaru";
}
function showList(data) {
  $("summary").replaceChildren(...facts([
    ["Tenant terdaftar", data.summary.total], ["Instalasi selesai", data.summary.complete],
    ["Instalasi gagal", data.summary.failed], ["Heartbeat terlambat", data.summary.late],
    ["Permintaan terbuka", data.summary.requests],
    ["Update bermasalah", data.summary.update_issues],
  ]).children);
  $("versions").replaceChildren(...facts(data.versions.map(row => [row.version || "Belum dilaporkan", row.total])).children);
  $("integrations").replaceChildren(element("h2", "WhatsApp pusat dan antrean"),
    data.whatsapp ? facts([
      ["Sesi pusat", data.whatsapp.session?.state || "Belum terdaftar"],
      ["Nomor terhubung", data.whatsapp.session?.phone_suffix ? "•••• " + data.whatsapp.session.phone_suffix : null],
      ["Notifikasi · 7 hari", data.whatsapp.queue.map(item => item.state + " " + item.total).join(" · ") || "Belum ada event"],
    ]) : element("p", "Sumber observasi WhatsApp belum terhubung."));
  for (const key of ["q", "state", "version", "heartbeat"]) $(key).value = params.get(key) || "";
  const rows = data.rows.map(row => {
    const item = element("article", undefined, "tenant-row");
    const identity = element("div");
    identity.append(element("strong", row.name), element("small", row.domain));
    item.append(identity, element("span", row.state ? label(row.state) : "Menunggu instalasi"),
      element("small", agentStatus(row)), link("Lihat detail", new URLSearchParams({ id: row.id })));
    return item;
  });
  $("tenants").replaceChildren(...(rows.length ? rows : [element("p", "Tenant tidak ditemukan.")]));
  const pages = Math.max(1, Math.ceil(data.total / data.pageSize));
  const pageLink = (text, page) => {
    const query = new URLSearchParams(params);
    query.set("page", page);
    return link(text, query);
  };
  $("pagination").replaceChildren(element("span", `Halaman ${data.page} dari ${pages} · ${data.total} tenant`));
  if (data.page > 1) $("pagination").append(pageLink("Sebelumnya", Math.min(data.page - 1, pages)));
  if (data.page < pages) $("pagination").append(pageLink("Berikutnya", data.page + 1));
  $("listing").hidden = false;
}
function showDetail(data) {
  selected = data.store;
  const row = data.store;
  $("back").hidden = false;
  $("title").textContent = row.name;
  $("description").textContent = row.domain;
  $("details").replaceChildren(
    section("Tenant dan pemilik", facts([
      ["Tenant ID", row.id], ["Akun pemilik", row.owner_email], ["ID pemilik", row.owner_id],
      ["Domain toko", row.domain], ["IPv4 konfigurasi", row.configured_ip],
      ["IPv4 dilaporkan saat pendaftaran", row.reported_ip],
    ])),
    section("Instalasi dan agent", facts([
      ["Instalasi aktif", row.installation_id], ["Generasi", row.installation_generation],
      ["Instalasi", row.state ? label(row.state) : "Menunggu instalasi"],
      ["Tahap terakhir", row.stage], ["Pembaruan job", time(row.job_updated)], ["Kode kendala", row.error_code],
      ["Heartbeat", agentStatus(row)], ["Diterima", time(row.last_seen)],
      ["Versi agent", row.observation?.agentVersion],
      ["Identitas updater", row.observation?.updaterInstallationId],
      ["Aplikasi lokal · laporan agent", row.observation?.application],
    ])),
    section("Aplikasi dan email", facts([
      ["Versi target", row.target_version], ["Versi dilaporkan agent", row.observation?.appVersion],
      ["Observasi diterima", time(row.observed_at)], ["Versi saat instalasi selesai", row.completed_version],
      ["Commit saat instalasi selesai", row.completed_sha],
      ["Updater lokal", row.observation?.updater === "available" ? "Terdeteksi" :
        row.observation?.updater === "unavailable" ? "Tidak terdeteksi" : null],
      ["Email & OTP", row.mail_enabled == null ? "Belum terdaftar" : row.mail_enabled ? "Diizinkan registry" : "Dinonaktifkan"],
      ["Nama pengirim", row.sender], ["Sinkronisasi terakhir", time(row.brand_synced_at)],
      ["Bukti relay terakhir", time(row.mail_verified)],
      ["Update terakhir · laporan agent", row.observation?.updateState],
      ["Waktu update", time(row.observation?.updateAt)],
      ["Backup tersedia · laporan agent", time(row.observation?.backupAt)],
      ["Bukti restore backup", "Belum dilaporkan"],
    ])),
    section("WhatsApp dan notifikasi", data.whatsapp ? facts([
      ["Sesi seller", data.whatsapp.session?.state || "Belum terdaftar"],
      ["Nomor terhubung", data.whatsapp.session?.phone_suffix ? "•••• " + data.whatsapp.session.phone_suffix : null],
      ["Pengiriman", data.whatsapp.session?.paused === false ? "Diizinkan tenant" : "Ditahan"],
      ["Antrean · 7 hari", data.whatsapp.queue.map(item => item.state + " " + item.total).join(" · ") || "Belum ada event"],
    ]) : element("p", "Sumber observasi WhatsApp belum terhubung.")),
    section("Riwayat instalasi", history(data.installations.map(item =>
      `Generasi ${item.generation} · ${item.id} · ${item.retired_at ? "Diganti" : label(item.state)}`))),
    section("Progres terakhir", history(data.events.map(event =>
      `${time(event.created_at)} · ${event.stage} · ${label(event.state)}${event.error_code ? " · " + event.error_code : ""}`))),
    section("Permintaan", history(data.requests.map(request =>
      `${label(request.action)} · ${label(request.state)} · ${request.reason}`))),
    section("Audit operator", history(data.audit.map(entry =>
      `${time(entry.created_at)} · ${entry.actor_id} · ${label(entry.role)} · ${label(entry.action)} · ${entry.reason}`)), true),
  );
  const choices = [];
  if (data.role !== "support") {
    if (row.configured_ip && (!row.installation_id || row.state === "complete"))
      choices.push(["release-ip", labels["release-ip"]]);
    if (data.whatsapp?.session) {
      const action = data.whatsapp.session.paused ? "resume-wa" : "pause-wa";
      choices.push([action, labels[action]]);
    }
    if (!row.revoked_at && ["failed", "waiting_dns"].includes(row.state)) choices.push(["retry", labels.retry]);
    if (data.role === "super_admin" && row.installation_id && row.state !== "running") choices.push(["reset", labels.reset]);
    for (const request of data.requests.filter(request => request.state === "requested")) {
      for (const action of ["review-request", "reject-request"])
        choices.push([action + ":" + request.id, `${labels[action]} · ${label(request.action)}`]);
    }
  }
  $("action").replaceChildren(...choices.map(([value, text]) => new Option(text, value)));
  $("actions").hidden = !choices.length;
  $("action").dispatchEvent(new Event("change"));
  $("detail").hidden = false;
}
async function load() {
  const data = await api(id ? "/ops/tenant?" + new URLSearchParams({ id }) : "/ops/tenants?" + params);
  $("role").textContent = label(data.role);
  $("role").hidden = false;
  $("signin").hidden = true;
  if (id) showDetail(data);
  else {
    showList(data);
    const catalog = await api("/ops/releases");
    $("release-list").replaceChildren(catalog.available ? history(catalog.releases.map(release =>
      `${release.version} · ${release.channel} · updater minimum ${release.minimumUpdater} · ${release.sha}`)) :
      element("p", "Katalog rilis terverifikasi belum tersedia."));
  }
  $("status").textContent = "";
}
function task(form, fn) {
  $(form).addEventListener("submit", async event => {
    event.preventDefault();
    const button = event.submitter;
    if (button?.disabled) return;
    if (button) button.disabled = true;
    $("status").textContent = "Memproses…";
    try { await fn(); }
    catch (error) { $("status").textContent = error.message; }
    finally { if (button) button.disabled = false; }
  });
}
task("email-form", async () => {
  const result = await api("/otp/request", { email: $("email").value, consent: "2026-11-05.M1" });
  challenge = result.challenge;
  $("email-form").hidden = true;
  $("code-form").hidden = false;
  $("code").focus();
  $("status").textContent = result.message;
});
task("code-form", async () => {
  await api("/otp/verify", { challenge, code: $("code").value });
  $("code").value = "";
  await load();
});
$("action").addEventListener("change", () => {
  const action = $("action").value;
  const confirm = ["reset", "release-ip"].includes(action);
  $("confirm-group").hidden = !confirm;
  $("confirm").required = confirm;
  $("impact").textContent = action === "reset"
    ? "Reset mencabut agent dan token relay lama, lalu membuka registrasi ulang untuk domain yang sama. Tenant, riwayat, DNS, dan data di VPS dipertahankan. Email relay baru aktif kembali setelah agent pengganti terhubung."
    : "Lepas IPv4 mengosongkan alamat VPS yang dikonfigurasi di registry pusat. Riwayat jaringan, domain, agent, DNS, dan isi VPS dipertahankan.";
  actionId = null;
});
task("action-form", async () => {
  const [action, targetRequestId] = $("action").value.split(":");
  actionId ||= crypto.randomUUID();
  try {
    await api("/ops/action", { action, targetRequestId, storeId: id, requestId: actionId,
      installationId: selected.installation_id, reason: $("reason").value, confirm: $("confirm").value });
  } catch (error) {
    if (error.status === 403 && error.message.includes("OTP")) {
      $("signin").hidden = false;
      $("email-form").hidden = false;
      $("code-form").hidden = true;
      $("email").focus();
    }
    throw error;
  }
  $("action-form").reset();
  await load();
  $("status").textContent = action === "reset" ? "Registrasi direset. Seller dapat menyiapkan instalasi ulang." : "Tindakan tercatat.";
});
load().catch(error => {
  $("status").textContent = error.status === 401 ? "Gunakan akun yang diberi akses operator." : error.message;
  $("signin").hidden = error.status !== 401;
});
