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
  const parshaSearchEl = document.getElementById("parshaSearch");
  const parshaSearchResultsEl = document.getElementById("parshaSearchResults");
  const parshaSheetFooterEl = document.getElementById("parshaSheetFooter");
  const keptSheet = document.getElementById("keptSheet");
  const keptBackdrop = document.getElementById("keptBackdrop");
  const keptClose = document.getElementById("keptClose");
  const keptListEl = document.getElementById("keptList");
  const notesSheet = document.getElementById("notesSheet");
  const notesBackdrop = document.getElementById("notesBackdrop");
  const notesClose = document.getElementById("notesClose");
  const notesListEl = document.getElementById("notesList");

  // ---------- Modal focus management ----------
  // All four sheets (detail, parsha navigator, kept, notes) declare
  // role="dialog" aria-modal="true" but, until now, never actually moved
  // focus into the dialog, never trapped Tab/Shift+Tab inside it, never
  // hid the background feed from assistive tech, and never restored focus
  // to whatever triggered the sheet on close. A keyboard or screen-reader
  // user could tab straight out of an "open" modal into the hidden
  // background feed — a real WCAG 2.1 violation (2.4.3 / 4.1.2), not a
  // hypothetical one, since every sheet already claims aria-modal="true".
  let activeModal = null;
  let lastFocused = null;

  function focusableIn(container) {
    return Array.from(
      container.querySelectorAll('button, [href], input, textarea, select, [tabindex]')
    ).filter((el) => !el.disabled && !el.closest("[hidden]"));
  }

  function openModal(overlayEl) {
    lastFocused = document.activeElement;
    overlayEl.hidden = false;
    document.body.style.overflow = "hidden";
    activeModal = overlayEl;
    const panel = overlayEl.querySelector(".sheet-panel");
    const focusables = focusableIn(panel);
    if (focusables[0]) focusables[0].focus({ preventScroll: true });
    feedEl.setAttribute("aria-hidden", "true");
    if (!onboarding.hidden) onboarding.setAttribute("aria-hidden", "true");
  }

  function closeModal(overlayEl) {
    overlayEl.hidden = true;
    document.body.style.overflow = "";
    activeModal = null;
    feedEl.removeAttribute("aria-hidden");
    onboarding.removeAttribute("aria-hidden");
    if (lastFocused && typeof lastFocused.focus === "function") {
      lastFocused.focus({ preventScroll: true });
    }
    lastFocused = null;
  }

  let verses = [];
  let renderedCount = 0;
  let renderedStart = 0; // first index currently present in the DOM (see windowJumpTo)
  const BATCH = 20;
  // A far jump (deep link, parsha jump, search/kept/notes-row jump) renders at
  // most this many cards instead of every card between the current render
  // position and the target. See windowJumpTo() for why: with Pasuk's
  // 5,846-verse dataset (13.8x sibling app Gatha's 423), rendering "every
  // card up to the target" in one shot measured as a real 3.5-6s
  // main-thread-blocking long task under realistic mobile CPU throttle when
  // jumping to a late verse (confirmed live via Playwright/CDP longtask
  // timing against production before this fix).
  const JUMP_WINDOW = BATCH * 2;
  // A forward jump this close to the already-rendered range is cheap enough
  // (<= 3 batches) to just contiguously fill via the existing renderUpTo(),
  // same as ordinary infinite scroll — no need to throw away the DOM.
  const CONTIGUOUS_FILL_LIMIT = BATCH * 3;
  let sentinel = null;
  let topSentinel = null;
  let io = null;
  let ioTop = null;
  let progressBar = null;
  let progressLabel = null;
  let keptBtn = null;
  let notesBtn = null;
  let parshas = []; // [{ parsha, book, firstIdx, lastIdx, startChapter, startVerse, endChapter, endVerse, count }]
  let currentParsha = "";
  let currentIdx = 0;

  function loadSet(key) {
    try {
      return new Set(JSON.parse(localStorage.getItem(key) || "[]"));
    } catch (e) {
      return new Set();
    }
  }
  function saveSet(key, set) {
    try { localStorage.setItem(key, JSON.stringify([...set])); } catch (e) { /* storage unavailable */ }
  }
  function loadNotes() {
    try {
      return JSON.parse(localStorage.getItem(LS_NOTES) || "{}");
    } catch (e) {
      return {};
    }
  }
  function saveNotes(notes) {
    try { localStorage.setItem(LS_NOTES, JSON.stringify(notes)); } catch (e) { /* storage unavailable */ }
  }
  function safeGetLastRead() {
    try { return localStorage.getItem(LS_LAST_READ); } catch (e) { return null; }
  }
  function safeSetLastRead(id) {
    try { localStorage.setItem(LS_LAST_READ, id); } catch (e) { /* storage unavailable */ }
  }

  const likes = loadSet(LS_LIKES);
  const notes = loadNotes();

  // A shared verse (`shareVerse()` below) produces a link like
  // `https://pasuk.ereboslab.com/#Genesis.1.1`. Previously, opening that
  // link cold still forced the recipient through the onboarding screen and
  // a manual "Start reading" tap before they ever saw the verse that was
  // actually shared with them — the deep link only "worked" after an extra
  // step, undermining the app's main stated growth lever (shares). If the
  // URL already carries a valid verse hash on first load, skip onboarding
  // and jump straight into the feed at that verse. Same fix as Shloka
  // (commit ca0e400) and Gatha, applied to Pasuk's own `Book.chapter.verse`
  // id format.
  const hasDeepLinkHash = /^#?[A-Za-z]+\.\d+\.\d+$/.test(location.hash);

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
          <p class="verse-hebrew-preview" lang="he" dir="rtl">${escapeHtml(truncate(v.hebrew, 60))}</p>
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

  // Hebrew verse text is stored *with* niqqud (vowel-point combining marks,
  // e.g. "בְּרֵאשִׁית") straight from the source API. Standard Hebrew
  // keyboards/layouts have no niqqud keys, so a real user typing a plain,
  // undotted search term (e.g. "בראשית") into the verse search box never
  // matched, even for a word that is clearly present in the text — a
  // substring check against dotted text can't match an undotted query.
  // Strip just the combining marks (niqqud + cantillation, Unicode general
  // category Mn), not punctuation like maqaf/sof-pasuq, so search works for
  // the plain text real users actually type.
  const NIQQUD_RE = /[\u0591-\u05BD\u05BF\u05C1\u05C2\u05C4\u05C5\u05C7]/g;
  function stripNiqqud(s) {
    return s.replace(NIQQUD_RE, "");
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

  // Bulk-render every card from the current render position up to and
  // including targetIdx in a single DOM write. Only called for a *close*
  // forward jump (see CONTIGUOUS_FILL_LIMIT) — a single insertAdjacentHTML
  // write instead of a loop of per-batch writes, so the browser never has to
  // lay out thousands of individual small inserts one at a time.
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

  // Render only a bounded window of JUMP_WINDOW cards ending at targetIdx,
  // discarding whatever was previously in the DOM, instead of every card
  // from the start of the render range up to targetIdx. This is the real fix
  // for the multi-second main-thread hang: the old renderUpTo()-for-everything
  // approach kept the single-DOM-write discipline but still had to build and
  // lay out HTML proportional to targetIdx itself, so a deep link near
  // Pasuk's 5,846th verse rendered nearly the entire feed (9.5MB of markup,
  // ~17k inline SVG icons) in one shot. Jump cost is now constant regardless
  // of dataset size or target position. Backward scrolling out of the window
  // is handled by the top sentinel / renderPrevBatch() below.
  function windowJumpTo(targetIdx) {
    const start = Math.max(0, targetIdx - JUMP_WINDOW + 1);
    const end = Math.min(verses.length, targetIdx + 1);
    let html = "";
    for (let i = start; i < end; i++) {
      html += cardHtml(verses[i], i);
    }
    feedEl.innerHTML = html;
    renderedStart = start;
    renderedCount = end;
    observeCards();
    attachSentinel();
    attachTopSentinel();
  }

  function attachSentinel() {
    sentinel = document.createElement("div");
    sentinel.style.height = "1px";
    sentinel.id = "sentinel";
    feedEl.appendChild(sentinel);
    if (io) io.observe(sentinel);
  }

  // Mirrors attachSentinel() but for backward (scroll-up) infinite-fill,
  // only needed once a windowed jump has left earlier verses (index <
  // renderedStart) unrendered. No-op while renderedStart is 0 (the normal,
  // never-jumped-far case), so this adds no cost to the common path.
  function attachTopSentinel() {
    if (topSentinel) { topSentinel.remove(); topSentinel = null; }
    if (renderedStart <= 0) return;
    topSentinel = document.createElement("div");
    topSentinel.style.height = "1px";
    topSentinel.id = "sentinel-top";
    feedEl.insertBefore(topSentinel, feedEl.firstChild);
    if (ioTop) ioTop.observe(topSentinel);
  }

  // Prepends the previous batch of cards above the current window when the
  // user scrolls up to the top sentinel. Preserves scroll position (prepending
  // content above the viewport otherwise visually shifts everything already
  // on screen, since scrollTop doesn't auto-adjust for content inserted above it).
  function renderPrevBatch() {
    if (renderedStart <= 0) return;
    const start = Math.max(0, renderedStart - BATCH);
    let html = "";
    for (let i = start; i < renderedStart; i++) {
      html += cardHtml(verses[i], i);
    }
    const prevScrollTop = feedEl.scrollTop;
    const prevScrollHeight = feedEl.scrollHeight;
    if (topSentinel) { topSentinel.remove(); topSentinel = null; }
    feedEl.insertAdjacentHTML("afterbegin", html);
    renderedStart = start;
    observeCards();
    attachTopSentinel();
    feedEl.scrollTop = prevScrollTop + (feedEl.scrollHeight - prevScrollHeight);
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

    ioTop = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting) renderPrevBatch();
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
    currentIdx = idx;
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

  // Jump the feed to a given verse index. Shared by the parsha navigator,
  // search results, the kept/notes sheets, keyboard nav, and the initial
  // deep-link/resume jump in start(). Three cases, all bounded cost:
  //  1. idx already rendered (within [renderedStart, renderedCount)) — just
  //     scroll, no DOM write.
  //  2. idx is a close forward jump — cheap single-write contiguous fill via
  //     renderUpTo() (unchanged from the original deep-link perf fix).
  //  3. idx is a far jump (forward or backward, e.g. a deep link near verse
  //     5,846, or a search/kept-row jump across the whole dataset) —
  //     windowJumpTo() renders a small bounded window instead of everything
  //     in between. This is what actually fixes the multi-second hang risk;
  //     see windowJumpTo()'s comment for the measured before/after numbers.
  function jumpToIndex(idx) {
    const alreadyRendered = idx >= renderedStart && idx < renderedCount;
    if (!alreadyRendered) {
      const forwardGap = idx - renderedCount;
      if (idx >= renderedCount && forwardGap <= CONTIGUOUS_FILL_LIMIT) {
        renderUpTo(idx);
      } else {
        windowJumpTo(idx);
      }
    }
    requestAnimationFrame(() => {
      const el = feedEl.querySelector(`.verse-card[data-idx="${idx}"]`);
      if (el) el.scrollIntoView({ block: "start" });
    });
  }

  // ---------- Keyboard feed navigation ----------
  // The feed region (html/body overflow:hidden, #feed owns its own
  // overflow-y:scroll) has no tabindex and is never a focus target, and
  // Arrow/PageDown keys were never wired to it — so a keyboard-only user
  // (no mouse, no touchscreen) had literally no way to move past the first
  // rendered batch of cards short of Tabbing through all 3 action buttons
  // on each of up to 5,846 cards one at a time. Mirrors jumpToIndex's own
  // single-write renderUpTo() so this never reintroduces the old per-batch
  // deep-link stall.
  function moveVerse(delta) {
    if (!verses.length) return;
    const next = Math.min(Math.max(currentIdx + delta, 0), verses.length - 1);
    if (next === currentIdx) return;
    currentIdx = next;
    jumpToIndex(next);
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

  // ---------- Notes sheet ----------
  // The per-verse "Note" action (private reflection textarea, opened from the
  // detail sheet) only ever wrote to localStorage keyed by verse id, with no
  // way to see or revisit which verses had notes — the same write-only gap
  // the Kept sheet fixed for likes, but left open for notes. Once a noted
  // verse scrolled out of the render batch, the only way back to it was
  // re-scrolling thousands of verses to find it again.
  function removeNote(id) {
    delete notes[id];
    saveNotes(notes);
    const btn = feedEl.querySelector(`.note-btn[data-id="${id}"] .action-count`);
    if (btn) btn.textContent = "Note";
    updateNotesCount();
  }

  function renderNotesList() {
    const withNotes = verses.filter((v) => notes[v.id]);

    if (withNotes.length === 0) {
      notesListEl.innerHTML = `<p class="kept-empty">No notes yet — tap any verse, then write a private reflection in the sheet.</p>`;
      return;
    }

    notesListEl.innerHTML = withNotes
      .map(
        (v) => `
      <div class="kept-row">
        <button class="kept-row-main" data-id="${v.id}">
          <span class="kept-row-tag">${escapeHtml(v.book)} ${v.chapter}:${v.verse} &middot; ${escapeHtml(v.parsha || "")}</span>
          <span class="kept-row-text">${escapeHtml(truncate(notes[v.id], 110))}</span>
        </button>
        <button class="kept-row-remove" data-id="${v.id}" aria-label="Delete note">&times;</button>
      </div>`
      )
      .join("");
  }

  function updateNotesCount() {
    const n = Object.keys(notes).length;
    if (notesBtn) notesBtn.textContent = n ? `Notes (${n})` : "Notes";
  }

  function openNotesSheet() {
    renderNotesList();
    openModal(notesSheet);
  }

  function closeNotesSheet() {
    closeModal(notesSheet);
  }

  function openKeptSheet() {
    renderKeptList();
    openModal(keptSheet);
  }

  function closeKeptSheet() {
    closeModal(keptSheet);
  }

  // ---------- Verse search ----------
  // The parsha navigator could only jump to the *start* of one of the 54
  // weekly portions — with 5,846 verses and no text search, finding a
  // specific passage (e.g. "let there be light", or a half-remembered
  // phrase) meant manually scrolling or already knowing which parsha it's
  // in. Sibling apps Shloka and Versling already ship verse search; Pasuk
  // and Gatha did not. Reuses the same jumpToIndex() used by the parsha
  // rows and kept-sheet, so no new perf-unsafe jump path is introduced.
  function renderSearchResults(query) {
    const q = query.trim().toLowerCase();
    if (!q) {
      parshaSearchResultsEl.hidden = true;
      parshaListEl.hidden = false;
      parshaSheetFooterEl.hidden = false;
      return;
    }
    parshaListEl.hidden = true;
    parshaSheetFooterEl.hidden = true;
    parshaSearchResultsEl.hidden = false;

    const rawQuery = query.trim();
    const plainQuery = stripNiqqud(rawQuery);
    const matches = verses
      .map((v, idx) => ({ v, idx }))
      .filter(({ v }) =>
        v.translation.toLowerCase().includes(q) ||
        v.hebrew.includes(rawQuery) ||
        (plainQuery && (v.hebrewPlain || v.hebrew).includes(plainQuery)) ||
        v.parsha.toLowerCase().includes(q) ||
        v.book.toLowerCase().includes(q)
      )
      .slice(0, 40);

    if (!matches.length) {
      parshaSearchResultsEl.innerHTML = `<p class="kept-empty">No verses match "${escapeHtml(query)}".</p>`;
      return;
    }

    parshaSearchResultsEl.innerHTML = matches
      .map(
        ({ v, idx }) => `
      <button class="parsha-result-item" data-idx="${idx}">
        <span class="kept-row-tag">${escapeHtml(v.book)} ${v.chapter}:${v.verse} &middot; ${escapeHtml(v.parsha || "")}</span>
        <span class="kept-row-text">${escapeHtml(truncate(v.translation, 110))}</span>
      </button>`
      )
      .join("");
  }

  function openParshaSheet() {
    renderParshaList();
    parshaSearchEl.value = "";
    renderSearchResults("");
    openModal(parshaSheet);
  }

  function closeParshaSheet() {
    closeModal(parshaSheet);
  }

  function openSheet(id) {
    const v = verses.find((x) => x.id === id);
    if (!v) return;
    sheet.querySelector(".sheet-kicker").textContent =
      `${v.book} ${v.chapter}:${v.verse} · Parashat ${v.parsha}`;
    sheet.querySelector(".sheet-chapter-title").textContent = v.parsha;
    sheet.querySelector(".sheet-chapter-summary").textContent = v.parshaSummary;
    sheet.querySelector(".sheet-hebrew").setAttribute("lang", "he");
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
      updateNotesCount();
    };

    openModal(sheet);
  }

  function closeSheet() {
    closeModal(sheet);
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

    const nBtn = document.createElement("button");
    nBtn.className = "kept-btn notes-btn";
    nBtn.type = "button";
    nBtn.setAttribute("aria-label", "Your notes");
    nBtn.addEventListener("click", openNotesSheet);
    document.body.appendChild(nBtn);
    notesBtn = nBtn;
    updateNotesCount();
  }

  async function start() {
    startBtn.disabled = true;
    startBtn.textContent = "Loading...";
    try {
      verses = await fetchData();
      // Precompute the undotted (niqqud-stripped) Hebrew once per verse so
      // every search keystroke doesn't re-run the regex over all 5,846
      // verses — and so plain-Hebrew queries (see stripNiqqud() above) match.
      verses.forEach((v) => { v.hebrewPlain = stripNiqqud(v.hebrew); });
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
  parshaSearchEl.addEventListener("input", () => renderSearchResults(parshaSearchEl.value));
  parshaSearchResultsEl.addEventListener("click", (e) => {
    const item = e.target.closest(".parsha-result-item");
    if (!item) return;
    const idx = parseInt(item.dataset.idx, 10);
    closeParshaSheet();
    jumpToIndex(idx);
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
  notesClose.addEventListener("click", closeNotesSheet);
  notesBackdrop.addEventListener("click", closeNotesSheet);
  notesListEl.addEventListener("click", (e) => {
    const removeBtn = e.target.closest(".kept-row-remove");
    if (removeBtn) { removeNote(removeBtn.dataset.id); renderNotesList(); return; }
    const row = e.target.closest(".kept-row-main");
    if (row) {
      closeNotesSheet();
      openSheet(row.dataset.id);
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !sheet.hidden) closeSheet();
    if (e.key === "Escape" && !parshaSheet.hidden) closeParshaSheet();
    if (e.key === "Escape" && !keptSheet.hidden) closeKeptSheet();
    if (e.key === "Escape" && !notesSheet.hidden) closeNotesSheet();

    if (e.key === "Tab" && activeModal) {
      const panel = activeModal.querySelector(".sheet-panel");
      const focusables = focusableIn(panel);
      if (!focusables.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (!panel.contains(document.activeElement)) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }

    // Keyboard-only feed navigation (see moveVerse() above). Only active
    // once the feed has started, no modal is open, and focus isn't inside
    // a text field (so typing in the note/search textareas is unaffected).
    if (!activeModal && !feedEl.hidden) {
      const tag = document.activeElement ? document.activeElement.tagName : "";
      const typing = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
      if (!typing) {
        if (e.key === "ArrowDown" || e.key === "PageDown") {
          e.preventDefault();
          moveVerse(1);
        } else if (e.key === "ArrowUp" || e.key === "PageUp") {
          e.preventDefault();
          moveVerse(-1);
        }
      }
    }
  });

  // Picks up likes/notes written by another tab/window of this same app
  // (e.g. two tabs open on the same device, or the OS restoring tabs) so
  // this tab's UI — and its own next write, which would otherwise silently
  // clobber the other tab's change — never works from a stale snapshot.
  // likes/notes are `const` bindings closed over by every render/toggle
  // function above, so refresh them in place (clear + repopulate) rather
  // than reassigning, which would desync the closures.
  window.addEventListener("storage", (e) => {
    if (e.key === LS_LIKES) {
      const fresh = loadSet(LS_LIKES);
      likes.clear();
      fresh.forEach((id) => likes.add(id));
      feedEl.querySelectorAll(".like-btn").forEach((btn) => {
        const liked = likes.has(btn.dataset.id);
        btn.classList.toggle("liked", liked);
        const count = btn.querySelector(".action-count");
        if (count) count.textContent = liked ? "Kept" : "Keep";
      });
      updateKeptCount();
      if (!keptSheet.hidden) renderKeptList();
    } else if (e.key === LS_NOTES) {
      const fresh = loadNotes();
      Object.keys(notes).forEach((k) => delete notes[k]);
      Object.assign(notes, fresh);
      feedEl.querySelectorAll(".note-btn").forEach((btn) => {
        const count = btn.querySelector(".action-count");
        if (count) count.textContent = notes[btn.dataset.id] ? "Noted" : "Note";
      });
      updateNotesCount();
      if (!notesSheet.hidden) renderNotesList();
    }
  });

  if (hasDeepLinkHash) start();

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    });
  }
})();
