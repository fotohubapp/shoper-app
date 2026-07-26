/* FOTOhub AI dla Shoper — vanilla-JS SPA. PL-first, ?lang=en for English. */
(function () {
  "use strict";

  /* ------------------------------------------------------------------ */
  /* State                                                                */
  /* ------------------------------------------------------------------ */

  var state = {
    lang: new URLSearchParams(location.search).get("lang") === "en" ? "en" : "pl",
    strings: {},
    status: null,
    products: [],
    page: 1,
    pages: 1,
    selected: {}, // product_id -> summary
    presets: [],
    defaultPresetSlug: null,
    currentJobId: localStorage.getItem("fh_current_job") || null,
    pollTimer: null,
    lastEstimate: null,
  };

  /* ------------------------------------------------------------------ */
  /* Helpers                                                              */
  /* ------------------------------------------------------------------ */

  function $(id) { return document.getElementById(id); }

  function api(path, options) {
    options = options || {};
    var init = { headers: {} };
    if (options.method) init.method = options.method;
    if (options.body !== undefined) {
      init.method = init.method || "POST";
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(options.body);
    }
    return fetch("/api" + path, init).then(function (res) {
      return res.json().then(function (body) {
        if (!res.ok) {
          var err = new Error(body && body.error ? body.error : "HTTP " + res.status);
          err.status = res.status;
          err.body = body;
          throw err;
        }
        return body;
      });
    });
  }

  function t(key, vars) {
    var s = state.strings[key] || key;
    if (vars) {
      Object.keys(vars).forEach(function (k) {
        s = s.split("{" + k + "}").join(String(vars[k]));
      });
    }
    return s;
  }

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === "class") node.className = attrs[k];
        else if (k === "text") node.textContent = attrs[k];
        else if (k.indexOf("on") === 0) node.addEventListener(k.slice(2), attrs[k]);
        else node.setAttribute(k, attrs[k]);
      });
    }
    (children || []).forEach(function (c) {
      if (c) node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    });
    return node;
  }

  function applyTranslations() {
    document.querySelectorAll("[data-i18n]").forEach(function (node) {
      node.textContent = t(node.getAttribute("data-i18n"));
    });
    document.querySelectorAll("[data-i18n-placeholder]").forEach(function (node) {
      node.setAttribute("placeholder", t(node.getAttribute("data-i18n-placeholder")));
    });
    document.querySelectorAll("[data-i18n-title]").forEach(function (node) {
      node.setAttribute("title", t(node.getAttribute("data-i18n-title")));
    });
    document.documentElement.lang = state.lang;
  }

  function statusBadge(status) {
    var cls = "badge-muted";
    if (status === "completed") cls = "badge-ok";
    else if (status === "failed" || status === "cancelled" || status === "completed_with_errors") cls = "badge-err";
    else if (status === "awaiting_credits") cls = "badge-warn";
    return el("span", { class: "badge " + cls, text: t("status_" + status) === "status_" + status ? status : t("status_" + status) });
  }

  /* ------------------------------------------------------------------ */
  /* Views / tabs                                                         */
  /* ------------------------------------------------------------------ */

  var VIEWS = ["products", "presets", "jobs", "drafts", "mcp", "settings"];

  function showView(name) {
    VIEWS.forEach(function (v) {
      $("view-" + v).classList.toggle("hidden", v !== name);
    });
    $("view-connect").classList.add("hidden");
    document.querySelectorAll(".tab").forEach(function (tab) {
      tab.classList.toggle("active", tab.getAttribute("data-view") === name);
    });
    if (name === "presets") loadPresets();
    if (name === "jobs") loadJobs();
    if (name === "drafts") loadDrafts();
    if (name === "settings") renderSettings();
  }

  function showConnect() {
    VIEWS.forEach(function (v) { $("view-" + v).classList.add("hidden"); });
    $("view-connect").classList.remove("hidden");
  }

  document.querySelectorAll(".tab").forEach(function (tab) {
    tab.addEventListener("click", function () {
      if (!state.status || !state.status.connected) {
        var view = tab.getAttribute("data-view");
        if (view !== "mcp" && view !== "settings") { showConnect(); return; }
      }
      showView(tab.getAttribute("data-view"));
    });
  });

  /* ------------------------------------------------------------------ */
  /* Credits meter (9)                                                    */
  /* ------------------------------------------------------------------ */

  function refreshBalance() {
    return api("/balance").then(function (b) {
      $("credits-value").textContent = String(b.available_credits);
      var meter = $("credits-meter");
      meter.classList.toggle("low", Boolean(b.low_balance));
      meter.title = t("credits_available", { n: b.available_credits });
      var banner = $("low-balance-banner");
      if (b.low_balance) {
        banner.textContent = t("credits_low", { n: b.available_credits });
        banner.classList.remove("hidden");
      } else {
        banner.classList.add("hidden");
      }
      return b;
    }).catch(function () { $("credits-value").textContent = "—"; });
  }

  /* ------------------------------------------------------------------ */
  /* Connection wizard (1)                                                */
  /* ------------------------------------------------------------------ */

  $("c-submit").addEventListener("click", function () {
    var msg = $("c-message");
    msg.className = "form-message";
    msg.textContent = t("loading");
    api("/connect", {
      body: {
        fotohub_api_key: $("c-api-key").value.trim() || undefined,
        shoper_store_url: $("c-store-url").value.trim() || undefined,
        shoper_access_token: $("c-token").value.trim() || undefined,
        shoper_login: $("c-login").value.trim() || undefined,
        shoper_password: $("c-password").value || undefined,
        store_name: $("c-store-name").value.trim() || undefined,
      },
    }).then(function (res) {
      msg.className = "form-message ok";
      msg.textContent = t("connect_success", { credits: res.available_credits });
      return init();
    }).catch(function (err) {
      msg.className = "form-message err";
      msg.textContent = err.message || t("error_generic");
    });
  });

  /* ------------------------------------------------------------------ */
  /* Product picker (2)                                                   */
  /* ------------------------------------------------------------------ */

  function loadCategories() {
    return api("/categories").then(function (res) {
      var select = $("f-category");
      while (select.options.length > 1) select.remove(1);
      res.categories.forEach(function (c) {
        select.appendChild(el("option", { value: String(c.category_id), text: c.name }));
      });
    }).catch(function () { /* picker still usable without categories */ });
  }

  function loadProducts() {
    var params = new URLSearchParams();
    params.set("page", String(state.page));
    var search = $("f-search").value.trim();
    if (search) params.set("search", search);
    var cat = $("f-category").value;
    if (cat) params.set("category_id", cat);
    if ($("f-missing-desc").checked) params.set("missing_description", "1");
    if ($("f-few-images").checked) params.set("max_images", $("f-max-images").value || "2");

    var body = $("products-body");
    body.innerHTML = "";
    body.appendChild(el("tr", null, [el("td", { colspan: "7", text: t("loading") })]));

    return api("/products?" + params.toString()).then(function (res) {
      state.products = res.products;
      state.pages = res.pages || 1;
      $("page-info").textContent = state.page + " / " + state.pages;
      body.innerHTML = "";
      if (res.products.length === 0) {
        body.appendChild(el("tr", null, [el("td", { colspan: "7", text: t("no_products") })]));
        return;
      }
      res.products.forEach(function (p) {
        var checkbox = el("input", { type: "checkbox" });
        checkbox.checked = Boolean(state.selected[p.product_id]);
        checkbox.addEventListener("change", function () {
          if (checkbox.checked) state.selected[p.product_id] = p;
          else delete state.selected[p.product_id];
          updateSelectedCount();
        });
        var thumb = p.thumbnail
          ? el("img", { class: "thumb", src: p.thumbnail, alt: "" })
          : el("span", { class: "thumb-empty", text: "—" });
        var descBadge = p.description_length < 20
          ? el("span", { class: "badge badge-warn", text: t("missing") })
          : el("span", { text: p.description_length + " " + t("chars") });
        body.appendChild(el("tr", null, [
          el("td", null, [checkbox]),
          el("td", null, [thumb]),
          el("td", { text: p.name }),
          el("td", { text: p.sku || "" }),
          el("td", { text: p.price !== undefined && p.price !== null ? p.price.toFixed(2) : "" }),
          el("td", null, [descBadge]),
          el("td", { text: String(p.image_count) }),
        ]));
      });
    }).catch(function (err) {
      body.innerHTML = "";
      body.appendChild(el("tr", null, [el("td", { colspan: "7", text: err.message })]));
    });
  }

  function updateSelectedCount() {
    var n = Object.keys(state.selected).length;
    $("selected-count").textContent = t("selected_count", { n: n });
    invalidateEstimate();
  }

  $("f-apply").addEventListener("click", function () { state.page = 1; loadProducts(); });
  $("f-search").addEventListener("keydown", function (e) {
    if (e.key === "Enter") { state.page = 1; loadProducts(); }
  });
  $("page-prev").addEventListener("click", function () {
    if (state.page > 1) { state.page -= 1; loadProducts(); }
  });
  $("page-next").addEventListener("click", function () {
    if (state.page < state.pages) { state.page += 1; loadProducts(); }
  });
  $("select-all").addEventListener("change", function () {
    var checked = $("select-all").checked;
    state.products.forEach(function (p) {
      if (checked) state.selected[p.product_id] = p;
      else delete state.selected[p.product_id];
    });
    document.querySelectorAll("#products-body input[type=checkbox]").forEach(function (cb) {
      cb.checked = checked;
    });
    updateSelectedCount();
  });

  /* ------------------------------------------------------------------ */
  /* Job composer: kinds, options, models (8)                             */
  /* ------------------------------------------------------------------ */

  var TEXT_KINDS = ["description", "alt_text", "complete_listing"];

  function populateModels() {
    var select = $("o-model");
    select.innerHTML = "";
    (state.status.models || []).forEach(function (m) {
      var opt = el("option", {
        value: m.id,
        text: m.label + " (" + m.creditsPerImage + " cr)",
      });
      if (m.isDefault) opt.selected = true;
      select.appendChild(opt);
    });
  }

  function onKindChange() {
    var kind = $("j-kind").value;
    var isText = TEXT_KINDS.indexOf(kind) !== -1;
    var isComplete = kind === "complete_listing";
    $("opts-text").classList.toggle("hidden", !isText);
    $("opts-image").classList.toggle("hidden", isText && !isComplete);
    $("wrap-background").classList.toggle("hidden", kind !== "bg_replace" && kind !== "image_generate" && kind !== "image_edit");
    $("wrap-recolor").classList.toggle("hidden", kind !== "recolor");
    $("wrap-target").classList.toggle("hidden", kind !== "recolor" && kind !== "bg_remove");
    invalidateEstimate();
  }
  $("j-kind").addEventListener("change", onKindChange);
  $("f-max-images").addEventListener("change", function () {
    $("f-few-images-label").textContent = t("filter_few_images", { n: $("f-max-images").value });
  });

  function collectOptions() {
    var kind = $("j-kind").value;
    var isText = TEXT_KINDS.indexOf(kind) !== -1;
    var options = {};
    if (!isText || kind === "complete_listing") {
      options.num_images = Number($("o-num-images").value);
      options.aspect_ratio = $("o-aspect").value;
      if (!$("wrap-background").classList.contains("hidden") && $("o-background").value.trim()) {
        options.background = $("o-background").value.trim();
      }
      if (kind === "recolor" && $("o-recolor").value.trim()) {
        options.recolor_prompt = $("o-recolor").value.trim();
      }
      if (!$("wrap-target").classList.contains("hidden") && $("o-target").value.trim()) {
        options.target_object = $("o-target").value.trim();
      }
    }
    if (isText) {
      options.language = $("o-language").value;
      options.tone = $("o-tone").value;
      if ($("o-brand-rules").value.trim()) options.brand_rules = $("o-brand-rules").value.trim();
    }
    return options;
  }

  function collectModel() {
    var kind = $("j-kind").value;
    if (TEXT_KINDS.indexOf(kind) !== -1 && kind !== "complete_listing") return undefined;
    return $("o-model").value || undefined;
  }

  /* ------------------------------------------------------------------ */
  /* Estimate (4) + submit (5)                                            */
  /* ------------------------------------------------------------------ */

  function invalidateEstimate() {
    state.lastEstimate = null;
    $("submit-btn").disabled = true;
    $("estimate-text").textContent = "";
    $("estimate-text").classList.remove("insufficient");
  }

  $("estimate-btn").addEventListener("click", function () {
    var ids = Object.keys(state.selected);
    var msg = $("composer-message");
    msg.className = "form-message";
    msg.textContent = "";
    if (ids.length === 0) {
      msg.className = "form-message err";
      msg.textContent = t("selected_count", { n: 0 });
      return;
    }
    var options = collectOptions();
    api("/estimate", {
      body: {
        kind: $("j-kind").value,
        model: collectModel(),
        num_items: ids.length,
        options: options,
      },
    }).then(function (est) {
      state.lastEstimate = est;
      var text = t("estimate_line", {
        items: ids.length,
        images: options.num_images || 1,
        total: est.total_credits,
        available: est.available_credits,
      });
      var node = $("estimate-text");
      node.textContent = text;
      node.classList.toggle("insufficient", !est.sufficient);
      if (est.sufficient) {
        $("submit-btn").disabled = false;
      } else {
        $("submit-btn").disabled = true;
        msg.className = "form-message err";
        msg.textContent = t("estimate_insufficient", {
          required: est.total_credits,
          available: est.available_credits,
        });
      }
    }).catch(function (err) {
      msg.className = "form-message err";
      msg.textContent = err.message || t("error_generic");
    });
  });

  $("submit-btn").addEventListener("click", function () {
    var ids = Object.keys(state.selected).map(Number);
    var msg = $("composer-message");
    if (ids.length === 0 || !state.lastEstimate) return;
    $("submit-btn").disabled = true;
    msg.className = "form-message";
    msg.textContent = t("loading");
    api("/jobs", {
      body: {
        kind: $("j-kind").value,
        product_ids: ids,
        model: collectModel(),
        preset_slug: state.defaultPresetSlug || undefined,
        options: collectOptions(),
        idempotency_key: "shoper-" + Date.now() + "-" + Math.random().toString(36).slice(2, 10),
      },
    }).then(function (job) {
      msg.className = "form-message ok";
      msg.textContent = t("job_submitted", { id: job.job_id });
      state.selected = {};
      updateSelectedCount();
      state.currentJobId = job.job_id;
      localStorage.setItem("fh_current_job", job.job_id);
      refreshBalance();
      showView("jobs");
      openJob(job.job_id);
    }).catch(function (err) {
      msg.className = "form-message err";
      if (err.status === 402 && err.body) {
        msg.textContent = t("estimate_insufficient", {
          required: err.body.required_credits,
          available: err.body.available_credits,
        });
      } else {
        msg.textContent = err.message || t("error_generic");
      }
    });
  });

  /* ------------------------------------------------------------------ */
  /* Presets (3)                                                          */
  /* ------------------------------------------------------------------ */

  function presetName(preset) {
    return state.lang === "pl" && preset.name_pl ? preset.name_pl : preset.name;
  }

  function loadPresets() {
    return api("/presets").then(function (res) {
      state.presets = res.presets;
      state.defaultPresetSlug = res.default_preset_slug;
      renderPresets();
      updateComposerPreset();
    }).catch(function (err) {
      $("presets-groups").textContent = err.message;
    });
  }

  function renderPresets() {
    var container = $("presets-groups");
    container.innerHTML = "";
    var groups = {};
    var order = [];
    state.presets.forEach(function (p) {
      if (!groups[p.category]) { groups[p.category] = []; order.push(p.category); }
      groups[p.category].push(p);
    });
    order.forEach(function (category) {
      var group = el("div", { class: "preset-group" });
      var labelKey = "preset_category_" + category;
      group.appendChild(el("h3", { text: t(labelKey) === labelKey ? category : t(labelKey) }));
      var grid = el("div", { class: "preset-grid" });
      groups[category].forEach(function (p) {
        var isDefault = p.slug === state.defaultPresetSlug;
        var isAllegro = p.slug.indexOf("allegro") !== -1 || category === "channel";
        var card = el("div", {
          class: "preset-card" + (isDefault ? " default" : "") + (category === "bundle" || isAllegro ? " featured" : ""),
        });
        if (p.thumbnail_url) {
          card.appendChild(el("img", { class: "preset-thumb", src: p.thumbnail_url, alt: "" }));
        } else {
          card.appendChild(el("div", { class: "preset-thumb-empty", text: presetName(p).charAt(0).toUpperCase() }));
        }
        var body = el("div", { class: "preset-body" });
        body.appendChild(el("h4", { text: presetName(p) }));
        body.appendChild(el("p", { text: p.description || "" }));
        var btn = el("button", {
          class: "btn",
          text: isDefault ? t("presets_default") : t("presets_set_default"),
          onclick: function () { setDefaultPreset(p.slug); },
        });
        if (isDefault) btn.disabled = true;
        body.appendChild(btn);
        card.appendChild(body);
        grid.appendChild(card);
      });
      group.appendChild(grid);
      container.appendChild(group);
    });
  }

  function setDefaultPreset(slug) {
    api("/presets/default", { body: { slug: slug } }).then(function () {
      state.defaultPresetSlug = slug;
      renderPresets();
      updateComposerPreset();
    });
  }

  function updateComposerPreset() {
    var preset = state.presets.filter(function (p) { return p.slug === state.defaultPresetSlug; })[0];
    $("composer-preset-name").textContent = preset ? presetName(preset) : "—";
  }

  /* ------------------------------------------------------------------ */
  /* Jobs list + progress (6)                                             */
  /* ------------------------------------------------------------------ */

  function loadJobs() {
    return api("/jobs").then(function (res) {
      var list = $("jobs-list");
      list.innerHTML = "";
      if (res.jobs.length === 0) {
        list.appendChild(el("p", { class: "muted", text: "—" }));
      }
      res.jobs.forEach(function (job) {
        var stateInfo = job.state
          ? t("job_progress", { done: job.state.done_items, total: job.state.total_items, failed: job.state.failed_items })
          : "";
        var row = el("div", {
          class: "job-row",
          onclick: function () { openJob(job.job_id); },
        }, [
          el("div", null, [
            el("strong", { text: t("kind_" + job.kind) === "kind_" + job.kind ? job.kind : t("kind_" + job.kind) }),
            el("div", { class: "meta", text: job.job_id + " · " + new Date(job.created_at).toLocaleString() }),
          ]),
          el("div", null, [
            job.state ? statusBadge(job.state.status) : el("span", { class: "badge badge-muted", text: "…" }),
            el("div", { class: "meta", text: stateInfo }),
          ]),
        ]);
        list.appendChild(row);
      });
      if (state.currentJobId) openJob(state.currentJobId);
    });
  }

  function openJob(jobId) {
    state.currentJobId = jobId;
    localStorage.setItem("fh_current_job", jobId);
    $("job-detail").classList.remove("hidden");
    $("job-detail-title").textContent = jobId;
    pollJob();
  }

  function pollJob() {
    if (state.pollTimer) { clearTimeout(state.pollTimer); state.pollTimer = null; }
    var jobId = state.currentJobId;
    if (!jobId) return;

    api("/jobs/" + encodeURIComponent(jobId)).then(function (job) {
      var pct = job.total_items > 0 ? Math.round((job.done_items + job.failed_items) / job.total_items * 100) : 0;
      $("job-progress-bar").firstElementChild.style.width = pct + "%";
      var text = t("job_progress", { done: job.done_items, total: job.total_items, failed: job.failed_items });
      if (job.spent_credits) text += " · " + t("job_credits_spent", { n: job.spent_credits });
      $("job-progress-text").textContent = text;
      $("job-retry").disabled = job.failed_items === 0;
      var terminal = ["completed", "completed_with_errors", "failed", "cancelled"].indexOf(job.status) !== -1;
      $("job-cancel").disabled = terminal;

      return api("/jobs/" + encodeURIComponent(jobId) + "/items?limit=100").then(function (res) {
        var body = $("job-items-body");
        body.innerHTML = "";
        res.items.forEach(function (item) {
          body.appendChild(el("tr", null, [
            el("td", { text: item.external_id }),
            el("td", { text: item.sku || "" }),
            el("td", null, [statusBadge(item.status)]),
            el("td", { text: item.error_message || "" }),
          ]));
        });
        if (!terminal) {
          state.pollTimer = setTimeout(pollJob, 4000);
        } else {
          refreshBalance();
        }
      });
    }).catch(function () {
      state.pollTimer = setTimeout(pollJob, 8000);
    });
  }

  $("job-retry").addEventListener("click", function () {
    if (!state.currentJobId) return;
    api("/jobs/" + encodeURIComponent(state.currentJobId) + "/retry-failed", { method: "POST" })
      .then(pollJob);
  });

  $("job-cancel").addEventListener("click", function () {
    if (!state.currentJobId) return;
    api("/jobs/" + encodeURIComponent(state.currentJobId) + "/cancel", { method: "POST" })
      .then(pollJob);
  });

  $("job-collect").addEventListener("click", function () {
    if (!state.currentJobId) return;
    api("/jobs/" + encodeURIComponent(state.currentJobId) + "/collect-drafts", { method: "POST" })
      .then(function () { showView("drafts"); });
  });

  /* ------------------------------------------------------------------ */
  /* Drafts review (7)                                                    */
  /* ------------------------------------------------------------------ */

  function loadDrafts() {
    return api("/drafts?status=pending").then(function (res) {
      var list = $("drafts-list");
      list.innerHTML = "";
      if (res.drafts.length === 0) {
        list.appendChild(el("p", { class: "muted", text: t("drafts_empty") }));
        return;
      }
      res.drafts.forEach(function (draft) { list.appendChild(renderDraft(draft)); });
    });
  }

  function textDl(text) {
    var dl = el("dl", { class: "ba-text" });
    var fields = [
      ["field_title", text.title],
      ["field_short_description", text.short_description],
      ["field_description", text.description],
      ["field_meta_title", text.meta_title],
      ["field_meta_description", text.meta_description],
      ["field_alt_text", text.alt_text],
    ];
    fields.forEach(function (f) {
      if (!f[1]) return;
      dl.appendChild(el("dt", { text: t(f[0]) }));
      var value = String(f[1]).replace(/<[^>]*>/g, " ");
      dl.appendChild(el("dd", { text: value }));
    });
    if (text.faq) {
      dl.appendChild(el("dt", { text: t("field_faq") }));
      var faq = typeof text.faq === "string" ? text.faq : text.faq.map(function (q) {
        return q.question + " — " + q.answer;
      }).join("\n");
      dl.appendChild(el("dd", { text: faq }));
    }
    return dl;
  }

  function renderDraft(draft) {
    var card = el("div", { class: "draft-card" });
    var head = el("div", { class: "draft-card-head" });
    head.appendChild(el("h4", { text: "#" + draft.product_id + " · " + (t("kind_" + draft.kind) === "kind_" + draft.kind ? draft.kind : t("kind_" + draft.kind)) }));
    head.appendChild(el("span", { class: "meta muted", text: new Date(draft.created_at).toLocaleString() }));
    card.appendChild(head);

    var ba = el("div", { class: "before-after" });

    // Before
    var before = el("div", { class: "ba-col before" });
    before.appendChild(el("h5", { text: t("draft_before") }));
    var b = draft.payload.before || {};
    if (draft.payload.images && draft.payload.images.length > 0) {
      var beforeImages = el("div", { class: "ba-images" });
      (b.image_urls || []).slice(0, 4).forEach(function (url) {
        beforeImages.appendChild(el("img", { src: url, alt: "", loading: "lazy" }));
      });
      if ((b.image_urls || []).length === 0) beforeImages.appendChild(el("span", { class: "muted", text: "—" }));
      before.appendChild(beforeImages);
    }
    if (draft.payload.text) {
      before.appendChild(textDl({
        title: b.name,
        short_description: b.short_description,
        description: b.description,
        meta_title: b.seo_title,
        meta_description: b.seo_description,
      }));
    }
    ba.appendChild(before);

    // After
    var after = el("div", { class: "ba-col after" });
    after.appendChild(el("h5", { text: t("draft_after") }));
    if (draft.payload.images && draft.payload.images.length > 0) {
      var afterImages = el("div", { class: "ba-images" });
      draft.payload.images.forEach(function (img) {
        afterImages.appendChild(el("img", { src: img.url, alt: img.alt_text || "", loading: "lazy" }));
      });
      after.appendChild(afterImages);
    }
    if (draft.payload.text) after.appendChild(textDl(draft.payload.text));
    ba.appendChild(after);
    card.appendChild(ba);

    if (draft.error) {
      card.appendChild(el("p", { class: "form-message err", text: draft.error }));
    }

    var actions = el("div", { class: "draft-actions" });
    actions.appendChild(el("button", {
      class: "btn btn-primary",
      text: t("draft_approve"),
      onclick: function () {
        api("/drafts/" + draft.id + "/approve", { method: "POST" })
          .then(function () { loadDrafts(); })
          .catch(function (err) { alert(err.message); loadDrafts(); });
      },
    }));
    actions.appendChild(el("button", {
      class: "btn btn-danger",
      text: t("draft_reject"),
      onclick: function () {
        api("/drafts/" + draft.id + "/reject", { method: "POST" }).then(function () { loadDrafts(); });
      },
    }));
    card.appendChild(actions);
    return card;
  }

  $("drafts-approve-all").addEventListener("click", function () {
    api("/drafts/approve-all", { body: {} }).then(function () { loadDrafts(); });
  });

  /* ------------------------------------------------------------------ */
  /* Settings + health (11)                                               */
  /* ------------------------------------------------------------------ */

  function renderSettings() {
    if (!state.status) return;
    $("s-store-name").textContent = state.status.store_name || "—";
    $("s-store-url").textContent = state.status.store_url || "";
    $("s-connection-id").textContent = state.status.connection_id || "—";
  }

  $("s-health").addEventListener("click", function () {
    var out = $("s-health-result");
    out.classList.remove("hidden");
    out.textContent = t("loading");
    api("/health").then(function (res) {
      out.textContent = JSON.stringify(res, null, 2);
    }).catch(function (err) {
      out.textContent = t("health_fail") + ": " + err.message;
    });
  });

  $("s-disconnect").addEventListener("click", function () {
    api("/disconnect", { method: "POST" }).then(function () {
      state.status = null;
      showConnect();
    });
  });

  /* ------------------------------------------------------------------ */
  /* Language switch (12)                                                 */
  /* ------------------------------------------------------------------ */

  $("lang-switch").addEventListener("click", function () {
    var next = state.lang === "pl" ? "en" : "pl";
    var url = new URL(location.href);
    url.searchParams.set("lang", next);
    api("/language", { body: { lang: next } }).catch(function () {}).then(function () {
      location.href = url.toString();
    });
  });

  /* ------------------------------------------------------------------ */
  /* Init                                                                 */
  /* ------------------------------------------------------------------ */

  function init() {
    return api("/i18n/" + state.lang).then(function (res) {
      state.strings = res.strings;
      applyTranslations();
      $("f-few-images-label").textContent = t("filter_few_images", { n: $("f-max-images").value });
      return api("/status");
    }).then(function (status) {
      state.status = status;
      state.defaultPresetSlug = status.default_preset_slug;
      if (!status.connected) {
        showConnect();
        return;
      }
      populateModels();
      onKindChange();
      updateSelectedCount();
      refreshBalance();
      loadCategories();
      loadProducts();
      loadPresets();
      showView("products");
      setInterval(refreshBalance, 60000);
    }).catch(function (err) {
      console.error(err);
      showConnect();
    });
  }

  init();
})();
