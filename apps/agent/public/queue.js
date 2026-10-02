/* RelayPay Support Queue — real data via GET/PATCH/POST /api/dashboard/cases/*
   (apps/agent/src/dashboard/routes.ts). Loaded via window.RelayAuth.api, which
   attaches the signed-in specialist's Supabase session as a bearer token. */
(function () {
  'use strict';

  var CURRENT_USER = null;
  var CASES = [];
  // 'loading' until the first fetch returns, so a refresh doesn't flash
  // "No open cases right now" with 0 counts while the request is in flight.
  var loadState = 'loading';
  var TOOL_CALLS = [];
  var toolCallsTimer = null;
  var toolCallsFor = null;

  /* ---------- Helpers ---------- */
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var H = 3600 * 1000;
  var PRIORITY_ORDER = { high: 0, medium: 1, low: 2 };
  var PRIORITY_LABEL = { high: 'High', medium: 'Medium', low: 'Low' };
  var STATUS_LABEL = { open: 'Open', in_progress: 'In progress', closed: 'Closed' };
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  function relTime(iso) {
    var m = Math.max(0, Math.round((Date.now() - new Date(iso)) / 60000));
    if (m < 1) return 'just now';
    if (m < 60) return m + 'm ago';
    var h = Math.floor(m / 60);
    if (h < 24) return h + 'h ago';
    return Math.floor(h / 24) + 'd ago';
  }
  function absTime(iso) {
    var d = new Date(iso);
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) + ', ' +
      d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  }
  var isOpen = function (c) { return c.status !== 'closed'; };
  var find = function (ref) { return CASES.filter(function (c) { return c.reference === ref; })[0]; };
  function replaceCase(shaped) {
    var i = CASES.map(function (c) { return c.reference; }).indexOf(shaped.reference);
    if (i >= 0) CASES[i] = shaped; else CASES.push(shaped);
  }

  /* ---------- UI state ---------- */
  var ui = { status: 'open', category: 'all', priority: 'all', selected: null, noteOpen: false, pendingClose: {}, actionBusy: false };

  function visibleCases() {
    return CASES.filter(function (c) {
      var closedNow = c.status === 'closed' && !ui.pendingClose[c.reference];
      if (ui.status === 'open' && closedNow) return false;
      if (ui.status === 'closed' && !closedNow) return false;
      if (ui.priority !== 'all' && c.priority !== ui.priority) return false;
      return ui.category === 'all' || c.category === ui.category;
    }).sort(function (a, b) {
      return (PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]) ||
        (new Date(a.createdAt) - new Date(b.createdAt));
    });
  }

  /* ---------- Queue ---------- */
  function rowHTML(c) {
    var ageH = (Date.now() - new Date(c.createdAt)) / H;
    var cls = ['case-row', 'case-row--' + c.priority];
    if (c.reference === ui.selected) cls.push('case-row--selected');
    if (ui.pendingClose[c.reference]) cls.push('case-row--resolving');
    else if (c.status === 'closed') cls.push('case-row--closed');
    var who = c.companyName
      ? '<span class="case-row__company">' + esc(c.companyName) + ' · ' + esc(c.contactName) + '</span>'
      : c.signedInAccount
        ? '<span class="case-row__company case-row__company--unverified">Signed in · no business account</span>'
        : '<span class="case-row__company case-row__company--unverified">Unverified caller</span>';
    var claim = c.status === 'closed'
      ? '<span class="case-row__claim" style="color:var(--c-success)">Resolved ' + relTime(c.resolvedAt) + '</span>'
      : c.claimedBy ? '<span class="case-row__claim">Claimed by ' + (c.claimedBy === CURRENT_USER ? 'you' : esc(c.claimedBy)) + '</span>' : '';
    return '<li><button type="button" class="' + cls.join(' ') + '" data-ref="' + c.reference + '"' +
      (c.reference === ui.selected ? ' aria-current="true"' : '') + '>' +
      '<span class="case-row__line1">' +
        '<span class="case-row__ref tabular">' + c.reference + '</span>' +
        '<span class="priority-badge priority-badge--' + c.priority + '">' + PRIORITY_LABEL[c.priority] + '</span>' +
        '<span class="case-row__category">' + c.category + '</span>' +
      '</span>' +
      '<span class="case-row__age tabular" title="Created ' + absTime(c.createdAt) + '">' + relTime(c.createdAt) +
        '<span class="case-row__age-bar" aria-hidden="true"><span style="width:' + Math.min(100, Math.max(6, ageH / 24 * 100)) + '%"></span></span>' +
      '</span>' +
      who +
      '<span class="case-row__summary">' + esc(c.summary) + '</span>' +
      claim +
    '</button></li>';
  }

  function renderQueue() {
    var list = visibleCases();
    var q = $('[data-queue]');
    if (loadState === 'loading') {
      q.innerHTML = '<div class="queue-empty" role="status"><p class="queue-empty__text">Loading cases…</p></div>';
      return;
    }
    if (loadState === 'error' && !CASES.length) {
      q.innerHTML = '<div class="queue-empty" role="alert"><p class="queue-empty__title">Couldn&rsquo;t load cases.</p>' +
        '<p class="queue-empty__text">Check your connection, then refresh the page.</p></div>';
      return;
    }
    if (!list.length) {
      var pr = ui.priority === 'all' ? '' : ui.priority + '-priority ';
      var catTxt = ui.category === 'all' ? '' : ' in ' + ui.category;
      var title = ui.status === 'closed' ? 'No closed ' + pr + 'cases' + catTxt + '.' : ui.status === 'all' ? 'No ' + pr + 'cases' + catTxt + '.' : 'No open ' + pr + 'cases' + catTxt + ' right now.';
      q.innerHTML = '<div class="queue-empty"><p class="queue-empty__title">' + title + '</p>' +
        '<p class="queue-empty__text">New cases appear here when the voice agent escalates a call.</p></div>';
      return;
    }
    q.innerHTML = '<ul class="queue-list">' + list.map(rowHTML).join('') + '</ul>';
  }

  function renderCounts() {
    var cat = function (c) {
      return (ui.category === 'all' || c.category === ui.category) && (ui.priority === 'all' || c.priority === ui.priority);
    };
    var open = CASES.filter(function (c) { return cat(c) && (isOpen(c) || ui.pendingClose[c.reference]); }).length;
    var closed = CASES.filter(function (c) { return cat(c) && c.status === 'closed'; }).length;
    var pending = loadState === 'loading';
    $('[data-count="open"]').textContent = pending ? '–' : open;
    $('[data-count="closed"]').textContent = pending ? '–' : closed;
    $('[data-count="all"]').textContent = pending ? '–' : CASES.filter(cat).length;
  }

  /* ---------- Detail ---------- */
  function linkedHTML(l) {
    if (!l) return '<span class="info-grid__sub">None linked</span>';
    var tone = { warn: 'info-grid__warn', bad: 'info-grid__bad', ok: 'info-grid__ok' }[l.tone] || '';
    return esc(l.type) + ' <span class="tabular">' + esc(l.reference) + '</span>' +
      '<span class="info-grid__sub ' + tone + '">' + esc(l.status) + '</span>';
  }
  function accountHTML(c) {
    var a = c.linkedAccount || {};
    if (!c.companyName && c.signedInAccount) {
      return '<span class="info-grid__warn">No business account</span><span class="info-grid__sub">Signed in as ' +
        esc(c.signedInAccount.email) + '</span>';
    }
    if (!c.companyName) {
      return '<span class="info-grid__warn">Not matched</span><span class="info-grid__sub">Unverified caller — confirm their identity on the callback before discussing any account details.</span>';
    }
    var tone = a.accountStatus === 'Active' ? '' : 'info-grid__warn';
    return esc(c.companyName) + '<span class="info-grid__sub">' + esc(a.plan) + ' plan · <span class="' + tone + '">' + esc(a.accountStatus) + '</span></span>';
  }

  function fmtClock(sec) {
    sec = sec || 0;
    var m = Math.floor(sec / 60), s = sec % 60;
    return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }
  function transcriptItemHTML(t) {
    var time = '<span class="case-transcript__time tabular">' + fmtClock(t.at) + '</span>';
    if (t.type === 'form') {
      return '<li class="case-transcript__item case-transcript__item--form">' +
        '<span class="case-transcript__speaker"><span class="case-transcript__speaker-name">Customer</span>' + time + '</span>' +
        '<div class="case-transcript__form">' +
          '<p class="case-transcript__form-title">Form submitted <span class="case-transcript__form-note">· typed, not spoken</span></p>' +
          '<dl class="case-transcript__form-fields">' +
            '<dt>Name</dt><dd>' + esc(t.name) + '</dd>' +
            '<dt>Email</dt><dd>' + esc(t.email) + '</dd>' +
            (t.callbackTime ? '<dt>Callback time</dt><dd class="tabular">' + esc(t.callbackTime) + '</dd>' : '') +
          '</dl>' +
        '</div></li>';
    }
    return '<li class="case-transcript__item case-transcript__item--' + t.speaker + '">' +
      '<span class="case-transcript__speaker"><span class="case-transcript__speaker-name">' + (t.speaker === 'agent' ? 'Agent' : 'Customer') + '</span>' + time + '</span>' +
      '<span class="case-transcript__text">' + esc(t.text) + '</span></li>';
  }

  function busyAttrs(label) {
    return ui.actionBusy ? ' disabled aria-busy="true"' : '';
  }
  function actionsHTML(c) {
    var busy = busyAttrs();
    if (c.status === 'closed') {
      return '<span class="case-actions__resolved"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 8.5l3 3 7-7"/></svg>Resolved ' + relTime(c.resolvedAt) + (c.claimedBy ? ' by ' + esc(c.claimedBy) : '') + '</span>' +
        '<button class="btn btn--secondary action-note" type="button" data-act="note" aria-expanded="' + ui.noteOpen + '"' + busy + '>Add note</button>';
    }
    var claim = c.claimedBy
      ? '<span class="case-actions__claimed action-claimed"><span class="case-actions__claimed-text">Claimed by<strong>' + (c.claimedBy === CURRENT_USER ? 'you (' + esc(CURRENT_USER) + ')' : esc(c.claimedBy)) + '</strong></span>' +
        '<button class="case-actions__unclaim action-unclaim" type="button" data-act="unclaim" aria-label="Unclaim ' + c.reference + '"' + busy + '>Unclaim</button></span>'
      : '<button class="btn btn--primary action-claim" type="button" data-act="claim"' + busy + '>Claim case</button>';
    return claim +
      '<button class="btn btn--secondary action-note" type="button" data-act="note" aria-expanded="' + ui.noteOpen + '" aria-controls="note-form"' + busy + '>Add note</button>' +
      '<button class="btn btn--success action-resolve" type="button" data-act="resolve"' + busy + '>Mark resolved</button>';
  }

  function fmtToolCallTime(iso) {
    return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }
  function toolCallRowHTML(t) {
    return '<li class="tool-call tool-call--' + (t.status === 'error' ? 'bad' : 'ok') + '">' +
      '<span class="tool-call__time tabular">' + fmtToolCallTime(t.created_at) + '</span>' +
      '<span class="tool-call__line"><span class="tool-call__name">' + esc(t.tool_name) + '</span> — ' + esc(t.purpose || '') + '</span>' +
    '</li>';
  }
  function toolCallsPanelHTML() {
    var list = TOOL_CALLS.slice().reverse();
    return '<section class="tool-calls-live" aria-live="polite">' +
      '<div class="tool-calls-live__head">' +
        '<h2 class="tool-calls-live__title">Tool calls, live</h2>' +
        '<span class="tool-calls-live__count tabular">' + TOOL_CALLS.length + ' call' + (TOOL_CALLS.length === 1 ? '' : 's') + '</span>' +
      '</div>' +
      (list.length
        ? '<ol class="tool-calls-live__list">' + list.map(toolCallRowHTML).join('') + '</ol>'
        : '<p class="tool-calls-live__empty">No tool calls yet for this call.</p>') +
    '</section>';
  }

  function renderDetail() {
    var pane = $('[data-detail]');
    var c = ui.selected && find(ui.selected);
    if (!c) {
      pane.innerHTML = loadState === 'loading' ? '' :
        '<div class="detail-empty"><p class="detail-empty__text">Select a case to see the details.</p></div>';
      return;
    }
    var statusKey = c.status;
    var transcript = c.transcript || [];
    var notes = (c.notes || []).length
      ? c.notes.map(function (n) {
          return '<li class="notes-list__item"><span class="notes-list__meta"><span>' + esc(String(n.author).split(' ')[0]) + '</span><span class="tabular">' + relTime(n.at) + '</span></span><span>' + esc(n.text) + '</span></li>';
        }).join('')
      : '<li class="notes-list__empty">No notes yet.</li>';

    pane.innerHTML =
      '<article class="case-detail case-detail--' + c.status + '" aria-labelledby="case-title">' +
        '<header class="case-detail__head">' +
          '<div>' +
            '<h1 class="case-detail__title tabular" id="case-title" tabindex="-1">' + c.reference + '</h1>' +
            '<div class="case-detail__meta">' +
              '<span class="priority-badge priority-badge--' + c.priority + '">' + PRIORITY_LABEL[c.priority] + '</span>' +
              '<span class="case-detail__category">' + c.category.charAt(0).toUpperCase() + c.category.slice(1) + '</span>' +
              '<span class="case-detail__meta-sep" aria-hidden="true"></span>' +
              '<span class="status-label status-label--' + statusKey + '">' + STATUS_LABEL[statusKey] + '</span>' +
              (c.status === 'closed' ? '<button class="case-detail__reopen action-reopen" type="button" data-act="reopen" aria-label="Mark ' + c.reference + ' unresolved"' + busyAttrs() + '>Mark unresolved</button>' : '') +
            '</div>' +
          '</div>' +
          '<p class="case-detail__created">Created by voice agent<br><span class="tabular">' + absTime(c.createdAt) + ' · ' + relTime(c.createdAt) + '</span></p>' +
        '</header>' +
        '<p class="case-detail__summary">' + esc(c.summary) + '</p>' +
        '<div class="case-actions">' + actionsHTML(c) + '</div>' +
        '<form class="note-form" id="note-form" data-note-form' + (ui.noteOpen ? '' : ' hidden') + '>' +
          '<label class="sr-only" for="note-input">Note</label>' +
          '<input class="note-form__input" id="note-input" type="text" placeholder="Add a note for this case" maxlength="280" autocomplete="off">' +
          '<button class="btn btn--primary action-note-save" type="submit"' + busyAttrs() + '>Save</button>' +
          '<button class="btn btn--text" type="button" data-act="note-cancel"' + busyAttrs() + '>Cancel</button>' +
        '</form>' +
        '<div class="case-detail__body">' +
          '<section class="detail-section"><h2 class="detail-section__title">Details</h2>' +
            '<dl class="info-grid">' +
              '<div class="info-grid__item info-grid__item--contact"><dt>Contact</dt><dd>' + esc(c.contactName) + '<span class="info-grid__sub">' + esc(c.contactEmail) + '</span></dd></div>' +
              '<div class="info-grid__item info-grid__item--callback"><dt>Preferred callback</dt><dd class="tabular">' + esc(c.callbackTime || 'Not provided') + '</dd></div>' +
              '<div class="info-grid__item info-grid__item--account"><dt>Linked account</dt><dd>' + accountHTML(c) + '</dd></div>' +
              '<div class="info-grid__item info-grid__item--linked"><dt>Transaction or payout</dt><dd>' + linkedHTML(c.linkedTransactionOrPayout) + '</dd></div>' +
            '</dl>' +
          '</section>' +
          (c.reference === toolCallsFor ? toolCallsPanelHTML() : '') +
          '<section class="detail-section"><h2 class="detail-section__title">Full transcript <span class="case-transcript__meta tabular">· ' + transcript.length + ' entries' + (transcript.length ? ' · ' + fmtClock(transcript[transcript.length - 1].at) : '') + '</span></h2>' +
            (transcript.length
              ? '<ol class="case-transcript" tabindex="0" aria-label="Full call transcript">' + transcript.map(transcriptItemHTML).join('') + '</ol>'
              : '<p class="detail-empty__text">No transcript recorded for this case.</p>') +
          '</section>' +
          '<section class="detail-section"><h2 class="detail-section__title">Notes</h2><ul class="notes-list">' + notes + '</ul></section>' +
        '</div>' +
      '</article>';
  }

  function render() { renderCounts(); renderQueue(); renderDetail(); }

  /* ---------- Actions: real API calls via window.RelayAuth.api ---------- */
  function callApi(path, options) { return window.RelayAuth.api(path, options); }

  async function reload() {
    try {
      var data = await callApi('/api/dashboard/cases');
      CASES.splice(0, CASES.length);
      Array.prototype.push.apply(CASES, data.cases);
      if (ui.selected && !find(ui.selected)) ui.selected = null;
      loadState = 'loaded';
      render();
    } catch (e) {
      console.error('Failed to load cases', e);
      if (loadState === 'loading') { loadState = 'error'; render(); }
    }
  }

  async function claim(c) {
    try {
      var updated = await callApi('/api/dashboard/cases/' + encodeURIComponent(c.reference) + '/claim', { method: 'PATCH' });
      replaceCase(updated);
    } catch (e) { console.error('claim failed', e); }
  }
  async function unclaim(c) {
    try {
      var updated = await callApi('/api/dashboard/cases/' + encodeURIComponent(c.reference) + '/unclaim', { method: 'PATCH' });
      replaceCase(updated);
    } catch (e) { console.error('unclaim failed', e); }
  }
  async function addNote(c, text) {
    try {
      var updated = await callApi('/api/dashboard/cases/' + encodeURIComponent(c.reference) + '/notes', { method: 'POST', body: { text: text } });
      replaceCase(updated);
    } catch (e) { console.error('add note failed', e); }
  }
  async function resolve(c) {
    try {
      var updated = await callApi('/api/dashboard/cases/' + encodeURIComponent(c.reference) + '/resolve', { method: 'PATCH' });
      replaceCase(updated);
      if (ui.status === 'open') {
        ui.pendingClose[c.reference] = setTimeout(function () { settlePending(); render(); }, 2500);
      }
    } catch (e) { console.error('resolve failed', e); }
  }
  async function reopen(c) {
    try {
      if (ui.pendingClose[c.reference]) { clearTimeout(ui.pendingClose[c.reference]); delete ui.pendingClose[c.reference]; }
      var updated = await callApi('/api/dashboard/cases/' + encodeURIComponent(c.reference) + '/reopen', { method: 'PATCH' });
      replaceCase(updated);
    } catch (e) { console.error('reopen failed', e); }
  }
  function settlePending() {
    Object.keys(ui.pendingClose).forEach(function (ref) {
      clearTimeout(ui.pendingClose[ref]); delete ui.pendingClose[ref];
      if (ui.selected === ref && ui.status === 'open') ui.selected = null;
    });
  }

  /* ---------- Tool calls, live (case detail pane) ---------- */
  function stopToolCallsPolling() {
    if (toolCallsTimer) { clearInterval(toolCallsTimer); toolCallsTimer = null; }
    toolCallsFor = null;
  }

  async function fetchToolCalls(reference) {
    try {
      var data = await window.RelayAuth.api('/api/dashboard/cases/' + encodeURIComponent(reference) + '/tool-calls');
      TOOL_CALLS = data.toolCalls;
      if (ui.selected === reference) renderDetail();
      return data.callEnded;
    } catch (e) {
      console.error('Failed to load tool calls', e);
      return true;
    }
  }

  // "Live" only matters while the case is still open and the underlying
  // call hasn't ended — once either is true, one more fetch keeps the panel
  // accurate but there's nothing left to poll for.
  async function watchToolCalls(reference) {
    stopToolCallsPolling();
    var c = find(reference);
    if (!c) return;
    toolCallsFor = reference;
    var callEnded = await fetchToolCalls(reference);
    if (c.status === 'closed' || callEnded) return;
    toolCallsTimer = setInterval(async function () {
      if (toolCallsFor !== reference) return;
      var ended = await fetchToolCalls(reference);
      var current = find(reference);
      if (ended || !current || current.status === 'closed') stopToolCallsPolling();
    }, 3000);
  }

  /* ---------- Events ---------- */
  $('[data-queue]').addEventListener('click', function (e) {
    var row = e.target.closest('.case-row');
    if (!row) return;
    ui.selected = row.dataset.ref; ui.noteOpen = false;
    render();
    watchToolCalls(ui.selected);
    var btn = $('.case-row[data-ref="' + ui.selected + '"]'); if (btn) btn.focus({ preventScroll: true });
  });

  $('[data-queue]').addEventListener('keydown', function (e) {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    var rows = $$('.case-row'); var i = rows.indexOf(document.activeElement);
    if (i < 0) return;
    e.preventDefault();
    var next = rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
    next.focus();
  });

  $('[data-detail]').addEventListener('click', async function (e) {
    var b = e.target.closest('[data-act]');
    var c = ui.selected && find(ui.selected);
    if (!b || !c) return;
    if (ui.actionBusy && b.dataset.act !== 'note' && b.dataset.act !== 'note-cancel') return;
    switch (b.dataset.act) {
      case 'claim': ui.actionBusy = true; render(); await claim(c); ui.actionBusy = false; render(); break;
      case 'reopen':
        ui.actionBusy = true; render();
        await reopen(c);
        ui.actionBusy = false; render();
        var ab = $('.action-claim') || $('.action-resolve'); if (ab) ab.focus();
        break;
      case 'unclaim':
        ui.actionBusy = true; render();
        await unclaim(c);
        ui.actionBusy = false; render();
        var cb = $('.action-claim'); if (cb) cb.focus();
        break;
      case 'note': ui.noteOpen = !ui.noteOpen; render(); if (ui.noteOpen) $('#note-input').focus(); break;
      case 'note-cancel': ui.noteOpen = false; render(); $('.action-note').focus(); break;
      case 'resolve':
        ui.actionBusy = true; render();
        await resolve(c);
        ui.actionBusy = false; ui.noteOpen = false; render();
        break;
    }
  });

  $('[data-detail]').addEventListener('submit', async function (e) {
    e.preventDefault();
    if (ui.actionBusy) return;
    var c = find(ui.selected); var input = $('#note-input');
    var text = input.value.trim();
    if (!text) { input.focus(); return; }
    ui.actionBusy = true; render();
    await addNote(c, text);
    ui.actionBusy = false; ui.noteOpen = false; render();
    $('.action-note').focus();
  });

  $('[data-status-toggle]').addEventListener('click', function (e) {
    var b = e.target.closest('[data-status]'); if (!b) return;
    settlePending();
    ui.status = b.dataset.status;
    $$('[data-status]').forEach(function (x) { x.setAttribute('aria-pressed', x === b); });
    var sel = ui.selected && find(ui.selected);
    if (sel && visibleCases().indexOf(sel) < 0) ui.selected = null;
    render();
  });

  $('[data-category-filter]').addEventListener('change', function (e) {
    settlePending();
    ui.category = e.target.value;
    var sel = ui.selected && find(ui.selected);
    if (sel && visibleCases().indexOf(sel) < 0) ui.selected = null;
    render();
  });

  $('[data-priority-filter]').addEventListener('change', function (e) {
    settlePending();
    ui.priority = e.target.value;
    var sel = ui.selected && find(ui.selected);
    if (sel && visibleCases().indexOf(sel) < 0) ui.selected = null;
    render();
  });

  /* ---------- Init: nothing loaded yet — auth.js calls reload() after sign-in ---------- */
  render();

  window.RelayQueue = {
    cases: CASES, render: render, reload: reload,
    setCurrentUser: function (n) { CURRENT_USER = n; render(); },
    claim: claim, unclaim: unclaim, reopen: reopen, addNote: addNote, resolve: resolve,
    stopToolCallsPolling: stopToolCallsPolling
  };
})();
