// ── DOM refs (search tab) ─────────────────────────────────────────────────────
const searchInput    = document.getElementById("search");
const sourceFilter   = document.getElementById("source-filter");
const matchWordToggle= document.getElementById("match-word");
const resultsEl      = document.getElementById("results");
const detailEl       = document.getElementById("detail");
const statusEl       = document.getElementById("status");
const totalCountEl   = document.getElementById("total-count");
const sourceSummaryEl= document.getElementById("source-summary");

let activeId        = null;
let debounceTimer   = null;
let meta            = null;
let cachedCategories= null;

// ── Helpers ───────────────────────────────────────────────────────────────────

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function highlightQuery(text, query) {
  if (!query) return escapeHtml(text);
  const { term, wholeWord } = parseTextQuery(query, getMatchMode());
  let out = escapeHtml(text);
  if (term) {
    const esc = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = wholeWord ? new RegExp(`\\b(${esc})\\b`, "gi") : new RegExp(`(${esc})`, "gi");
    out = out.replace(re, m => `<span class="highlight">${m}</span>`);
  }
  const digits = query.replace(/[^\d]/g, "");
  if (digits.length >= 4) {
    const dotted = digits.replace(/^(\d{4})(\d{2})?(\d{2,4})?.*$/, (_, a, b, c) => {
      let s = a; if (b) s += "." + b; if (c) s += "." + c; return s;
    });
    if (dotted && dotted.length >= 4) {
      const re = new RegExp(dotted.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
      out = out.replace(re, m => `<span class="highlight">${m}</span>`);
    }
  }
  return out;
}

function getMatchMode() { return matchWordToggle?.checked ? "word" : "substr"; }

function parseTextQuery(query, forceMode) {
  let q = query.trim();
  const wholeWord = forceMode === "word" || (forceMode !== "substr" && matchWordToggle?.checked);
  if (!q) return { term: "", wholeWord: true };
  if (q.length >= 2 && q[0] === q[q.length - 1] && (q[0] === '"' || q[0] === "'"))
    return { term: q.slice(1, -1).trim().toLowerCase(), wholeWord: true };
  if (!wholeWord && q.startsWith("*")) q = q.slice(1).trim();
  const digits = q.replace(/[^\d]/g, "").length;
  if (digits >= Math.max(2, Math.floor(q.length / 2)))
    return { term: q.toLowerCase(), wholeWord: false };
  return { term: q.toLowerCase(), wholeWord };
}

function productMatches(searchText, query) {
  const { term, wholeWord } = parseTextQuery(query, getMatchMode());
  if (!term) return false;
  const text = (searchText || "").toLowerCase();
  return wholeWord
    ? new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(text)
    : text.includes(term);
}

function codesMatch(recordCodes, query) {
  const q = query.trim();
  if (!q) return true;
  const qDigits = q.replace(/[^\d]/g, "");
  return recordCodes.some(code => {
    const cDigits = code.replace(/[^\d]/g, "");
    if (code.includes(q) || code.startsWith(q)) return true;
    if (qDigits && (cDigits.startsWith(qDigits) || cDigits.includes(qDigits))) return true;
    return false;
  });
}

function renderCodeTags(codes, query, limit, enrichment) {
  const q = (query || "").trim();
  const hit = code => codesMatch([code], q);
  const shown = limit ? codes.slice(0, limit) : codes;
  const tags = shown.map(c => {
    const desc = enrichment?.[c]?.description;
    const title = desc ? ` title="${escapeHtml(desc)}"` : "";
    return `<span class="code-tag${hit(c) ? " hit" : ""}"${title}>${escapeHtml(c)}</span>`;
  }).join("");
  const more = limit && codes.length > limit
    ? `<span class="code-tag more">+${codes.length - limit} more</span>` : "";
  return tags + more;
}

function renderEnrichmentPanel(codes, enrichment, query) {
  if (!enrichment || !codes.length) return "";
  const q = (query || "").trim();
  return codes.map(c => {
    const e = enrichment[c];
    if (!e) {
      const isHit = codesMatch([c], q);
      return `<div class="enrich-row enrich-row-plain"><span class="code-tag${isHit ? " hit" : ""}">${escapeHtml(c)}</span></div>`;
    }
    const isHit = codesMatch([c], q);
    const rate   = e.general_rate ? `<span class="enrich-rate" title="US duty rate">${escapeHtml(e.general_rate)}</span>` : "";
    const caUst  = e.ca_ust  ? `<span class="enrich-ca-ust" title="Canada CUSMA/UST rate">CA UST: ${escapeHtml(e.ca_ust)}</span>` : "";
    const caMfn  = e.ca_mfn  ? `<span class="enrich-ca-mfn" title="Canada MFN rate">CA MFN: ${escapeHtml(e.ca_mfn)}</span>` : "";
    const signal = e.agreement > 0
      ? `<span class="enrich-signal">${e.agreement} record${e.agreement === 1 ? "" : "s"}</span>` : "";
    const link   = `<a class="enrich-link" href="${escapeHtml(e.usitc_url)}" target="_blank" rel="noopener">↗ Verify on USITC</a>`;
    const hier   = (e.hierarchy || []).map(h =>
      `<span class="enrich-level"><span class="enrich-level-code">${escapeHtml(h.code)}</span><span class="enrich-level-desc">${escapeHtml(h.description)}</span></span>`
    ).join(`<span class="enrich-sep">›</span>`);
    return `
      <div class="enrich-row">
        <div class="enrich-header">
          <span class="code-tag${isHit ? " hit" : ""}">${escapeHtml(c)}</span>
          ${rate}${caUst}${caMfn}${signal}${link}
        </div>
        ${e.description ? `<div class="enrich-desc">${escapeHtml(e.description)}</div>` : ""}
        ${hier ? `<div class="enrich-hierarchy">${hier}</div>` : ""}
      </div>`;
  }).join("");
}

const REVIEW_LABELS = { missing: "No Code", review: "Review", confirmed: "CUSMA OK", unconfirmed: "Unconfirmed" };

function reviewBadgeHtml(status) {
  const label = REVIEW_LABELS[status] || status;
  return `<span class="review-badge review-${escapeHtml(status)}">${escapeHtml(label)}</span>`;
}

// ── CBP CROSS ─────────────────────────────────────────────────────────────────

async function fetchCrossRulings(q) {
  try {
    const res = await fetch(`/api/cross-search?q=${encodeURIComponent(q)}`);
    if (!res.ok) return { rulings: [], error: "Request failed" };
    return await res.json();
  } catch (e) { return { rulings: [], error: String(e) }; }
}

function renderCrossResults(rulings, term, error) {
  if (error) return `<p class="prod-notes muted">Error: ${escapeHtml(error)}</p>`;
  if (!rulings.length) return `<p class="prod-notes muted">No CBP rulings found for "${escapeHtml(term)}".</p>`;
  return rulings.map(r => {
    const date  = (r.rulingDate || "").slice(0, 10);
    const codes = (r.tariffs || []).join(", ");
    const url   = `https://rulings.cbp.gov/ruling/${encodeURIComponent(r.rulingNumber)}`;
    const badge = r.collection === "hq"
      ? `<span class="cross-hq">HQ</span>` : `<span class="cross-ny">NY</span>`;
    return `<div class="cross-row">
      <div class="cross-header">
        ${badge}
        <span class="cross-num">${escapeHtml(r.rulingNumber)}</span>
        <span class="cross-date">${escapeHtml(date)}</span>
        ${codes ? `<span class="cross-codes">${escapeHtml(codes)}</span>` : ""}
        <a class="enrich-link" href="${escapeHtml(url)}" target="_blank" rel="noopener">↗ Full ruling</a>
      </div>
      <div class="cross-subject">${escapeHtml(r.subject || "")}</div>
    </div>`;
  }).join("");
}

function crossPanelHtml(defaultQuery) {
  return `
    <section class="codes-panel">
      <h3>CBP Binding Rulings</h3>
      <div class="cross-search-row">
        <input class="cross-input" id="cross-input" placeholder="Code or product description…" value="${escapeHtml(defaultQuery || "")}">
        <button class="cross-btn" id="cross-btn">Search</button>
      </div>
      <div class="cross-results" id="cross-results">
        <p class="prod-notes muted">Search CBP CROSS for authoritative binding rulings.</p>
      </div>
    </section>`;
}

function initCrossPanel() {
  const input   = document.getElementById("cross-input");
  const btn     = document.getElementById("cross-btn");
  const results = document.getElementById("cross-results");
  if (!input || !btn || !results) return;
  const doSearch = async () => {
    const q = input.value.trim();
    if (!q) return;
    results.innerHTML = `<p class="prod-notes muted">Searching…</p>`;
    btn.disabled = true;
    const data = await fetchCrossRulings(q);
    btn.disabled = false;
    results.innerHTML = renderCrossResults(data.rulings || [], q, data.error || "");
  };
  btn.addEventListener("click", doSearch);
  input.addEventListener("keydown", e => { if (e.key === "Enter") doSearch(); });
}

// ── Tab switching ─────────────────────────────────────────────────────────────

let currentTab       = "search";
let categoriesLoaded = false;
let productsLoaded   = false;

function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll(".tab-btn").forEach(b =>
    b.classList.toggle("active", b.dataset.tab === tab));
  ["search", "categories", "products"].forEach(t => {
    const el = document.getElementById("view-" + t);
    if (el) el.style.display = t === tab ? "" : "none";
  });
  if (tab === "categories" && !categoriesLoaded) loadCategories();
  if (tab === "products"   && !productsLoaded)   loadProducts();
}

