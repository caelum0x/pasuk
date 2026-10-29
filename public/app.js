(() => {
  "use strict";

  const ICONS = {
    heart: `<svg viewBox="0 0 24 24"><path d="M12 21s-7.5-4.6-10-9.3C.5 8.2 2.3 5 5.6 5 7.9 5 9.6 6.3 12 9c2.4-2.7 4.1-4 6.4-4 3.3 0 5.1 3.2 3.6 6.7C19.5 16.4 12 21 12 21z"/></svg>`,
    note: `<svg viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`,
    share: `<svg viewBox="0 0 24 24"><path d="M12 3v12M12 3l4 4M12 3 8 7M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"/></svg>`,
  };

  const LS_LIKES = "pasuk:likes";
  const LS_NOTES = "pasuk:notes";
  const LS_LAST_READ = "pasuk:lastRead";

  const onboarding = document.getElementById("onboarding");
  const startBtn = document.getElementById("startBtn");
  const feedEl = document.getElementById("feed");
  const sheet = document.getElementById("sheet");
  const sheetBackdrop = document.getElementById("sheetBackdrop");
  const sheetClose = document.getElementById("sheetClose");
  const parshaSheet = document.getElementById("parshaSheet");
  const parshaBackdrop = document.getElementById("parshaBackdrop");
  const parshaClose = document.getElementById("parshaClose");
  const parshaListEl = document.getElementById("parshaList");
  const keptSheet = document.getElementById("keptSheet");
  const keptBackdrop = document.getElementById("keptBackdrop");
  const keptClose = document.getElementById("keptClose");
  const keptListEl = document.getElementById("keptList");

  let verses = [];
  let renderedCount = 0;
  const BATCH = 20;
  let sentinel = null;
  let io = null;
  let progressBar = null;
  let progressLabel = null;
  let keptBtn = null;
  let parshas = []; // [{ parsha, book, firstIdx, lastIdx, startChapter, startVerse, endChapter, endVerse, count }]
  let currentParsha = "";

  function loadSet(key) {
    try {
      return new Set(JSON.parse(localStorage.getItem(key) || "[]"));
    } catch (e) {
      return new Set();
    }
  }
  function saveSet(key, set) {
    localStorage.setItem(key, JSON.stringify([...set]));
  }
  function loadNotes() {
    try {
      return JSON.parse(localStorage.getItem(LS_NOTES) || "{}");
    } catch (e) {
      return {};
    }
  }
  function saveNotes(notes) {
    localStorage.setItem(LS_NOTES, JSON.stringify(notes));
  }
  function safeGetLastRead() {
    try { return localStorage.getItem(LS_LAST_READ); } catch (e) { return null; }
  }
  function safeSetLastRead(id) {
    try { localStorage.setItem(LS_LAST_READ, id); } catch (e) { /* storage unavailable */ }
  }

  const likes = loadSet(LS_LIKES);
  const notes = loadNotes();

  async function fetchData() {
    const res = await fetch("/data/torah.json");
    if (!res.ok) throw new Error("failed to load verses");
    return res.json();
  }

  function cardHtml(v, idx) {
    const liked = likes.has(v.id);
    return `
      <section class="verse-card" data-id="${v.id}" data-idx="${idx}" data-book="${escapeHtml(v.book)}" data-parsha="${escapeHtml(v.parsha || "")}">
        <div class="verse-inner" data-open="${v.id}">
          <div class="verse-chapter-tag">${escapeHtml(v.book)} ${v.chapter}:${v.verse} &middot; ${escapeHtml(v.parsha || "")}</div>
          <p class="verse-text">${escapeHtml(v.translation)}</p>
          <p class="verse-hebrew-preview">${escapeHtml(truncate(v.hebrew, 60))}</p>
        </div>
        <div class="verse-tap-hint">Tap to read Hebrew &amp; context</div>
        <div class="verse-actions">
          <button class="action-btn like-btn ${liked ? "liked" : ""}" data-id="${v.id}" aria-label="Like">
            ${ICONS.heart}
            <span class="action-count">${liked ? "Kept" : "Keep"}</span>
          </button>
          <button class="action-btn note-btn" data-id="${v.id}" aria-label="Note">
            ${ICONS.note}
            <span class="action-count">${notes[v.id] ? "Noted" : "Note"}</span>
          </button>
          <button class="action-btn share-btn" data-id="${v.id}" aria-label="Share">
            ${ICONS.share}
            <span class="action-count">Share</span>
          </button>
        </div>
      </section>
    `;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }
  function truncate(s, n) {
    return s.length > n ? s.slice(0, n).trim() + "…" : s;
  }

  function renderNextBatch() {
    if (renderedCount >= verses.length) return;
    const end = Math.min(renderedCount + BATCH, verses.length);
    let html = "";
    for (let i = renderedCount; i < end; i++) {
      html += cardHtml(verses[i], i);
    }
    if (sentinel) sentinel.remove();
    feedEl.insertAdjacentHTML("beforeend", html);
    renderedCount = end;
    attachSentinel();
    observeCards();
  }

  // Bulk-render every card up to and including targetIdx in a single DOM write.
  // Used for deep-link jumps (e.g. #Deuteronomy.34.12) so the browser never has
  // to lay out thousands of individual insertAdjacentHTML calls one at a time.
  function renderUpTo(targetIdx) {
    if (renderedCount > targetIdx) return;
    const end = Math.min(targetIdx + 1, verses.length);
    let html = "";
    for (let i = renderedCount; i < end; i++) {
      html += cardHtml(verses[i], i);
    }
    if (sentinel) sentinel.remove();
    feedEl.insertAdjacentHTML("beforeend", html);
    renderedCount = end;
    attachSentinel();
    observeCards();
  }

  function attachSentinel() {
    sentinel = document.createElement("div");
    sentinel.style.height = "1px";
    sentinel.id = "sentinel";
    feedEl.appendChild(sentinel);
    if (io) io.observe(sentinel);
  }

  let cardObserver = null;
  function observeCards() {
    const cards = feedEl.querySelectorAll(".verse-card:not([data-observed])");
    cards.forEach((c) => {
      c.setAttribute("data-observed", "1");
      if (cardObserver) cardObserver.observe(c);
    });
  }

  function setupObservers() {
    io = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting) renderNextBatch();
      });
    }, { root: feedEl, threshold: 0 });

    cardObserver = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting && e.intersectionRatio > 0.6) {
          const idx = parseInt(e.target.getAttribute("data-idx"), 10);
          updateProgress(idx, e.target.getAttribute("data-book"), e.target.getAttribute("data-parsha"), e.target.getAttribute("data-id"));
        }
      });
    }, { root: feedEl, threshold: [0.6] });
  }

  function updateProgress(idx, book, parsha, id) {
    currentParsha = parsha;
    if (progressBar) {
      const pct = ((idx + 1) / verses.length) * 100;
      progressBar.style.width = pct.toFixed(2) + "%";
    }
    if (progressLabel) {
      progressLabel.textContent = `${book} · ${parsha}`;
    }
    if (id) safeSetLastRead(id);
  }

  // Group the sequential verse list into its 54 weekly Torah portions, in
  // canonical order (the data is already Genesis→Deuteronomy ordered, so
  // first-seen insertion order into the Map is the correct parsha order).
  function buildParshas() {
    const map = new Map();
    verses.forEach((v, idx) => {
      if (!map.has(v.parsha)) {
        map.set(v.parsha, {
          parsha: v.parsha,
          book: v.book,
          firstIdx: idx,
          lastIdx: idx,
          startChapter: v.chapter,
          startVerse: v.verse,
          endChapter: v.chapter,
          endVerse: v.verse,
          count: 0,
        });
      }
      const p = map.get(v.parsha);
      p.lastIdx = idx;
      p.endChapter = v.chapter;
      p.endVerse = v.verse;
      p.count += 1;
    });
    parshas = [...map.values()];
  }

  function parshaRange(p) {
    return p.startChapter === p.endChapter
      ? `${p.startChapter}:${p.startVerse}–${p.endVerse}`
      : `${p.startChapter}:${p.startVerse}–${p.endChapter}:${p.endVerse}`;
  }

  function renderParshaList() {
    let html = "";
    let lastBook = null;
    parshas.forEach((p) => {
      if (p.book !== lastBook) {
        html += `<div class="parsha-book-header">${escapeHtml(p.book)}</div>`;
        lastBook = p.book;
      }
      html += `
        <button class="parsha-row${p.parsha === currentParsha ? " parsha-row-active" : ""}" data-parsha="${escapeHtml(p.parsha)}">
          <span class="parsha-row-names">
            <span class="parsha-row-title">${escapeHtml(p.parsha)}</span>
            <span class="parsha-row-range">${escapeHtml(p.book)} ${parshaRange(p)} &middot; ${p.count} verses</span>
          </span>
        </button>`;
    });
    parshaListEl.innerHTML = html;
  }

  // Jump the feed to a given verse index. Uses the single-write renderUpTo()
  // (not a loop of renderNextBatch()) so a jump to a late verse (e.g. near
  // verse 5,846) never blocks the main thread the way the original per-batch
  // deep-link loop did before that bug was fixed. Shared by the parsha
  // navigator and the kept-verses sheet.
  function jumpToIndex(idx) {
    renderUpTo(idx);
    requestAnimationFrame(() => {
      const el = feedEl.querySelector(`.verse-card[data-idx="${idx}"]`);
      if (el) el.scrollIntoView({ block: "start" });
    });
  }

  function jumpToParsha(name) {
    const target = parshas.find((p) => p.parsha === name);
    if (!target) return;
    closeParshaSheet();
    jumpToIndex(target.firstIdx);
  }

  // ---------- Kept verses sheet ----------
  // The side-rail "Keep" action only ever wrote to localStorage with no way
  // to see or revisit what was kept — the feature was effectively write-only.
  // This renders every currently-kept verse (resolved live against `likes`)
  // so a kept verse can be reopened or un-kept without re-scrolling the feed.
  function renderKeptList() {
    const kept = verses
      .map((v, idx) => ({ v, idx }))
      .filter(({ v }) => likes.has(v.id));

    if (kept.length === 0) {
      keptListEl.innerHTML = `<p class="kept-empty">No kept verses yet — tap the heart on any verse to save it here.</p>`;
      return;
    }

    keptListEl.innerHTML = kept
      .map(
        ({ v, idx }) => `
      <div class="kept-row">
        <button class="kept-row-main" data-idx="${idx}">
          <span class="kept-row-tag">${escapeHtml(v.book)} ${v.chapter}:${v.verse} &middot; ${escapeHtml(v.parsha || "")}</span>
          <span class="kept-row-text">${escapeHtml(truncate(v.translation, 110))}</span>
        </button>
        <button class="kept-row-remove" data-id="${v.id}" aria-label="Remove from kept">&times;</button>
      </div>`
      )
      .join("");
  }

  function updateKeptCount() {
    if (keptBtn) keptBtn.textContent = likes.size ? `Kept (${likes.size})` : "Kept";
  }

  function openKeptSheet() {
    renderKeptList();
    keptSheet.hidden = false;
    document.body.style.overflow = "hidden";
  }

  function closeKeptSheet() {
    keptSheet.hidden = true;
    document.body.style.overflow = "";
  }

  function openParshaSheet() {
    renderParshaList();
    parshaSheet.hidden = false;
    document.body.style.overflow = "hidden";
  }

  function closeParshaSheet() {
    parshaSheet.hidden = true;
    document.body.style.overflow = "";
  }

  function openSheet(id) {
    const v = verses.find((x) => x.id === id);
    if (!v) return;
    sheet.querySelector(".sheet-kicker").textContent =
      `${v.book} ${v.chapter}:${v.verse} · Parashat ${v.parsha}`;
    sheet.querySelector(".sheet-chapter-title").textContent = v.parsha;
    sheet.querySelector(".sheet-chapter-summary").textContent = v.parshaSummary;
    sheet.querySelector(".sheet-hebrew").textContent = v.hebrew;
    sheet.querySelector(".sheet-translation").textContent = v.translation;

    let noteWrap = sheet.querySelector(".sheet-note-wrap");
    if (!noteWrap) {
      noteWrap = document.createElement("div");
      noteWrap.className = "sheet-note-wrap";
      noteWrap.innerHTML = `
        <div class="sheet-divider"></div>
        <div class="sheet-label">Your note (private, saved on this device)</div>
        <textarea class="sheet-note" rows="3" placeholder="Write a private reflection on this verse..."></textarea>
      `;
      sheet.querySelector(".sheet-scroll").appendChild(noteWrap);
    }
    const textarea = noteWrap.querySelector(".sheet-note");
    textarea.value = notes[id] || "";
    textarea.oninput = () => {
      const val = textarea.value;
      if (val.trim()) notes[id] = val; else delete notes[id];
      saveNotes(notes);
      const btn = feedEl.querySelector(`.note-btn[data-id="${id}"] .action-count`);
      if (btn) btn.textContent = notes[id] ? "Noted" : "Note";
    };

    sheet.hidden = false;
    document.body.style.overflow = "hidden";
  }

  function closeSheet() {
    sheet.hidden = true;
    document.body.style.overflow = "";
  }

  function toggleLike(id) {
    if (likes.has(id)) likes.delete(id); else likes.add(id);
    saveSet(LS_LIKES, likes);
    const btn = feedEl.querySelector(`.like-btn[data-id="${id}"]`);
    if (btn) {
      btn.classList.toggle("liked", likes.has(id));
      btn.querySelector(".action-count").textContent = likes.has(id) ? "Kept" : "Keep";
    }
    updateKeptCount();
    if (!keptSheet.hidden) renderKeptList();
  }

  async function shareVerse(id) {
    const v = verses.find((x) => x.id === id);
    if (!v) return;
    const text = `"${v.translation}"\n— ${v.book} ${v.chapter}:${v.verse}, Parashat ${v.parsha}`;
    const url = `${location.origin}/#${id}`;
    if (navigator.share) {
      try {
        await navigator.share({ text, url, title: "Pasuk" });
        return;
      } catch (e) { /* user cancelled */ return; }
    }
    try {
      await navigator.clipboard.writeText(`${text}\n${url}`);
      toast("Copied to clipboard");
    } catch (e) {
      toast("Could not copy");
    }
  }

  let toastTimer = null;
  function toast(msg) {
    let el = document.getElementById("toast");
    if (!el) {
      el = document.createElement("div");
      el.id = "toast";
      el.style.position = "fixed";
      el.style.bottom = "calc(32px + env(safe-area-inset-bottom, 0px))";
      el.style.left = "50%";
      el.style.transform = "translateX(-50%)";
      el.style.background = "rgba(19,20,25,0.95)";
      el.style.color = "#eef0f4";
      el.style.padding = "10px 18px";
      el.style.borderRadius = "999px";
      el.style.fontSize = "13px";
      el.style.zIndex = "50";
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.style.opacity = "1";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.style.opacity = "0"; }, 1800);
  }

  function wireFeedEvents() {
    feedEl.addEventListener("click", (e) => {
      const likeBtn = e.target.closest(".like-btn");
      if (likeBtn) { toggleLike(likeBtn.dataset.id); return; }
      const noteBtn = e.target.closest(".note-btn");
      if (noteBtn) { openSheet(noteBtn.dataset.id); return; }
      const shareBtn = e.target.closest(".share-btn");
      if (shareBtn) { shareVerse(shareBtn.dataset.id); return; }
      const openTarget = e.target.closest("[data-open]");
      if (openTarget) { openSheet(openTarget.getAttribute("data-open")); return; }
    });
  }

  function createProgressBar() {
    const wrap = document.createElement("div");
    wrap.className = "feed-progress";
    wrap.innerHTML = `<div class="feed-progress-bar"></div>`;
    document.body.appendChild(wrap);
    progressBar = wrap.querySelector(".feed-progress-bar");

    const label = document.createElement("div");
    label.className = "feed-progress-label";
    label.textContent = "Genesis · Bereshit";
    label.setAttribute("aria-label", "Jump to a parsha");
    label.addEventListener("click", openParshaSheet);
    document.body.appendChild(label);
    progressLabel = label;

    const kBtn = document.createElement("button");
    kBtn.className = "kept-btn";
    kBtn.type = "button";
    kBtn.setAttribute("aria-label", "Your kept verses");
    kBtn.addEventListener("click", openKeptSheet);
    document.body.appendChild(kBtn);
    keptBtn = kBtn;
    updateKeptCount();
  }

  async function start() {
    startBtn.disabled = true;
    startBtn.textContent = "Loading...";
    try {
      verses = await fetchData();
    } catch (e) {
      startBtn.textContent = "Could not load — tap to retry";
      startBtn.disabled = false;
      return;
    }
    onboarding.hidden = true;
    feedEl.hidden = false;
    buildParshas();
    currentParsha = parshas[0] ? parshas[0].parsha : "";
    createProgressBar();
    setupObservers();
    wireFeedEvents();
    renderNextBatch();

    const hashId = location.hash.replace("#", "");
    if (hashId) {
      const idx = verses.findIndex((v) => v.id === hashId);
      if (idx >= 0) jumpToIndex(idx);
    } else {
      const lastReadId = safeGetLastRead();
      if (lastReadId && lastReadId !== verses[0].id) {
        const idx = verses.findIndex((v) => v.id === lastReadId);
        if (idx > 0) {
          jumpToIndex(idx);
          toast("Continuing where you left off");
        }
      }
    }
  }

  startBtn.addEventListener("click", start);
  sheetClose.addEventListener("click", closeSheet);
  sheetBackdrop.addEventListener("click", closeSheet);
  parshaClose.addEventListener("click", closeParshaSheet);
  parshaBackdrop.addEventListener("click", closeParshaSheet);
  parshaListEl.addEventListener("click", (e) => {
    const row = e.target.closest(".parsha-row");
    if (row) jumpToParsha(row.dataset.parsha);
  });
  keptClose.addEventListener("click", closeKeptSheet);
  keptBackdrop.addEventListener("click", closeKeptSheet);
  keptListEl.addEventListener("click", (e) => {
    const removeBtn = e.target.closest(".kept-row-remove");
    if (removeBtn) { toggleLike(removeBtn.dataset.id); return; }
    const row = e.target.closest(".kept-row-main");
    if (row) {
      const idx = parseInt(row.dataset.idx, 10);
      closeKeptSheet();
      jumpToIndex(idx);
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !sheet.hidden) closeSheet();
    if (e.key === "Escape" && !parshaSheet.hidden) closeParshaSheet();
    if (e.key === "Escape" && !keptSheet.hidden) closeKeptSheet();
  });
})();
