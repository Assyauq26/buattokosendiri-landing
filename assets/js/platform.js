(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  let challenge = "",
    authenticated = false,
    current = null,
    busy = false,
    editing = false;
  let onePaste = false;
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
  $("service-request-form").addEventListener("submit", event => {
    event.preventDefault();
    action(async () => {
      await api("/ops/request", { action: $("request-type").value, reason: $("request-reason").value });
      $("request-reason").value = "";
      message("Permintaan tercatat. Operator akan meninjaunya.");
      await refreshRequests();
    });
  });
  async function refreshRequests() {
    $("service-requests").hidden = !authenticated || !current?.store;
    if ($("service-requests").hidden) return;
    const result = await api("/ops/my-requests");
    const states = { requested: "Menunggu tinjauan", reviewed: "Ditinjau operator", rejected: "Ditolak" };
    $("request-history").replaceChildren(...result.requests.map(request => {
      const item = document.createElement("li");
      const option = [...$("request-type").options].find(option => option.value === request.action);
      item.textContent = (option?.textContent || request.action) + " · " + states[request.state];
      return item;
    }));
  }
  let mailIdentity = null;
  for (const actionName of ['identity', 'administrators', 'rotate', 'disable', 'enable']) bind('mail-' + actionName, async () => {
    if (!mailIdentity || !current?.store) return;
    if (['disable', 'rotate'].includes(actionName) && !window.confirm('Akses email lama langsung dicabut. Lanjutkan?')) return;
    await api('/store/mail', { action: actionName, generation: mailIdentity.generation,
      brand: $('mail-brand').value.trim(), domain: current.store.domain, adminEmail: $('signed-in').textContent,
      emails: $('mail-admins').value.split(',').map(v => v.trim()).filter(Boolean) });
    message('Perubahan diterima. Agent akan menyelaraskan konfigurasi email.');
    await refresh();
  });
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
  const dnsInput = () => ({ domain: $("domain").value.trim().toLowerCase(), vpsIpv4: $("vps-ipv4").value.trim() });
  function showDnsTarget() {
    const { domain, vpsIpv4 } = dnsInput();
    $("dns-host").textContent = domain || "domain toko";
    $("dns-target").textContent = vpsIpv4 || "IP publik VPS";
    $("dns-result").textContent = "";
  }
  for (const id of ["domain", "vps-ipv4"]) $(id).addEventListener("input", showDnsTarget);
  bind("check-dns", async () => {
    if (!$("domain").reportValidity() || !$("vps-ipv4").reportValidity()) return;
    const input = dnsInput();
    $("dns-result").textContent = "Sedang memeriksa DNS…";
    try {
      const result = await api("/store/dns", input);
      if (JSON.stringify(input) === JSON.stringify(dnsInput()))
        $("dns-result").textContent = result.message;
    } catch (error) {
      $("dns-result").textContent = "";
      throw error;
    }
  });
  $("store-form").addEventListener("submit", (e) => {
    e.preventDefault();
    action(async () => {
      await api("/store", {
        name: $("store-name").value.trim(),
        ...dnsInput(),
        adminEmail: $("admin-email").value.trim(),
        adminPassword: $("admin-password").value,
        adminPasswordConfirmation: $("admin-password-confirmation").value,
      });
      $("admin-password").value = "";
      $("admin-password-confirmation").value = "";
      $("command").value = "";
      $("pairing").hidden = true;
      editing = false;
      await refresh();
    });
  });
  bind("edit-store", async () => {
    editing = true;
    panel(2);
  });
  bind("pair", async () => {
    const r = await api("/pairing", { installer: onePaste ? "stdin" : "legacy" });
    $("command").value = r.command;
    $("legacy-pairing").hidden = onePaste;
    $("pair-token").value = r.token || "";
    $("pairing").hidden = false;
    message(
      r.instruction,
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
    $("service-requests").hidden = true;
    $("command").value = "";
    $("pair-token").value = "";
    $("request-history").replaceChildren();
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
      ["Versi", job.evidence.version || job.release.version],
    ]) {
      const dt = document.createElement("dt"),
        dd = document.createElement("dd");
      dt.textContent = label;
      dd.textContent = value;
      $("result").append(dt, dd);
    }
    $("open-store").href = "https://" + store.domain;
    $("open-dashboard").href = "https://" + store.domain + "/admin";
    const reattached = job.evidence.installation === "reattached";
    $("reattached-password").hidden = !reattached;
    $("legacy-password").hidden = reattached || Boolean(store.vps_ipv4);
    $("chosen-password").hidden = reattached || !store.vps_ipv4;
  }
  async function refresh() {
    if (!authenticated) return;
    const r = await api("/store");
    current = r;
    await refreshRequests();
    if (!r.store || (!r.agent && !r.store.vps_ipv4)) {
      panel(2);
      return;
    }
    if (!r.agent) {
      if (!editing) panel(3);
      return;
    }
    $("command").value = "";
    $("pairing").hidden = true;
    message("");
    const j = r.job;
    if (!j) return;
    panel(j.state === "complete" ? 5 : 4);
    if (j.state === "complete") {
      results(r.store, j);
      const result = await api('/store/mail');
      mailIdentity = result.mail;
      $('mail-management').hidden = !mailIdentity;
      if (mailIdentity) {
        if (document.activeElement !== $('mail-brand')) $('mail-brand').value = mailIdentity.brand;
        if (document.activeElement !== $('mail-admins')) $('mail-admins').value = mailIdentity.seller_emails.join(', ');
        $('mail-state').textContent = !mailIdentity.enabled ? 'Email dinonaktifkan.' :
          mailIdentity.verified_at ? 'Konfigurasi email terverifikasi. Status pengiriman tersedia di dashboard toko.' :
            'Menunggu verifikasi identitas dan koneksi agent. Pastikan nama brand sama dengan yang dipublikasikan di toko.';
        $('mail-enable').hidden = mailIdentity.enabled;
        $('mail-disable').hidden = !mailIdentity.enabled;
      }
      return;
    }
    const online = Date.now() - Date.parse(r.agent.last_seen) < 90000;
    $("install-progress").value = j.progress;
    $("install-percent").textContent = j.progress + "%";
    const queuedTooLong = Date.now() - Date.parse(j.updated_at) >= 90000;
    const queuedStatus = !online
      ? "Agent VPS tidak merespons. Periksa layanan btos-agent di VPS."
      : queuedTooLong
        ? "Agent terhubung, tetapi tugas belum mulai. Periksa journal btos-agent atau jalankan bootstrap terbaru di VPS."
        : "VPS terhubung. Menunggu instalasi dimulai…";
    const status = r.agent.revoked_at ? "Akses instalasi sudah dicabut." : {
      queued: queuedStatus,
      running: online ? "Sedang menyiapkan toko Anda…" : "Koneksi VPS terputus. Periksa VPS Anda.",
      waiting_dns: "DNS atau HTTPS belum siap. Periksa record A dan pastikan port 80 dan 443 terbuka, lalu coba lagi.",
      failed: j.evidence.error_code === "WRONG_VPS_IP"
        ? "IP publik VPS berubah. Periksa alamat VPS sebelum mencoba lagi."
        : j.evidence.error_code === "EXISTING_STORE_DOMAIN_MISMATCH"
          ? "VPS masih menjalankan domain lain. Gunakan domain toko yang sudah terpasang untuk menyambungkan kembali."
          : "Instalasi terhenti. Periksa VPS Anda, lalu coba lagi.",
    }[j.state];
    if ($("job-state").textContent !== status) $("job-state").textContent = status;
    $("retry").hidden =
      !["waiting_dns", "failed"].includes(j.state) || !!r.agent.revoked_at;
    $("revoke").hidden = !!r.agent.revoked_at;
  }
  async function restore() {
    try {
      const { seller, onePaste: enabled } = await api("/session");
      authenticated = true;
      $("signed-in").textContent = seller.email;
      $("logout").hidden = false;
      onePaste = Boolean(enabled);
      $("pair-instruction").textContent = onePaste
        ? "Siapkan instalasi, lalu tempel seluruh perintah sekali di terminal VPS."
        : "Siapkan instalasi, jalankan perintah di VPS, lalu tempel token saat diminta.";
      $("admin-email").value = seller.email;
      const r = await api("/store");
      if (r.store) {
        $("store-name").value = r.store.name;
        $("domain").value = r.store.domain;
        $("vps-ipv4").value = r.store.vps_ipv4 || "";
        $("admin-email").value = r.store.admin_email;
      }
      showDnsTarget();
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