document.querySelectorAll(".tab-btn").forEach(b =>
  b.addEventListener("click", () => switchTab(b.dataset.tab)));

// ── Search tab ────────────────────────────────────────────────────────────────

function renderResults(records, query) {
  resultsEl.innerHTML = "";
  if (!records.length) {
    resultsEl.innerHTML = `<li class="empty">No records match "${escapeHtml(query)}"</li>`;
    return;
  }
  const q = query.trim();
  for (const r of records) {
    const li = document.createElement("li");
    li.className = "result-item" + (r.id === activeId ? " active" : "");
    li.dataset.id = r.id;
    const isProduct     = r.source === "products";
    const codesForSearch= r.codes_all || r.codes || [];
    const primary       = r.codes || [];
    const nameHit       = r.match_text || productMatches(r.search_text || r.product, q);
    const productHtml   = nameHit
      ? highlightQuery(r.product || "(no title)", q)
      : escapeHtml(r.product || "(no title)");
    const metaLine = isProduct
      ? `<div class="codes-meta">${[r.substrate, r.category].filter(Boolean).join(" · ") || "&nbsp;"}</div>`
      : `<div class="codes-meta">${primary.length} primary · ${r.code_count ?? codesForSearch.length} total codes</div>`;
    li.innerHTML = `
      <div class="id">
        <span class="source-badge">${escapeHtml(r.source_label || r.source)}</span>
        ${isProduct ? reviewBadgeHtml(r.review_status) : `#${r.id}`}
        ${nameHit && !/^\d/.test(q) ? " · text match" : ""}
      </div>
      <div class="product${nameHit ? " name-hit" : ""}">${productHtml}</div>
      ${metaLine}
      <div class="codes">${renderCodeTags(primary, q, 8)}</div>
      ${r.top_desc ? `<div class="top-desc">${escapeHtml(r.top_desc.slice(0, 110))}</div>` : ""}
    `;
    li.addEventListener("click", () => selectRecord(r.id, q));
    resultsEl.appendChild(li);
  }
}

async function selectRecord(id, query) {
  activeId = id;
  document.querySelectorAll(".result-item").forEach(el =>
    el.classList.toggle("active", Number(el.dataset.id) === id));
  detailEl.innerHTML = `<p class="empty">Loading record #${id}…</p>`;
  const res = await fetch(`/api/record/${id}?q=${encodeURIComponent(query || "")}`);
  if (!res.ok) { detailEl.innerHTML = `<p class="empty">Failed to load record.</p>`; return; }
  const data = await res.json();
  renderDetail(data, query);
}

function searchForCode(code) {
  searchInput.value = code;
  sourceFilter.value = "";
  activeId = null;
  switchTab("search");
  runSearch();
}

function renderProductDetail(data, query) {
  const enrichment = data.enrichment || {};
  const codes  = data.codes || [];
  const status = data.review_status || "missing";
  const approved = data.approved;

  const fields = [
    data.product_code ? ["Product Code", data.product_code] : null,
    data.substrate    ? ["Substrate",     data.substrate]    : null,
    data.category     ? ["Category",      data.category]     : null,
  ].filter(Boolean);

  const fieldsHtml = fields.map(([k, v]) =>
    `<div class="prod-field"><span class="prod-field-label">${escapeHtml(k)}</span><span class="prod-field-value">${escapeHtml(v)}</span></div>`
  ).join("");

  const codeSection = codes.length
    ? `<section class="codes-panel">
        <h3>Suggested HTS Code</h3>
        ${Object.keys(enrichment).length
          ? `<div class="enrich-list">${renderEnrichmentPanel(codes, enrichment, query)}</div>`
          : `<div class="codes">${renderCodeTags(codes, query)}</div>`}
      </section>`
    : `<section class="codes-panel">
        <h3>Suggested HTS Code</h3>
        <p class="prod-notes muted">No code assigned yet.</p>
      </section>`;

  const approvedBanner = approved ? `
    <div class="approve-current">
      <span class="enrich-signal">✓ Approved</span>
      <span class="code-tag hit">${escapeHtml(approved.code)}</span>
      ${approved.note ? `<span class="prod-notes muted">${escapeHtml(approved.note)}</span>` : ""}
      <span class="prod-notes muted" style="font-size:0.66rem;margin-left:auto">${(approved.ts || "").slice(0, 10)}</span>
    </div>` : "";

  const notesHtml = data.review_notes
    ? `<section class="codes-panel"><h3>Review Notes</h3><p class="prod-notes">${escapeHtml(data.review_notes)}</p></section>` : "";

  const searchBtn = codes.length
    ? `<div class="prod-actions"><button class="search-link-btn" onclick="searchForCode('${escapeHtml(codes[0])}')">Search training data for ${escapeHtml(codes[0])}</button></div>` : "";

  detailEl.innerHTML = `
    <p class="source-line">
      <span class="source-badge">${escapeHtml(data.source_label || data.source)}</span>
      <span class="review-badge review-${escapeHtml(approved ? "confirmed" : status)}">${escapeHtml(approved ? "Approved" : (REVIEW_LABELS[status] || status))}</span>
    </p>
    <h2 class="detail-title">${highlightQuery(data.product || "Product", query)}</h2>
    ${fields.length ? `<div class="prod-fields">${fieldsHtml}</div>` : ""}
    ${codeSection}
    ${notesHtml}
    ${approvedBanner}
    ${searchBtn}
    <section class="codes-panel">
      <h3>Browse CUSMA Codes</h3>
      <div class="hts-tree" id="search-hts-tree"></div>
    </section>
    ${crossPanelHtml(codes[0] || data.product || "")}
  `;
  // Tree in search tab — clicking a code searches training data for it
  attachHtsTree(document.getElementById("search-hts-tree"), code => searchForCode(code));
  initCrossPanel();
}

function renderDetail(data, query) {
  if (data.source === "products") { renderProductDetail(data, query); return; }
  const enrichment = data.enrichment || {};
  const parts = data.messages.map(m => {
    const body = m.content
      ? `<div class="message-body${m.role === "system" ? " collapsed" : ""}">${highlightQuery(m.content, query)}</div>` : "";
    const tools = m.tool_calls?.length
      ? `<ul class="tool-calls">${m.tool_calls.map(tc => {
          const name   = tc.function?.name || "tool";
          const args   = tc.function?.arguments;
          const argStr = typeof args === "string" ? args.slice(0, 200) : JSON.stringify(args || {}).slice(0, 200);
          return `<li><strong>${escapeHtml(name)}</strong>(${escapeHtml(argStr)}${argStr.length >= 200 ? "…" : ""})</li>`;
        }).join("")}</ul>` : "";
    return `<article class="message role-${m.role}">
      <div class="message-header">${escapeHtml(m.role)}${m.tool_calls?.length ? " · tool call" : ""}</div>
      ${body}${tools}
    </article>`;
  });
  const allCodes    = data.codes_all || data.codes || [];
  const primaryCode = (data.codes || [])[0] || "";
  detailEl.innerHTML = `
    <p class="source-line"><span class="source-badge">${escapeHtml(data.source_label || data.source)}</span></p>
    <h2 class="detail-title">${highlightQuery(data.product || `Record #${data.id}`, query)}</h2>
    <p class="detail-meta">${data.messages.length} messages</p>
    <section class="codes-panel">
      <h3>Primary HTS codes (${(data.codes || []).length})</h3>
      ${Object.keys(enrichment).length
        ? `<div class="enrich-list">${renderEnrichmentPanel(data.codes || [], enrichment, query)}</div>`
        : `<div class="codes codes-scroll">${renderCodeTags(data.codes || [], query, null)}</div>`}
    </section>
    <section class="codes-panel">
      <h3>All HTS codes in record (${allCodes.length})</h3>
      <div class="codes codes-scroll">${renderCodeTags(allCodes, query, null, enrichment)}</div>
    </section>
    ${crossPanelHtml(primaryCode)}
    <section class="messages-panel">
      <h3>Conversation</h3>
      ${parts.join("")}
    </section>
  `;
  initCrossPanel();
}

function searchUrl() {
  const q      = searchInput.value.trim();
  const source = sourceFilter.value;
  const params = new URLSearchParams();
  if (q)      params.set("q", q);
  if (source) params.set("source", source);
  params.set("mode", getMatchMode());
  const qs = params.toString();
  return `/api/search${qs ? `?${qs}` : ""}`;
}

async function runSearch() {
  const q   = searchInput.value.trim();
  const res = await fetch(searchUrl());
  const data= await res.json();
  const scope = data.source ? ` in ${data.source}` : "";
  statusEl.textContent = q
    ? `${data.count} of ${data.total} records${scope}`
    : `Showing ${data.count} records${scope}`;
  renderResults(data.results, q);
  if (data.results.length && activeId === null) {
    selectRecord(data.results[0].id, q);
  } else if (data.results.length && !data.results.some(r => r.id === activeId)) {
    selectRecord(data.results[0].id, q);
  } else if (!data.results.length) {
    activeId = null;
    detailEl.innerHTML = `<p class="empty">No matching records.</p>`;
  }
}

searchInput.addEventListener("input", () => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(runSearch, 180);
});
sourceFilter.addEventListener("change", () => { activeId = null; runSearch(); });
matchWordToggle.addEventListener("change", () => { activeId = null; runSearch(); });

// ── Categories tab ────────────────────────────────────────────────────────────

let activeCategoryCode = null;

async function getCategories() {
  if (cachedCategories) return cachedCategories;
  const res  = await fetch("/api/categories");
  const data = await res.json();
  cachedCategories = data.categories || [];
  return cachedCategories;
}

async function loadCategories() {
  const catDetail = document.getElementById("cat-detail");
  catDetail.innerHTML = `<p class="empty">Loading categories…</p>`;
  const categories = await getCategories();
  categoriesLoaded = true;
  const countEl = document.getElementById("cat-count");
  if (countEl) countEl.textContent = `(${categories.length})`;
  renderCategoryList(categories);
  catDetail.innerHTML = `<p class="empty">Select a category to see HTS enrichment, training records, and CBP rulings.</p>`;
}

function renderCategoryList(categories) {
  const listEl = document.getElementById("cat-list");
  if (!listEl) return;
  listEl.innerHTML = "";
  if (!categories.length) {
    listEl.innerHTML = `<li class="empty">No categories found.</li>`; return;
  }
  for (const cat of categories) {
    const li = document.createElement("li");
    li.className = "result-item" + (cat.code === activeCategoryCode ? " active" : "");
    li.dataset.code = cat.code;
    const e    = cat.enrichment || {};
    const rate = e.general_rate ? `US: ${escapeHtml(e.general_rate)}` : "";
    const caUst= e.ca_ust  ? `CA UST: ${escapeHtml(e.ca_ust)}` : "";
    const rates= [rate, caUst].filter(Boolean).join(" · ");
    const prodBadge = cat.product_count > 0
      ? `<span class="enrich-signal">${cat.product_count} product${cat.product_count === 1 ? "" : "s"}</span>` : "";
    li.innerHTML = `
      <div class="id">
        <span class="code-tag">${escapeHtml(cat.code)}</span>
        ${prodBadge}
      </div>
      <div class="product">${escapeHtml(cat.description)}</div>
      ${rates ? `<div class="codes-meta">${rates}</div>` : ""}
    `;
    li.addEventListener("click", () => selectCategory(cat));
    listEl.appendChild(li);
  }
}

async function selectCategory(cat) {
  activeCategoryCode = cat.code;
  document.querySelectorAll("#cat-list .result-item").forEach(el =>
    el.classList.toggle("active", el.dataset.code === cat.code));
  const catDetail = document.getElementById("cat-detail");
  catDetail.innerHTML = `<p class="empty">Loading…</p>`;

  const [searchRes, prodsRes] = await Promise.all([
    fetch(`/api/search?q=${encodeURIComponent(cat.code)}&mode=auto`),
    fetch(`/api/products?code=${encodeURIComponent(cat.code)}`),
  ]);
  const searchData = await searchRes.json();
  const prodsData  = await prodsRes.json();
  renderCategoryDetail(cat, searchData.results || [], prodsData.products || []);
}

function renderCategoryDetail(cat, trainingMatches, products) {
  const catDetail = document.getElementById("cat-detail");
  const e = cat.enrichment || {};

  const rate  = e.general_rate ? `<span class="enrich-rate" title="US duty rate">${escapeHtml(e.general_rate)}</span>` : "";
  const caUst = e.ca_ust  ? `<span class="enrich-ca-ust" title="CUSMA/UST">CA UST: ${escapeHtml(e.ca_ust)}</span>` : "";
  const caMfn = e.ca_mfn  ? `<span class="enrich-ca-mfn" title="MFN">CA MFN: ${escapeHtml(e.ca_mfn)}</span>` : "";
  const hier  = (e.hierarchy || []).map(h =>
    `<span class="enrich-level"><span class="enrich-level-code">${escapeHtml(h.code)}</span><span class="enrich-level-desc">${escapeHtml(h.description)}</span></span>`
  ).join(`<span class="enrich-sep">›</span>`);

  const matchRows = trainingMatches.slice(0, 15).map(r => `
    <li class="result-item cat-match-row" data-id="${r.id}">
      <div class="id"><span class="source-badge">${escapeHtml(r.source_label || r.source)}</span> #${r.id}</div>
      <div class="product">${escapeHtml((r.product || "(no title)").slice(0, 120))}</div>
      <div class="codes">${renderCodeTags(r.codes || [], cat.code, 5)}</div>
      ${r.top_desc ? `<div class="top-desc">${escapeHtml(r.top_desc.slice(0, 110))}</div>` : ""}
    </li>`).join("");

  const prodRows = products.slice(0, 20).map(p => {
    const approved     = p.approved;
    const displayCode  = approved ? approved.code : (p.codes || [])[0] || "";
    return `<li class="result-item cat-prod-row" data-id="${p.id}">
      <div class="id">
        ${reviewBadgeHtml(approved ? "confirmed" : (p.review_status || "missing"))}
        ${approved ? `<span class="enrich-signal">✓ Approved</span>` : ""}
      </div>
      <div class="product">${escapeHtml(p.product || "(no name)")}</div>
      ${displayCode ? `<div class="codes"><span class="code-tag${approved ? " hit" : ""}">${escapeHtml(displayCode)}</span></div>` : ""}
    </li>`;
  }).join("");

  catDetail.innerHTML = `
    <p class="source-line"><span class="source-badge">CUSMA</span></p>
    <h2 class="detail-title">${escapeHtml(cat.description)}</h2>
    <section class="codes-panel">
      <h3>HTS Code</h3>
      <div class="enrich-list">
        <div class="enrich-row">
          <div class="enrich-header">
            <span class="code-tag">${escapeHtml(cat.code)}</span>
            ${rate}${caUst}${caMfn}
            ${e.usitc_url ? `<a class="enrich-link" href="${escapeHtml(e.usitc_url)}" target="_blank" rel="noopener">↗ Verify on USITC</a>` : ""}
          </div>
          ${e.description ? `<div class="enrich-desc">${escapeHtml(e.description)}</div>` : ""}
          ${hier ? `<div class="enrich-hierarchy">${hier}</div>` : ""}
        </div>
      </div>
    </section>
    ${products.length ? `
      <section class="codes-panel">
        <h3>Your products (${products.length})</h3>
        <ul style="list-style:none;margin:0;padding:0">${prodRows}</ul>
        ${products.length > 20 ? `<p class="codes-meta">Showing 20 of ${products.length}</p>` : ""}
      </section>` : ""}
    ${trainingMatches.length ? `
      <section class="codes-panel">
        <h3>Training records (${trainingMatches.length})</h3>
        <ul style="list-style:none;margin:0;padding:0">${matchRows}</ul>
        ${trainingMatches.length > 15 ? `
          <p class="codes-meta">Showing 15 of ${trainingMatches.length} —
            <button class="search-link-btn" style="font-size:0.73rem;padding:0.22rem 0.6rem"
              onclick="searchForCode(${JSON.stringify(cat.code)})">See all in Search</button>
          </p>` : ""}
      </section>` : `
      <section class="codes-panel">
        <p class="prod-notes muted">No training records match this code.</p>
      </section>`}
    ${crossPanelHtml(cat.code)}
  `;

  catDetail.querySelectorAll(".cat-match-row").forEach(row => {
    row.addEventListener("click", () => {
      const id = Number(row.dataset.id);
      switchTab("search");
      activeId = null;
      searchInput.value = cat.code;
      sourceFilter.value = "";
      runSearch().then(() => selectRecord(id, cat.code));
    });
  });

  catDetail.querySelectorAll(".cat-prod-row").forEach(row => {
    row.addEventListener("click", async () => {
      const id = Number(row.dataset.id);
      switchTab("products");
      if (!productsLoaded) await loadProducts();
      const p = allProducts.find(x => x.id === id);
      if (p) selectProductApproval(p);
    });
  });

  initCrossPanel();
}

// ── HTS code tree ────────────────────────────────────────────────────────────

function buildHtsTree(categories) {
  const chapterMap = {};
  for (const cat of categories) {
    const hier     = (cat.enrichment || {}).hierarchy || [];
    const chapter  = hier.find(h => h.level === "chapter");
    const heading  = hier.find(h => h.level === "heading");
    const digits   = cat.code.replace(/[^\d]/g, "");
    // Fall back to deriving chapter/heading from code digits when not in HTS_DB
    const chCode   = chapter ? chapter.code : digits.slice(0, 2) || "??";
    const chDesc   = chapter ? chapter.description : "";
    const hdCode   = heading ? heading.code : (digits.length >= 4 ? digits.slice(0, 4) : chCode);
    const hdDesc   = heading ? heading.description : "";
    if (!chapterMap[chCode]) chapterMap[chCode] = { code: chCode, description: chDesc, headings: {} };
    if (!chapterMap[chCode].headings[hdCode])
      chapterMap[chCode].headings[hdCode] = { code: hdCode, description: hdDesc, leaves: [] };
    chapterMap[chCode].headings[hdCode].leaves.push({
      code:         cat.code,
      description:  cat.description,
      general_rate: (cat.enrichment || {}).general_rate || "",
      ca_ust:       (cat.enrichment || {}).ca_ust || "",
    });
  }
  return Object.values(chapterMap)
    .sort((a, b) => a.code.localeCompare(b.code))
    .map(ch => ({ ...ch, headings: Object.values(ch.headings).sort((a, b) => a.code.localeCompare(b.code)) }));
}

function htsTreeHtml(tree) {
  return tree.map(chapter => {
    const headingsHtml = chapter.headings.map(heading => {
      const leavesHtml = heading.leaves.map(leaf => `
        <li class="hts-leaf" data-code="${escapeHtml(leaf.code)}">
          <span class="code-tag">${escapeHtml(leaf.code)}</span>
          <span class="hts-leaf-name">${escapeHtml(leaf.description)}</span>
          ${leaf.general_rate ? `<span class="enrich-rate">${escapeHtml(leaf.general_rate)}</span>` : ""}
          ${leaf.ca_ust ? `<span class="enrich-ca-ust">CA UST: ${escapeHtml(leaf.ca_ust)}</span>` : ""}
          <button class="hts-select-btn">↳ Use</button>
        </li>`).join("");
      // skip heading level if it's the same code as chapter
      if (heading.code === chapter.code) return `<ul class="hts-leaves">${leavesHtml}</ul>`;
      return `
        <details class="hts-hd">
          <summary class="hts-hd-summary">
            <span class="hts-node-code">${escapeHtml(heading.code)}</span>
            <span class="hts-node-desc">${escapeHtml(heading.description)}</span>
          </summary>
          <ul class="hts-leaves">${leavesHtml}</ul>
        </details>`;
    }).join("");
    return `
      <details class="hts-ch">
        <summary class="hts-ch-summary">
          <span class="hts-ch-num">Ch. ${escapeHtml(chapter.code)}</span>
          <span class="hts-ch-desc">${escapeHtml(chapter.description)}</span>
        </summary>
        <div class="hts-ch-body">${headingsHtml}</div>
      </details>`;
  }).join("");
}

async function attachHtsTree(containerEl, onSelect) {
  containerEl.innerHTML = `<p class="prod-notes muted" style="padding:0.35rem 0">Loading…</p>`;
  const categories = await getCategories();
  if (!categories.length) {
    containerEl.innerHTML = `<p class="prod-notes muted">No CUSMA codes available.</p>`;
    return;
  }
  const tree = buildHtsTree(categories);
  containerEl.innerHTML = htsTreeHtml(tree);
  containerEl.querySelectorAll(".hts-select-btn").forEach(btn => {
    btn.addEventListener("click", e => {
      e.stopPropagation();
      onSelect(btn.closest(".hts-leaf").dataset.code);
    });
  });
}

// ── Products tab ──────────────────────────────────────────────────────────────

let activeProductId = null;
let allProducts     = [];
let prodDebounce    = null;

async function loadProducts(q = "", status = "", code = "") {
  const params = new URLSearchParams();
  if (q)      params.set("q", q);
  if (status) params.set("status", status);
  if (code)   params.set("code", code);
  const qs  = params.toString();
  const res = await fetch(`/api/products${qs ? "?" + qs : ""}`);
  const data= await res.json();
  allProducts     = data.products || [];
  productsLoaded  = true;
  renderProductList(allProducts);
  const countEl = document.getElementById("prod-count");
  if (countEl) countEl.textContent = `(${allProducts.length})`;
  const statusEl2 = document.getElementById("prod-status");
  if (statusEl2) statusEl2.textContent = allProducts.length === data.total
    ? `${data.total} products` : `${allProducts.length} of ${data.total}`;
}

function renderProductList(products) {
  const listEl = document.getElementById("prod-list");
  if (!listEl) return;
  listEl.innerHTML = "";
  if (!products.length) {
    listEl.innerHTML = `<li class="empty">No products found.</li>`; return;
  }
  for (const p of products) {
    const li = document.createElement("li");
    li.className = "result-item" + (p.id === activeProductId ? " active" : "");
    li.dataset.id = p.id;
    const approved    = p.approved;
    const displayCode = approved ? approved.code : (p.codes || [])[0] || "";
    li.innerHTML = `
      <div class="id">
        <span class="source-badge">Product</span>
        ${reviewBadgeHtml(approved ? "confirmed" : (p.review_status || "missing"))}
        ${approved ? `<span class="enrich-signal">✓</span>` : ""}
      </div>
      <div class="product">${escapeHtml(p.product || "(no name)")}</div>
      <div class="codes-meta">${[p.substrate, p.category].filter(Boolean).join(" · ") || "&nbsp;"}</div>
      ${displayCode ? `<div class="codes"><span class="code-tag${approved ? " hit" : ""}">${escapeHtml(displayCode)}</span></div>` : ""}
      ${p.top_desc ? `<div class="top-desc">${escapeHtml(p.top_desc.slice(0, 110))}</div>` : ""}
    `;
    li.addEventListener("click", () => selectProductApproval(p));
    listEl.appendChild(li);
  }
}

async function selectProductApproval(p) {
  activeProductId = p.id;
  document.querySelectorAll("#prod-list .result-item").forEach(el =>
    el.classList.toggle("active", Number(el.dataset.id) === p.id));
  const prodDetail = document.getElementById("prod-detail");
  prodDetail.innerHTML = `<p class="empty">Loading…</p>`;
  const res = await fetch(`/api/record/${p.id}`);
  if (!res.ok) { prodDetail.innerHTML = `<p class="empty">Failed to load.</p>`; return; }
  const data = await res.json();
  // Merge latest approval from the record response
  if (data.approved) p.approved = data.approved;
  renderApprovalDetail(data, p);
}

async function saveApproval(productId, code, note) {
  const res = await fetch("/api/approve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: productId, code, note }),
  });
  return await res.json();
}

function renderApprovalDetail(data, p) {
  const prodDetail = document.getElementById("prod-detail");
  const enrichment = data.enrichment || {};
  const codes      = data.codes || [];
  const approved   = p.approved;
  const currentCode= approved ? approved.code : (codes[0] || "");

  const fields = [
    p.product_code ? ["Product Code", p.product_code] : null,
    p.substrate    ? ["Substrate",     p.substrate]    : null,
    p.category     ? ["Category",      p.category]     : null,
  ].filter(Boolean);

  const fieldsHtml = fields.map(([k, v]) =>
    `<div class="prod-field">
      <span class="prod-field-label">${escapeHtml(k)}</span>
      <span class="prod-field-value">${escapeHtml(v)}</span>
    </div>`
  ).join("");

  const codeSection = codes.length ? `
    <section class="codes-panel">
      <h3>Suggested HTS Code</h3>
      ${Object.keys(enrichment).length
        ? `<div class="enrich-list">${renderEnrichmentPanel(codes, enrichment, "")}</div>`
        : `<div class="codes">${renderCodeTags(codes, "", null, enrichment)}</div>`}
    </section>` : "";

  const approvedBanner = approved ? `
    <div class="approve-current">
      <span class="enrich-signal">✓ Approved</span>
      <span class="code-tag hit">${escapeHtml(approved.code)}</span>
      ${approved.note ? `<span class="prod-notes muted">${escapeHtml(approved.note)}</span>` : ""}
      <span class="prod-notes muted" style="font-size:0.66rem;margin-left:auto">${(approved.ts || "").slice(0, 10)}</span>
    </div>` : "";

  const searchVal   = JSON.stringify(currentCode || data.product || "");
  const searchLabel = currentCode ? `Search training data for ${escapeHtml(currentCode)}` : "Search training data";

  prodDetail.innerHTML = `
    <p class="source-line">
      <span class="source-badge">Product</span>
      ${reviewBadgeHtml(approved ? "confirmed" : (p.review_status || "missing"))}
    </p>
    <h2 class="detail-title">${escapeHtml(data.product || p.product || "Product")}</h2>
    ${fields.length ? `<div class="prod-fields">${fieldsHtml}</div>` : ""}
    ${codeSection}
    ${p.review_notes ? `<section class="codes-panel"><h3>Review Notes</h3><p class="prod-notes">${escapeHtml(p.review_notes)}</p></section>` : ""}
    ${approvedBanner}
    <section class="codes-panel approve-panel" id="approve-panel">
      <h3>Assign Approved Code</h3>
      <div class="approve-form">
        <input class="approve-input" id="approve-code-input" type="text"
          placeholder="e.g. 8310.00.0000" value="${escapeHtml(currentCode)}">
        <input class="approve-note-input" id="approve-note-input" type="text"
          placeholder="Optional note…" value="${escapeHtml(approved?.note || "")}">
        <button class="cross-btn approve-btn" id="approve-btn">Approve</button>
      </div>
      <p id="approve-status" class="prod-notes muted" style="margin-top:0.45rem;min-height:1.1em"></p>
    </section>
    <section class="codes-panel">
      <h3>Browse CUSMA Codes</h3>
      <div class="hts-tree" id="prod-hts-tree"></div>
    </section>
    <div class="prod-actions">
      <button class="search-link-btn" onclick="searchForCode(${searchVal})">${searchLabel}</button>
    </div>
    ${crossPanelHtml(currentCode || data.product || "")}
  `;

  // Wire up tree — clicking a code fills the approval input
  attachHtsTree(document.getElementById("prod-hts-tree"), code => {
    const input = document.getElementById("approve-code-input");
    if (input) {
      input.value = code;
      input.focus();
      document.getElementById("approve-panel")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  });

  const approveBtn    = document.getElementById("approve-btn");
  const approveInput  = document.getElementById("approve-code-input");
  const approveNote   = document.getElementById("approve-note-input");
  const approveStatus = document.getElementById("approve-status");

  approveBtn.addEventListener("click", async () => {
    const code = approveInput.value.trim();
    if (!code) { approveStatus.textContent = "Enter a code first."; return; }
    approveBtn.disabled  = true;
    approveStatus.textContent = "Saving…";
    approveStatus.style.color = "";
    const result = await saveApproval(data.id, code, approveNote.value.trim());
    approveBtn.disabled = false;
    if (result.ok) {
      approveStatus.textContent = `Saved: ${result.code}`;
      approveStatus.style.color = "var(--match)";
      p.approved = { code: result.code, note: approveNote.value.trim(), ts: new Date().toISOString() };
      const li = document.querySelector(`#prod-list .result-item[data-id="${data.id}"]`);
      if (li) {
        li.querySelector(".id").innerHTML =
          `<span class="source-badge">Product</span> ${reviewBadgeHtml("confirmed")} <span class="enrich-signal">✓</span>`;
        let codesDiv = li.querySelector(".codes");
        if (!codesDiv) { codesDiv = document.createElement("div"); codesDiv.className = "codes"; li.appendChild(codesDiv); }
        codesDiv.innerHTML = `<span class="code-tag hit">${escapeHtml(code)}</span>`;
      }
    } else {
      approveStatus.textContent = "Error saving.";
      approveStatus.style.color = "#f87171";
    }
  });

  initCrossPanel();
}

