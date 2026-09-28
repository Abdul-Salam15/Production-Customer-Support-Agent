/* RelayPay Support Queue — prototype controller (vanilla JS).
   Replace CASES with API data; keep the same object shape. */
(function () {
  'use strict';

  var NOW = Date.now();
  var H = 3600 * 1000;
  var ago = function (h) { return new Date(NOW - h * H).toISOString(); };
  var CURRENT_USER = 'Tunde Adeyemi';
  // "Mon 28 Sep, 10:00" style, for sample callback times relative to now
  var slot = function (h, hh, mm) {
    var d = new Date(NOW - h * H); d.setHours(hh, mm, 0, 0);
    return ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getDay()] + ' ' + d.getDate() + ' ' +
      ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()] + ', ' + (hh < 10 ? '0' : '') + hh + ':' + (mm < 10 ? '0' : '') + mm;
  };

  /* ---------- Sample data ---------- */
  var CASES = [
    {
      reference: 'RP-4821', priority: 'high', category: 'compliance',
      companyName: 'AccraStack', contactName: 'Efua Mensah',
      summary: 'Payout to Kente Labs under compliance review, customer asking why.',
      createdAt: ago(3.1), status: 'open',
      contactEmail: 'efua@accrastack.example',
      callbackTime: 'Mon 28 Sep, 10:00', callbackTimezone: 'GMT · Accra',
      linkedAccount: { plan: 'Growth', accountStatus: 'Active' },
      linkedTransactionOrPayout: { type: 'Payout', reference: 'PO-7734', status: 'Under compliance review', tone: 'warn' },
      transcript: [
        { speaker: 'agent', at: 2, text: 'Hello, this is RelayPay support. I’m an AI agent and this call is recorded. How can I help?' },
        { speaker: 'customer', at: 9, text: 'Hi. Our payout to Kente Labs has been on hold since Friday.' },
        { speaker: 'agent', at: 14, text: 'I can look into that. First I need to confirm the account. What is the registered business name?' },
        { speaker: 'customer', at: 20, text: 'AccraStack.' },
        { speaker: 'agent', at: 27, text: 'Thank you, the account is verified. Do you have the payout reference?' },
        { speaker: 'customer', at: 32, text: 'Yes, PO-7734.' },
        { speaker: 'agent', at: 41, text: 'PO-7734 is under a compliance review. That review is handled by our specialists.' },
        { speaker: 'customer', at: 48, text: 'Why is it under review, and when will it be released? Kente Labs is waiting on this.' },
        { speaker: 'agent', at: 56, text: 'I can’t give a reason or a release date on this call. I’ve created ticket RP-4821, and a specialist can call you back. When suits you?' },
        { speaker: 'customer', at: 65, text: 'Monday at ten, Accra time. Use my email on file.' },
        { speaker: 'agent', at: 71, text: 'Done. A specialist will call you on Monday 28 September at 10:00 GMT. Your reference is RP-4821.' }
      ],
      claimedBy: null, notes: []
    },
    {
      reference: 'RP-4819', priority: 'high', category: 'account',
      companyName: null, contactName: 'Kwame Boateng (unconfirmed)',
      summary: 'Caller says account was restricted, could not be matched to a customer record.',
      createdAt: ago(1.2), status: 'open',
      contactEmail: 'kwame@boatengfreight.example',
      callbackTime: 'Mon 28 Sep, 15:30', callbackTimezone: 'WAT · Lagos',
      linkedAccount: { plan: null, accountStatus: 'No matching record' },
      linkedTransactionOrPayout: null,
      transcript: [
        { speaker: 'agent', at: 2, text: 'Hello, this is RelayPay support. I’m an AI agent and this call is recorded. How can I help?' },
        { speaker: 'customer', at: 8, text: 'Our account was restricted this morning and we can’t send any payments.' },
        { speaker: 'agent', at: 13, text: 'I’m sorry to hear that. To check the account, what is the registered business name?' },
        { speaker: 'customer', at: 19, text: 'Boateng Freight.' },
        { speaker: 'agent', at: 28, text: 'I couldn’t find a RelayPay account under that name. Could it be registered under a different name?' },
        { speaker: 'customer', at: 35, text: 'No, that’s the name. We’ve used RelayPay for over a year.' },
        { speaker: 'agent', at: 42, text: 'I can’t share account details without a match. Account restrictions are reviewed by a specialist. Can I take your details for a callback?' },
        { speaker: 'customer', at: 50, text: 'Yes. I’ll type them in.' },
        { type: 'form', at: 94, name: 'Kwame Boateng', email: 'kwame@boatengfreight.example', callbackTime: 'Mon 28 Sep, 15:30', callbackTimezone: 'WAT · Lagos', notes: 'Account may be under Boateng Freight Services Ltd.' },
        { speaker: 'agent', at: 98, text: 'Thank you, I’ve received your details. A specialist will call you on Monday at 15:30 WAT to verify the account and review the restriction.' },
        { speaker: 'customer', at: 107, text: 'Okay. Thanks.' }
      ],
      claimedBy: null, notes: []
    },
    {
      reference: 'RP-4818', priority: 'medium', category: 'payment',
      companyName: 'CapeCloud', contactName: 'Amina Jacobs',
      summary: 'Payout to Mwiza Design failed, beneficiary details need review.',
      createdAt: ago(5.3), status: 'in_progress',
      contactEmail: 'amina@capecloud.example',
      callbackTime: 'Mon 28 Sep, 09:00', callbackTimezone: 'SAST · Johannesburg',
      linkedAccount: { plan: 'Scale', accountStatus: 'Active' },
      linkedTransactionOrPayout: { type: 'Payout', reference: 'PO-7701', status: 'Failed', tone: 'bad' },
      transcriptExcerpt: {
        customerLine: 'The payout to Mwiza Design failed twice. We need it to go through today.',
        agentLine: 'The payout failed because the beneficiary bank details didn’t validate. I can’t change beneficiary details on a call, so I’ve passed this to a specialist.'
      },
      claimedBy: 'Zainab Bello',
      notes: [{ author: 'Zainab Bello', at: ago(4.6), text: 'Asked customer to confirm Mwiza Design’s account number by email.' }]
    },
    {
      reference: 'RP-4815', priority: 'medium', category: 'payment',
      companyName: 'KigaliWorks', contactName: 'Patrick Ndayisaba',
      summary: 'Invoice payment failed, customer wants someone to look into it.',
      createdAt: ago(8.4), status: 'open',
      contactEmail: 'patrick@kigaliworks.example',
      callbackTime: 'Mon 28 Sep, 11:00', callbackTimezone: 'CAT · Kigali',
      linkedAccount: { plan: 'Starter', accountStatus: 'Active' },
      linkedTransactionOrPayout: { type: 'Transaction', reference: 'TXN-9140', status: 'Failed', tone: 'bad' },
      transcriptExcerpt: {
        customerLine: 'Our client tried to pay invoice INV-2207 and it failed. Can someone look into it?',
        agentLine: 'I can see TXN-9140 was declined by the payer’s bank. I’ve created a ticket so a specialist can check it with the payment provider.'
      },
      claimedBy: null, notes: []
    },
    {
      reference: 'RP-4810', priority: 'low', category: 'other',
      companyName: 'NairobiOps', contactName: 'Daniel Mwangi',
      summary: 'General question about verification timeline, referred for follow-up.',
      createdAt: ago(26), status: 'open',
      contactEmail: 'daniel@nairobiops.example',
      callbackTime: 'Tue 29 Sep, 10:00', callbackTimezone: 'EAT · Nairobi',
      linkedAccount: { plan: 'Growth', accountStatus: 'Verification pending' },
      linkedTransactionOrPayout: null,
      transcriptExcerpt: {
        customerLine: 'We submitted our verification documents last week. How long does the review usually take?',
        agentLine: 'Business verification usually takes three to five business days. I’ve referred this so a specialist can confirm where yours is.'
      },
      claimedBy: null, notes: []
    },
    {
      reference: 'RP-4790', priority: 'medium', category: 'account',
      companyName: 'LagosLedger', contactName: 'Amara Okafor',
      summary: 'Requested help verifying a new team member.',
      createdAt: ago(336), status: 'in_progress',
      contactEmail: 'amara@lagosledger.example',
      callbackTime: slot(312, 11, 0), callbackTimezone: 'WAT · Lagos',
      linkedAccount: { plan: 'Growth', accountStatus: 'Active' },
      linkedTransactionOrPayout: null,
      transcriptExcerpt: {
        customerLine: 'We added a new finance manager to our account, but their verification is stuck. Can you help?',
        agentLine: 'Team member verification is reviewed by our specialists. I’ve created a ticket so someone can check it with you.'
      },
      claimedBy: 'Zainab Bello', notes: []
    },
    {
      reference: 'RP-4802', priority: 'low', category: 'dispute',
      companyName: 'LagosLedger', contactName: 'Amara Okafor',
      summary: 'Disputed a fee on a completed transaction.',
      createdAt: ago(70), status: 'closed', resolvedAt: ago(48),
      contactEmail: 'amara@lagosledger.example',
      callbackTime: 'Fri 25 Sep, 14:00', callbackTimezone: 'WAT · Lagos',
      linkedAccount: { plan: 'Growth', accountStatus: 'Active' },
      linkedTransactionOrPayout: { type: 'Transaction', reference: 'TXN-8876', status: 'Completed', tone: 'ok' },
      transcriptExcerpt: {
        customerLine: 'We were charged a fee on TXN-8876 that doesn’t match your published rates.',
        agentLine: 'Fee disputes are handled by our specialists. I’ve created a ticket and someone will review the charge with you.'
      },
      claimedBy: 'Zainab Bello',
      notes: [{ author: 'Zainab Bello', at: ago(48.2), text: 'Fee matches published FX rate. Sent the breakdown to the customer, who accepted it.' }]
    }
  ];

  // Shared cases use the same transcript the customer sees in their call history (shared-cases.js)
  var SHARED = (window.RELAY_SHARED && window.RELAY_SHARED.transcripts) || {};
  CASES.forEach(function (c) { if (SHARED[c.reference]) c.transcript = SHARED[c.reference]; });

  // Cases with only a two-line excerpt get a transcript built from it (sample data only)
  CASES.forEach(function (c) {
    if (c.transcript || !c.transcriptExcerpt) return;
    c.transcript = [
      { speaker: 'agent', at: 2, text: 'Hello, this is RelayPay support. I’m an AI agent and this call is recorded. How can I help?' },
      { speaker: 'customer', at: 9, text: c.transcriptExcerpt.customerLine },
      { speaker: 'agent', at: 18, text: 'I can help with that. First I need to confirm the account. What is the registered business name?' },
      { speaker: 'customer', at: 24, text: c.companyName + '.' },
      { speaker: 'agent', at: 31, text: 'Thank you, the account is verified.' },
      { speaker: 'agent', at: 44, text: c.transcriptExcerpt.agentLine },
      { speaker: 'customer', at: 53, text: 'Okay. ' + c.callbackTime.split(', ')[0].replace(/^\w+ /, '') + ' at ' + c.callbackTime.split(', ')[1] + ' works for a callback.' },
      { speaker: 'agent', at: 60, text: 'Done. A specialist will call you then. Your reference is ' + c.reference + '.' }
    ];
  });

  /* ---------- Helpers ---------- */
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
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

  /* ---------- UI state ---------- */
  var ui = { status: 'open', category: 'all', priority: 'all', selected: null, noteOpen: false, pendingClose: {}, forceEmpty: false };

  function visibleCases() {
    return CASES.filter(function (c) {
      if (ui.forceEmpty) return false;
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
    if (ui.forceEmpty) { open = 0; closed = 0; }
    $('[data-count="open"]').textContent = open;
    $('[data-count="closed"]').textContent = closed;
    $('[data-count="all"]').textContent = ui.forceEmpty ? 0 : CASES.filter(cat).length;
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
    if (!c.companyName) return '<span class="info-grid__warn">Not matched</span><span class="info-grid__sub">' + esc(a.accountStatus) + '</span>';
    var tone = a.accountStatus === 'Active' ? '' : 'info-grid__warn';
    return esc(c.companyName) + '<span class="info-grid__sub">' + esc(a.plan) + ' plan · <span class="' + tone + '">' + esc(a.accountStatus) + '</span></span>';
  }

  function fmtClock(sec) {
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
            '<dt>Callback time</dt><dd class="tabular">' + esc(t.callbackTime) + ' ' + esc(t.callbackTimezone) + '</dd>' +
            (t.notes ? '<dt>Note</dt><dd>' + esc(t.notes) + '</dd>' : '') +
          '</dl>' +
        '</div></li>';
    }
    return '<li class="case-transcript__item case-transcript__item--' + t.speaker + '">' +
      '<span class="case-transcript__speaker"><span class="case-transcript__speaker-name">' + (t.speaker === 'agent' ? 'Agent' : 'Customer') + '</span>' + time + '</span>' +
      '<span class="case-transcript__text">' + esc(t.text) + '</span></li>';
  }

  function actionsHTML(c) {
    if (c.status === 'closed') {
      return '<span class="case-actions__resolved"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 8.5l3 3 7-7"/></svg>Resolved ' + relTime(c.resolvedAt) + (c.claimedBy ? ' by ' + esc(c.claimedBy) : '') + '</span>' +
        '<button class="btn btn--secondary action-note" type="button" data-act="note" aria-expanded="' + ui.noteOpen + '">Add note</button>';
    }
    var claim = c.claimedBy
      ? '<span class="case-actions__claimed action-claimed"><span class="case-actions__claimed-text">Claimed by<strong>' + (c.claimedBy === CURRENT_USER ? 'you (' + esc(CURRENT_USER) + ')' : esc(c.claimedBy)) + '</strong></span>' +
        '<button class="case-actions__unclaim action-unclaim" type="button" data-act="unclaim" aria-label="Unclaim ' + c.reference + '">Unclaim</button></span>'
      : '<button class="btn btn--primary action-claim" type="button" data-act="claim">Claim case</button>';
    return claim +
      '<button class="btn btn--secondary action-note" type="button" data-act="note" aria-expanded="' + ui.noteOpen + '" aria-controls="note-form">Add note</button>' +
      '<button class="btn btn--success action-resolve" type="button" data-act="resolve">Mark resolved</button>';
  }

  function renderDetail() {
    var pane = $('[data-detail]');
    var c = ui.selected && find(ui.selected);
    if (!c || ui.forceEmpty) {
      pane.innerHTML = '<div class="detail-empty"><p class="detail-empty__text">Select a case to see the details.</p></div>';
      return;
    }
    var statusKey = c.status;
    var notes = c.notes.length
      ? c.notes.map(function (n) {
          return '<li class="notes-list__item"><span class="notes-list__meta"><span>' + esc(n.author.split(' ')[0]) + '</span><span class="tabular">' + relTime(n.at) + '</span></span><span>' + esc(n.text) + '</span></li>';
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
              (c.status === 'closed' ? '<button class="case-detail__reopen action-reopen" type="button" data-act="reopen" aria-label="Mark ' + c.reference + ' unresolved">Mark unresolved</button>' : '') +
            '</div>' +
          '</div>' +
          '<p class="case-detail__created">Created by voice agent<br><span class="tabular">' + absTime(c.createdAt) + ' · ' + relTime(c.createdAt) + '</span></p>' +
        '</header>' +
        '<p class="case-detail__summary">' + esc(c.summary) + '</p>' +
        '<div class="case-actions">' + actionsHTML(c) + '</div>' +
        '<form class="note-form" id="note-form" data-note-form' + (ui.noteOpen ? '' : ' hidden') + '>' +
          '<label class="sr-only" for="note-input">Note</label>' +
          '<input class="note-form__input" id="note-input" type="text" placeholder="Add a note for this case" maxlength="280" autocomplete="off">' +
          '<button class="btn btn--primary action-note-save" type="submit">Save</button>' +
          '<button class="btn btn--text" type="button" data-act="note-cancel">Cancel</button>' +
        '</form>' +
        '<div class="case-detail__body">' +
          '<section class="detail-section"><h2 class="detail-section__title">Details</h2>' +
            '<dl class="info-grid">' +
              '<div class="info-grid__item info-grid__item--contact"><dt>Contact</dt><dd>' + esc(c.contactName) + '<span class="info-grid__sub">' + esc(c.contactEmail) + '</span></dd></div>' +
              '<div class="info-grid__item info-grid__item--callback"><dt>Preferred callback</dt><dd class="tabular">' + esc(c.callbackTime) + '<span class="info-grid__sub">' + esc(c.callbackTimezone) + '</span></dd></div>' +
              '<div class="info-grid__item info-grid__item--account"><dt>Linked account</dt><dd>' + accountHTML(c) + '</dd></div>' +
              '<div class="info-grid__item info-grid__item--linked"><dt>Transaction or payout</dt><dd>' + linkedHTML(c.linkedTransactionOrPayout) + '</dd></div>' +
            '</dl>' +
          '</section>' +
          '<section class="detail-section"><h2 class="detail-section__title">Full transcript <span class="case-transcript__meta tabular">· ' + c.transcript.length + ' entries · ' + fmtClock(c.transcript[c.transcript.length - 1].at) + '</span></h2>' +
            '<ol class="case-transcript" tabindex="0" aria-label="Full call transcript">' + c.transcript.map(transcriptItemHTML).join('') + '</ol>' +
          '</section>' +
          '<section class="detail-section"><h2 class="detail-section__title">Notes</h2><ul class="notes-list">' + notes + '</ul></section>' +
        '</div>' +
      '</article>';
  }

  function render() { renderCounts(); renderQueue(); renderDetail(); }

  /* ---------- Actions (local only; swap for API calls) ---------- */
  function claim(c) { c.claimedBy = CURRENT_USER; c.status = 'in_progress'; }
  function unclaim(c) { c.claimedBy = null; if (c.status === 'in_progress') c.status = 'open'; }
  function addNote(c, text) { c.notes.push({ author: CURRENT_USER, at: new Date().toISOString(), text: text }); }
  function resolve(c) {
    c.status = 'closed'; c.resolvedAt = new Date().toISOString();
    if (!c.claimedBy) c.claimedBy = CURRENT_USER;
    if (ui.status === 'open') {
      ui.pendingClose[c.reference] = setTimeout(function () { settlePending(); render(); }, 2500);
    }
  }
  function reopen(c) {
    if (ui.pendingClose[c.reference]) { clearTimeout(ui.pendingClose[c.reference]); delete ui.pendingClose[c.reference]; }
    c.status = c.claimedBy ? 'in_progress' : 'open';
    delete c.resolvedAt;
  }
  function settlePending() {
    Object.keys(ui.pendingClose).forEach(function (ref) {
      clearTimeout(ui.pendingClose[ref]); delete ui.pendingClose[ref];
      if (ui.selected === ref && ui.status === 'open') ui.selected = null;
    });
  }

  /* ---------- Events ---------- */
  $('[data-queue]').addEventListener('click', function (e) {
    var row = e.target.closest('.case-row');
    if (!row) return;
    ui.selected = row.dataset.ref; ui.noteOpen = false;
    render();
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

  $('[data-detail]').addEventListener('click', function (e) {
    var b = e.target.closest('[data-act]');
    var c = ui.selected && find(ui.selected);
    if (!b || !c) return;
    switch (b.dataset.act) {
      case 'claim': claim(c); render(); break;
      case 'reopen': reopen(c); render(); var st = $('.case-detail .status-label'); var ab = $('.action-claim') || $('.action-resolve'); if (ab) ab.focus(); break;
      case 'unclaim': unclaim(c); render(); var cb = $('.action-claim'); if (cb) cb.focus(); break;
      case 'note': ui.noteOpen = !ui.noteOpen; render(); if (ui.noteOpen) $('#note-input').focus(); break;
      case 'note-cancel': ui.noteOpen = false; render(); $('.action-note').focus(); break;
      case 'resolve': resolve(c); ui.noteOpen = false; render(); break;
    }
  });

  $('[data-detail]').addEventListener('submit', function (e) {
    e.preventDefault();
    var c = find(ui.selected); var input = $('#note-input');
    var text = input.value.trim();
    if (!text) { input.focus(); return; }
    addNote(c, text); ui.noteOpen = false; render();
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

  $('[data-proto-empty]').addEventListener('change', function (e) { ui.forceEmpty = e.target.checked; render(); });

  /* ---------- Init: nothing selected ---------- */
  render();

  window.RelayQueue = { cases: CASES, render: render, setCurrentUser: function (n) { CURRENT_USER = n; render(); }, claim: claim, unclaim: unclaim, reopen: reopen, addNote: addNote, resolve: resolve };
})();
