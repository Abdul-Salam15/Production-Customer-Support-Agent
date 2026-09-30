/* RelayPay Voice Support — customer accounts + call history (prototype only; no backend).
   Replace CUSTOMERS / call history with API data. Customers only see what they heard on the call:
   never the specialist's name, internal notes, or the transcript. */
(function () {
  'use strict';
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  var DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  var MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  var pad = function (n) { return (n < 10 ? '0' : '') + n; };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };

  var NOW = Date.now();
  function daysAgo(n, hh, mm) { var d = new Date(); d.setDate(d.getDate() - n); d.setHours(hh, mm, 0, 0); return d; }
  function hoursAgo(h) { return new Date(NOW - h * 3600 * 1000); } // matches queue.js createdAt for shared cases

  // status: 'resolved' | 'in_progress' | 'callback' (callback needs callbackAt: Date)
  var SHARED = (window.RELAY_SHARED && window.RELAY_SHARED.transcripts) || {};
  var GREETING = 'Hello, this is RelayPay support. I\u2019m an AI agent and this call is recorded. How can I help?';
  // duration: seconds of the phone call itself. resolvedAt: when the case closed (agent-only calls close when the call ends).
  var CUSTOMERS = [{
    name: 'Amara Okafor', business: 'LagosLedger', email: 'amara@lagosledger.example', password: 'relaypay-demo',
    calls: [
      { at: daysAgo(0, 9, 14), duration: 62, summary: 'Asked about the estimated arrival for a transaction.', status: 'resolved', ref: 'RP-4824',
        transcript: [
          { speaker: 'agent', at: 2, text: GREETING },
          { speaker: 'customer', at: 8, text: 'When will transaction TXN-9214 arrive? We sent it this morning.' },
          { speaker: 'agent', at: 14, text: 'I can check that. To confirm the account, what is the registered business name?' },
          { speaker: 'customer', at: 19, text: 'LagosLedger.' },
          { speaker: 'agent', at: 26, text: 'Thank you, the account is verified. I\u2019m checking transaction records now.' },
          { speaker: 'agent', at: 38, text: 'TXN-9214 was sent at 08:52 and is with the receiving bank. It should arrive by the end of today.' },
          { speaker: 'customer', at: 51, text: 'Great, that\u2019s all I needed.' },
          { speaker: 'agent', at: 55, text: 'Glad I could help. Your reference for this call is RP-4824. Thanks for calling RelayPay support.' }
        ] },
      { at: hoursAgo(70), duration: 149, resolvedAt: hoursAgo(48), summary: 'Disputed a fee on a completed transaction.', status: 'resolved', ref: 'RP-4802', transcript: SHARED['RP-4802'] },
      { at: daysAgo(7, 11, 5), duration: 51, summary: 'Asked how long international payouts take.', status: 'resolved', ref: 'RP-4795',
        transcript: [
          { speaker: 'agent', at: 2, text: GREETING },
          { speaker: 'customer', at: 7, text: 'How long do international payouts take?' },
          { speaker: 'agent', at: 12, text: 'Most international payouts arrive within one to two business days. Some corridors and receiving banks can take up to three.' },
          { speaker: 'customer', at: 26, text: 'And to Nairobi?' },
          { speaker: 'agent', at: 30, text: 'Payouts to Kenyan banks usually arrive within one business day. If a payout hasn\u2019t arrived after two, call us with the reference and I can check it.' },
          { speaker: 'customer', at: 44, text: 'Thanks.' },
          { speaker: 'agent', at: 47, text: 'You\u2019re welcome. Your reference for this call is RP-4795. Thanks for calling RelayPay support.' }
        ] },
      { at: hoursAgo(336), duration: 136, summary: 'Requested help verifying a new team member.', status: 'in_progress', ref: 'RP-4790', transcript: SHARED['RP-4790'] }
    ]
  }];
  var STATUS = {
    resolved: { label: 'Resolved', cls: 'resolved' },
    in_progress: { label: 'In progress', cls: 'progress' },
    callback: { label: 'Waiting for callback', cls: 'callback' }
  };
  var KEY = 'relaypay-proto-customer';
  var ui = { customer: null, open: null, tx: null };
  CUSTOMERS[0].calls.forEach(function (call) {
    if (call.status === 'resolved' && !call.resolvedAt) call.resolvedAt = new Date(call.at.getTime() + call.duration * 1000);
  });

  function fmtStamp(d) { return d.getDate() + ' ' + MONTHS[d.getMonth()] + ', ' + pad(d.getHours()) + ':' + pad(d.getMinutes()); }
  function fmtDuration(sec) { var m = Math.floor(sec / 60), s = sec % 60; return m ? m + 'm ' + s + 's' : s + 's'; }
  function fmtClock(sec) { return pad(Math.floor(sec / 60)) + ':' + pad(sec % 60); }
  function transcriptHTML(list) {
    return list.map(function (t) {
      var time = '<span class="call-transcript__time tabular">' + fmtClock(t.at) + '</span>';
      if (t.type === 'form') {
        return '<li class="call-transcript__item call-transcript__item--form">' +
          '<span class="call-transcript__speaker"><span class="call-transcript__speaker-name">You</span>' + time + '</span>' +
          '<div class="call-transcript__form">' +
            '<p class="call-transcript__form-title">Form submitted <span class="call-transcript__form-note">\u00b7 typed, not spoken</span></p>' +
            '<dl class="call-transcript__form-fields">' +
              '<dt>Name</dt><dd>' + esc(t.name) + '</dd>' +
              '<dt>Email</dt><dd>' + esc(t.email) + '</dd>' +
              '<dt>Callback time</dt><dd class="tabular">' + esc(t.callbackTime) + ' ' + esc(t.callbackTimezone) + '</dd>' +
              (t.notes ? '<dt>Note</dt><dd>' + esc(t.notes) + '</dd>' : '') +
            '</dl>' +
          '</div></li>';
      }
      return '<li class="call-transcript__item call-transcript__item--' + t.speaker + '">' +
        '<span class="call-transcript__speaker"><span class="call-transcript__speaker-name">' + (t.speaker === 'agent' ? 'RelayPay' : 'You') + '</span>' + time + '</span>' +
        '<span class="call-transcript__text">' + esc(t.text) + '</span></li>';
    }).join('');
  }
  function isToday(d) { var n = new Date(); return d.toDateString() === n.toDateString(); }
  function fmtDay(d) { return DAYS[d.getDay()] + ' ' + d.getDate() + ' ' + MONTHS[d.getMonth()]; }
  function fmtWhen(d) { return (isToday(d) ? 'Today' : fmtDay(d)) + ', ' + pad(d.getHours()) + ':' + pad(d.getMinutes()); }
  var findCustomer = function (email) { var e = String(email || '').trim().toLowerCase(); return CUSTOMERS.filter(function (c) { return c.email.toLowerCase() === e; })[0]; };

  /* ---------- Views (hash routed: #login, #signup, #history; anything else = call page) ---------- */
  var VIEWS = ['login', 'signup', 'history'];
  function route() {
    var v = location.hash.slice(1);
    if (v === 'history' && !ui.customer) v = 'login';
    if ((v === 'login' || v === 'signup') && ui.customer) v = 'history';
    var isView = VIEWS.indexOf(v) >= 0;
    $('#main').hidden = isView;
    $$('[data-view]').forEach(function (el) { el.hidden = el.dataset.view !== v; });
    if (isView) {
      if (v === 'history') renderHistory();
      window.scrollTo(0, 0);
      var hd = $('[data-view="' + v + '"] [data-view-heading]'); if (hd) hd.focus({ preventScroll: true });
    } else if (v) {
      var target = document.getElementById(v); if (target) window.scrollTo(0, target.getBoundingClientRect().top + window.scrollY);
    }
  }
  function go(v) { if (location.hash === '#' + v) route(); else location.hash = v; }
  window.addEventListener('hashchange', route);

  /* ---------- Header ---------- */
  function renderHeader() {
    var c = ui.customer;
    $('[data-account-out]').hidden = !!c;
    $('[data-account-in]').hidden = !c;
    if (c) {
      $('[data-account-name]').textContent = c.name.split(' ')[0];
      var n = c.calls.length;
      $('[data-account-count]').textContent = n + (n === 1 ? ' call' : ' calls');
    }
    var sel = $('[data-review-view]'); if (sel) sel.value = c ? 'customer' : 'logged-out';
  }
  function signIn(c) { ui.customer = c; ui.open = null; try { sessionStorage.setItem(KEY, c.email); } catch (e) {} renderHeader(); }
  function signOut() { ui.customer = null; try { sessionStorage.removeItem(KEY); } catch (e) {} renderHeader(); }

  /* ---------- Call history ---------- */
  var CHEVRON = '<svg class="history-row__chevron" viewBox="0 0 12 8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 1.5l5 5 5-5"/></svg>';
  function badge(s) { var st = STATUS[s]; return '<span class="call-badge call-badge--' + st.cls + '">' + st.label + '</span>'; }
  function subtext(call) {
    if (call.status === 'in_progress') return 'A specialist is on this.';
    if (call.status === 'callback' && call.callbackAt) return 'A specialist will contact you by ' + fmtDay(call.callbackAt) + ', ' + pad(call.callbackAt.getHours()) + ':' + pad(call.callbackAt.getMinutes()) + '.';
    return '';
  }
  function statusBlock(call) {
    var sub = subtext(call);
    return '<span class="call-status">' + badge(call.status) + (sub ? '<span class="call-status__sub">' + sub + '</span>' : '') + '</span>';
  }
  function renderHistory() {
    var c = ui.customer; if (!c) return;
    var calls = c.calls.slice().sort(function (a, b) { return b.at - a.at; });
    $('[data-history-empty]').hidden = calls.length > 0;
    $('[data-history-list]').innerHTML = calls.map(function (call, i) {
      var id = 'call-' + call.at.getTime(), open = ui.open === id;
      return '<li class="history-item' + (open ? ' is-open' : '') + '">' +
        '<button class="history-row" type="button" aria-expanded="' + open + '" aria-controls="' + id + '" data-call="' + id + '">' +
          '<span class="history-row__when tabular">' + fmtWhen(call.at) + '</span>' +
          '<span class="history-row__summary">' + esc(call.summary) + '</span>' +
          statusBlock(call) + CHEVRON +
        '</button>' +
        '<div class="history-detail" id="' + id + '"' + (open ? '' : ' hidden') + '>' +
          '<dl class="history-detail__list">' +
            '<div><dt>Created</dt><dd class="tabular">' + fmtStamp(call.at) + '</dd></div>' +
            '<div><dt>Resolved</dt><dd class="tabular">' + (call.resolvedAt ? fmtStamp(call.resolvedAt) : '<span class="history-detail__muted">Not yet resolved</span>') + '</dd></div>' +
            '<div><dt>Call duration</dt><dd class="tabular">' + fmtDuration(call.duration) + '</dd></div>' +
            '<div><dt>Status</dt><dd>' + statusBlock(call) + '</dd></div>' +
            (call.ref ? '<div><dt>Reference</dt><dd class="tabular">' + call.ref + '</dd></div>' : '') +
            '<div class="history-detail__wide"><dt>Summary</dt><dd>' + esc(call.summary) + '</dd></div>' +
          '</dl>' +
          (call.transcript ? (function () {
            var txOpen = ui.tx === id, txId = id + '-tx';
            return '<button class="history-detail__tx-toggle" type="button" data-tx="' + id + '" aria-expanded="' + txOpen + '" aria-controls="' + txId + '">' + (txOpen ? 'Hide transcript' : 'View full transcript') + '</button>' +
              '<ol class="call-transcript" id="' + txId + '" aria-label="Transcript"' + (txOpen ? '' : ' hidden') + '>' + transcriptHTML(call.transcript) + '</ol>';
          })() : '') +
        '</div>' +
      '</li>';
    }).join('');
  }
  $('[data-history-list]').addEventListener('click', function (e) {
    var t = e.target.closest('[data-tx]');
    if (t) { ui.tx = ui.tx === t.dataset.tx ? null : t.dataset.tx; renderHistory(); $('[data-tx="' + t.dataset.tx + '"]').focus(); return; }
    var b = e.target.closest('[data-call]'); if (!b) return;
    ui.open = ui.open === b.dataset.call ? null : b.dataset.call;
    renderHistory();
    $('[data-call="' + b.dataset.call + '"]').focus();
  });

  /* ---------- Forms ---------- */
  function bindForm(form, rules, onValid) {
    var touched = {};
    function check(k, force) {
      if (force) touched[k] = true;
      var msg = rules[k](), f = $('[data-field="' + k + '"]', form), err = $('.field__error', f), input = $('.field__input', f);
      var show = !!(touched[k] && msg);
      err.textContent = show ? msg : ''; err.hidden = !show;
      input.setAttribute('aria-invalid', show ? 'true' : 'false');
      return !msg;
    }
    form.addEventListener('focusout', function (e) { var f = e.target.closest('[data-field]'); if (f && rules[f.dataset.field]) { touched[f.dataset.field] = true; check(f.dataset.field); } });
    form.addEventListener('input', function () { Object.keys(touched).forEach(function (k) { if (touched[k]) check(k); }); });
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var first = null;
      Object.keys(rules).forEach(function (k) { if (!check(k, true) && !first) first = k; });
      if (first) { $('[data-field="' + first + '"] .field__input', form).focus(); return; }
      onValid();
    });
    return { reset: function () { form.reset(); touched = {}; Object.keys(rules).forEach(function (k) { check(k); }); } };
  }
  var val = function (s) { return $(s).value.trim(); };
  var emailRule = function (s) { return function () { var v = val(s); if (!v) return 'Enter your email'; return EMAIL_RE.test(v) ? '' : 'Enter a valid email address'; }; };

  var clErr = $('[data-cl-error]');
  var login = bindForm($('[data-customer-login]'), {
    email: emailRule('#cl-email'),
    password: function () { return $('#cl-password').value ? '' : 'Enter your password'; }
  }, function () {
    var c = findCustomer(val('#cl-email'));
    if (!c || c.password !== $('#cl-password').value) { clErr.hidden = false; $('#cl-password').value = ''; $('#cl-email').focus(); return; }
    clErr.hidden = true; login.reset(); signIn(c); go('');
  });
  $('[data-customer-login]').addEventListener('input', function () { clErr.hidden = true; });

  var signup = bindForm($('[data-customer-signup]'), {
    name: function () { return val('#cs-name').length < 2 ? 'Enter your full name' : ''; },
    email: function () { var m = emailRule('#cs-email')(); if (m) return m; return findCustomer(val('#cs-email')) ? 'An account with this email already exists. Log in instead.' : ''; },
    password: function () { return $('#cs-password').value.length < 8 ? 'Use at least 8 characters' : ''; },
    confirm: function () { var c = $('#cs-confirm').value; if (!c) return 'Confirm your password'; return c !== $('#cs-password').value ? "Passwords don't match" : ''; }
  }, function () {
    var c = { name: val('#cs-name'), business: null, email: val('#cs-email'), password: $('#cs-password').value, calls: [] };
    CUSTOMERS.push(c); signup.reset(); signIn(c); go('');
  });

  /* ---------- Prototype: View as ---------- */
  var viewSel = $('[data-review-view]');
  if (viewSel) viewSel.addEventListener('change', function (e) {
    var v = e.target.value;
    if (v === 'specialist' || v === 'admin') { location.href = 'support-queue.html?as=' + v; return; }
    if (v === 'customer') signIn(CUSTOMERS[0]); else signOut();
    go('');
  });
  // Review toolbar call-state changes bring you back to the call page
  $$('.review-toolbar__body select:not([data-review-view]), .review-toolbar__body button, .review-toolbar__body input').forEach(function (el) {
    el.addEventListener(el.tagName === 'BUTTON' ? 'click' : 'change', function () { if (VIEWS.indexOf(location.hash.slice(1)) >= 0) go(''); });
  });

  $('[data-action="log-out"]').addEventListener('click', function () { signOut(); go(''); });

  /* ---------- Init ---------- */
  var as = new URLSearchParams(location.search).get('as'), saved = null;
  try { saved = sessionStorage.getItem(KEY); } catch (e) {}
  if (as === 'customer') signIn(CUSTOMERS[0]);
  else if (as === 'logged-out') signOut();
  else if (saved && findCustomer(saved)) signIn(findCustomer(saved));
  else renderHeader();
  route();

  window.RelayCustomer = { customers: CUSTOMERS, signIn: signIn, signOut: signOut, go: go };
})();