// Wire up products toolbar
const prodSearchInput  = document.getElementById("prod-search");
const prodStatusFilter = document.getElementById("prod-status-filter");

if (prodSearchInput) {
  prodSearchInput.addEventListener("input", () => {
    clearTimeout(prodDebounce);
    prodDebounce = setTimeout(() => {
      loadProducts(prodSearchInput.value.trim(), prodStatusFilter?.value || "");
    }, 180);
  });
}
if (prodStatusFilter) {
  prodStatusFilter.addEventListener("change", () => {
    loadProducts(prodSearchInput?.value.trim() || "", prodStatusFilter.value);
  });
}

// ── Init ──────────────────────────────────────────────────────────────────────

async function init() {
  const res = await fetch("/api/meta");
  meta = await res.json();
  totalCountEl.textContent = String(meta.total);

  if ((meta.version || 0) < 7 || meta.total < 1000) {
    statusEl.textContent =
      `Wrong server (v${meta.version || "?"}, ${meta.total} records). Restart: python server.py`;
    detailEl.innerHTML = `<p class="empty">Expected v7+ server with both JSONL files. You have ${meta.total} records.</p>`;
    return;
  }

  const parts = Object.entries(meta.sources || {}).map(([k, n]) => `${k}: ${n.toLocaleString()}`);
  sourceSummaryEl.textContent = parts.length ? ` (${parts.join(", ")})` : "";

  for (const [key, count] of Object.entries(meta.sources || {})) {
    const opt = document.createElement("option");
    opt.value = key; opt.textContent = `${key} (${count.toLocaleString()})`;
    sourceFilter.appendChild(opt);
  }

  if (meta.has_products) {
    const btn = document.getElementById("tab-products-btn");
    if (btn) btn.style.display = "";
  }

  statusEl.textContent = "Ready — text uses whole words (sign not design); *sign for substring";
  await runSearch();
}

init().catch(err => {
  statusEl.textContent = "Error loading data";
  console.error(err);
});
