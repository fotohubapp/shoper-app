/* FOTOhub AI dla Shoper — panel administracyjny (vanilla JS, bez zależności).
 *
 * Struktura DOM jest kontraktem index.html: jeden pojemnik #view-root, do
 * którego rysowane są wszystkie widoki, oraz nawigacja oparta o .nav-item
 * z atrybutem data-view. Ten plik NIE zakłada istnienia statycznych sekcji
 * per widok — każdy ekran powstaje w JS.
 *
 * Zasady, które trzymają panel przy życiu:
 *  1. Dostęp do DOM tylko przez $() / need() — brak elementu nigdy nie rzuca,
 *     bo jeden brakujący opcjonalny węzeł kiedyś wygasił cały panel.
 *  2. Każda wartość pochodząca ze sklepu lub z API (nazwy produktów, SKU,
 *     treści błędów) trafia do DOM przez textContent albo esc(). To realny
 *     wektor XSS, nie formalność.
 *  3. Żaden łańcuch widoczny dla użytkownika nie jest zapisany na sztywno —
 *     wszystko przechodzi przez t() i katalog z /api/i18n/:lang.
 */
(function () {
  "use strict";

  /* ------------------------------------------------------------------ */
  /* Stan                                                                 */
  /* ------------------------------------------------------------------ */

  var VIEWS = [
    "dashboard",
    "photos",
    "descriptions",
    "jobs",
    "drafts",
    "presets",
    "settings",
    "mcp",
  ];

  /** Widoki dostępne bez połączonego sklepu. */
  var OFFLINE_VIEWS = ["settings", "mcp"];

  var IMAGE_KINDS = ["image_generate", "image_edit", "bg_remove", "bg_replace", "upscale", "recolor"];
  var TEXT_KINDS = ["description", "alt_text", "complete_listing"];
  var ASPECT_RATIOS = ["1:1", "4:3", "3:4", "16:9", "9:16"];
  var CONTENT_LANGUAGES = ["pl", "en", "de"];
  var TERMINAL_STATUSES = ["completed", "completed_with_errors", "failed", "cancelled"];

  var state = {
    lang: new URLSearchParams(location.search).get("lang") === "en" ? "en" : "pl",
    strings: {},
    status: null,
    csrf: null,
    view: null,
    products: [],
    page: 1,
    pages: 1,
    total: 0,
    filters: { search: "", category: "", missingDescription: false, fewImages: false, maxImages: 2 },
    selected: {}, // product_id -> ProductSummary
    categories: [],
    presets: [],
    defaultPresetSlug: null,
    kind: "image_generate",
    model: null,
    options: { num_images: 1, aspect_ratio: "1:1", background: "", recolor: "", target: "", language: "pl", tone: "professional", brand_rules: "" },
    lastEstimate: null,
    jobs: [],
    currentJobId: localStorage.getItem("fh_current_job") || null,
    jobDetail: null,
    jobItems: [],
    drafts: [],
    draftIndex: 0,
    pollTimer: null,
    balanceTimer: null,
    balance: null,
    summary: null,
  };

  /* ------------------------------------------------------------------ */
  /* Defensywny dostęp do DOM                                            */
  /* ------------------------------------------------------------------ */

  /**
   * Zwraca element albo null i loguje ostrzeżenie. Nigdy nie rzuca — pojedynczy
   * brakujący węzeł opcjonalny nie może wygasić całego panelu (dokładnie ten
   * tryb awarii naprawiamy).
   */
  function $(id) {
    var node = document.getElementById(id);
    if (!node) console.warn("[fotohub] brak elementu #" + id);
    return node;
  }

  /** Ustawia textContent, jeśli element istnieje. */
  function setText(id, value) {
    var node = $(id);
    if (node) node.textContent = value == null ? "" : String(value);
  }

  /** Przełącza klasę is-hidden, jeśli element istnieje. */
  function setHidden(id, hidden) {
    var node = $(id);
    if (node) node.classList.toggle("is-hidden", Boolean(hidden));
  }

  function on(node, event, handler) {
    if (node && node.addEventListener) node.addEventListener(event, handler);
  }

  /* ------------------------------------------------------------------ */
  /* Budowa DOM i escaping                                               */
  /* ------------------------------------------------------------------ */

  /**
   * Escaping dla tych nieliczonych miejsc, gdzie budujemy HTML jako tekst
   * (ikony sprite'a). Nazwy produktów, SKU i treści błędów są kontrolowane
   * przez atakującego, więc nigdy nie wchodzą do innerHTML bez tego filtra.
   */
  function esc(value) {
    return String(value == null ? "" : value)
      .split("&").join("&amp;")
      .split("<").join("&lt;")
      .split(">").join("&gt;")
      .split('"').join("&quot;")
      .split("'").join("&#39;");
  }

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v === undefined || v === null || v === false) return;
        if (k === "class") node.className = v;
        else if (k === "text") node.textContent = String(v);
        else if (k === "html") node.innerHTML = v; // tylko zaufane fragmenty (ikony)
        else if (k === "dataset") Object.keys(v).forEach(function (d) { node.dataset[d] = v[d]; });
        else if (k.indexOf("on") === 0 && typeof v === "function") node.addEventListener(k.slice(2), v);
        else if (k === "checked" || k === "disabled" || k === "selected") node[k] = Boolean(v);
        else if (k === "value") node.value = v;
        else node.setAttribute(k, String(v));
      });
    }
    (children || []).forEach(function (c) {
      if (c === null || c === undefined || c === false) return;
      node.appendChild(typeof c === "string" || typeof c === "number" ? document.createTextNode(String(c)) : c);
    });
    return node;
  }

  /** Ikona ze sprite'a. Identyfikator jest zawsze literałem z tego pliku. */
  function icon(name) {
    var svg = el("svg", { class: "icon", "aria-hidden": "true" });
    svg.innerHTML = '<use href="#i-' + esc(name) + '"/>';
    return svg;
  }

  function clear(node) {
    if (!node) return null;
    while (node.firstChild) node.removeChild(node.firstChild);
    return node;
  }

  /* ------------------------------------------------------------------ */
  /* i18n                                                                */
  /* ------------------------------------------------------------------ */

  function t(key, vars) {
    var s = Object.prototype.hasOwnProperty.call(state.strings, key) ? state.strings[key] : key;
    if (vars) {
      Object.keys(vars).forEach(function (k) {
        s = String(s).split("{" + k + "}").join(String(vars[k]));
      });
    }
    return String(s);
  }

  /** Tłumaczenie z zapasem: klucz nieznany katalogowi zwraca wartość surową. */
  function tOr(key, fallback) {
    var value = t(key);
    return value === key ? fallback : value;
  }

  function applyTranslations(root) {
    var scope = root || document;
    scope.querySelectorAll("[data-i18n]").forEach(function (node) {
      node.textContent = t(node.getAttribute("data-i18n"));
    });
    scope.querySelectorAll("[data-i18n-placeholder]").forEach(function (node) {
      node.setAttribute("placeholder", t(node.getAttribute("data-i18n-placeholder")));
    });
    scope.querySelectorAll("[data-i18n-title]").forEach(function (node) {
      node.setAttribute("title", t(node.getAttribute("data-i18n-title")));
    });
    scope.querySelectorAll("[data-i18n-aria-label]").forEach(function (node) {
      node.setAttribute("aria-label", t(node.getAttribute("data-i18n-aria-label")));
    });
    document.documentElement.lang = state.lang;
  }

  /* ------------------------------------------------------------------ */
  /* Warstwa API                                                          */
  /* ------------------------------------------------------------------ */

  /**
   * Jedno miejsce na fetch: dokłada token CSRF do mutacji i zamienia
   * 401/402/429 w komunikat z katalogu, żeby żaden widok nie musiał znać
   * kodów HTTP.
   */
  function api(path, options) {
    options = options || {};
    var init = { headers: {}, credentials: "same-origin" };
    if (options.method) init.method = options.method;
    if (options.body !== undefined) {
      init.method = init.method || "POST";
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(options.body);
    }
    var mutating = init.method && init.method !== "GET" && init.method !== "HEAD";
    if (mutating && state.csrf) init.headers["X-CSRF-Token"] = state.csrf;

    return fetch("/api" + path, init).then(
      function (res) {
        return res.text().then(function (raw) {
          var body = null;
          try { body = raw ? JSON.parse(raw) : null; } catch (e) { body = null; }
          if (res.ok) return body;
          var err = new Error(apiErrorMessage(res.status, body));
          err.status = res.status;
          err.body = body;
          throw err;
        });
      },
      function () {
        var err = new Error(t("error_network"));
        err.status = 0;
        throw err;
      }
    );
  }

  function apiErrorMessage(status, body) {
    if (status === 401) return t("error_401");
    if (status === 402 && body) {
      return t("estimate_insufficient", {
        required: body.required_credits,
        available: body.available_credits,
      });
    }
    if (status === 429) {
      var seconds = body && body.retry_after_ms ? Math.ceil(body.retry_after_ms / 1000) : 60;
      return t("error_429", { n: seconds });
    }
    if (status >= 500) return t("error_500");
    if (body && body.error) return String(body.error);
    return t("error_generic");
  }

  /* ------------------------------------------------------------------ */
  /* Powiadomienia i dialogi                                              */
  /* ------------------------------------------------------------------ */

  function toast(message, kind) {
    var host = $("toasts");
    if (!host) return;
    var node = el("div", { class: "toast " + (kind || "ok"), role: "status" }, [
      icon(kind === "err" ? "alert" : kind === "warn" ? "info" : "check"),
      el("span", { class: "text", text: message }),
      el("button", {
        class: "icon-btn",
        type: "button",
        "aria-label": t("toast_dismiss"),
        onclick: function () { if (node.parentNode) node.parentNode.removeChild(node); },
      }, [icon("close")]),
    ]);
    host.appendChild(node);
    setTimeout(function () { if (node.parentNode) node.parentNode.removeChild(node); }, 6000);
  }

  var dialogResolve = null;

  /** Potwierdzenie oparte o statyczny #dialog z markupu. Zwraca Promise<boolean>. */
  function confirmDialog(title, body) {
    var backdrop = $("dialog-backdrop");
    if (!backdrop) return Promise.resolve(window.confirm(title));
    setText("dialog-title", title);
    setText("dialog-body", body);
    backdrop.classList.remove("is-hidden");
    var confirm = $("dialog-confirm");
    if (confirm) confirm.focus();
    return new Promise(function (resolve) { dialogResolve = resolve; });
  }

  function closeDialog(result) {
    var backdrop = $("dialog-backdrop");
    if (backdrop) backdrop.classList.add("is-hidden");
    if (dialogResolve) { dialogResolve(result); dialogResolve = null; }
  }

  /* ------------------------------------------------------------------ */
  /* Wspólne fragmenty widoków                                            */
  /* ------------------------------------------------------------------ */

  function panel(titleKey, children) {
    var node = el("section", { class: "panel" });
    if (titleKey) node.appendChild(el("h3", { text: t(titleKey) }));
    (children || []).forEach(function (c) { if (c) node.appendChild(c); });
    return node;
  }

  function emptyState(titleKey, bodyKey, action) {
    return el("div", { class: "empty" }, [
      icon("info"),
      el("p", { class: "empty-title", text: t(titleKey) }),
      el("p", { class: "empty-text", text: t(bodyKey) }),
      action || null,
    ]);
  }

  function skeletonRows(cols, rows) {
    var frag = document.createDocumentFragment();
    for (var r = 0; r < (rows || 3); r++) {
      var tr = el("tr");
      for (var c = 0; c < cols; c++) {
        tr.appendChild(el("td", null, [el("div", { class: "skeleton skeleton-text" })]));
      }
      frag.appendChild(tr);
    }
    return frag;
  }

  function statusBadge(status) {
    var cls = "badge-muted";
    if (status === "completed") cls = "badge-ok";
    else if (status === "failed" || status === "cancelled" || status === "completed_with_errors") cls = "badge-err";
    else if (status === "awaiting_credits" || status === "processing" || status === "queued") cls = "badge-warn";
    return el("span", { class: "badge " + cls, text: tOr("status_" + status, String(status)) });
  }

  function kindLabel(kind) {
    return tOr("kind_" + kind, String(kind));
  }

  function fieldRow(labelKey, control, helpKey) {
    var label = el("label", { class: "field" });
    label.appendChild(el("span", { text: t(labelKey) }));
    label.appendChild(control);
    if (helpKey) label.appendChild(el("small", { text: t(helpKey) }));
    return label;
  }

  function selectControl(values, current, labelFor, onChange) {
    var select = el("select", { onchange: onChange });
    values.forEach(function (v) {
      select.appendChild(el("option", { value: v, text: labelFor(v), selected: String(v) === String(current) }));
    });
    return select;
  }

  function formatDate(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    return isNaN(d.getTime()) ? String(iso) : d.toLocaleString();
  }

  /* ------------------------------------------------------------------ */
  /* Nawigacja i szkielet                                                 */
  /* ------------------------------------------------------------------ */

  var VIEW_META = {
    dashboard: { title: "dashboard_title", subtitle: "dashboard_subtitle", nav: "nav_dashboard" },
    photos: { title: "wizard_title_photos", subtitle: "wizard_subtitle_photos", nav: "nav_photos" },
    descriptions: { title: "wizard_title_descriptions", subtitle: "wizard_subtitle_descriptions", nav: "nav_descriptions" },
    jobs: { title: "jobs_title", subtitle: "jobs_subtitle", nav: "nav_jobs" },
    drafts: { title: "drafts_title", subtitle: "drafts_subtitle", nav: "nav_drafts" },
    presets: { title: "presets_title", subtitle: "presets_subtitle", nav: "nav_presets" },
    settings: { title: "settings_title", subtitle: "settings_subtitle", nav: "nav_settings" },
    mcp: { title: "mcp_title", subtitle: "mcp_subtitle", nav: "nav_mcp" },
    connect: { title: "connect_title", subtitle: "connect_intro", nav: "nav_settings" },
  };

  function root() { return $("view-root"); }

  function setPageHead(view) {
    var meta = VIEW_META[view] || VIEW_META.dashboard;
    setText("page-title", t(meta.title));
    setText("page-subtitle", t(meta.subtitle));
    var crumbs = $("breadcrumb-list");
    if (crumbs) {
      clear(crumbs);
      crumbs.appendChild(el("li", { text: t("breadcrumb_root") }));
      if (view !== "dashboard") crumbs.appendChild(el("li", { text: t(meta.nav) }));
    }
    clear($("page-actions"));
  }

  function markActiveNav(view) {
    document.querySelectorAll(".nav-item, .tabbar-item").forEach(function (node) {
      var active = node.getAttribute("data-view") === view;
      node.classList.toggle("active", active);
      if (active) node.setAttribute("aria-current", "page");
      else node.removeAttribute("aria-current");
    });
  }

  /**
   * Wspólne opcje zadania (m.in. przełącznik wariantów) żyją w statycznym
   * #opts-common poza #view-root, więc pokazujemy je tylko na ekranach
   * kreatora, gdzie mają znaczenie.
   */
  function setCommonOptsVisible(visible) {
    var node = $("opts-common");
    if (node) node.classList.toggle("is-hidden", !visible);
  }

  function stopPolling() {
    if (state.pollTimer) { clearTimeout(state.pollTimer); state.pollTimer = null; }
  }

  var RENDERERS = {}; // wypełniane niżej, po zdefiniowaniu widoków

  function showView(view) {
    if (!state.status || !state.status.connected) {
      if (OFFLINE_VIEWS.indexOf(view) === -1) { showConnect(); return; }
    }
    if (VIEWS.indexOf(view) === -1) view = "dashboard";
    stopPolling();
    state.view = view;
    setPageHead(view);
    markActiveNav(view);
    setCommonOptsVisible(view === "photos" || view === "descriptions");
    closeNavDrawer();
    var host = clear(root());
    if (!host) return;
    var render = RENDERERS[view];
    if (!render) return;
    try {
      render(host);
    } catch (err) {
      console.error("[fotohub] widok " + view + " nie wyrenderował się", err);
      clear(host).appendChild(
        emptyState("error_boundary_title", "error_boundary_body",
          el("button", { class: "btn", type: "button", text: t("error_boundary_retry"), onclick: function () { showView(view); } }))
      );
    }
    var content = $("content");
    if (content && content.focus) content.focus();
  }

  function showConnect() {
    stopPolling();
    state.view = "connect";
    setPageHead("connect");
    markActiveNav("connect");
    setCommonOptsVisible(false);
    var host = clear(root());
    if (host) renderConnect(host);
  }

  function openNavDrawer(open) {
    var nav = $("sidenav");
    var scrim = $("nav-scrim");
    var toggle = $("nav-toggle");
    if (nav) nav.classList.toggle("active", open);
    if (scrim) scrim.classList.toggle("is-hidden", !open);
    if (toggle) toggle.setAttribute("aria-expanded", open ? "true" : "false");
  }

  function closeNavDrawer() { openNavDrawer(false); }

  /** Jedna delegacja na cały dokument obsługuje sidenav i pasek zakładek. */
  function bindNavigation() {
    document.addEventListener("click", function (event) {
      var target = event.target && event.target.closest
        ? event.target.closest(".nav-item, .tabbar-item")
        : null;
      if (!target) return;
      var view = target.getAttribute("data-view");
      if (view) showView(view);
    });
    on($("nav-toggle"), "click", function () {
      var nav = $("sidenav");
      openNavDrawer(!(nav && nav.classList.contains("active")));
    });
    on($("nav-scrim"), "click", closeNavDrawer);
    on($("help-btn"), "click", function () { toggleShortcuts(true); });
    on($("settings-btn"), "click", function () { showView("settings"); });
    on($("dialog-cancel"), "click", function () { closeDialog(false); });
    on($("dialog-confirm"), "click", function () { closeDialog(true); });
    on($("shortcuts-close"), "click", function () { toggleShortcuts(false); });
    on($("lang-switch"), "click", switchLanguage);
  }

  function toggleShortcuts(open) {
    setHidden("shortcuts-popover", !open);
  }

  function switchLanguage() {
    var next = state.lang === "pl" ? "en" : "pl";
    var url = new URL(location.href);
    url.searchParams.set("lang", next);
    api("/language", { body: { lang: next } })
      .catch(function () { /* preferencja serwerowa jest opcjonalna */ })
      .then(function () { location.href = url.toString(); });
  }

  /* ------------------------------------------------------------------ */
  /* Skróty klawiszowe                                                    */
  /* ------------------------------------------------------------------ */

  function bindShortcuts() {
    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape") {
        closeDialog(false);
        toggleShortcuts(false);
        closeNavDrawer();
        return;
      }
      var tag = event.target && event.target.tagName ? event.target.tagName.toLowerCase() : "";
      if (tag === "input" || tag === "textarea" || tag === "select") return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (state.view !== "drafts" || state.drafts.length === 0) return;
      var draft = state.drafts[state.draftIndex];
      var key = event.key.toLowerCase();
      if (key === "a" && draft) { event.preventDefault(); approveDraft(draft.id); }
      else if (key === "r" && draft) { event.preventDefault(); rejectDraft(draft.id); }
      else if (key === "j") { event.preventDefault(); moveDraftFocus(1); }
      else if (key === "k") { event.preventDefault(); moveDraftFocus(-1); }
    });
  }

  function moveDraftFocus(delta) {
    if (state.drafts.length === 0) return;
    var next = state.draftIndex + delta;
    if (next < 0) next = 0;
    if (next > state.drafts.length - 1) next = state.drafts.length - 1;
    state.draftIndex = next;
    var cards = document.querySelectorAll("#view-root .draft-card");
    var card = cards[next];
    if (card && card.scrollIntoView) card.scrollIntoView({ block: "nearest" });
    cards.forEach(function (node, i) { node.setAttribute("aria-selected", i === next ? "true" : "false"); });
  }

  /* ------------------------------------------------------------------ */
  /* Kredyty                                                              */
  /* ------------------------------------------------------------------ */

  function refreshBalance() {
    return api("/balance").then(function (b) {
      state.balance = b;
      setText("credits-value", String(b.available_credits));
      var pill = $("credits-pill");
      if (pill) {
        pill.classList.toggle("is-low", Boolean(b.low_balance));
        pill.setAttribute("title", t("credits_available", { n: b.available_credits }));
      }
      setText("low-balance-text", b.low_balance ? t("credits_low", { n: b.available_credits }) : "");
      setHidden("low-balance-banner", !b.low_balance);
      return b;
    }).catch(function () {
      setText("credits-value", "—");
    });
  }

  /** Odpytywanie tylko przy widocznej karcie — tło nie zużywa limitów API. */
  function startBalancePolling() {
    if (state.balanceTimer) clearInterval(state.balanceTimer);
    state.balanceTimer = setInterval(function () {
      if (!document.hidden) refreshBalance();
    }, 60000);
  }

  function updateBadges(pendingDrafts, activeJobs) {
    var draftsBadge = $("nav-badge-drafts");
    if (draftsBadge) {
      draftsBadge.textContent = pendingDrafts > 0 ? String(pendingDrafts) : "";
      draftsBadge.classList.toggle("is-hidden", !(pendingDrafts > 0));
    }
    setHidden("tabbar-dot-drafts", !(pendingDrafts > 0));
    var jobsBadge = $("nav-badge-jobs");
    if (jobsBadge) {
      jobsBadge.textContent = activeJobs > 0 ? String(activeJobs) : "";
      jobsBadge.classList.toggle("is-hidden", !(activeJobs > 0));
    }
  }

  /* ------------------------------------------------------------------ */
  /* 1. Kreator połączenia                                                */
  /* ------------------------------------------------------------------ */

  function renderConnect(host) {
    var fields = {};
    function input(id, key, helpKey, type) {
      var control = el("input", { type: type || "text", id: id, autocomplete: "off" });
      if (type === "password") control.className = "c-password";
      fields[id] = control;
      return fieldRow(key, control, helpKey);
    }

    var message = el("p", { class: "form-message", id: "connect-message" });

    var form = el("form", { class: "view-connect", novalidate: "novalidate" }, [
      panel("connect_step_key", [
        el("p", { class: "muted", text: t("connect_intro") }),
        input("c-api-key", "connect_api_key", "connect_api_key_help", "password"),
        el("button", {
          class: "btn",
          type: "button",
          text: t("connect_validate"),
          onclick: function () {
            var key = fields["c-api-key"].value.trim();
            api("/validate-key", { body: key ? { fotohub_api_key: key } : {} })
              .then(function (res) { toast(t("settings_validate_ok", { credits: res.available_credits }), "ok"); })
              .catch(function (err) { toast(err.message || t("settings_validate_fail"), "err"); });
          },
        }),
      ]),
      panel("connect_step_store", [
        input("c-store-url", "connect_store_url", "connect_store_url_help", "url"),
        input("c-token", "connect_access_token", "connect_access_token_help", "password"),
        input("c-login", "connect_login", null, "text"),
        input("c-password", "connect_password", null, "password"),
        input("c-store-name", "connect_store_name", "connect_store_name_help", "text"),
        el("div", { class: "page-actions" }, [
          el("button", { class: "btn btn-primary", type: "submit", text: t("connect_submit") }),
        ]),
        message,
      ]),
    ]);

    form.addEventListener("submit", function (event) {
      event.preventDefault();
      submitConnect(fields, message);
    });
    host.appendChild(form);
  }

  function submitConnect(fields, message) {
    function value(id) { return fields[id] ? fields[id].value.trim() : ""; }

    var storeUrl = value("c-store-url");
    var token = value("c-token");
    var login = value("c-login");
    var password = fields["c-password"] ? fields["c-password"].value : "";
    var apiKey = value("c-api-key");

    message.className = "form-message";
    if (!storeUrl || !/^https:\/\//i.test(storeUrl)) {
      message.className = "form-message err";
      message.textContent = t("connect_invalid_url");
      return;
    }
    if (apiKey && !/^fh_(live|test)_/.test(apiKey)) {
      message.className = "form-message err";
      message.textContent = t("connect_invalid_key");
      return;
    }
    if (!token && !(login && password)) {
      message.className = "form-message err";
      message.textContent = t("connect_need_auth");
      return;
    }

    message.textContent = t("loading");
    api("/connect", {
      body: {
        fotohub_api_key: apiKey || undefined,
        shoper_store_url: storeUrl || undefined,
        shoper_access_token: token || undefined,
        shoper_login: login || undefined,
        shoper_password: password || undefined,
        store_name: value("c-store-name") || undefined,
      },
    }).then(function (res) {
      message.className = "form-message ok";
      message.textContent = t("connect_success", { credits: res.available_credits });
      toast(t("connect_success", { credits: res.available_credits }), "ok");
      return boot();
    }).catch(function (err) {
      message.className = "form-message err";
      message.textContent = err.message || t("error_generic");
    });
  }

  /* ------------------------------------------------------------------ */
  /* 2. Panel (dashboard)                                                 */
  /* ------------------------------------------------------------------ */

  function kpiCard(labelKey, value, hint) {
    return el("div", { class: "panel" }, [
      el("p", { class: "meta", text: t(labelKey) }),
      el("p", { class: "credits-value", text: value }),
      el("p", { class: "meta muted", text: hint || "" }),
    ]);
  }

  function renderDashboard(host) {
    var actions = $("page-actions");
    if (actions) {
      actions.appendChild(el("button", {
        class: "btn btn-primary", type: "button", text: t("dashboard_quick_photos"),
        onclick: function () { showView("photos"); },
      }));
      actions.appendChild(el("button", {
        class: "btn", type: "button", text: t("dashboard_quick_descriptions"),
        onclick: function () { showView("descriptions"); },
      }));
    }

    var grid = el("div", { class: "opts-image" }, [
      el("div", { class: "panel" }, [el("div", { class: "skeleton skeleton-text" })]),
      el("div", { class: "panel" }, [el("div", { class: "skeleton skeleton-text" })]),
    ]);
    host.appendChild(grid);
    var recent = panel("dashboard_recent_jobs", [el("div", { class: "skeleton skeleton-text" })]);
    host.appendChild(recent);

    api("/summary").then(function (summary) {
      state.summary = summary;
      updateBadges(summary.drafts_pending || 0, summary.jobs_active || 0);
      clear(grid);
      grid.appendChild(kpiCard("kpi_credits",
        summary.available_credits === null || summary.available_credits === undefined ? "—" : String(summary.available_credits),
        summary.spent_recently ? t("kpi_delta_spent", { n: summary.spent_recently }) : t("kpi_credits_hint")));
      grid.appendChild(kpiCard("kpi_jobs_active", String(summary.jobs_active || 0), t("kpi_jobs_active_hint")));
      grid.appendChild(kpiCard("kpi_drafts_pending", String(summary.drafts_pending || 0), t("kpi_drafts_pending_hint")));
      grid.appendChild(kpiCard("kpi_products_no_desc",
        summary.missing_description ? String(summary.missing_description.count) : "—",
        summary.missing_description ? t("kpi_products_no_desc_hint", { n: summary.missing_description.sample }) : ""));

      clear(recent);
      recent.appendChild(el("h3", { text: t("dashboard_recent_jobs") }));
      var jobs = summary.recent_jobs || [];
      if (jobs.length === 0) {
        recent.appendChild(emptyState("dashboard_recent_empty_title", "dashboard_recent_empty_body",
          el("button", {
            class: "btn btn-primary", type: "button", text: t("dashboard_recent_empty_action"),
            onclick: function () { showView("photos"); },
          })));
        return;
      }
      var list = el("div", { class: "jobs-list" });
      jobs.forEach(function (job) { list.appendChild(jobRow(job)); });
      recent.appendChild(list);
    }).catch(function (err) {
      clear(grid);
      grid.appendChild(el("p", { class: "form-message err", text: err.message || t("error_generic") }));
      clear(recent);
    });
  }

  /* ------------------------------------------------------------------ */
  /* 3. Kreator zadania: produkty, preset, opcje, koszt                   */
  /* ------------------------------------------------------------------ */

  /** Warianty: statyczny przełącznik z markupu, czytany zawsze defensywnie. */
  var includeVariantsBox = document.getElementById("o-include-variants");
  if (includeVariantsBox) {
    includeVariantsBox.addEventListener("change", invalidateEstimate);
  }

  function includeVariants() {
    return Boolean(includeVariantsBox && includeVariantsBox.checked);
  }

  function isTextKind(kind) { return TEXT_KINDS.indexOf(kind) !== -1; }

  function kindsFor(mode) {
    return mode === "descriptions" ? TEXT_KINDS : IMAGE_KINDS.concat(["complete_listing"]);
  }

  function renderWizard(host, mode) {
    var kinds = kindsFor(mode);
    if (kinds.indexOf(state.kind) === -1) state.kind = kinds[0];

    host.appendChild(renderKindPanel(kinds));
    host.appendChild(renderProductsPanel());
    host.appendChild(renderPresetPanel());
    host.appendChild(renderOptionsPanel());
    host.appendChild(renderSummaryPanel());

    loadCategories();
    loadProducts();
    if (state.presets.length === 0) loadPresets(true);
    invalidateEstimate();
  }

  function renderKindPanel(kinds) {
    var grid = el("div", { class: "preset-grid" });
    kinds.forEach(function (kind) {
      var active = kind === state.kind;
      var card = el("button", {
        type: "button",
        class: "preset-card" + (active ? " active" : ""),
        "aria-pressed": active ? "true" : "false",
        onclick: function () {
          state.kind = kind;
          invalidateEstimate();
          showView(state.view);
        },
      }, [
        el("div", { class: "preset-body" }, [
          el("span", { class: "title", text: kindLabel(kind) }),
          el("p", { class: "description", text: tOr("kind_" + kind + "_desc", "") }),
          el("span", { class: "chip", text: isTextKind(kind) && kind !== "complete_listing" ? t("kind_cost_text") : t("kind_cost_per_item", { n: 2 }) }),
        ]),
      ]);
      grid.appendChild(card);
    });
    return panel("job_kind", [grid]);
  }

  /* ---- produkt picker ---- */

  function renderProductsPanel() {
    var box = panel("wizard_step_products", []);

    var search = el("input", { type: "search", class: "f-search search", value: state.filters.search, "data-i18n-placeholder": "filter_search", "aria-label": t("filter_search_label") });
    search.setAttribute("placeholder", t("filter_search"));
    on(search, "keydown", function (event) {
      if (event.key === "Enter") { event.preventDefault(); state.filters.search = search.value.trim(); state.page = 1; loadProducts(); }
    });

    var category = el("select", { class: "f-category", "aria-label": t("filter_category") });
    category.appendChild(el("option", { value: "", text: t("filter_all_categories") }));
    state.categories.forEach(function (c) {
      category.appendChild(el("option", { value: String(c.category_id), text: c.name, selected: String(c.category_id) === state.filters.category }));
    });
    on(category, "change", function () { state.filters.category = category.value; state.page = 1; loadProducts(); });
    state.refs = state.refs || {};
    state.refs.category = category;

    var missingDesc = el("input", { type: "checkbox", checked: state.filters.missingDescription });
    on(missingDesc, "change", function () { state.filters.missingDescription = missingDesc.checked; state.page = 1; loadProducts(); });

    var fewImages = el("input", { type: "checkbox", checked: state.filters.fewImages });
    var maxImages = el("input", { type: "number", class: "f-max-images", min: "1", max: "10", value: String(state.filters.maxImages) });
    var fewLabel = el("span", { text: t("filter_few_images", { n: state.filters.maxImages }) });
    on(fewImages, "change", function () { state.filters.fewImages = fewImages.checked; state.page = 1; loadProducts(); });
    on(maxImages, "change", function () {
      state.filters.maxImages = Number(maxImages.value) || 2;
      fewLabel.textContent = t("filter_few_images", { n: state.filters.maxImages });
      if (state.filters.fewImages) { state.page = 1; loadProducts(); }
    });

    var filters = el("div", { class: "opts-text" }, [
      fieldRow("filter_search_label", search),
      fieldRow("filter_category", category),
      el("label", { class: "field f-missing-desc" }, [
        el("span", null, [missingDesc, el("span", { text: t("filter_missing_description") })]),
      ]),
      el("label", { class: "field f-few-images-label" }, [
        el("span", null, [fewImages, fewLabel]),
        maxImages,
      ]),
    ]);
    box.appendChild(filters);

    var selectAll = el("input", { type: "checkbox", class: "select-all", "aria-label": t("select_all") });
    on(selectAll, "change", function () {
      state.products.forEach(function (p) {
        if (selectAll.checked) state.selected[p.product_id] = p;
        else delete state.selected[p.product_id];
      });
      renderProductRows();
      updateSelectionUi();
    });

    var table = el("table");
    table.appendChild(el("thead", null, [
      el("tr", null, [
        el("th", null, [selectAll]),
        el("th", { text: t("col_thumb") }),
        el("th", { text: t("col_product") }),
        el("th", { text: t("col_sku") }),
        el("th", { text: t("col_price") }),
        el("th", { text: t("col_description") }),
        el("th", { text: t("col_images") }),
      ]),
    ]));
    var tbody = el("tbody");
    table.appendChild(tbody);
    box.appendChild(el("div", { class: "products" }, [table]));

    var pageInfo = el("span", { class: "page-info" });
    var prev = el("button", { class: "btn page-prev", type: "button", "aria-label": t("page_prev") }, [icon("chevron-left")]);
    var next = el("button", { class: "btn page-next", type: "button", "aria-label": t("page_next") }, [icon("chevron-right")]);
    on(prev, "click", function () { if (state.page > 1) { state.page -= 1; loadProducts(); } });
    on(next, "click", function () { if (state.page < state.pages) { state.page += 1; loadProducts(); } });

    var selectedCount = el("span", { class: "selected-count", text: t("selected_count", { n: Object.keys(state.selected).length }) });
    box.appendChild(el("div", { class: "page-actions" }, [selectedCount, prev, pageInfo, next]));

    state.refs.tbody = tbody;
    state.refs.pageInfo = pageInfo;
    state.refs.selectedCount = selectedCount;
    state.refs.selectAll = selectAll;
    return box;
  }

  function loadCategories() {
    if (state.categories.length > 0) return Promise.resolve();
    return api("/categories").then(function (res) {
      state.categories = res.categories || [];
      var select = state.refs && state.refs.category;
      if (!select) return;
      while (select.options.length > 1) select.remove(1);
      state.categories.forEach(function (c) {
        // textContent w el() escape'uje nazwę kategorii z API sklepu.
        select.appendChild(el("option", { value: String(c.category_id), text: c.name }));
      });
    }).catch(function () { /* picker działa też bez kategorii */ });
  }

  function loadProducts() {
    var tbody = state.refs && state.refs.tbody;
    if (!tbody) return Promise.resolve();
    clear(tbody).appendChild(skeletonRows(7, 4));

    var params = new URLSearchParams();
    params.set("page", String(state.page));
    if (state.filters.search) params.set("search", state.filters.search);
    if (state.filters.category) params.set("category_id", state.filters.category);
    if (state.filters.missingDescription) params.set("missing_description", "1");
    if (state.filters.fewImages) params.set("max_images", String(state.filters.maxImages));

    return api("/products?" + params.toString()).then(function (res) {
      state.products = res.products || [];
      state.pages = res.pages || 1;
      state.total = res.count || state.products.length;
      renderProductRows();
      updateSelectionUi();
    }).catch(function (err) {
      clear(tbody).appendChild(el("tr", null, [
        el("td", { colspan: "7" }, [
          el("p", { class: "empty-title", text: t("products_error_title") }),
          // Treść błędu z API jest kontrolowana przez zdalny serwis: textContent.
          el("p", { class: "empty-text", text: err.message || t("products_error_body") }),
        ]),
      ]));
    });
  }

  function renderProductRows() {
    var tbody = state.refs && state.refs.tbody;
    if (!tbody) return;
    clear(tbody);
    if (state.products.length === 0) {
      tbody.appendChild(el("tr", null, [
        el("td", { colspan: "7" }, [emptyState("no_products_title", "no_products_body", null)]),
      ]));
      return;
    }
    state.products.forEach(function (p) {
      var checkbox = el("input", {
        type: "checkbox",
        checked: Boolean(state.selected[p.product_id]),
        "aria-label": t("select_row", { name: p.name }),
      });
      on(checkbox, "change", function () {
        if (checkbox.checked) state.selected[p.product_id] = p;
        else delete state.selected[p.product_id];
        updateSelectionUi();
      });
      var thumb = p.thumbnail
        ? el("img", { class: "thumb", src: p.thumbnail, alt: "", loading: "lazy" })
        : el("span", { class: "thumb thumb-empty" }, [icon("image")]);
      var descCell = p.description_length < 20
        ? el("span", { class: "badge missing", text: t("missing") })
        : el("span", { class: "chars", text: p.description_length + " " + t("chars") });

      tbody.appendChild(el("tr", null, [
        el("td", { "data-label": t("select_all") }, [checkbox]),
        el("td", { "data-label": t("col_thumb") }, [thumb]),
        // p.name i p.sku pochodzą ze sklepu — zawsze textContent, nigdy HTML.
        el("td", { "data-label": t("col_product"), text: p.name }),
        el("td", { "data-label": t("col_sku"), text: p.sku || "" }),
        el("td", { "data-label": t("col_price"), text: typeof p.price === "number" ? p.price.toFixed(2) : "" }),
        el("td", { "data-label": t("col_description") }, [descCell]),
        el("td", { "data-label": t("col_images"), text: String(p.image_count) }),
      ]));
    });
  }

  function updateSelectionUi() {
    var refs = state.refs || {};
    if (refs.pageInfo) refs.pageInfo.textContent = t("page_info", { page: state.page, pages: state.pages });
    if (refs.selectedCount) refs.selectedCount.textContent = t("selected_count", { n: Object.keys(state.selected).length });
    if (refs.selectAll) {
      refs.selectAll.checked = state.products.length > 0 && state.products.every(function (p) {
        return Boolean(state.selected[p.product_id]);
      });
    }
    invalidateEstimate();
  }

  /* ---- preset w kreatorze ---- */

  function presetName(preset) {
    return state.lang === "pl" && preset.name_pl ? preset.name_pl : preset.name;
  }

  function renderPresetPanel() {
    var name = el("span", { class: "composer-preset-name", text: "—" });
    state.refs = state.refs || {};
    state.refs.presetName = name;
    var box = panel("wizard_step_style", [
      el("p", { class: "meta" }, [el("span", { text: t("option_preset") + ": " }), name]),
      el("button", {
        class: "btn", type: "button", text: t("presets_select"),
        onclick: function () { showView("presets"); },
      }),
    ]);
    updateComposerPreset();
    return box;
  }

  function updateComposerPreset() {
    var name = state.refs && state.refs.presetName;
    if (!name) return;
    var preset = state.presets.filter(function (p) { return p.slug === state.defaultPresetSlug; })[0];
    name.textContent = preset ? presetName(preset) : t("option_preset_none");
  }

  /* ---- opcje ---- */

  function renderOptionsPanel() {
    var kind = state.kind;
    var textual = isTextKind(kind);
    var imageSide = !textual || kind === "complete_listing";
    var children = [];

    if (imageSide) {
      var models = (state.status && state.status.models) || [];
      if (!state.model) {
        var def = models.filter(function (m) { return m.isDefault; })[0] || models[0];
        state.model = (state.status && state.status.default_model) || (def && def.id) || null;
      }
      var modelSelect = el("select", null, models.map(function (m) {
        return el("option", {
          value: m.id,
          text: m.label + " (" + m.creditsPerImage + " " + t("credits_unit") + ")",
          selected: m.id === state.model,
        });
      }));
      on(modelSelect, "change", function () { state.model = modelSelect.value; invalidateEstimate(); });
      children.push(fieldRow("option_model", modelSelect, "option_model_help"));

      var numImages = el("input", { type: "number", min: "1", max: "4", value: String(state.options.num_images) });
      on(numImages, "change", function () {
        state.options.num_images = Math.min(Math.max(Number(numImages.value) || 1, 1), 4);
        numImages.value = String(state.options.num_images);
        invalidateEstimate();
      });
      children.push(fieldRow("option_num_images", numImages));

      var aspect = selectControl(ASPECT_RATIOS, state.options.aspect_ratio, function (v) { return v; }, function (e) {
        state.options.aspect_ratio = e.target.value; invalidateEstimate();
      });
      children.push(fieldRow("option_aspect_ratio", aspect));

      if (kind === "bg_replace" || kind === "image_generate" || kind === "image_edit") {
        var background = el("input", { type: "text", value: state.options.background });
        on(background, "input", function () { state.options.background = background.value; invalidateEstimate(); });
        children.push(el("div", { class: "wrap-background" }, [fieldRow("option_background", background, "option_background_help")]));
      }
      if (kind === "recolor") {
        var recolor = el("input", { type: "text", value: state.options.recolor });
        on(recolor, "input", function () { state.options.recolor = recolor.value; invalidateEstimate(); });
        children.push(el("div", { class: "wrap-recolor" }, [fieldRow("option_recolor_prompt", recolor)]));
      }
      if (kind === "recolor" || kind === "bg_remove") {
        var target = el("input", { type: "text", value: state.options.target });
        on(target, "input", function () { state.options.target = target.value; invalidateEstimate(); });
        children.push(el("div", { class: "wrap-target" }, [fieldRow("option_target_object", target, "option_target_object_help")]));
      }
    }

    if (textual) {
      var language = selectControl(CONTENT_LANGUAGES, state.options.language,
        function (v) { return tOr("lang_" + v, v); },
        function (e) { state.options.language = e.target.value; invalidateEstimate(); });
      children.push(fieldRow("option_language", language));

      var tones = (state.status && state.status.tones) || ["professional"];
      var tone = selectControl(tones, state.options.tone,
        function (v) { return tOr("tone_" + v, v); },
        function (e) { state.options.tone = e.target.value; invalidateEstimate(); });
      children.push(fieldRow("option_tone", tone));

      var brand = el("textarea", { rows: "3" });
      brand.value = state.options.brand_rules;
      on(brand, "input", function () { state.options.brand_rules = brand.value; invalidateEstimate(); });
      children.push(fieldRow("option_brand_rules", brand, "option_brand_rules_help"));
    }

    return panel("options_title", [el("div", { class: textual && !imageSide ? "opts-text" : "opts-image" }, children)]);
  }

  function collectOptions() {
    var kind = state.kind;
    var textual = isTextKind(kind);
    var options = {};
    if (!textual || kind === "complete_listing") {
      options.num_images = state.options.num_images;
      options.aspect_ratio = state.options.aspect_ratio;
      if ((kind === "bg_replace" || kind === "image_generate" || kind === "image_edit") && state.options.background.trim()) {
        options.background = state.options.background.trim();
      }
      if (kind === "recolor" && state.options.recolor.trim()) options.recolor_prompt = state.options.recolor.trim();
      if ((kind === "recolor" || kind === "bg_remove") && state.options.target.trim()) {
        options.target_object = state.options.target.trim();
      }
    }
    if (textual) {
      options.language = state.options.language;
      options.tone = state.options.tone;
      if (state.options.brand_rules.trim()) options.brand_rules = state.options.brand_rules.trim();
    }
    return options;
  }

  function collectModel() {
    if (isTextKind(state.kind) && state.kind !== "complete_listing") return undefined;
    return state.model || undefined;
  }

  /* ---- kosztorys i uruchomienie ---- */

  function renderSummaryPanel() {
    var estimateText = el("p", { class: "estimate-text", text: t("estimate_pending") });
    var message = el("p", { class: "form-message" });
    var submit = el("button", { class: "btn btn-primary submit-btn", type: "button", text: t("submit_job"), disabled: true });
    var estimateBtn = el("button", { class: "btn estimate-btn", type: "button", text: t("estimate_button") });

    state.refs = state.refs || {};
    state.refs.estimateText = estimateText;
    state.refs.composerMessage = message;
    state.refs.submit = submit;

    on(estimateBtn, "click", runEstimate);
    on(submit, "click", submitJob);

    return panel("wizard_summary_cost", [
      el("p", { class: "muted", text: t("wizard_summary_note") }),
      estimateText,
      el("div", { class: "page-actions" }, [estimateBtn, submit]),
      message,
    ]);
  }

  function invalidateEstimate() {
    state.lastEstimate = null;
    var refs = state.refs || {};
    if (refs.submit) refs.submit.disabled = true;
    if (refs.estimateText) {
      refs.estimateText.textContent = t("estimate_pending");
      refs.estimateText.classList.remove("insufficient");
      refs.estimateText.classList.remove("ok");
    }
  }

  function runEstimate() {
    var refs = state.refs || {};
    var ids = Object.keys(state.selected);
    var message = refs.composerMessage;
    if (message) { message.className = "form-message"; message.textContent = ""; }
    if (ids.length === 0) {
      if (message) { message.className = "form-message err"; message.textContent = t("wizard_need_products"); }
      return;
    }
    var options = collectOptions();
    if (refs.estimateText) refs.estimateText.textContent = t("estimate_calculating");

    api("/estimate", {
      body: { kind: state.kind, model: collectModel(), num_items: ids.length, options: options },
    }).then(function (est) {
      state.lastEstimate = est;
      var key = isTextKind(state.kind) && state.kind !== "complete_listing" ? "estimate_line_text" : "estimate_line";
      if (refs.estimateText) {
        refs.estimateText.textContent = t(key, {
          items: ids.length,
          images: options.num_images || 1,
          total: est.total_credits,
          available: est.available_credits,
        });
        refs.estimateText.classList.toggle("insufficient", !est.sufficient);
        refs.estimateText.classList.toggle("ok", Boolean(est.sufficient));
      }
      if (refs.submit) refs.submit.disabled = !est.sufficient;
      if (!est.sufficient && message) {
        message.className = "form-message err";
        message.textContent = t("estimate_insufficient", { required: est.total_credits, available: est.available_credits });
      }
    }).catch(function (err) {
      if (refs.estimateText) refs.estimateText.textContent = "";
      if (message) { message.className = "form-message err"; message.textContent = err.message || t("error_generic"); }
    });
  }

  function submitJob() {
    var refs = state.refs || {};
    var ids = Object.keys(state.selected).map(Number);
    var message = refs.composerMessage;
    if (ids.length === 0 || !state.lastEstimate) return;
    if (refs.submit) { refs.submit.disabled = true; refs.submit.textContent = t("submit_job_running"); }
    if (message) { message.className = "form-message"; message.textContent = t("loading"); }

    api("/jobs", {
      body: {
        kind: state.kind,
        product_ids: ids,
        model: collectModel(),
        preset_slug: state.defaultPresetSlug || undefined,
        options: collectOptions(),
        include_variants: includeVariants(),
        idempotency_key: "shoper-" + Date.now() + "-" + Math.random().toString(36).slice(2, 10),
      },
    }).then(function (job) {
      toast(t("job_submitted", { id: job.job_id }), "ok");
      state.selected = {};
      state.currentJobId = job.job_id;
      localStorage.setItem("fh_current_job", job.job_id);
      refreshBalance();
      showView("jobs");
    }).catch(function (err) {
      if (refs.submit) { refs.submit.disabled = false; refs.submit.textContent = t("submit_job"); }
      if (message) { message.className = "form-message err"; message.textContent = err.message || t("error_generic"); }
    });
  }

  /* ------------------------------------------------------------------ */
  /* 4. Galeria presetów                                                  */
  /* ------------------------------------------------------------------ */

  function loadPresets(quiet) {
    return api("/presets").then(function (res) {
      state.presets = res.presets || [];
      state.defaultPresetSlug = res.default_preset_slug;
      updateComposerPreset();
      if (!quiet && state.view === "presets") showView("presets");
      return state.presets;
    }).catch(function (err) {
      if (!quiet) toast(err.message || t("presets_empty_body"), "err");
      return [];
    });
  }

  function renderPresets(host) {
    if (state.presets.length === 0) {
      var loading = panel("presets_title", [el("div", { class: "skeleton skeleton-text" })]);
      host.appendChild(loading);
      loadPresets(true).then(function (presets) {
        clear(host);
        if (presets.length === 0) {
          host.appendChild(emptyState("presets_empty_title", "presets_empty_body", null));
          return;
        }
        host.appendChild(presetGroups());
      });
      return;
    }
    host.appendChild(presetGroups());
  }

  function presetGroups() {
    var container = el("div", { class: "presets-groups" });
    var groups = {};
    var order = [];
    state.presets.forEach(function (p) {
      if (!groups[p.category]) { groups[p.category] = []; order.push(p.category); }
      groups[p.category].push(p);
    });
    order.forEach(function (category) {
      var group = el("div", { class: "preset-group" });
      group.appendChild(el("h4", { text: tOr("preset_category_" + category, category) }));
      var grid = el("div", { class: "preset-grid" });
      groups[category].forEach(function (p) { grid.appendChild(presetCard(p, category)); });
      group.appendChild(grid);
      container.appendChild(group);
    });
    return container;
  }

  function presetCard(preset, category) {
    var isDefault = preset.slug === state.defaultPresetSlug;
    var isAllegro = String(preset.slug).indexOf("allegro") !== -1;
    var card = el("button", {
      type: "button",
      class: "preset-card" + (isDefault ? " active" : ""),
      "aria-pressed": isDefault ? "true" : "false",
      onclick: function () { setDefaultPreset(preset); },
    });
    if (preset.thumbnail_url) {
      card.appendChild(el("img", { class: "preset-thumb", src: preset.thumbnail_url, alt: "", loading: "lazy" }));
    } else {
      card.appendChild(el("div", { class: "preset-thumb" }));
    }
    var body = el("div", { class: "preset-body" }, [
      // Nazwa i opis presetu przychodzą z API — textContent.
      el("span", { class: "title", text: presetName(preset) }),
      el("p", { class: "description", text: preset.description || "" }),
    ]);
    var chips = el("p", { class: "meta" });
    if (isDefault) chips.appendChild(el("span", { class: "badge badge-ok", text: t("presets_default") }));
    if (isAllegro) chips.appendChild(el("span", { class: "badge allegro", text: t("preset_allegro_badge") }));
    if (category === "bundle") chips.appendChild(el("span", { class: "badge bundle", text: t("preset_recommended") }));
    body.appendChild(chips);
    card.appendChild(body);
    return card;
  }

  function setDefaultPreset(preset) {
    api("/presets/default", { body: { slug: preset.slug } }).then(function () {
      state.defaultPresetSlug = preset.slug;
      toast(t("presets_saved", { name: presetName(preset) }), "ok");
      updateComposerPreset();
      showView("presets");
    }).catch(function (err) { toast(err.message || t("error_generic"), "err"); });
  }

  /* ------------------------------------------------------------------ */
  /* 5. Monitor zadań                                                     */
  /* ------------------------------------------------------------------ */

  function jobRow(job) {
    var progress = job.state
      ? t("job_progress", { done: job.state.done_items, total: job.state.total_items, failed: job.state.failed_items })
      : "";
    return el("button", {
      type: "button",
      class: "job-row",
      onclick: function () { openJob(job.job_id); },
    }, [
      el("div", { class: "wrap" }, [
        el("span", { class: "j-kind", text: kindLabel(job.kind) }),
        el("div", { class: "meta", text: job.job_id + " · " + formatDate(job.created_at) }),
      ]),
      el("div", { class: "draft-actions" }, [
        job.state ? statusBadge(job.state.status) : el("span", { class: "badge badge-muted", text: "…" }),
        el("span", { class: "meta", text: progress }),
      ]),
    ]);
  }

  function renderJobs(host) {
    var actions = $("page-actions");
    if (actions) {
      actions.appendChild(el("button", {
        class: "btn", type: "button", text: t("refresh"),
        onclick: function () { showView("jobs"); },
      }));
    }

    var listPanel = panel("jobs_list_title", [el("div", { class: "skeleton skeleton-text" })]);
    var detailHost = el("div", { class: "job-detail" });
    host.appendChild(listPanel);
    host.appendChild(detailHost);
    state.refs = state.refs || {};
    state.refs.jobDetail = detailHost;

    api("/jobs").then(function (res) {
      state.jobs = res.jobs || [];
      clear(listPanel).appendChild(el("h3", { text: t("jobs_list_title") }));
      if (state.jobs.length === 0) {
        listPanel.appendChild(emptyState("jobs_empty_title", "jobs_empty_body",
          el("button", {
            class: "btn btn-primary", type: "button", text: t("jobs_empty_action"),
            onclick: function () { showView("photos"); },
          })));
        return;
      }
      var list = el("div", { class: "jobs-list" });
      state.jobs.forEach(function (job) { list.appendChild(jobRow(job)); });
      listPanel.appendChild(list);
      var known = state.jobs.filter(function (j) { return j.job_id === state.currentJobId; })[0];
      openJob(known ? known.job_id : state.jobs[0].job_id);
    }).catch(function (err) {
      clear(listPanel).appendChild(el("p", { class: "form-message err", text: err.message || t("error_generic") }));
    });
  }

  function openJob(jobId) {
    if (!jobId) return;
    state.currentJobId = jobId;
    localStorage.setItem("fh_current_job", jobId);
    var host = state.refs && state.refs.jobDetail;
    if (!host) { showView("jobs"); return; }

    clear(host);
    var bar = el("div", { class: "job-progress-bar" }, [el("span")]);
    var progressText = el("p", { class: "job-progress-text" });
    var retry = el("button", { class: "btn job-retry", type: "button", text: t("retry_failed"), disabled: true });
    var cancelBtn = el("button", { class: "btn btn-danger job-cancel", type: "button", text: t("cancel_job"), disabled: true });
    var collect = el("button", { class: "btn job-collect", type: "button", text: t("collect_drafts") });
    var pausedNote = el("p", { class: "meta is-hidden", text: t("auto_refresh_paused") });

    var itemsTable = el("table");
    itemsTable.appendChild(el("thead", null, [
      el("tr", null, [
        el("th", { text: t("col_product") }),
        el("th", { text: t("col_sku") }),
        el("th", { text: t("col_status") }),
        el("th", { text: t("col_error") }),
      ]),
    ]));
    var itemsBody = el("tbody", { class: "job-items-body" });
    itemsTable.appendChild(itemsBody);

    host.appendChild(panel(null, [
      el("h3", { class: "job-detail-title", text: t("job_detail_title", { id: jobId }) }),
      bar,
      progressText,
      pausedNote,
      el("div", { class: "page-actions" }, [retry, cancelBtn, collect]),
    ]));
    host.appendChild(panel("job_items_title", [el("div", { class: "products" }, [itemsTable])]));

    state.refs.jobBar = bar;
    state.refs.jobProgress = progressText;
    state.refs.jobRetry = retry;
    state.refs.jobCancel = cancelBtn;
    state.refs.jobItemsBody = itemsBody;
    state.refs.jobPaused = pausedNote;

    on(retry, "click", function () { retryFailed(jobId); });
    on(cancelBtn, "click", function () { cancelJob(jobId); });
    on(collect, "click", function () { collectDrafts(jobId); });

    pollJob();
  }

  /**
   * Odpytywanie świadome widoczności karty: w tle nie palimy limitu zapytań,
   * tylko czekamy na powrót użytkownika.
   */
  function pollJob() {
    stopPolling();
    var jobId = state.currentJobId;
    if (!jobId || state.view !== "jobs") return;
    var refs = state.refs || {};

    if (document.hidden) {
      if (refs.jobPaused) refs.jobPaused.classList.remove("is-hidden");
      state.pollTimer = setTimeout(pollJob, 5000);
      return;
    }
    if (refs.jobPaused) refs.jobPaused.classList.add("is-hidden");

    api("/jobs/" + encodeURIComponent(jobId)).then(function (job) {
      state.jobDetail = job;
      var handled = job.done_items + job.failed_items;
      var pct = job.total_items > 0 ? Math.round((handled / job.total_items) * 100) : 0;
      if (refs.jobBar && refs.jobBar.firstElementChild) refs.jobBar.firstElementChild.style.width = pct + "%";
      var text = t("job_progress", { done: job.done_items, total: job.total_items, failed: job.failed_items });
      if (job.spent_credits) text += " · " + t("job_credits_spent", { n: job.spent_credits });
      if (refs.jobProgress) refs.jobProgress.textContent = text;
      var terminal = TERMINAL_STATUSES.indexOf(job.status) !== -1;
      if (refs.jobRetry) refs.jobRetry.disabled = !job.failed_items;
      if (refs.jobCancel) refs.jobCancel.disabled = terminal;

      return api("/jobs/" + encodeURIComponent(jobId) + "/items?limit=100").then(function (res) {
        state.jobItems = res.items || [];
        renderJobItems();
        if (!terminal) state.pollTimer = setTimeout(pollJob, 4000);
        else refreshBalance();
      });
    }).catch(function (err) {
      if (refs.jobProgress) refs.jobProgress.textContent = err.message || t("error_generic");
      state.pollTimer = setTimeout(pollJob, 8000);
    });
  }

  function renderJobItems() {
    var body = state.refs && state.refs.jobItemsBody;
    if (!body) return;
    clear(body);
    if (state.jobItems.length === 0) {
      body.appendChild(el("tr", null, [el("td", { colspan: "4", class: "muted", text: t("job_items_empty") })]));
      return;
    }
    state.jobItems.forEach(function (item) {
      body.appendChild(el("tr", null, [
        el("td", { "data-label": t("col_product"), text: item.external_id }),
        el("td", { "data-label": t("col_sku"), text: item.sku || "" }),
        el("td", { "data-label": t("col_status") }, [statusBadge(item.status)]),
        // error_message pochodzi od dostawcy modelu — nigdy jako HTML.
        el("td", { "data-label": t("col_error"), text: item.error_message || "" }),
      ]));
    });
  }

  function retryFailed(jobId) {
    var failed = state.jobDetail ? state.jobDetail.failed_items : 0;
    confirmDialog(t("retry_failed_confirm_title"), t("retry_failed_confirm_body", { n: failed })).then(function (ok) {
      if (!ok) return;
      api("/jobs/" + encodeURIComponent(jobId) + "/retry-failed", { method: "POST" }).then(function () {
        toast(t("retry_started"), "ok");
        pollJob();
      }).catch(function (err) { toast(err.message || t("error_generic"), "err"); });
    });
  }

  function cancelJob(jobId) {
    confirmDialog(t("cancel_job_confirm_title"), t("cancel_job_confirm_body")).then(function (ok) {
      if (!ok) return;
      api("/jobs/" + encodeURIComponent(jobId) + "/cancel", { method: "POST" }).then(function () {
        toast(t("cancel_job_done"), "ok");
        pollJob();
      }).catch(function (err) { toast(err.message || t("error_generic"), "err"); });
    });
  }

  function collectDrafts(jobId) {
    api("/jobs/" + encodeURIComponent(jobId) + "/collect-drafts", { method: "POST" }).then(function (res) {
      toast(t("collect_drafts_done", { n: res.collected }), "ok");
      showView("drafts");
    }).catch(function (err) { toast(err.message || t("error_generic"), "err"); });
  }

  /* ------------------------------------------------------------------ */
  /* 6. Przegląd wersji roboczych                                         */
  /* ------------------------------------------------------------------ */

  function renderDrafts(host) {
    host.appendChild(el("p", { class: "muted", text: t("drafts_intro") }));
    var listHost = el("div", { class: "drafts-list" }, [el("div", { class: "skeleton skeleton-text" })]);
    host.appendChild(listHost);
    state.refs = state.refs || {};
    state.refs.draftsList = listHost;
    loadDrafts();
  }

  function loadDrafts() {
    var listHost = state.refs && state.refs.draftsList;
    if (!listHost) return Promise.resolve();
    return api("/drafts?status=pending").then(function (res) {
      state.drafts = res.drafts || [];
      state.draftIndex = 0;
      updateBadges(state.drafts.length, state.summary ? state.summary.jobs_active || 0 : 0);
      clear(listHost);

      var actions = $("page-actions");
      if (actions) {
        clear(actions);
        if (state.drafts.length > 0) {
          actions.appendChild(el("button", {
            class: "btn btn-primary drafts-approve-all", type: "button",
            text: t("draft_approve_all"),
            onclick: approveAllDrafts,
          }));
        }
        actions.appendChild(el("span", { class: "page-info", text: t("drafts_list_title", { n: state.drafts.length }) }));
      }

      if (state.drafts.length === 0) {
        listHost.appendChild(emptyState("drafts_empty_title", "drafts_empty_body",
          el("button", {
            class: "btn", type: "button", text: t("drafts_empty_action"),
            onclick: function () { showView("jobs"); },
          })));
        return;
      }
      state.drafts.forEach(function (draft, index) {
        listHost.appendChild(renderDraftCard(draft, index));
      });
    }).catch(function (err) {
      clear(listHost).appendChild(el("p", { class: "form-message err", text: err.message || t("error_generic") }));
    });
  }

  function renderDraftCard(draft, index) {
    var payload = draft.payload || {};
    var before = payload.before || {};
    var card = el("div", {
      class: "draft-card",
      tabindex: "-1",
      "aria-selected": index === state.draftIndex ? "true" : "false",
    });

    card.appendChild(el("div", { class: "draft-card-head" }, [
      el("span", { class: "title", text: t("draft_product", { id: draft.product_id }) }),
      el("span", { class: "badge", text: kindLabel(draft.kind) }),
      el("span", { class: "meta muted", text: formatDate(draft.created_at) }),
      el("div", { class: "draft-actions" }, [
        el("button", {
          class: "btn btn-primary", type: "button", text: t("draft_approve"),
          onclick: function () { approveDraft(draft.id); },
        }),
        el("button", {
          class: "btn btn-danger", type: "button", text: t("draft_reject"),
          onclick: function () { rejectDraft(draft.id); },
        }),
      ]),
    ]));

    if (payload.images && payload.images.length > 0) {
      card.appendChild(el("div", { class: "ba-images" }, [
        el("div", { class: "ba-col before" }, [
          el("h5", { text: t("draft_before") }),
          imageStrip(before.image_urls || [], "draft_no_before_image"),
        ]),
        el("div", { class: "ba-col after" }, [
          el("h5", { text: t("draft_after") }),
          imageStrip(payload.images.map(function (img) { return img.url; }), null, payload.images),
        ]),
      ]));
    }

    if (payload.text) {
      card.appendChild(el("div", { class: "before-after" }, [
        el("div", { class: "ba-col before" }, [
          el("h5", { text: t("draft_before") }),
          textDl({
            title: before.name,
            short_description: before.short_description,
            description: before.description,
            meta_title: before.seo_title,
            meta_description: before.seo_description,
          }),
        ]),
        el("div", { class: "ba-col after" }, [
          el("h5", { text: t("draft_after") }),
          textDl(payload.text, {
            title: before.name,
            short_description: before.short_description,
            description: before.description,
            meta_title: before.seo_title,
            meta_description: before.seo_description,
          }),
        ]),
      ]));
    }

    if (draft.error) {
      card.appendChild(el("p", { class: "form-message err", text: draft.error }));
    }
    return card;
  }

  function imageStrip(urls, emptyKey, images) {
    if (!urls || urls.length === 0) {
      return el("p", { class: "placeholder", text: emptyKey ? t(emptyKey) : t("none") });
    }
    var wrap = el("div", { class: "wrap" });
    urls.slice(0, 4).forEach(function (url, i) {
      var alt = images && images[i] && images[i].alt_text ? images[i].alt_text : "";
      wrap.appendChild(el("img", { src: url, alt: alt, loading: "lazy" }));
    });
    return wrap;
  }

  /** Pola tekstowe; gdy podano `baseline`, zaznacza różnice słowo po słowie. */
  function textDl(text, baseline) {
    var dl = el("dl", { class: "ba-text" });
    var fields = [
      ["field_title", text.title, baseline && baseline.title],
      ["field_short_description", text.short_description, baseline && baseline.short_description],
      ["field_description", text.description, baseline && baseline.description],
      ["field_meta_title", text.meta_title, baseline && baseline.meta_title],
      ["field_meta_description", text.meta_description, baseline && baseline.meta_description],
      ["field_alt_text", text.alt_text, null],
    ];
    var any = false;
    fields.forEach(function (f) {
      if (!f[1]) return;
      any = true;
      dl.appendChild(el("dt", { text: t(f[0]) }));
      var value = stripTags(f[1]);
      dl.appendChild(baseline ? el("dd", null, [diffNode(stripTags(f[2] || ""), value)]) : el("dd", { text: value }));
    });
    if (text.faq) {
      any = true;
      dl.appendChild(el("dt", { text: t("field_faq") }));
      var faq = typeof text.faq === "string"
        ? text.faq
        : text.faq.map(function (q) { return q.question + " — " + q.answer; }).join("\n");
      dl.appendChild(el("dd", { text: stripTags(faq) }));
    }
    if (!any) dl.appendChild(el("dd", { class: "placeholder", text: t("none") }));
    return dl;
  }

  /** Usuwa znaczniki z treści sklepu; wynik trafia wyłącznie do textContent. */
  function stripTags(value) {
    return String(value == null ? "" : value).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  }

  /**
   * Różnica słowo po słowie. Buduje węzły przez createElement/textContent,
   * więc żaden fragment treści produktu nie jest interpretowany jako HTML.
   */
  function diffNode(oldText, newText) {
    var frag = document.createDocumentFragment();
    var oldWords = oldText ? oldText.split(/\s+/) : [];
    var newWords = newText ? newText.split(/\s+/) : [];
    var oldSet = {};
    oldWords.forEach(function (w) { oldSet[w.toLowerCase()] = (oldSet[w.toLowerCase()] || 0) + 1; });
    newWords.forEach(function (word, i) {
      var key = word.toLowerCase();
      if (oldSet[key] > 0) {
        oldSet[key] -= 1;
        frag.appendChild(document.createTextNode(word));
      } else {
        frag.appendChild(el("span", { class: "diff-add", text: word, title: t("draft_diff_added") }));
      }
      if (i < newWords.length - 1) frag.appendChild(document.createTextNode(" "));
    });
    return frag;
  }

  function approveDraft(id) {
    api("/drafts/" + encodeURIComponent(id) + "/approve", { method: "POST" }).then(function () {
      toast(t("draft_approved"), "ok");
      loadDrafts();
    }).catch(function (err) {
      toast(t("draft_approve_failed", { error: err.message || t("error_generic") }), "err");
      loadDrafts();
    });
  }

  function rejectDraft(id) {
    api("/drafts/" + encodeURIComponent(id) + "/reject", { method: "POST" }).then(function () {
      toast(t("draft_rejected"), "ok");
      loadDrafts();
    }).catch(function (err) { toast(err.message || t("error_generic"), "err"); });
  }

  function approveAllDrafts() {
    var ids = state.drafts.map(function (d) { return d.id; });
    if (ids.length === 0) return;
    confirmDialog(t("draft_approve_all_confirm_title", { n: ids.length }), t("draft_approve_all_confirm_body")).then(function (ok) {
      if (!ok) return;
      api("/drafts/approve-all", { body: { ids: ids } }).then(function (res) {
        toast(t("draft_approved_n", { n: res.approved }), res.failed ? "warn" : "ok");
        loadDrafts();
        refreshBalance();
      }).catch(function (err) { toast(err.message || t("error_generic"), "err"); });
    });
  }

  /* ------------------------------------------------------------------ */
  /* 7. Ustawienia                                                        */
  /* ------------------------------------------------------------------ */

  function definitionList(pairs) {
    var dl = el("dl");
    pairs.forEach(function (pair) {
      if (!pair) return;
      dl.appendChild(el("dt", { text: t(pair[0]) }));
      // Wartości ze sklepu (nazwa, adres, id połączenia) — textContent.
      dl.appendChild(el("dd", { class: pair[2] || null, text: pair[1] || "—" }));
    });
    return dl;
  }

  function renderSettings(host) {
    var status = state.status || {};

    host.appendChild(panel("settings_connection", [
      definitionList([
        ["settings_store_name", status.store_name],
        ["settings_store_url", status.store_url],
        ["settings_connection_id", status.connection_id, "s-connection-id"],
        ["settings_api_key", status.has_fotohub_key ? t("settings_api_key_set") : t("settings_api_key_missing")],
      ]),
      el("p", { class: "meta muted", text: t("settings_api_key_help") }),
      el("div", { class: "page-actions" }, [
        el("button", {
          class: "btn", type: "button", text: t("settings_validate"),
          onclick: validateKey,
        }),
        status.connected ? null : el("button", {
          class: "btn btn-primary", type: "button", text: t("connect_submit"),
          onclick: showConnect,
        }),
      ]),
    ]));

    host.appendChild(renderDefaultsPanel());

    var healthOut = el("pre", { class: "s-health-result is-hidden" });
    host.appendChild(panel("settings_health", [
      el("p", { class: "meta", text: status.last_health_check
        ? t("settings_last_checked", { time: formatDate(status.last_health_check) })
        : t("settings_never_checked") }),
      el("button", {
        class: "btn", type: "button", text: t("health_check"),
        onclick: function () { runHealthCheck(healthOut); },
      }),
      healthOut,
    ]));

    if (status.connected) {
      host.appendChild(panel("settings_danger", [
        el("p", { class: "muted", text: t("disconnect_confirm_body") }),
        el("button", {
          class: "btn btn-danger s-disconnect", type: "button", text: t("disconnect"),
          onclick: disconnectStore,
        }),
      ]));
    }
  }

  function renderDefaultsPanel() {
    var status = state.status || {};
    var models = status.models || [];

    var model = el("select", null, models.map(function (m) {
      return el("option", { value: m.id, text: m.label, selected: m.id === (status.default_model || state.model) });
    }));
    var language = selectControl(CONTENT_LANGUAGES, status.default_language || "pl",
      function (v) { return tOr("lang_" + v, v); }, null);
    var tone = selectControl(status.tones || ["professional"], status.default_tone || "professional",
      function (v) { return tOr("tone_" + v, v); }, null);
    var autoAlt = el("input", { type: "checkbox", checked: Boolean(status.auto_alt_text) });

    var save = el("button", { class: "btn btn-primary", type: "button", text: t("save") });
    on(save, "click", function () {
      api("/settings", {
        body: {
          default_model: model.value,
          default_language: language.value,
          default_tone: tone.value,
          auto_alt_text: autoAlt.checked,
        },
      }).then(function (res) {
        state.status.default_model = res.default_model;
        state.status.default_language = res.default_language;
        state.status.default_tone = res.default_tone;
        state.status.auto_alt_text = res.auto_alt_text;
        state.model = res.default_model;
        toast(t("settings_saved"), "ok");
      }).catch(function (err) { toast(err.message || t("error_generic"), "err"); });
    });

    return panel("settings_defaults", [
      el("div", { class: "opts-text" }, [
        fieldRow("settings_default_model", model),
        fieldRow("settings_default_language", language),
        fieldRow("settings_default_tone", tone),
        el("label", { class: "field" }, [
          el("span", null, [autoAlt, el("span", { text: t("settings_auto_alt") })]),
          el("small", { text: t("settings_auto_alt_help") }),
        ]),
      ]),
      save,
    ]);
  }

  function validateKey() {
    api("/validate-key", { body: {} }).then(function (res) {
      toast(t("settings_validate_ok", { credits: res.available_credits }), "ok");
    }).catch(function (err) {
      toast(err.message || t("settings_validate_fail"), "err");
    });
  }

  function runHealthCheck(out) {
    out.classList.remove("is-hidden");
    out.textContent = t("loading");
    api("/health").then(function (res) {
      // JSON.stringify + textContent: żadna treść odpowiedzi nie jest HTML-em.
      out.textContent = JSON.stringify(res, null, 2);
      var ok = res.bridge && res.bridge.ok !== false && res.shoper && res.shoper.ok !== false;
      toast(ok ? t("health_ok") : t("health_fail"), ok ? "ok" : "warn");
      if (state.status) state.status.last_health_check = res.checked_at;
    }).catch(function (err) {
      out.textContent = t("health_fail") + ": " + (err.message || "");
      toast(t("health_fail"), "err");
    });
  }

  function disconnectStore() {
    confirmDialog(t("disconnect_confirm_title"), t("disconnect_confirm_body")).then(function (ok) {
      if (!ok) return;
      api("/disconnect", { method: "POST" }).then(function () {
        toast(t("disconnect_done"), "ok");
        state.status = null;
        showConnect();
      }).catch(function (err) { toast(err.message || t("error_generic"), "err"); });
    });
  }

  /* ------------------------------------------------------------------ */
  /* 8. Pomoc MCP                                                         */
  /* ------------------------------------------------------------------ */

  function mcpConfig(url) {
    return JSON.stringify({
      mcpServers: {
        fotohub: {
          url: url,
          headers: { Authorization: "Bearer fh_live_..." },
        },
      },
    }, null, 2);
  }

  function copyBlock(pathKey, text) {
    var pre = el("pre", { text: text });
    var copy = el("button", { class: "btn", type: "button", text: t("copy") });
    on(copy, "click", function () {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () { toast(t("copied"), "ok"); }, function () {});
      }
    });
    return el("div", { class: "wrap" }, [
      el("p", { class: "meta", text: t(pathKey) }),
      pre,
      copy,
    ]);
  }

  function renderMcp(host) {
    var url = (state.status && state.status.mcp_url) || "https://apis.fotohub.app/mcp/";
    var config = mcpConfig(url);

    host.appendChild(panel(null, [
      el("p", { text: t("mcp_intro") }),
      el("ol", null, [
        el("li", { text: t("mcp_step1") }),
        el("li", { text: t("mcp_step2") }),
        el("li", { text: t("mcp_step3") }),
      ]),
      el("p", { class: "form-message" }, [icon("alert"), el("span", { text: t("mcp_security_note") })]),
    ]));

    host.appendChild(el("div", { class: "mcp" }, [
      panel("mcp_claude_title", [copyBlock("mcp_claude_path", config)]),
      panel("mcp_cursor_title", [copyBlock("mcp_cursor_path", config)]),
    ]));

    host.appendChild(panel("mcp_examples_title", [
      el("ul", null, ["mcp_example_1", "mcp_example_2", "mcp_example_3", "mcp_example_4"].map(function (key) {
        return el("li", { text: t(key) });
      })),
      el("p", { class: "meta" }, [
        el("a", { href: "https://docs.fotohub.app/", target: "_blank", rel: "noopener noreferrer", text: t("mcp_docs") }),
      ]),
    ]));
  }

  /* ------------------------------------------------------------------ */
  /* Rejestr widoków                                                      */
  /* ------------------------------------------------------------------ */

  RENDERERS.dashboard = renderDashboard;
  RENDERERS.photos = function (host) { renderWizard(host, "photos"); };
  RENDERERS.descriptions = function (host) { renderWizard(host, "descriptions"); };
  RENDERERS.jobs = renderJobs;
  RENDERERS.drafts = renderDrafts;
  RENDERERS.presets = renderPresets;
  RENDERERS.settings = renderSettings;
  RENDERERS.mcp = renderMcp;

  /* ------------------------------------------------------------------ */
  /* Start                                                                */
  /* ------------------------------------------------------------------ */

  function initialView() {
    var hash = String(location.hash || "").replace(/^#/, "");
    return VIEWS.indexOf(hash) !== -1 ? hash : "dashboard";
  }

  /**
   * Kolejność ma znaczenie: najpierw katalog tłumaczeń (bez niego każdy
   * komunikat byłby surowym kluczem), potem /api/status, który dostarcza token
   * CSRF i decyduje, czy pokazać kreator połączenia.
   */
  function boot() {
    return api("/i18n/" + state.lang).then(function (res) {
      state.strings = (res && res.strings) || {};
      applyTranslations();
      return api("/status");
    }).then(function (status) {
      state.status = status;
      state.csrf = status.csrf_token || null;
      state.defaultPresetSlug = status.default_preset_slug;
      state.model = status.default_model || state.model;
      if (status.default_language) state.options.language = status.default_language;
      if (status.default_tone) state.options.tone = status.default_tone;
      setText("store-name", status.store_name || t("topbar_store_unknown"));

      if (!status.connected) { showConnect(); return; }
      refreshBalance();
      startBalancePolling();
      loadPresets(true);
      showView(initialView());
    }).catch(function (err) {
      console.error("[fotohub] start nie powiódł się", err);
      applyTranslations();
      showConnect();
    });
  }

  function start() {
    bindNavigation();
    bindShortcuts();
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden && state.view === "jobs") pollJob();
    });
    return boot();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }

  // Uchwyt testowy: pozwala sprawdzić, że skrypt wystartował bez wyjątku.
  window.__fotohubShoper = { state: state, showView: showView, t: t, esc: esc, boot: boot };
})();
