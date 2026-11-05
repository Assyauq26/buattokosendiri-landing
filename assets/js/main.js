(() => {
  "use strict";

  document.documentElement.classList.add("js");
  // Footer year
  const year = document.getElementById("year");
  if (year) year.textContent = String(new Date().getFullYear());

  // Mobile navigation
  const toggle = document.querySelector(".nav-toggle");
  const nav = document.getElementById("nav");
  const actions = document.querySelector(".header-actions");
  if (toggle && nav) {
    toggle.addEventListener("click", () => {
      const open = nav.classList.toggle("open");
      if (actions) actions.classList.toggle("open", open);
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
      toggle.setAttribute("aria-label", open ? "Tutup menu navigasi" : "Buka menu navigasi");
    });
    nav.addEventListener("click", (event) => {
      const link = event.target.closest("a");
      if (!link) return;
      nav.classList.remove("open");
      if (actions) actions.classList.remove("open");
      toggle.setAttribute("aria-expanded", "false");
    });
  }

  if (toggle && nav) {
    const close = () => { nav.classList.remove("open"); toggle.setAttribute("aria-expanded", "false"); toggle.setAttribute("aria-label", "Buka menu navigasi"); };
    document.addEventListener("keydown", e => { if (e.key === "Escape" && nav.classList.contains("open")) { close(); toggle.focus(); } });
    nav.addEventListener("click", e => { if (e.target.closest("a")) close(); });
    matchMedia("(min-width:901px)").addEventListener("change", close);
  }
  const header = document.querySelector(".site-header");
  addEventListener("scroll", () => header?.classList.toggle("scrolled", scrollY > 12), { passive:true });
  if ("IntersectionObserver" in window && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
    const reveal = new IntersectionObserver(entries => entries.forEach(entry => {
      if (entry.isIntersecting) { entry.target.classList.add("revealed"); reveal.unobserve(entry.target); }
    }), { threshold:.15 });
    document.querySelectorAll(".card,.step,.faq,.cta-banner").forEach(el => reveal.observe(el));
  }
  // Active nav highlighting on scroll (progressive enhancement only)
  const links = Array.from(document.querySelectorAll(".nav-link[href^='#']"));
  const sections = links
    .map((a) => document.querySelector(a.getAttribute("href")))
    .filter(Boolean);
  if ("IntersectionObserver" in window && sections.length > 0) {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const id = `#${entry.target.id}`;
          for (const a of links) {
            const active = a.getAttribute("href") === id;
            a.classList.toggle("is-active", active);
            if (active) a.setAttribute("aria-current", "page");
            else a.removeAttribute("aria-current");
          }
        }
      },
      { rootMargin: "-40% 0px -55% 0px" }
    );
    for (const s of sections) observer.observe(s);
  }
})();
