const searchInput = document.getElementById("search");
const sourceFilter = document.getElementById("source-filter");
const matchWordToggle = document.getElementById("match-word");
const resultsEl = document.getElementById("results");
const detailEl = document.getElementById("detail");
const statusEl = document.getElementById("status");
const totalCountEl = document.getElementById("total-count");
const sourceSummaryEl = document.getElementById("source-summary");

let activeId = null;
let debounceTimer = null;
let meta = null;

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function highlightQuery(text, query) {
  if (!query) return escapeHtml(text);

  const { term, wholeWord } = parseTextQuery(query, getMatchMode());
  let out = escapeHtml(text);

  if (term) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = wholeWord
      ? new RegExp(`\\b(${escaped})\\b`, "gi")
      : new RegExp(`(${escaped})`, "gi");
    out = out.replace(re, (m) => `<span class="highlight">${m}</span>`);
  }

  const digits = query.replace(/[^\d]/g, "");
  if (digits.length >= 4) {
    const dotted = digits.replace(/^(\d{4})(\d{2})?(\d{2,4})?.*$/, (_, a, b, c) => {
      let s = a;
      if (b) s += "." + b;
      if (c) s += "." + c;
      return s;
    });
    if (dotted && dotted.length >= 4) {
      const re = new RegExp(dotted.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
      out = out.replace(re, (m) => `<span class="highlight">${m}</span>`);
    }
  }
  return out;
}

function getMatchMode() {
  return matchWordToggle?.checked ? "word" : "substr";
}

function parseTextQuery(query, forceMode) {
  let q = query.trim();
  const wholeWord = forceMode === "word" || (forceMode !== "substr" && matchWordToggle?.checked);
  if (!q) return { term: "", wholeWord: true };
  if (q.length >= 2 && q[0] === q[q.length - 1] && (q[0] === '"' || q[0] === "'")) {
    return { term: q.slice(1, -1).trim().toLowerCase(), wholeWord: true };
  }
  if (!wholeWord && q.startsWith("*")) {
    q = q.slice(1).trim();
  }
  const digits = q.replace(/[^\d]/g, "").length;
  if (digits >= Math.max(2, Math.floor(q.length / 2))) {
    return { term: q.toLowerCase(), wholeWord: false };
  }
  return { term: q.toLowerCase(), wholeWord };
}

function productMatches(searchText, query) {
  const { term, wholeWord } = parseTextQuery(query, getMatchMode());
  if (!term) return false;
  const text = (searchText || "").toLowerCase();
  if (wholeWord) {
    return new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(text);
  }
  return text.includes(term);
}

function codesMatch(recordCodes, query) {
  const q = query.trim();
  if (!q) return true;
  const qDigits = q.replace(/[^\d]/g, "");
  return recordCodes.some((code) => {
    const cDigits = code.replace(/[^\d]/g, "");
    if (code.includes(q) || code.startsWith(q)) return true;
    if (qDigits && cDigits.startsWith(qDigits)) return true;
    if (qDigits && cDigits.includes(qDigits)) return true;
    return false;
  });
}

function renderCodeTags(codes, query, limit, enrichment) {
  const q = query.trim();
  const hit = (code) => codesMatch([code], q);
  const shown = limit ? codes.slice(0, limit) : codes;
  const tags = shown
    .map((c) => {
      const desc = enrichment?.[c]?.description;
      const title = desc ? ` title="${escapeHtml(desc)}"` : "";
      return `<span class="code-tag${hit(c) ? " hit" : ""}"${title}>${escapeHtml(c)}</span>`;
    })
    .join("");
  const more =
    limit && codes.length > limit
      ? `<span class="code-tag more">+${codes.length - limit} more</span>`
      : "";
  return tags + more;
}

