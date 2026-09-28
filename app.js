/* RelayPay Voice Support — call panel controller (vanilla JS)
   Public API: window.RelayCall.{setState, setLiveMode, setActivity, setOutcome,
   setCaption, addTranscriptLine, openTranscript, closeTranscript, setMuted}
   Wire these to real voice-session events. The demo script below is for review only. */
(function () {
  'use strict';

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  var panel = $('[data-call-panel]');
  var announcer = $('[data-announcer]');
  var STATES = $$('.call-state', panel).map(function (el) { return el.dataset.state; });

  var ACTIVITIES = {
    help: 'Searching RelayPay help articles',
    account: 'Checking your account',
    transactions: 'Checking transaction records',
    payouts: 'Checking payout records',
    ticket: 'Creating a support ticket',
    callback: 'Arranging a specialist callback'
  };
  var MODE_LABEL = { listening: 'Listening', thinking: 'Thinking', speaking: 'Speaking' };

  var SAMPLE_TRANSCRIPT = [
    ['agent', 2, "Hello, this is RelayPay support. I'm an AI agent and this call is recorded. How can I help?"],
    ['you', 9, "A payout to our supplier in Nairobi hasn't arrived. It was sent on Monday."],
    ['agent', 16, 'I can check that. What is the transaction reference? It starts with TXN.'],
    ['you', 22, 'It’s TXN-9001.'],
    ['agent', 26, 'Thanks. First I need to confirm the account. What is the registered business name?'],
    ['you', 31, 'LagosLedger.'],
    ['agent', 38, 'Thank you, your account is verified. I’m checking transaction records now.'],
    ['agent', 52, 'TXN-9001 was sent on 22 September and is held for a routine check at the receiving bank. These usually clear within two business days.'],
    ['you', 65, 'It’s been longer than that. Can someone look into it?'],
    ['agent', 71, 'I’ve created support ticket RP-4821 for this delay. Would you also like a specialist to call you?'],
    ['you', 78, 'Yes, please. Tomorrow morning, between ten and twelve.'],
    ['agent', 84, 'What name and email should the specialist use?']
  ];

  var state = {
    panel: 'idle', mode: 'listening', activity: 'transactions',
    muted: false, seconds: 84, level: 0,
    outcomes: { verified: true, status: true, ticket: true, callback: true },
    transcript: SAMPLE_TRANSCRIPT.slice()
  };

  /* ---------- G4. Transaction / payout status cards ----------
     kind: 'transaction' | 'payout'
     status: 'processing' | 'scheduled' | 'delayed' | 'failed' | 'review'
     transaction → eta (Date). payout → scheduledFor (Date) OR reason (string), never both.
     amount is only set when the caller is verified; reference-only callers never see it. */
  var MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  var STATUS_BADGE = {
    processing: ['Processing', 'neutral'], scheduled: ['Scheduled', 'neutral'],
    delayed: ['Delayed', 'caution'], failed: ['Failed', 'error'], review: ['Review required', 'error']
  };
  function dayOffset(n) { var d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() + n); return d; }
  function fmtShortDate(d) { return d.getDate() + ' ' + MONTHS[d.getMonth()]; }
  var STATUS_SAMPLES = {
    live: { cards: [{ kind: 'transaction', ref: 'TXN-9001', status: 'delayed', summary: 'Held for a routine check at the receiving bank.', eta: dayOffset(-4), amount: '1,250 USD' }],
      outcomes: { verified: true, ticket: true, callback: true } },
    'ref-future': { cards: [{ kind: 'transaction', ref: 'TXN-9214', status: 'processing', summary: 'Estimated to arrive within the normal window for this corridor.', eta: dayOffset(2) }],
      outcomes: { verified: false, ticket: false, callback: false } },
    'ref-past': { cards: [{ kind: 'transaction', ref: 'TXN-8990', status: 'delayed', summary: 'Held for a routine check at the receiving bank.', eta: dayOffset(-3) }],
      outcomes: { verified: false, ticket: false, callback: false } },
    'payout-failed': { cards: [{ kind: 'payout', ref: 'PAY-7002', status: 'failed', summary: 'This payout didn\u2019t go through. The funds are back in your RelayPay balance.', reason: 'beneficiary details need review', amount: '2,400 USD' }],
      outcomes: { verified: true, ticket: false, callback: true } },
    'verified-tx': { cards: [{ kind: 'transaction', ref: 'TXN-9102', status: 'scheduled', summary: 'Scheduled to send on the date you chose, then arrive within the normal window.', eta: dayOffset(3), amount: '850,000 NGN' }],
      outcomes: { verified: true, ticket: false, callback: false } }
  };
  STATUS_SAMPLES.all = {
    cards: ['ref-future', 'ref-past', 'payout-failed', 'verified-tx'].map(function (k) { return STATUS_SAMPLES[k].cards[0]; }),
    outcomes: { verified: true, ticket: false, callback: true }
  };
  var statusCards = STATUS_SAMPLES.live.cards;

  function statusCardHTML(c) {
    var b = STATUS_BADGE[c.status] || ['', 'neutral'];
    var title = (c.kind === 'payout' ? 'Payout ' : 'Transaction ') + '<span class="tabular">' + c.ref + '</span>';
    var when = '';
    if (c.kind === 'transaction' && c.eta) {
      when = '<p class="outcome-card__when tabular">Estimated arrival: ' + fmtShortDate(c.eta) + '</p>';
      if (c.eta < dayOffset(0)) when += '<p class="outcome-card__foot">This is beyond the original estimate. We don\u2019t have an updated date yet.</p>';
    } else if (c.kind === 'payout') {
      when = c.reason ? '<p class="outcome-card__when">Reason: ' + c.reason + '</p>'
        : c.scheduledFor ? '<p class="outcome-card__when tabular">Scheduled for ' + fmtShortDate(c.scheduledFor) + '</p>' : '';
    }
    var tier = c.amount
      ? '<div class="outcome-card__tier"><p class="outcome-card__tier-label">Shown because your account is verified</p><p class="outcome-card__when tabular">Amount: ' + c.amount + '</p></div>' : '';
    return '<div class="outcome-card outcome-card--status outcome-card--' + c.kind + '">' +
      '<div class="outcome-card__head"><p class="outcome-card__title">' + title + '</p><span class="status-badge status-badge--' + b[1] + '">' + b[0] + '</span></div>' +
      '<p class="outcome-card__summary">' + c.summary + '</p>' + when + tier + '</div>';
  }
  function setStatusCards(list) {
    statusCards = list || [];
    $('[data-status-cards]').innerHTML = statusCards.map(statusCardHTML).join('');
    if (typeof syncOutcomes === 'function' && state) syncOutcomes();
  }
  function applyStatusSample(key) {
    var s = STATUS_SAMPLES[key]; if (!s) return;
    setStatusCards(s.cards);
    Object.keys(s.outcomes).forEach(function (k) { setOutcome(k, s.outcomes[k]); });
    setOutcome('status', true);
  }

  /* ---------- Globe bridge (globe.js may load later or never) ---------- */
  window.__globeState = { state: 'idle', volume: 0 };
  function globeState(s) {
    window.__globeState.state = s;
    if (window.RelayGlobe) window.RelayGlobe.setState(s);
  }
  function globeVolume(v) {
    window.__globeState.volume = v;
    if (window.RelayGlobe) window.RelayGlobe.setVolume(v);
  }

  function announce(text) {
    announcer.textContent = '';
    setTimeout(function () { announcer.textContent = text; }, 40);
  }
  function fmt(sec) {
    var m = Math.floor(sec / 60), s = Math.floor(sec % 60);
    return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }

  /* ---------- Panel state ---------- */
  var ANNOUNCE = {
    idle: 'Ready to start a voice call.',
    requesting: 'Allow microphone access in your browser prompt.',
    blocked: 'Microphone access is blocked.',
    connecting: 'Connecting you to RelayPay support.',
    live: 'Call connected.',
    ended: 'Call ended.',
    'error-connection': "We couldn't connect the call.",
    'error-dropped': 'The call dropped.',
    'error-busy': 'Voice support is busy right now. Please try again in a few minutes.',
    'error-limit': 'This call has reached its time limit.',
    'error-unsupported': "Voice calls don't work in this browser."
  };

  function setState(name, opts) {
    if (STATES.indexOf(name) < 0) return;
    opts = opts || {};
    state.panel = name;
    $$('.call-state', panel).forEach(function (el) { el.hidden = el.dataset.state !== name; });
    panel.className = 'call-panel call-panel--' + name + (name === 'live' ? ' call-panel--' + state.mode : '');
    if (name === 'live') { startTimer(); startWave(); globeState(state.mode); }
    else { stopTimer(); stopWave(); globeState('idle'); globeVolume(0); }
    if (name === 'ended') {
      $('[data-summary-duration]').textContent = fmt(state.seconds);
    }
    syncOutcomes();
    if (name !== 'live') closeTranscript(true);
    announce(ANNOUNCE[name]);
    if (opts.focus) {
      var h = $('.call-state[data-state="' + name + '"] [data-state-heading]', panel);
      if (h) h.focus({ preventScroll: true });
    }
    var sel = $('[data-review="state"]');
    if (sel) sel.value = name;
  }

  function setLiveMode(mode) {
    if (!MODE_LABEL[mode]) return;
    state.mode = mode;
    $('[data-live-status-text]').textContent = MODE_LABEL[mode];
    $('[data-activity-line]').hidden = mode !== 'thinking';
    if (state.panel === 'live') {
      panel.className = 'call-panel call-panel--live call-panel--' + mode;
      globeState(mode);
      if (reduceMotion.matches) drawWave(0);
    }
    $$('[data-review="mode"] button').forEach(function (b) { b.setAttribute('aria-pressed', b.dataset.mode === mode); });
    announce(MODE_LABEL[mode] + (mode === 'thinking' ? '. ' + ACTIVITIES[state.activity] : ''));
  }

  function setActivity(key) {
    if (!ACTIVITIES[key]) return;
    state.activity = key;
    $('[data-activity-text]').textContent = ACTIVITIES[key];
    var sel = $('[data-review="activity"]');
    if (sel) sel.value = key;
  }

  function setOutcome(key, on) {
    state.outcomes[key] = !!on;
    var card = $('[data-outcomes-source] [data-outcome="' + key + '"]');
    if (card) card.hidden = !on;
    var cb = $('[data-review-outcome="' + key + '"]');
    if (cb) cb.checked = !!on;
    syncOutcomes();
  }

  function syncOutcomes() {
    var src = $('[data-outcomes-source]');
    var visible = $$('[data-outcome]', src).filter(function (c) { return !c.hidden; });
    $$('[data-outcomes-slot]').forEach(function (slot) {
      slot.innerHTML = '';
      visible.forEach(function (c) { slot.appendChild(c.cloneNode(true)); });
      var label = slot.previousElementSibling;
      if (label && label.hasAttribute('data-refs-label')) label.hidden = visible.length === 0;
    });
  }

  function setCaption(who, text) {
    var el = $('[data-caption="' + who + '"]');
    if (el) el.textContent = text;
  }

  function setMuted(on) {
    state.muted = !!on;
    var btn = $('[data-action="toggle-mute"]');
    btn.setAttribute('aria-pressed', state.muted);
    $('[data-mute-label]').textContent = state.muted ? 'Unmute' : 'Mute';
    $('[data-icon="mic"]', btn).hidden = state.muted;
    $('[data-icon="mic-off"]', btn).hidden = !state.muted;
    $('[data-muted-label]').hidden = !state.muted;
    announce(state.muted ? 'Microphone muted' : 'Microphone on');
  }

  /* ---------- Timer ---------- */
  var timerId = null;
  function renderTimer() { $('[data-call-timer]').textContent = fmt(state.seconds); }
  function startTimer() {
    renderTimer();
    if (timerId) return;
    timerId = setInterval(function () { state.seconds++; renderTimer(); }, 1000);
  }
  function stopTimer() { clearInterval(timerId); timerId = null; }

  /* ---------- Audio level line (single waveform line) ---------- */
  var canvas = $('[data-audio-level]');
  var ctx = canvas.getContext('2d');
  var waveRaf = null, smooth = 0;
  function sizeCanvas() {
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var w = canvas.clientWidth || 300, h = canvas.clientHeight || 40;
    canvas.width = w * dpr; canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  function simulatedVoice(t) {
    var v = Math.sin(t * 7.3) * 0.5 + Math.sin(t * 3.1 + 1) * 0.4 + Math.sin(t * 13.7) * 0.2;
    return Math.max(0, Math.min(1, v * 0.9 + 0.1));
  }
  function targetLevel(t) {
    if (state.panel !== 'live') return 0;
    if (state.mode === 'thinking') return 0.02;
    if (state.mode === 'listening' && state.muted) return 0;
    // Replace with real analyser values (0–1) from mic / agent audio.
    return simulatedVoice(t) * (state.mode === 'speaking' ? 0.9 : 0.7);
  }
  function drawWave(t) {
    var w = canvas.clientWidth, h = canvas.clientHeight, mid = h / 2;
    ctx.clearRect(0, 0, w, h);
    ctx.beginPath();
    var a = reduceMotion.matches ? (state.mode === 'thinking' ? 0.02 : 0.25) : smooth;
    for (var x = 0; x <= w; x += 2) {
      var env = Math.sin(Math.PI * x / w);
      var y = mid + env * a * h * 0.42 * (Math.sin(x * 0.045 + t * 6) * 0.7 + Math.sin(x * 0.12 - t * 4.2) * 0.3);
      x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.strokeStyle = state.mode === 'speaking' ? '#16788A' : '#0E2A47';
    ctx.globalAlpha = state.muted && state.mode === 'listening' ? 0.3 : 1;
    ctx.lineWidth = 1.25;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
  function waveLoop(ts) {
    var t = ts / 1000;
    smooth += (targetLevel(t) - smooth) * 0.15;
    drawWave(t);
    globeVolume(state.mode === 'speaking' ? smooth : 0);
    waveRaf = requestAnimationFrame(waveLoop);
  }
  function startWave() {
    sizeCanvas();
    if (reduceMotion.matches) { drawWave(0); globeVolume(state.mode === 'speaking' ? 0.5 : 0); return; }
    if (!waveRaf) waveRaf = requestAnimationFrame(waveLoop);
  }
  function stopWave() { cancelAnimationFrame(waveRaf); waveRaf = null; smooth = 0; }
  window.addEventListener('resize', function () { if (state.panel === 'live') { sizeCanvas(); drawWave(0); } });

  /* ---------- Transcript drawer ---------- */
  var drawer = $('[data-transcript-drawer]');
  var scrim = $('[data-drawer-scrim]');
  var lastFocus = null;
  function renderTranscript() {
    var list = $('[data-transcript-list]');
    list.innerHTML = '';
    state.transcript.forEach(function (row) {
      var li = document.createElement('li');
      li.className = 'transcript-list__item transcript-list__item--' + row[0];
      li.innerHTML =
        '<div class="transcript-list__speaker"><span class="transcript-list__speaker-name"></span>' +
        '<span class="transcript-list__time tabular"></span></div><p class="transcript-list__text"></p>';
      li.querySelector('.transcript-list__speaker-name').textContent = row[0] === 'agent' ? 'RelayPay' : 'You';
      li.querySelector('.transcript-list__time').textContent = fmt(row[1]);
      li.querySelector('.transcript-list__text').textContent = row[2];
      list.appendChild(li);
    });
  }
  function addTranscriptLine(who, text, sec) {
    state.transcript.push([who, sec == null ? state.seconds : sec, text]);
    renderTranscript();
  }
  function openTranscript() {
    lastFocus = document.activeElement;
    renderTranscript();
    drawer.classList.add('is-open'); scrim.classList.add('is-open');
    $$('[data-action="open-transcript"]').forEach(function (b) { b.setAttribute('aria-expanded', 'true'); });
    setTimeout(function () { $('[data-action="close-transcript"]').focus(); }, 30);
    var body = $('.transcript-drawer__body');
    body.scrollTop = body.scrollHeight;
  }
  function closeTranscript(silent) {
    if (!drawer.classList.contains('is-open')) return;
    drawer.classList.remove('is-open'); scrim.classList.remove('is-open');
    $$('[data-action="open-transcript"]').forEach(function (b) { b.setAttribute('aria-expanded', 'false'); });
    if (!silent && lastFocus && lastFocus.focus) lastFocus.focus();
  }
  scrim.addEventListener('click', function () { closeTranscript(); });
  document.addEventListener('keydown', function (e) {
    if (!drawer.classList.contains('is-open')) return;
    if (e.key === 'Escape') { closeTranscript(); return; }
    if (e.key === 'Tab') {
      var f = $$('button, [href], [tabindex]:not([tabindex="-1"])', drawer);
      if (!f.length) return;
      var first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });

  /* ---------- K. Contact details form ---------- */
  var cf = $('[data-contact-form]');
  var cfForm = $('[data-contact-form-form]');
  var cfDone = $('[data-contact-form-done]');
  var cfOnFile = $('[data-email-on-file]');
  var cfEmailField = $('[data-field="email"]');
  var cfTz = $('#cf-tz');
  var cfDate = $('#cf-date');
  var cfOnSubmitted = null;
  var cfTouched = {};
  var ON_FILE_EMAIL = 'am***@lagosledger.example';
  var cfVerified = false, cfUseOther = false;
  var collapseTimer = null;

  (function initTz() {
    var tz = '';
    try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) {}
    var match = $$('option', cfTz).some(function (o) { return o.value === tz; });
    if (!match && tz) {
      var o = document.createElement('option');
      o.value = tz; o.dataset.abbr = tz.split('/').pop().replace(/_/g, ' ') + ' time';
      o.textContent = tz.replace(/_/g, ' ');
      cfTz.insertBefore(o, cfTz.firstChild);
    }
    cfTz.value = tz || 'Africa/Lagos';
    if (!cfTz.value) cfTz.value = 'Africa/Lagos';
    cfTz.dataset.detected = cfTz.value;
    var d = new Date(), pad = function (n) { return (n < 10 ? '0' : '') + n; };
    cfDate.min = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  })();

  function maskEmail(v) {
    var parts = v.split('@');
    return parts[0].slice(0, 2) + '***@' + (parts[1] || '');
  }
  var VALIDATORS = {
    name: function () { return $('#cf-name').value.trim().length < 2 ? 'Enter your full name' : ''; },
    email: function () {
      if (cfVerified && !cfUseOther) return '';
      var v = $('#cf-email').value.trim();
      if (!v) return 'Enter your work email';
      return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v) ? '' : 'Enter a valid email address';
    },
    when: function () {
      var d = cfDate.value, t = $('#cf-time').value;
      if (!d && !t) return 'Choose a date and time for the callback';
      if (!d) return 'Choose a date';
      if (!t) return 'Choose a time';
      if (d < cfDate.min) return 'Choose a date from today onwards';
      return '';
    }
  };
  function showFieldError(key, msg) {
    var field = $('[data-field="' + key + '"]', cf);
    var err = $('.field__error', field);
    field.classList.toggle('field--invalid', !!msg);
    $$('.field__input', field).forEach(function (i) {
      if (i.tagName !== 'SELECT') i.setAttribute('aria-invalid', msg ? 'true' : 'false');
    });
    err.textContent = msg; err.hidden = !msg;
  }
  function validate(key) {
    var msg = VALIDATORS[key]();
    showFieldError(key, cfTouched[key] ? msg : '');
    return !msg;
  }
  function validateAll(force) {
    var ok = true, first = null;
    Object.keys(VALIDATORS).forEach(function (k) {
      if (force) cfTouched[k] = true;
      if (!validate(k)) { ok = false; if (!first) first = k; }
    });
    return { ok: ok, first: first };
  }
  // Blur = "leaves field": mark touched, validate. While typing, only clear existing errors.
  cfForm.addEventListener('focusout', function (e) {
    var field = e.target.closest('[data-field]');
    if (!field || !VALIDATORS[field.dataset.field]) return;
    var key = field.dataset.field;
    if (key === 'when' && field.contains(e.relatedTarget)) return;
    cfTouched[key] = true; validate(key);
  });
  cfForm.addEventListener('input', function (e) {
    var field = e.target.closest('[data-field]');
    if (field && cfTouched[field.dataset.field]) validate(field.dataset.field);
  });
  cfTz.addEventListener('change', function () {
    $('[data-tz-hint]').textContent = 'Times are shown in ' + cfTz.options[cfTz.selectedIndex].textContent + '.';
  });

  function setEmailMode(verified, useOther) {
    cfVerified = !!verified; cfUseOther = !!useOther;
    cfOnFile.hidden = !cfVerified || cfUseOther;
    cfEmailField.hidden = cfVerified && !cfUseOther;
    if (cfEmailField.hidden) showFieldError('email', '');
  }

  function resetContactForm() {
    clearTimeout(collapseTimer);
    cfForm.reset(); cfTouched = {};
    cfTz.value = cfTz.dataset.detected || 'Africa/Lagos';
    Object.keys(VALIDATORS).forEach(function (k) { showFieldError(k, ''); });
    cfForm.hidden = false; cfDone.hidden = true;
    cf.classList.remove('contact-form--submitted');
    $('[data-tz-hint]').textContent = 'Detected from your browser. Change it if you\'ll be elsewhere.';
  }

  // Public: show the form. variant: 'standard' | 'verified'
  function showContactForm(variant, opts) {
    opts = opts || {};
    resetContactForm();
    setEmailMode(variant === 'verified', false);
    cf.className = 'contact-form contact-form--' + (variant === 'verified' ? 'verified' : 'standard');
    cf.hidden = false;
    cfOnSubmitted = opts.onSubmit || null;
    announce('Callback form shown. A specialist will follow up. Add your details below, or say them aloud.');
    if (opts.focus) setTimeout(function () { $('#contact-form-title').focus({ preventScroll: false }); }, 30);
  }
  function hideContactForm() { clearTimeout(collapseTimer); cf.hidden = true; var s = $('[data-review="form"]'); if (s) s.value = 'hidden'; }

  function formatWhen() {
    var d = cfDate.value, t = $('#cf-time').value;
    var abbr = cfTz.options[cfTz.selectedIndex].dataset.abbr || cfTz.value;
    if (!d) return '';
    var dt = new Date(d + 'T12:00:00');
    var day = dt.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }).replace(',', '');
    return day + ', ' + t + ' ' + abbr;
  }

  function submitContactForm(data) {
    $('[data-callback-name]').textContent = data.name;
    $('[data-callback-email]').textContent = data.email;
    $('[data-callback-time]').textContent = data.when;
    cfForm.hidden = true; cfDone.hidden = false;
    cf.classList.add('contact-form--submitted');
    announce('Details received.');
    addTranscriptLine('you', 'Sent callback details using the form.');
    // Brief confirmation, then collapse into the outcome card
    collapseTimer = setTimeout(function () {
      hideContactForm();
      setOutcome('callback', true);
      announce('Specialist callback arranged. A RelayPay specialist will contact you.');
      if (cfOnSubmitted) cfOnSubmitted(data);
    }, reduceMotion.matches ? 2400 : 1600);
  }

  cfForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var res = validateAll(true);
    if (!res.ok) {
      var target = res.first === 'when' ? (cfDate.value ? $('#cf-time') : cfDate) : $('[data-field="' + res.first + '"] .field__input', cf);
      target.focus();
      return;
    }
    // Real: POST to callback endpoint, then call submitContactForm on success.
    submitContactForm({
      name: $('#cf-name').value.trim(),
      email: cfVerified && !cfUseOther ? ON_FILE_EMAIL : maskEmail($('#cf-email').value.trim()),
      when: formatWhen(),
      tz: cfTz.value,
      notes: $('#cf-notes').value.trim()
    });
  });

  function sayInstead() {
    hideContactForm();
    var line = 'No problem. Please tell me your full name, your email, and a good time for the callback.';
    setLiveMode('speaking'); setCaption('agent', line); addTranscriptLine('agent', line);
    setTimeout(function () { if (state.panel === 'live') setLiveMode('listening'); }, 3500);
  }

  // Review helper: fill + surface a specific form variant
  function previewContactForm(v) {
    if (v === 'hidden') { hideContactForm(); return; }
    if (state.panel !== 'live') setState('live');
    setOutcome('callback', false);
    showContactForm(v === 'standard' || v === 'errors' ? 'standard' : 'verified');
    if (v === 'verified-edit') setEmailMode(true, true);
    if (v === 'errors') {
      $('#cf-name').value = 'Amara';
      $('#cf-email').value = 'amara@lagosledger';
      cfTouched = { name: true, email: true, when: true };
      showFieldError('name', '');
      showFieldError('email', VALIDATORS.email());
      showFieldError('when', VALIDATORS.when());
    }
    if (v === 'submitted') {
      $('#cf-name').value = 'Amara Okafor';
      cfForm.hidden = true; cfDone.hidden = false; cf.classList.add('contact-form--submitted');
    }
  }

  /* ---------- Demo call (review only; replace with real session events) ---------- */
  var demoTimers = [];
  function clearDemo() { demoTimers.forEach(clearTimeout); demoTimers = []; }
  function at(ms, fn) { demoTimers.push(setTimeout(fn, ms)); }

  var SCRIPT = [
    { mode: 'speaking', agent: "Hello, this is RelayPay support. I'm an AI agent and this call is recorded. How can I help?", d: 5000 },
    { mode: 'listening', you: "A payout to our supplier in Nairobi hasn't arrived. The reference is TXN-9001.", d: 4500 },
    { mode: 'speaking', agent: 'Thanks. To confirm the account, what is the registered business name?', d: 4000 },
    { mode: 'listening', you: 'LagosLedger.', d: 2500 },
    { mode: 'thinking', activity: 'account', d: 2500, then: 'verified' },
    { mode: 'thinking', activity: 'transactions', d: 3000, then: 'status' },
    { mode: 'speaking', agent: 'Your account is verified. TXN-9001 is held for a routine check at the receiving bank. These usually clear within two business days.', d: 6000 },
    { mode: 'listening', you: 'It’s been four days. Can someone look into it?', d: 4000 },
    { mode: 'thinking', activity: 'ticket', d: 2500, then: 'ticket' },
    { mode: 'speaking', agent: 'I’ve created support ticket RP-4821. Would you also like a specialist to call you?', d: 4500 },
    { mode: 'listening', you: 'Yes, please.', d: 2500 },
    { mode: 'thinking', activity: 'callback', d: 2200 },
    { mode: 'speaking', agent: 'A specialist will follow up. You can add your details in the form on screen, or say them aloud.', d: 4500, form: true }
  ];
  var SCRIPT_AFTER_FORM = [
    { mode: 'speaking', agent: 'Thank you. Your callback is arranged and the reference is RP-4822. Is there anything else I can help with?', d: 6000 },
    { mode: 'listening', d: 0 }
  ];

  function runScript(steps) {
    var t = 0;
    (steps || SCRIPT).forEach(function (step) {
      at(t, function () {
        if (step.activity) setActivity(step.activity);
        setLiveMode(step.mode);
        if (step.agent) { setCaption('agent', step.agent); addTranscriptLine('agent', step.agent); }
        if (step.you) { setCaption('you', step.you); addTranscriptLine('you', step.you); }
      });
      if (step.then) at(t + step.d - 200, function () { setOutcome(step.then, true); });
      if (step.form) at(t + 600, function () {
        showContactForm(state.outcomes.verified ? 'verified' : 'standard', {
          onSubmit: function () { runScript(SCRIPT_AFTER_FORM); }
        });
      });
      t += step.d;
      if (step.form) at(t, function () { setLiveMode('listening'); });
    });
  }

  function startCall() {
    clearDemo();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.RTCPeerConnection && !window.WebSocket) {
      setState('error-unsupported', { focus: true }); return;
    }
    state.seconds = 0; state.transcript = []; setMuted(false);
    ['verified', 'status', 'ticket', 'callback'].forEach(function (k) { setOutcome(k, false); });
    setStatusCards(STATUS_SAMPLES.live.cards); syncStatusSelect('live');
    setCaption('you', ''); setCaption('agent', '');
    hideContactForm(); syncFormSelect('hidden');
    setState('requesting', { focus: true });
    // Real: navigator.mediaDevices.getUserMedia({ audio: true }) → connecting | blocked
    at(1600, function () { setState('connecting', { focus: true }); });
    at(3400, function () { setState('live', { focus: true }); runScript(); });
  }

  function endCall() {
    clearDemo();
    setState('ended', { focus: true });
  }

  /* ---------- Events ---------- */
  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-action]');
    if (!btn) return;
    switch (btn.dataset.action) {
      case 'start-call': startCall(); break;
      case 'cancel': clearDemo(); setState('idle', { focus: true }); break;
      case 'end-call': endCall(); break;
      case 'toggle-mute': setMuted(!state.muted); break;
      case 'open-transcript': openTranscript(); break;
      case 'close-transcript': closeTranscript(); break;
      case 'use-different-email':
        setEmailMode(true, true); $('#cf-email').focus(); break;
      case 'say-instead': sayInstead(); break;
      case 'copy-link':
        var lbl = $('[data-copy-label]', btn);
        (navigator.clipboard ? navigator.clipboard.writeText(location.href) : Promise.reject())
          .then(function () { lbl.textContent = 'Link copied'; })
          .catch(function () { lbl.textContent = location.host || 'Copy the address bar link'; });
        break;
    }
  });

  var hint = $('[data-suggestion-hint]');
  $$('[data-suggestion]').forEach(function (b) {
    b.addEventListener('click', function () {
      $$('[data-suggestion]').forEach(function (o) { o.setAttribute('aria-pressed', o === b); });
      var q = b.textContent.replace(/Say this$/, '').trim();
      hint.innerHTML = 'Once the call starts, say: <strong></strong>';
      hint.querySelector('strong').textContent = '“' + q + '”';
    });
  });

  /* ---------- Preview states toolbar (design review only) ---------- */
  var tb = $('[data-review-toolbar]');
  if (tb) {
    $('[data-review="state"]').addEventListener('change', function (e) { clearDemo(); setState(e.target.value); });
    $$('[data-review="mode"] button').forEach(function (b) {
      b.addEventListener('click', function () {
        clearDemo(); if (state.panel !== 'live') setState('live'); setLiveMode(b.dataset.mode);
      });
    });
    $('[data-review="activity"]').addEventListener('change', function (e) {
      clearDemo(); if (state.panel !== 'live') setState('live');
      setActivity(e.target.value); setLiveMode('thinking');
    });
    $$('[data-review-outcome]').forEach(function (cb) {
      cb.addEventListener('change', function () { setOutcome(cb.dataset.reviewOutcome, cb.checked); });
    });
    $('[data-review="transcript"]').addEventListener('click', function () {
      clearDemo(); if (state.panel !== 'live') setState('live'); openTranscript();
    });
    $('[data-review="demo"]').addEventListener('click', startCall);
    $('[data-review="form"]').addEventListener('change', function (e) { clearDemo(); previewContactForm(e.target.value); });
    $('[data-review="status-sample"]').addEventListener('change', function (e) {
      clearDemo();
      if (state.panel !== 'live' && state.panel !== 'ended') setState('live');
      applyStatusSample(e.target.value);
    });
    $('[data-review="all"]').addEventListener('change', function (e) {
      document.body.classList.toggle('review-all', e.target.checked);
      if (e.target.checked) { sizeCanvas(); drawWave(0); }
    });
    var collapse = $('[data-review="collapse"]');
    collapse.addEventListener('click', function () {
      var c = tb.classList.toggle('is-collapsed');
      collapse.textContent = c ? 'Preview states' : 'Hide';
      collapse.setAttribute('aria-expanded', !c);
    });
    if (window.matchMedia('(max-width: 760px)').matches) collapse.click();
  }

  function syncStatusSelect(v) { var s = $('[data-review="status-sample"]'); if (s) s.value = v; }
  function syncFormSelect(v) { var s = $('[data-review="form"]'); if (s) s.value = v; }

  /* ---------- Init ---------- */
  setStatusCards(statusCards);
  setActivity(state.activity);
  Object.keys(state.outcomes).forEach(function (k) { setOutcome(k, state.outcomes[k]); });
  renderTranscript();
  setState('idle');
  announcer.textContent = '';

  window.RelayCall = {
    setState: setState, setLiveMode: setLiveMode, setActivity: setActivity, setOutcome: setOutcome,
    setCaption: setCaption, addTranscriptLine: addTranscriptLine, setMuted: setMuted,
    openTranscript: openTranscript, closeTranscript: closeTranscript, startDemo: startCall,
    showContactForm: showContactForm, hideContactForm: hideContactForm, submitContactForm: submitContactForm,
    setStatusCards: setStatusCards
  };
})();
