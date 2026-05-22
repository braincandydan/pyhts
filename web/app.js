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
      ? `<span class="enrich-rate">${escapeHtml(e.general_rate)}</span>`
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
          ${rate}${signal}${link}
        </div>
        ${e.description ? `<div class="enrich-desc">${escapeHtml(e.description)}</div>` : ""}
        ${hier ? `<div class="enrich-hierarchy">${hier}</div>` : ""}
      </div>`;
  });
  return rows.join("");
}

function renderResults(records, query) {
  resultsEl.innerHTML = "";
  if (!records.length) {
    resultsEl.innerHTML = `<li class="empty">No records match “${escapeHtml(query)}”</li>`;
    return;
  }

  const q = query.trim();
  for (const r of records) {
    const li = document.createElement("li");
    li.className = "result-item" + (r.id === activeId ? " active" : "");
    li.dataset.id = r.id;

    const codesForSearch = r.codes_all || r.codes || [];
    const primary = r.codes || [];
    const nameHit = r.match_text || productMatches(r.search_text || r.product, q);
    const productHtml = nameHit
      ? highlightQuery(r.product || "(no title)", q)
      : escapeHtml(r.product || "(no title)");

    li.innerHTML = `
      <div class="id">
        <span class="source-badge">${escapeHtml(r.source_label || r.source)}</span>
        #${r.id}
        ${nameHit && !/^\d/.test(q) ? " · text match" : ""}
      </div>
      <div class="product${nameHit ? " name-hit" : ""}">${productHtml}</div>
      <div class="codes-meta">${primary.length} primary · ${r.code_count ?? codesForSearch.length} total codes</div>
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

  detailEl.innerHTML = `<p class="empty">Loading record #${id}…</p>`;
  const res = await fetch(`/api/record/${id}?q=${encodeURIComponent(query || "")}`);
  if (!res.ok) {
    detailEl.innerHTML = `<p class="empty">Failed to load record.</p>`;
    return;
  }
  const data = await res.json();
  renderDetail(data, query);
}

function renderDetail(data, query) {
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
            return `<li><strong>${escapeHtml(name)}</strong>(${escapeHtml(argStr)}${argStr.length >= 200 ? "…" : ""})</li>`;
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
    <section class="messages-panel">
      <h3>Conversation</h3>
      ${parts.join("")}
    </section>
  `;
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

  if (!meta.word_search || (meta.version || 0) < 5 || meta.total < 1000) {
    statusEl.textContent =
      `Wrong server (v${meta.version || "?"}, ${meta.total} records). Stop old process, run: python server.py`;
    detailEl.innerHTML = `<p class="empty">Expected ~18,569 records (both JSONL files). You have ${meta.total}. Restart the server in the <code>web</code> folder.</p>`;
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
