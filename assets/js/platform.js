(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  let challenge = "",
    authenticated = false,
    current = null,
    busy = false,
    editing = false;
  const stages = {
    preflight: "Preflight VPS",
    runtime: "Persiapan runtime",
    dns: "Pemeriksaan DNS",
    https: "Verifikasi HTTPS",
    database: "Database & migrasi",
    application: "Deployment aplikasi",
    admin: "Pembuatan administrator",
    health: "Health check",
    complete: "Penyelesaian",
  };
  function message(text, error = false) {
    const el = $(error ? "error" : "notice");
    el.textContent = text;
    el.hidden = !text;
  }
  function panel(n) {
    document
      .querySelectorAll("[data-panel]")
      .forEach((el) => (el.hidden = Number(el.dataset.panel) !== n));
    document.querySelectorAll("[data-step]").forEach((el) => {
      if (Number(el.dataset.step) === n)
        el.setAttribute("aria-current", "step");
      else el.removeAttribute("aria-current");
    });
  }
  async function api(path, data) {
    const response = await fetch("/api/platform" + path, {
      method: data ? "POST" : "GET",
      credentials: "same-origin",
      headers: data ? { "Content-Type": "application/json" } : {},
      body: data ? JSON.stringify(data) : undefined,
      cache: "no-store",
      signal: AbortSignal.timeout(20000),
    });
    const result = await response.json();
    if (!response.ok) {
      const e = new Error(result.error || "Layanan belum tersedia.");
      e.status = response.status;
      throw e;
    }
    return result;
  }
  async function action(fn) {
    if (busy) return;
    busy = true;
    message("", true);
    const buttons = [...document.querySelectorAll("button:not([disabled])")];
    buttons.forEach((x) => (x.disabled = true));
    try {
      await fn();
    } catch (e) {
      message(e.message, true);
    } finally {
      buttons.forEach((x) => (x.disabled = false));
      busy = false;
    }
  }
  function bind(id, fn) {
    $(id).addEventListener("click", () => action(fn));
  }
  async function requestCode() {
    if (!$("email-form").reportValidity()) return;
    const r = await api("/otp/request", {
      email: $("email").value.trim(),
      consent: "2026-11-05.M1",
    });
    challenge = r.challenge;
    $("otp-form").hidden = false;
    message(r.message);
    $("otp").focus();
  }
  $("email-form").addEventListener("submit", (e) => {
    e.preventDefault();
    action(requestCode);
  });
  bind("resend", requestCode);
  $("otp-form").addEventListener("submit", (e) => {
    e.preventDefault();
    action(async () => {
      await api("/otp/verify", { challenge, code: $("otp").value });
      $("otp").value = "";
      message("");
      await restore();
    });
  });
  $("store-form").addEventListener("submit", (e) => {
    e.preventDefault();
    action(async () => {
      await api("/store", {
        name: $("store-name").value.trim(),
        domain: $("domain").value.trim().toLowerCase(),
        adminEmail: $("admin-email").value.trim(),
      });
      editing = false;
      await refresh();
    });
  });
  bind("edit-store", async () => {
    editing = true;
    panel(2);
  });
  bind("pair", async () => {
    const r = await api("/pairing", {});
    $("command").value = r.command;
    $("pair-token").value = r.token;
    $("pairing").hidden = false;
    message(
      "Token aktif selama 15 menit. Jalankan perintah di VPS kosong Anda.",
    );
  });
  for (const [id, input] of [
    ["copy-command", "command"],
    ["copy-token", "pair-token"],
  ])
    bind(id, async () => {
      try {
        await navigator.clipboard.writeText($(input).value);
        message("Berhasil disalin.");
      } catch {
        $(input).focus();
        $(input).select();
        message("Pilih teks lalu salin menggunakan Ctrl+C.");
      }
    });
  bind("retry", async () => {
    await api("/retry", {});
    await refresh();
  });
  bind("revoke", async () => {
    if (
      !window.confirm(
        "Cabut komunikasi agent toko ini? Pemulihan pairing memerlukan operator.",
      )
    )
      return;
    await api("/revoke", {});
    await refresh();
  });
  bind("logout", async () => {
    await api("/logout", {});
    authenticated = false;
    current = null;
    location.reload();
  });
  function results(store, job) {
    $("result").replaceChildren();
    for (const [label, value] of [
      ["Nama toko", store.name],
      ["Domain", store.domain],
      [
        "HTTPS",
        job.evidence.https === "PUBLIC_CERTIFICATE_VALID"
          ? "Terverifikasi"
          : "Belum terverifikasi",
      ],
      [
        "Aplikasi",
        job.evidence.application === "healthy"
          ? "Sehat"
          : "Belum terverifikasi",
      ],
      ["Versi", job.release.version],
    ]) {
      const dt = document.createElement("dt"),
        dd = document.createElement("dd");
      dt.textContent = label;
      dd.textContent = value;
      $("result").append(dt, dd);
    }
    $("open-store").href = "https://" + store.domain;
    $("open-dashboard").href = "https://" + store.domain + "/admin";
  }
  async function refresh() {
    if (!authenticated) return;
    const r = await api("/store");
    current = r;
    if (!r.store) {
      panel(2);
      return;
    }
    if (!r.agent) {
      if (!editing) panel(3);
      return;
    }
    $("pair-token").value = "";
    $("pairing").hidden = true;
    message("");
    const j = r.job;
    if (!j) return;
    panel(j.state === "complete" ? 5 : 4);
    if (j.state === "complete") {
      results(r.store, j);
      return;
    }
    $("install-name").textContent = r.store.name;
    $("install-domain").textContent = r.store.domain;
    const online = Date.now() - Date.parse(r.agent.last_seen) < 90000;
    $("agent-status").textContent = r.agent.revoked_at
      ? "Akses dicabut"
      : online
        ? "Terhubung"
        : "Belum ada heartbeat terbaru — periksa koneksi VPS";
    $("last-update").textContent = new Date(j.updated_at).toLocaleString(
      "id-ID",
    );
    $("job-state").textContent =
      {
        queued: "Menunggu agent mengambil pekerjaan.",
        running: "Sedang menjalankan: " + stages[j.stage],
        waiting_dns:
          "Menunggu DNS atau HTTPS. Periksa pengaturan, lalu klik Periksa lagi.",
        failed:
          "Operasi terhenti. Periksa VPS dan log installer, lalu lanjutkan.",
      }[j.state] || j.state;
    $("vps-ip").textContent = j.evidence.ipv4 || "yang diberikan penyedia VPS";
    $("retry").hidden =
      !["waiting_dns", "failed"].includes(j.state) || !!r.agent.revoked_at;
    $("revoke").hidden = !!r.agent.revoked_at;
    $("stages").replaceChildren();
    for (const [key, label] of Object.entries(stages)) {
      const li = document.createElement("li");
      li.dataset.active = String(key === j.stage);
      li.textContent = label;
      const hint = document.createElement("small");
      hint.textContent =
        key === j.stage ? "Status terakhir dari agent" : "Tahap instalasi";
      li.append(hint);
      $("stages").append(li);
    }
  }
  async function restore() {
    try {
      const { seller } = await api("/session");
      authenticated = true;
      $("signed-in").textContent = seller.email;
      $("logout").hidden = false;
      $("admin-email").value = seller.email;
      const r = await api("/store");
      if (r.store) {
        $("store-name").value = r.store.name;
        $("domain").value = r.store.domain;
        $("admin-email").value = r.store.admin_email;
      }
      await refresh();
    } catch (e) {
      if (e.status === 401) {
        authenticated = false;
        panel(1);
      } else message(e.message, true);
    }
  }
  restore();
  setInterval(() => {
    if (authenticated && !busy)
      refresh().catch((e) =>
        message(
          e.status === 401
            ? "Session berakhir. Muat ulang dan masuk kembali."
            : e.message,
          true,
        ),
      );
  }, 5000);
})();
