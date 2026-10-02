/* RelayPay — customer signup + call history (real Supabase Auth +
   /api/customer/* in apps/agent/src/customer/routes.ts). Served at both
   /signup and /customer; /login (support-queue.html) redirects customers
   here after a successful sign-in. */
(function () {
  'use strict';

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  var val = function (sel) { return $(sel).value.trim(); };
  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

  var supabaseClient = null;
  async function initSupabaseClient() {
    var res = await fetch('/api/config');
    var config = await res.json();
    supabaseClient = window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey);
  }

  async function api(path, options) {
    options = options || {};
    var headers = Object.assign({ 'Content-Type': 'application/json' }, options.headers || {});
    var sessionResult = await supabaseClient.auth.getSession();
    var session = sessionResult.data && sessionResult.data.session;
    if (session) headers['Authorization'] = 'Bearer ' + session.access_token;

    var res = await fetch(path, {
      method: options.method || 'GET',
      headers: headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    var data = null;
    try { data = await res.json(); } catch (e) { /* no body */ }
    if (!res.ok) {
      var err = new Error((data && data.error) || 'request_failed');
      err.status = res.status; err.data = data;
      throw err;
    }
    return data;
  }

  function show(screen) {
    $$('[data-screen]').forEach(function (el) { el.hidden = el.dataset.screen !== screen; });
    var h = $('[data-screen="' + screen + '"] [data-screen-heading]');
    if (h) h.focus({ preventScroll: true });
  }

  /* ---------- Password visibility toggle ---------- */
  document.addEventListener('click', function (e) {
    var b = e.target.closest('[data-action="toggle-password"]');
    if (!b) return;
    var field = b.closest('.password-field');
    var input = field && field.querySelector('input');
    if (!input) return;
    var showing = input.type === 'password';
    input.type = showing ? 'text' : 'password';
    b.setAttribute('aria-pressed', showing ? 'true' : 'false');
    b.setAttribute('aria-label', showing ? 'Hide password' : 'Show password');
    $('svg[data-icon="eye"]', b).hidden = showing;
    $('svg[data-icon="eye-off"]', b).hidden = !showing;
  });

  /* ---------- Form validation helper (small, self-contained copy of auth.js's) ---------- */
  function setBusy(button, busy) {
    if (!button) return;
    button.disabled = !!busy;
    button.setAttribute('aria-busy', busy ? 'true' : 'false');
  }

  function bindForm(form, rules, onValid) {
    var touched = {};
    function fieldEl(k) { return form.querySelector('[data-field="' + k + '"]'); }
    function check(k, force) {
      if (force) touched[k] = true;
      var msg = rules[k]();
      var f = fieldEl(k), err = f.querySelector('.field__error'), input = f.querySelector('input');
      var visible = !!(touched[k] && msg);
      if (err) { err.textContent = visible ? msg : ''; err.hidden = !visible; }
      input.setAttribute('aria-invalid', visible ? 'true' : 'false');
      return !msg;
    }
    form.addEventListener('focusout', function (e) {
      var f = e.target.closest('[data-field]');
      if (!f || !rules[f.dataset.field]) return;
      touched[f.dataset.field] = true; check(f.dataset.field);
    });
    form.addEventListener('input', function () {
      Object.keys(touched).forEach(function (k) { if (touched[k]) check(k); });
    });
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var submitBtn = form.querySelector('button[type="submit"]');
      if (submitBtn && submitBtn.getAttribute('aria-busy') === 'true') return;
      var first = null;
      Object.keys(rules).forEach(function (k) { if (!check(k, true) && !first) first = k; });
      if (first) { fieldEl(first).querySelector('input').focus(); return; }
      setBusy(submitBtn, true);
      Promise.resolve(onValid()).finally(function () { setBusy(submitBtn, false); });
    });
    return { reset: function () { form.reset(); touched = {}; Object.keys(rules).forEach(function (k) { check(k); }); } };
  }

  /* ---------- Sign up ---------- */
  var signupErr = $('[data-signup-error]');
  var signup = bindForm($('[data-signup-form]'), {
    name: function () { return val('#cs-name').length < 2 ? 'Enter your full name' : ''; },
    email: function () { var v = val('#cs-email'); if (!v) return 'Enter your email'; return EMAIL_RE.test(v) ? '' : 'Enter a valid email address'; },
    password: function () { return $('#cs-password').value.length < 8 ? 'Use at least 8 characters' : ''; },
    confirm: function () { var c = $('#cs-confirm').value; if (!c) return 'Confirm your password'; return c !== $('#cs-password').value ? "Passwords don't match" : ''; }
  }, async function () {
    signupErr.hidden = true;
    var name = val('#cs-name'), email = val('#cs-email'), password = $('#cs-password').value;
    try {
      // No sign-in yet: the account only works once the emailed link proves
      // this person owns the address (call history is matched by email).
      await api('/api/customer/signup', { method: 'POST', body: { fullName: name, email: email, password: password } });
      $('[data-confirm-email]').textContent = email;
      show('check-email');
    } catch (e) {
      var code = e.data && e.data.error;
      signupErr.textContent = code === 'email_in_use'
        ? 'An account with this email already exists. Log in instead.'
        : code === 'confirmation_email_failed'
          ? "Your account was created but we couldn't send the confirmation email. Try signing up again in a moment to resend it."
          : 'Could not create your account — try again.';
      signupErr.hidden = false;
    }
  });

  /* ---------- Call history ---------- */
  function fmtClock(sec) {
    sec = sec || 0;
    var m = Math.floor(sec / 60), s = Math.floor(sec % 60);
    return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }
  function fmtDuration(totalSeconds) {
    if (totalSeconds == null) return '—';
    var m = Math.floor(totalSeconds / 60), s = totalSeconds % 60;
    return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }
  function fmtWhen(iso) {
    var d = new Date(iso);
    return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }) + ', ' +
      d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  }
  var STATUS_BADGE = {
    resolved: { label: 'Resolved', cls: 'call-badge--resolved' },
    ticket_created: { label: 'Ticket open', cls: 'call-badge--progress' },
    escalated: { label: 'Callback arranged', cls: 'call-badge--callback' },
    case_in_progress: { label: 'With a specialist', cls: 'call-badge--callback' },
    case_resolved: { label: 'Resolved', cls: 'call-badge--resolved' },
    abandoned: { label: 'Ended', cls: 'call-badge--progress' },
    in_progress: { label: 'Call in progress', cls: 'call-badge--progress' }
  };
  function transcriptItemHTML(t) {
    var time = '<span class="call-transcript__time tabular">' + fmtClock(t.at) + '</span>';
    return '<li class="call-transcript__item call-transcript__item--' + t.speaker + '">' +
      '<span class="call-transcript__speaker"><span class="call-transcript__speaker-name">' + (t.speaker === 'agent' ? 'RelayPay' : 'You') + '</span>' + time + '</span>' +
      '<span class="call-transcript__text">' + esc(t.text) + '</span></li>';
  }
  function rowHTML(call, i) {
    // An unknown status is a finished call, never "in progress".
    var badge = STATUS_BADGE[call.status] || STATUS_BADGE.abandoned;
    var summary = call.summary || 'Call with RelayPay support';
    return '<li class="history-item" data-index="' + i + '">' +
      '<button class="history-row" type="button" aria-expanded="false" aria-controls="history-detail-' + i + '">' +
        '<span class="history-row__when tabular">' + fmtWhen(call.at) + '</span>' +
        '<span class="history-row__summary">' + esc(summary) + '</span>' +
        '<span class="call-status"><span class="call-badge ' + badge.cls + '">' + badge.label + '</span>' +
          (call.ref ? '<span class="call-status__sub tabular">' + esc(call.ref) + '</span>' : '') + '</span>' +
        '<svg class="history-row__chevron" viewBox="0 0 12 8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 1.5l5 5 5-5"/></svg>' +
      '</button>' +
      '<div class="history-detail" id="history-detail-' + i + '" hidden>' +
        '<dl class="history-detail__list">' +
          '<dt>Reference</dt><dd class="tabular">' + esc(call.ref || '—') + '</dd>' +
          '<dt>Duration</dt><dd class="tabular">' + fmtDuration(call.duration) + '</dd>' +
          '<dt>Status</dt><dd>' + badge.label + '</dd>' +
        '</dl>' +
        (call.transcript && call.transcript.length
          ? '<button class="history-detail__tx-toggle" type="button" data-act="toggle-transcript">Show full transcript</button>' +
            '<ol class="call-transcript" hidden>' + call.transcript.map(transcriptItemHTML).join('') + '</ol>'
          : '<p class="history-detail__muted">No transcript recorded for this call.</p>') +
      '</div>' +
    '</li>';
  }

  var CALLS = [];
  function renderHistory() {
    var list = $('[data-history-list]'), empty = $('[data-history-empty]');
    if (!CALLS.length) { list.innerHTML = ''; empty.hidden = false; return; }
    empty.hidden = true;
    list.innerHTML = CALLS.map(rowHTML).join('');
  }

  $('[data-history-list]').addEventListener('click', function (e) {
    var toggleTx = e.target.closest('[data-act="toggle-transcript"]');
    if (toggleTx) {
      var tx = toggleTx.nextElementSibling;
      tx.hidden = !tx.hidden;
      toggleTx.textContent = tx.hidden ? 'Show full transcript' : 'Hide full transcript';
      return;
    }
    var row = e.target.closest('.history-row');
    if (!row) return;
    var item = row.closest('.history-item');
    var detail = $('.history-detail', item);
    var open = detail.hidden;
    detail.hidden = !open;
    row.setAttribute('aria-expanded', open ? 'true' : 'false');
    item.classList.toggle('is-open', open);
  });

  async function loadHistory(account) {
    $('[data-account-name]').textContent = account.fullName || account.email;
    try {
      var data = await api('/api/customer/calls');
      CALLS = data.calls;
      renderHistory();
    } catch (e) {
      console.error('Failed to load call history', e);
    }
  }

  $('[data-action="log-out"]').addEventListener('click', async function () {
    try { await supabaseClient.auth.signOut(); } catch (e) { /* ignore */ }
    location.href = '/login';
  });

  /* ---------- Init ---------- */
  (async function init() {
    await initSupabaseClient();

    var sessionResult = await supabaseClient.auth.getSession();
    var hasSession = !!(sessionResult.data && sessionResult.data.session);
    var account = null;
    if (hasSession) {
      try { account = (await api('/api/customer/me')).account; } catch (e) { account = null; }
    }

    if (account) {
      $('[data-account-in]').hidden = false;
      show('history');
      await loadHistory(account);
      return;
    }

    if (location.pathname === '/customer') { location.href = '/login'; return; }
    show('signup');
  })();
})();