function renderEnrichmentPanel(codes, enrichment, query) {
  if (!enrichment || !codes.length) return "";
  const q = query.trim();
  const rows = codes.map((c) => {
    const e = enrichment[c];
    if (!e) {
      // no enrichment — fall back to plain badge
      const isHit = codesMatch([c], q);
      return `<div class="enrich-row enrich-row-plain"><span class="code-tag${isHit ? " hit" : ""}">${escapeHtml(c)}</span></div>`;
    }
    const isHit = codesMatch([c], q);
    const rate = e.general_rate
      ? `<span class="enrich-rate" title="US duty rate">${escapeHtml(e.general_rate)}</span>`
      : "";
    const caUst = e.ca_ust
      ? `<span class="enrich-ca-ust" title="Canada CUSMA/UST rate">CA UST: ${escapeHtml(e.ca_ust)}</span>`
      : "";
    const caMfn = e.ca_mfn
      ? `<span class="enrich-ca-mfn" title="Canada MFN rate">CA MFN: ${escapeHtml(e.ca_mfn)}</span>`
      : "";
    const signal =
      e.agreement > 0
        ? `<span class="enrich-signal">${e.agreement} record${e.agreement === 1 ? "" : "s"}</span>`
        : "";
    const link = `<a class="enrich-link" href="${escapeHtml(e.usitc_url)}" target="_blank" rel="noopener">↗ Verify on USITC</a>`;
    const hier = (e.hierarchy || [])
      .map(
        (h) =>
          `<span class="enrich-level"><span class="enrich-level-code">${escapeHtml(h.code)}</span><span class="enrich-level-desc">${escapeHtml(h.description)}</span></span>`
      )
      .join(`<span class="enrich-sep">›</span>`);
    return `
      <div class="enrich-row">
        <div class="enrich-header">
          <span class="code-tag${isHit ? " hit" : ""}">${escapeHtml(c)}</span>
          ${rate}${caUst}${caMfn}${signal}${link}
        </div>
        ${e.description ? `<div class="enrich-desc">${escapeHtml(e.description)}</div>` : ""}
        ${hier ? `<div class="enrich-hierarchy">${hier}</div>` : ""}
      </div>`;
  });
  return rows.join("");
}

const REVIEW_LABELS = { missing: "No Code", review: "Review", confirmed: "CUSMA OK", unconfirmed: "Unconfirmed" };

function reviewBadgeHtml(status) {
  const label = REVIEW_LABELS[status] || status;
  return `<span class="review-badge review-${escapeHtml(status)}">${escapeHtml(label)}</span>`;
}

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

    const isProduct = r.source === "products";
    const codesForSearch = r.codes_all || r.codes || [];
    const primary = r.codes || [];
    const nameHit = r.match_text || productMatches(r.search_text || r.product, q);
    const productHtml = nameHit
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
  document.querySelectorAll(".result-item").forEach((el) => {
    el.classList.toggle("active", Number(el.dataset.id) === id);
  });

  detailEl.innerHTML = `<p class="empty">Loading record #${id}...</p>`;
  const res = await fetch(`/api/record/${id}?q=${encodeURIComponent(query || "")}`);
  if (!res.ok) {
    detailEl.innerHTML = `<p class="empty">Failed to load record.</p>`;
    return;
  }
  const data = await res.json();
  renderDetail(data, query);
}

// ── CBP CROSS ────────────────────────────────────────────

async function fetchCrossRulings(q) {
  try {
    const res = await fetch(`/api/cross-search?q=${encodeURIComponent(q)}`);
    if (!res.ok) return { rulings: [], error: "Request failed" };
    return await res.json();
  } catch (e) {
    return { rulings: [], error: String(e) };
  }
}

function renderCrossResults(rulings, term, error) {
  if (error) return `<p class="prod-notes muted">Error: ${escapeHtml(error)}</p>`;
  if (!rulings.length) return `<p class="prod-notes muted">No CBP rulings found for "${escapeHtml(term)}".</p>`;
  return rulings.map(r => {
    const date = (r.rulingDate || "").slice(0, 10);
    const codes = (r.tariffs || []).join(", ");
    const url = `https://rulings.cbp.gov/ruling/${encodeURIComponent(r.rulingNumber)}`;
    const badge = r.collection === "hq"
      ? `<span class="cross-hq">HQ</span>`
      : `<span class="cross-ny">NY</span>`;
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
        <input class="cross-input" id="cross-input" placeholder="Code or product description..." value="${escapeHtml(defaultQuery || "")}">
        <button class="cross-btn" id="cross-btn">Search</button>
      </div>
      <div class="cross-results" id="cross-results">
        <p class="prod-notes muted">Search CBP CROSS for authoritative binding rulings.</p>
      </div>
    </section>`;
}

function initCrossPanel() {
  const input = document.getElementById("cross-input");
  const btn = document.getElementById("cross-btn");
  const results = document.getElementById("cross-results");
  if (!input || !btn || !results) return;

  const doSearch = async () => {
    const q = input.value.trim();
    if (!q) return;
    results.innerHTML = `<p class="prod-notes muted">Searching...</p>`;
    btn.disabled = true;
    const data = await fetchCrossRulings(q);
    btn.disabled = false;
    results.innerHTML = renderCrossResults(data.rulings || [], q, data.error || "");
  };

  btn.addEventListener("click", doSearch);
  input.addEventListener("keydown", e => { if (e.key === "Enter") doSearch(); });
}

function searchForCode(code) {
  searchInput.value = code;
  sourceFilter.value = "";
  activeId = null;
  runSearch();
}

function renderProductDetail(data, query) {
  const enrichment = data.enrichment || {};
  const codes = data.codes || [];
  const status = data.review_status || "missing";
  const statusLabel = REVIEW_LABELS[status] || status;

  const fields = [
    data.product_code ? ["Product Code", data.product_code] : null,
    data.substrate ? ["Substrate", data.substrate] : null,
    data.category ? ["Category", data.category] : null,
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
        <p class="prod-notes muted">No code assigned yet — search training data for similar products.</p>
      </section>`;

  const notesHtml = data.review_notes
    ? `<section class="codes-panel"><h3>Review Notes</h3><p class="prod-notes">${escapeHtml(data.review_notes)}</p></section>`
    : "";

  const searchBtn = codes.length
    ? `<div class="prod-actions"><button class="search-link-btn" onclick="searchForCode('${escapeHtml(codes[0])}')">Search training data for ${escapeHtml(codes[0])}</button></div>`
    : "";

  detailEl.innerHTML = `
    <p class="source-line">
      <span class="source-badge">${escapeHtml(data.source_label || data.source)}</span>
      <span class="review-badge review-${escapeHtml(status)}">${escapeHtml(statusLabel)}</span>
    </p>
    <h2 class="detail-title">${highlightQuery(data.product || "Product", query)}</h2>
    ${fields.length ? `<div class="prod-fields">${fieldsHtml}</div>` : ""}
    ${codeSection}
    ${notesHtml}
    ${searchBtn}
    ${crossPanelHtml(codes[0] || data.product || "")}
  `;
  initCrossPanel();
}

function renderDetail(data, query) {
  if (data.source === "products") {
    renderProductDetail(data, query);
    return;
  }
  const enrichment = data.enrichment || {};
  const parts = data.messages.map((m) => {
    const body = m.content
      ? `<div class="message-body${m.role === "system" ? " collapsed" : ""}">${highlightQuery(m.content, query)}</div>`
      : "";
    const tools = m.tool_calls?.length
      ? `<ul class="tool-calls">${m.tool_calls
          .map((tc) => {
            const name = tc.function?.name || "tool";
            const args = tc.function?.arguments;
            const argStr =
              typeof args === "string"
                ? args.slice(0, 200)
                : JSON.stringify(args || {}).slice(0, 200);
            return `<li><strong>${escapeHtml(name)}</strong>(${escapeHtml(argStr)}${argStr.length >= 200 ? "..." : ""})</li>`;
          })
          .join("")}</ul>`
      : "";
    return `
      <article class="message role-${m.role}">
        <div class="message-header">${escapeHtml(m.role)}${m.tool_calls?.length ? " · tool call" : ""}</div>
        ${body}
        ${tools}
      </article>
    `;
  });

  const allCodes = data.codes_all || data.codes || [];

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
  const q = searchInput.value.trim();
  const source = sourceFilter.value;
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (source) params.set("source", source);
  params.set("mode", getMatchMode());
  const qs = params.toString();
  return `/api/search${qs ? `?${qs}` : ""}`;
}

async function runSearch() {
  const q = searchInput.value.trim();
  const res = await fetch(searchUrl());
  const data = await res.json();
  const scope = data.source ? ` in ${data.source}` : "";
  statusEl.textContent = q
    ? `${data.count} of ${data.total} records${scope}`
    : `Showing ${data.count} records${scope}`;
  renderResults(data.results, q);
  if (data.results.length && activeId === null) {
    selectRecord(data.results[0].id, q);
  } else if (data.results.length && !data.results.some((r) => r.id === activeId)) {
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

sourceFilter.addEventListener("change", () => {
  activeId = null;
  runSearch();
});

matchWordToggle.addEventListener("change", () => {
  activeId = null;
  runSearch();
});

async function init() {
  const res = await fetch("/api/meta");
  meta = await res.json();
  totalCountEl.textContent = String(meta.total);

  if (!meta.word_search || (meta.version || 0) < 7 || meta.total < 1000) {
    statusEl.textContent =
      `Wrong server (v${meta.version || "?"}, ${meta.total} records). Stop old process, run: python server.py`;
    detailEl.innerHTML = `<p class="empty">Expected v6+ server with both JSONL files. You have ${meta.total} records. Restart the server in the <code>web</code> folder.</p>`;
    return;
  }

  const parts = Object.entries(meta.sources || {}).map(
    ([k, n]) => `${k}: ${n.toLocaleString()}`
  );
  sourceSummaryEl.textContent = parts.length ? ` (${parts.join(", ")})` : "";

  for (const [key, count] of Object.entries(meta.sources || {})) {
    const opt = document.createElement("option");
    opt.value = key;
    opt.textContent = `${key} (${count.toLocaleString()})`;
    sourceFilter.appendChild(opt);
  }

  statusEl.textContent = "Ready — text uses whole words (sign not design); *sign for substring";
  await runSearch();
}

init().catch((err) => {
  statusEl.textContent = "Error loading data";
  console.error(err);
});
