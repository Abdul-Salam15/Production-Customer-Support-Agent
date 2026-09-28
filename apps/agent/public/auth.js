/* RelayPay Support — auth, roles and team (prototype only; no backend).
   Replace USERS and the functions below with real auth/API calls. */
(function () {
  'use strict';

  /* ---------- Sample data ---------- */
  // role: 'user' | 'specialist' | 'admin'   status: 'active' | 'invited'
  var USERS = [
    { name: 'Tunde Adeyemi', email: 'tunde@relaypay.example', role: 'admin', status: 'active', password: 'relaypay-demo', invitedBy: null },
    { name: 'Zainab Bello', email: 'zainab@relaypay.example', role: 'specialist', status: 'active', password: 'relaypay-demo', invitedBy: 'Tunde Adeyemi' },
    { name: 'Ngozi Adaeze', email: 'ngozi@relaypay.example', role: 'specialist', status: 'invited', password: null, invitedBy: 'Tunde Adeyemi' }
  ];

  var ROLE_LABEL = { user: 'User', specialist: 'Specialist', admin: 'Admin' };
  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  var article = function (role) { return role === 'admin' ? 'an ' : 'a '; };
  var findUser = function (email) {
    var e = String(email || '').trim().toLowerCase();
    return USERS.filter(function (u) { return u.email.toLowerCase() === e; })[0];
  };

  var ui = { user: null, view: 'app', tab: 'queue', invitee: null, preview: null, editing: null, newRow: null, teamTab: 'admin', roleMenu: null, pending: null };
  var TAB_ORDER = ['admin', 'specialist'];
  var fmtDate = function (d) { return d.getDate() + ' ' + ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()]; };
  var possessive = function (n) { return /s$/i.test(n) ? n + '\u2019' : n + '\u2019s'; };

  /* ---------- Screens ---------- */
  function show(view) {
    ui.view = view;
    $$('[data-screen]').forEach(function (el) { el.hidden = el.dataset.screen !== view; });
    $('[data-proto-empty-wrap]').hidden = view !== 'app' || ui.tab !== 'queue';
    syncProtoRoles();
    var h = $('[data-screen="' + view + '"] [data-screen-heading]');
    if (h) h.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }

  function setTab(t) {
    if (t === 'team' && (!ui.user || ui.user.role !== 'admin')) t = 'queue';
    ui.tab = t;
    $$('[data-tab]').forEach(function (b) { b.setAttribute('aria-current', b.dataset.tab === t ? 'page' : 'false'); });
    $$('[data-queue-only]').forEach(function (el) { el.hidden = t !== 'queue'; });
    $('[data-team-view]').hidden = t !== 'team';
    $('[data-proto-empty-wrap]').hidden = t !== 'queue' || ui.view !== 'app';
    syncProtoRoles();
    if (t === 'team') { ui.editing = null; ui.roleMenu = null; renderTeam(); renderPreview(); }
  }

  function signIn(user, opts) {
    opts = opts || {};
    ui.user = user;
    delete user.upgraded;
    $$('[data-current-user]').forEach(function (el) { el.textContent = user.name; });
    $('[data-pending-email]').textContent = user.email;
    if (window.RelayQueue) window.RelayQueue.setCurrentUser(user.name);
    $('[data-tab="team"]').hidden = user.role !== 'admin';
    syncProto();
    if (user.role === 'user') { show('pending'); return; }
    show('app'); setTab('queue');
    if (opts.welcome) showWelcome(user.name);
  }

  function signOut() {
    ui.user = null; closeInvite(true); closeRole(true); closeRemove(true); resetAuthForms(); syncProto(); show('login');
  }

  function syncProto() { $('[data-proto-view]').value = ui.user ? ui.user.role : 'logged-out'; }

  var welcomeTimers = [];
  function showWelcome(name) {
    var el = $('[data-welcome]');
    welcomeTimers.forEach(clearTimeout);
    el.textContent = 'Welcome, ' + name;
    el.classList.remove('welcome-line--fading'); el.hidden = false;
    welcomeTimers = [
      setTimeout(function () { el.classList.add('welcome-line--fading'); }, 2800),
      setTimeout(function () { el.hidden = true; }, 3600)
    ];
  }

  /* ---------- Form validation (errors after blur or submit) ---------- */
  function bindForm(form, rules, onValid) {
    var touched = {};
    function fieldEl(k) { return form.querySelector('[data-field="' + k + '"]'); }
    function check(k, force) {
      if (force) touched[k] = true;
      var msg = rules[k]();
      var f = fieldEl(k), err = f.querySelector('.form-field__error'), input = f.querySelector('input, select');
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
      var first = null;
      Object.keys(rules).forEach(function (k) { if (!check(k, true) && !first) first = k; });
      if (first) { fieldEl(first).querySelector('input, select').focus(); return; }
      onValid();
    });
    return {
      reset: function () {
        form.reset(); touched = {};
        Object.keys(rules).forEach(function (k) { check(k); });
      }
    };
  }
  var val = function (sel) { return $(sel).value.trim(); };
  var emailRule = function (sel, emptyMsg) {
    return function () {
      var v = val(sel);
      if (!v) return emptyMsg;
      return EMAIL_RE.test(v) ? '' : 'Enter a valid email address';
    };
  };
  var passwordRule = function (sel) { return function () { return $(sel).value.length < 8 ? 'Use at least 8 characters' : ''; }; };
  var confirmRule = function (pw, cf) {
    return function () {
      var c = $(cf).value;
      if (!c) return 'Confirm your password';
      return c !== $(pw).value ? "Passwords don't match" : '';
    };
  };

  /* Log in */
  var loginErr = $('[data-login-error]');
  var login = bindForm($('[data-login-form]'), {
    email: emailRule('#login-email', 'Enter your email'),
    password: function () { return $('#login-password').value ? '' : 'Enter your password'; }
  }, function () {
    var u = findUser(val('#login-email'));
    if (!u || u.status !== 'active' || u.password !== $('#login-password').value) {
      loginErr.hidden = false;
      $('#login-password').value = '';
      $('#login-password').focus();
      return;
    }
    loginErr.hidden = true; login.reset(); signIn(u);
  });
  $('[data-login-form]').addEventListener('input', function () { loginErr.hidden = true; });

  /* Sign up — always creates a 'user' */
  var signup = bindForm($('[data-signup-form]'), {
    name: function () { return val('#su-name').length < 2 ? 'Enter your full name' : ''; },
    email: function () {
      var m = emailRule('#su-email', 'Enter your email')();
      if (m) return m;
      return findUser(val('#su-email')) ? 'An account with this email already exists. Log in instead.' : '';
    },
    password: passwordRule('#su-password'),
    confirm: confirmRule('#su-password', '#su-confirm')
  }, function () {
    var u = { name: val('#su-name'), email: val('#su-email'), role: 'user', status: 'active', password: $('#su-password').value, invitedBy: null };
    USERS.push(u); signup.reset(); signIn(u);
  });

  /* Set password — from invite */
  var setPw = bindForm($('[data-setpw-form]'), {
    name: function () { return $('[data-sp-name-field]').hidden ? '' : (val('#sp-name').length < 2 ? 'Enter your full name' : ''); },
    password: passwordRule('#sp-password'),
    confirm: confirmRule('#sp-password', '#sp-confirm')
  }, function () {
    var u = ui.invitee;
    if (!u.name) u.name = val('#sp-name');
    u.password = $('#sp-password').value; u.status = 'active';
    ui.invitee = null; setPw.reset();
    signIn(u, { welcome: true });
  });

  function openSetPassword(u) {
    ui.invitee = u; ui.user = null; closeInvite(true); syncProto(); setPw.reset();
    var needName = !u.name;
    $('[data-sp-name-row]').hidden = needName;
    $('[data-sp-name]').textContent = u.name || '';
    $('[data-sp-email]').textContent = u.email;
    $('[data-sp-role]').textContent = ROLE_LABEL[u.role];
    $('[data-sp-name-field]').hidden = !needName;
    show('set-password');
  }

  function resetAuthForms() { login.reset(); signup.reset(); loginErr.hidden = true; }

  /* ---------- Team table ---------- */
  var PENCIL = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.5 2.5l3 3L5 14H2v-3z"/></svg>';

  function roleMenuHtml(u) {
    var open = ui.roleMenu === u.email;
    var opts = TAB_ORDER.filter(function (r) { return r !== 'user' && r !== u.role; });
    return '<div class="role-change">' +
      '<button class="link-quiet action-change-role" type="button" data-act="role-menu" aria-haspopup="menu" aria-expanded="' + open + '">Change role</button>' +
      (open ? '<div class="role-menu" role="menu" aria-label="Change ' + esc(possessive(u.name || u.email)) + ' role to">' +
        '<p class="role-menu__label" aria-hidden="true">Change to</p>' +
        opts.map(function (r) { return '<button class="role-menu__item" type="button" role="menuitem" data-act="pick-role" data-role="' + r + '">' + ROLE_LABEL[r] + '</button>'; }).join('') +
      '</div>' : '') +
    '</div>';
  }

  function renderTeam() {
    TAB_ORDER.forEach(function (r) {
      $('[data-team-count="' + r + '"]').textContent = USERS.filter(function (u) { return u.role === r; }).length;
      var t = $('[data-team-tab="' + r + '"]'), on = r === ui.teamTab;
      t.setAttribute('aria-selected', on ? 'true' : 'false'); t.tabIndex = on ? 0 : -1;
    });
    $('[data-team-panel]').setAttribute('aria-labelledby', 'tt-' + ui.teamTab);
    var list = USERS.filter(function (u) { return u.role === ui.teamTab; });
    if (!list.length) {
      var empty = { admin: 'No admins.', specialist: 'No specialists yet. Invite one to get started.' }[ui.teamTab];
      $('[data-team-body]').innerHTML = '<tr class="team-row team-row--empty"><td class="team-row__cell team-row__cell--empty" colspan="6">' + empty + '</td></tr>';
      return;
    }
    $('[data-team-body]').innerHTML = list.map(function (u) {
      var you = ui.user === u;
      var nameCell = ui.editing === u.email
        ? '<form class="name-edit" data-name-edit>' +
            '<label class="sr-only" for="name-edit-input">Name</label>' +
            '<input class="name-edit__input" id="name-edit-input" type="text" value="' + esc(u.name || '') + '" autocomplete="off" aria-describedby="name-edit-error">' +
            '<button class="btn btn--primary name-edit__save" type="submit">Save</button>' +
            '<button class="btn btn--text name-edit__cancel" type="button" data-act="cancel-edit">Cancel</button>' +
          '</form><p class="name-edit__error" id="name-edit-error" hidden>Enter a name</p>'
        : '<div class="team-row__name">' +
            '<span class="team-row__name-text' + (u.name ? '' : ' team-row__name-text--empty') + '">' + (u.name ? esc(u.name) : 'Name not set') + '</span>' +
            (you ? '<span class="team-row__you">You</span>' : '') +
            '<button class="icon-edit action-edit-name" type="button" data-act="edit" aria-label="Edit name for ' + esc(u.name || u.email) + '">' + PENCIL + '</button>' +
          '</div>';
      var status = u.status === 'invited'
        ? '<span class="status-label status-label--invited">Invited, pending</span><button class="link-quiet team-row__view-invite" type="button" data-act="preview">View invite</button>'
        : '<span class="status-label status-label--active">Active</span>' + (u.role === 'user' ? '<span class="team-row__sub">No queue access</span>' : '');
      return '<tr class="team-row team-row--' + u.status + ' team-row--' + u.role + (ui.newRow === u.email ? ' team-row--new' : '') + '" data-email="' + esc(u.email) + '">' +
        '<td class="team-row__cell team-row__cell--name">' + nameCell + '</td>' +
        '<td class="team-row__cell team-row__cell--email">' + esc(u.email) + '</td>' +
        '<td class="team-row__cell team-row__cell--role"><span class="role-badge role-badge--' + u.role + '">' + ROLE_LABEL[u.role] + '</span></td>' +
        '<td class="team-row__cell team-row__cell--status"><div class="team-row__status">' + status + '</div></td>' +
        '<td class="team-row__cell team-row__cell--changed">' + (u.roleChanged
          ? '<span class="team-row__changed">' + esc(fmtDate(u.roleChanged.date)) + ' by ' + esc(u.roleChanged.by) + '</span>'
          : '<span class="team-row__changed team-row__changed--none" aria-label="Never changed">\u2014</span>') + '</td>' +
        '<td class="team-row__cell team-row__cell--actions">' + (you ? '' : '<div class="team-row__actions">' + roleMenuHtml(u) +
          '<button class="link-quiet link-quiet--danger action-remove" type="button" data-act="remove" aria-label="Remove ' + esc(u.name || u.email) + '">Remove</button></div>') + '</td>' +
      '</tr>';
    }).join('');
  }

  function announce(t) { var a = $('[data-team-announce]'); a.textContent = ''; setTimeout(function () { a.textContent = t; }, 40); }
  function rowFor(email) { return $('.team-row[data-email="' + email.replace(/"/g, '\\"') + '"]'); }

  function saveName(u, name) {
    u.name = name;
    if (ui.user === u) {
      $$('[data-current-user]').forEach(function (el) { el.textContent = name; });
      if (window.RelayQueue) window.RelayQueue.setCurrentUser(name);
    }
  }

  var teamBody = $('[data-team-body]');
  teamBody.addEventListener('click', function (e) {
    var b = e.target.closest('[data-act]'); if (!b) return;
    var row = b.closest('.team-row'), u = findUser(row.dataset.email);
    switch (b.dataset.act) {
      case 'role-menu':
        ui.roleMenu = ui.roleMenu === u.email ? null : u.email; renderTeam();
        var r = rowFor(u.email), first = ui.roleMenu && $('.role-menu__item', r);
        (first || $('.action-change-role', r)).focus(); break;
      case 'remove':
        ui.roleMenu = null; openRemove(u, b); break;
      case 'pick-role':
        ui.roleMenu = null; renderTeam(); openRole(u, b.dataset.role); break;
      case 'edit':
        ui.editing = u.email; renderTeam();
        var input = $('#name-edit-input'); input.focus(); input.select(); break;
      case 'cancel-edit':
        ui.editing = null; renderTeam(); $('.action-edit-name', rowFor(u.email)).focus(); break;
      case 'preview':
        ui.preview = u; renderPreview();
        var view = $('[data-team-view]'); view.scrollTop = $('[data-invite-preview]').offsetTop - 24;
        $('[data-ip-cta]').focus({ preventScroll: true }); break;
    }
  });
  teamBody.addEventListener('submit', function (e) {
    e.preventDefault();
    var row = e.target.closest('.team-row'), u = findUser(row.dataset.email);
    var input = $('#name-edit-input'), v = input.value.trim();
    if (!v) { input.setAttribute('aria-invalid', 'true'); $('#name-edit-error').hidden = false; input.focus(); return; }
    saveName(u, v); ui.editing = null; renderTeam(); renderPreview();
    announce('Name updated to ' + v);
    $('.action-edit-name', rowFor(u.email)).focus();
  });
  teamBody.addEventListener('keydown', function (e) {
    if (e.target.classList.contains('role-menu__item') && /^(ArrowDown|ArrowUp)$/.test(e.key)) {
      e.preventDefault();
      var items = $$('.role-menu__item', e.target.parentNode), i = items.indexOf(e.target);
      items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus(); return;
    }
    if (e.key === 'Escape' && ui.roleMenu) {
      var em = ui.roleMenu; ui.roleMenu = null; renderTeam(); $('.action-change-role', rowFor(em)).focus(); return;
    }
    if (e.key === 'Escape' && e.target.id === 'name-edit-input') {
      var email = e.target.closest('.team-row').dataset.email;
      ui.editing = null; renderTeam(); $('.action-edit-name', rowFor(email)).focus();
    }
  });

  document.addEventListener('click', function (e) {
    if (ui.roleMenu && !e.target.closest('.role-change')) { ui.roleMenu = null; renderTeam(); }
  });

  /* ---------- Team tabs ---------- */
  function setTeamTab(r, focus) {
    ui.teamTab = r; ui.editing = null; ui.roleMenu = null; renderTeam();
    if (focus) $('[data-team-tab="' + r + '"]').focus();
  }
  $$('[data-team-tab]').forEach(function (t) {
    t.addEventListener('click', function () { setTeamTab(t.dataset.teamTab); });
    t.addEventListener('keydown', function (e) {
      var i = TAB_ORDER.indexOf(ui.teamTab);
      var n = TAB_ORDER.length;
      if (e.key === 'ArrowRight') { e.preventDefault(); setTeamTab(TAB_ORDER[(i + 1) % n], true); }
      if (e.key === 'ArrowLeft') { e.preventDefault(); setTeamTab(TAB_ORDER[(i + n - 1) % n], true); }
    });
  });

  function flashRow(email) {
    ui.newRow = email; renderTeam();
    setTimeout(function () { ui.newRow = null; var r = rowFor(email); if (r) r.classList.remove('team-row--new'); }, 2200);
  }

  /* ---------- Change role (confirm step) ---------- */
  var roleModal = $('[data-role-modal]'), roleScrim = $('[data-role-scrim]'), roleOpener = null;
  function openRole(u, role) {
    ui.pending = { user: u, role: role };
    roleOpener = $('.action-change-role', rowFor(u.email));
    var n = u.name || u.email, label = ROLE_LABEL[role];
    $('[data-role-title]').textContent = 'Change ' + possessive(n) + ' role to ' + label + '?';
    $('[data-role-change]').innerHTML = '<span class="role-badge role-badge--' + u.role + '">' + ROLE_LABEL[u.role] + '</span><span class="role-modal__arrow" aria-hidden="true">\u2192</span><span class="role-badge role-badge--' + role + '">' + label + '</span>';
    $('[data-role-text]').textContent = n + ' will get an email letting them know their role changed and who changed it. (Email notifications aren\u2019t built yet in this prototype.)';
    roleModal.hidden = false; roleScrim.hidden = false;
    $('[data-role-confirm]').focus();
  }
  function closeRole(silent) {
    if (roleModal.hidden) return;
    roleModal.hidden = true; roleScrim.hidden = true; ui.pending = null;
    if (!silent && roleOpener && document.contains(roleOpener)) roleOpener.focus();
  }
  function applyRole(u, role, by) {
    u.role = role;
    u.roleChanged = { date: new Date(), by: by };
  }
  $('[data-role-confirm]').addEventListener('click', function () {
    var p = ui.pending; if (!p) return;
    applyRole(p.user, p.role, ui.user.name);
    closeRole(true);
    ui.teamTab = p.role; flashRow(p.user.email); renderPreview();
    $('.action-change-role', rowFor(p.user.email)).focus();
    announce((p.user.name || p.user.email) + ' is now ' + article(p.role) + ROLE_LABEL[p.role] + '. Showing ' + ROLE_LABEL[p.role] + 's.');
  });
  $$('[data-role-cancel]').forEach(function (b) { b.addEventListener('click', function () { closeRole(); }); });
  roleScrim.addEventListener('click', function () { closeRole(); });
  document.addEventListener('keydown', function (e) {
    if (roleModal.hidden) return;
    if (e.key === 'Escape') { closeRole(); return; }
    if (e.key === 'Tab') {
      var f = $$('button', roleModal), first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });

  /* ---------- Remove person (confirm step) ---------- */
  var rmModal = $('[data-remove-modal]'), rmScrim = $('[data-remove-scrim]'), rmOpener = null, rmUser = null;
  function claimedOpen(u) {
    var cases = (window.RelayQueue && window.RelayQueue.cases) || [];
    return u.name ? cases.filter(function (c) { return c.claimedBy === u.name && c.status !== 'closed'; }) : [];
  }
  function openRemove(u, opener) {
    rmUser = u; rmOpener = opener;
    var n = u.name || u.email, open = claimedOpen(u);
    $('[data-remove-title]').textContent = 'Remove ' + n + ' from RelayPay support?';
    var t = u.status === 'invited'
      ? 'Their invite link will stop working and they\u2019ll be removed from the team.'
      : 'They\u2019ll lose access immediately and won\u2019t be able to log in.';
    if (open.length) t += ' ' + (open.length === 1 ? '1 open case they claimed (' + open[0].reference + ') goes' : open.length + ' open cases they claimed go') + ' back to the queue unclaimed.';
    if (u.status !== 'invited') t += ' Resolved cases and notes keep their name.';
    $('[data-remove-text]').textContent = t;
    rmModal.hidden = false; rmScrim.hidden = false;
    $('[data-remove-cancel].btn').focus();
  }
  function closeRemove(silent) {
    if (rmModal.hidden) return;
    rmModal.hidden = true; rmScrim.hidden = true; rmUser = null;
    if (!silent && rmOpener && document.contains(rmOpener)) rmOpener.focus();
  }
  $('[data-remove-confirm]').addEventListener('click', function () {
    var u = rmUser; if (!u) return;
    claimedOpen(u).forEach(function (c) { window.RelayQueue.unclaim(c); });
    if (window.RelayQueue) window.RelayQueue.render();
    USERS.splice(USERS.indexOf(u), 1);
    if (ui.preview === u) ui.preview = null;
    closeRemove(true);
    renderTeam(); renderPreview(); syncProtoRoles();
    var next = $('.team-row .action-remove') || $('[data-team-tab="' + ui.teamTab + '"]');
    next.focus();
    announce((u.name || u.email) + ' was removed from the team.');
  });
  $$('[data-remove-cancel]').forEach(function (b) { b.addEventListener('click', function () { closeRemove(); }); });
  rmScrim.addEventListener('click', function () { closeRemove(); });
  document.addEventListener('keydown', function (e) {
    if (rmModal.hidden) return;
    if (e.key === 'Escape') { closeRemove(); return; }
    if (e.key === 'Tab') {
      var f = $$('button', rmModal), first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });

  /* ---------- Invite email preview (mockup) ---------- */
  function renderPreview() {
    var p = ui.preview;
    var u = p && (p.status === 'invited' || p.upgraded) ? p : USERS.filter(function (x) { return x.status === 'invited'; }).pop();
    var sec = $('[data-invite-preview]');
    if (!u) { sec.hidden = true; ui.preview = null; return; }
    sec.hidden = false; ui.preview = u;
    var role = ROLE_LABEL[u.role], by = u.invitedBy || 'A RelayPay admin';
    $('[data-ip-to]').textContent = u.email;
    if (u.upgraded) {
      $('[data-ip-subject]').textContent = 'You now have access to RelayPay support';
      $('[data-ip-line]').textContent = by + ' gave you access to RelayPay support as ' + article(u.role) + role + '.';
      $('[data-ip-cta]').textContent = 'Log in';
      $('[data-ip-foot]').textContent = 'Use your existing password. If you weren\u2019t expecting this, contact your RelayPay admin.';
    } else {
      $('[data-ip-subject]').textContent = 'You\u2019re invited to RelayPay support';
      $('[data-ip-line]').textContent = by + ' invited you to join RelayPay support as ' + article(u.role) + role + '.';
      $('[data-ip-cta]').textContent = 'Set your password';
      $('[data-ip-foot]').textContent = 'This link expires in 7 days. If you weren\u2019t expecting this invite, you can ignore this email.';
    }
  }
  $('[data-ip-cta]').addEventListener('click', function () {
    var u = ui.preview; if (!u) return;
    if (u.upgraded) { signOut(); $('#login-email').value = u.email; $('#login-password').focus(); }
    else openSetPassword(u);
  });

  /* ---------- Invite modal ---------- */
  var modal = $('[data-invite-modal]'), scrim = $('[data-invite-scrim]'), inviteOpener = null;
  var invite = bindForm($('[data-invite-form]'), {
    email: function () {
      var m = emailRule('#invite-email', 'Enter their email')();
      if (m) return m;
      var u = findUser(val('#invite-email'));
      if (u && u.status === 'invited') return 'This person already has a pending invite.';
      if (u && u.role !== 'user') return 'This person is already on the team as ' + article(u.role) + ROLE_LABEL[u.role] + '.';
      return '';
    },
    role: function () { return ''; }
  }, function () {
    var email = val('#invite-email'), role = $('#invite-role').value, u = findUser(email);
    if (u) { applyRole(u, role, ui.user.name); u.upgraded = true; u.invitedBy = ui.user.name; }
    else { u = { name: null, email: email, role: role, status: 'invited', password: null, invitedBy: ui.user.name }; USERS.push(u); }
    closeInvite();
    ui.preview = u; ui.teamTab = role;
    flashRow(u.email); renderPreview();
    announce('Invite sent to ' + email);
  });

  function updateInviteNote() {
    var u = findUser(val('#invite-email')), n = $('[data-invite-note]');
    if (u && u.role === 'user') {
      var role = ROLE_LABEL[$('#invite-role').value];
      n.textContent = (u.name || u.email) + ' already has an account. Sending this invite gives them ' + role + ' access.';
      n.hidden = false;
    } else n.hidden = true;
  }
  $('#invite-email').addEventListener('input', updateInviteNote);
  $('#invite-role').addEventListener('change', updateInviteNote);

  function openInvite() {
    inviteOpener = document.activeElement;
    invite.reset(); $('[data-invite-note]').hidden = true;
    modal.hidden = false; scrim.hidden = false;
    $('#invite-email').focus();
  }
  function closeInvite(silent) {
    if (modal.hidden) return;
    modal.hidden = true; scrim.hidden = true;
    if (!silent && inviteOpener && inviteOpener.focus) inviteOpener.focus();
  }
  $('[data-invite-open]').addEventListener('click', openInvite);
  $$('[data-invite-close]').forEach(function (b) { b.addEventListener('click', function () { closeInvite(); }); });
  scrim.addEventListener('click', function () { closeInvite(); });
  document.addEventListener('keydown', function (e) {
    if (modal.hidden) return;
    if (e.key === 'Escape') { closeInvite(); return; }
    if (e.key === 'Tab') {
      var f = $$('button, input, select', modal);
      var first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });

  /* ---------- Navigation ---------- */
  $$('[data-tab]').forEach(function (b) {
    b.addEventListener('click', function () {
      setTab(b.dataset.tab);
      if (b.dataset.tab === 'team') $('#team-title').focus({ preventScroll: true });
    });
  });
  $$('[data-logout]').forEach(function (b) { b.addEventListener('click', signOut); });
  $$('[data-go]').forEach(function (a) {
    a.addEventListener('click', function (e) { e.preventDefault(); resetAuthForms(); show(a.dataset.go); });
  });

  /* ---------- Prototype: View as ---------- */
  $('[data-proto-view]').addEventListener('change', function (e) {
    var v = e.target.value, u;
    if (v === 'customer') { location.href = 'index.html?as=customer'; return; }
    if (v === 'logged-out') { signOut(); return; }
    var firstActive = function (r, pref) {
      var p = findUser(pref);
      return p && p.role === r && p.status === 'active' ? p : USERS.filter(function (x) { return x.role === r && x.status === 'active'; })[0];
    };
    if (v === 'admin') u = firstActive('admin', 'tunde@relaypay.example');
    else if (v === 'specialist') u = firstActive('specialist', 'zainab@relaypay.example') ||
      firstActive('specialist', '') || (function () { var x = { name: 'Emeka Nwosu', email: 'emeka@relaypay.example', role: 'specialist', status: 'active', password: 'relaypay-demo', invitedBy: 'Tunde Adeyemi' }; USERS.push(x); return x; })();
    else {
      u = USERS.filter(function (x) { return x.role === 'user' && x.status === 'active'; })[0];
      if (!u) { u = { name: 'Folake Adebayo', email: 'folake@relaypay.example', role: 'user', status: 'active', password: 'relaypay-demo', invitedBy: null }; USERS.push(u); }
    }
    closeInvite(true); closeRole(true); closeRemove(true);
    signIn(u);
  });

  /* ---------- Prototype: sample role change (Zainab → Admin) ---------- */
  var protoRoles = $('[data-proto-roles]');
  function syncProtoRoles() {
    var z = findUser('zainab@relaypay.example');
    protoRoles.hidden = ui.view !== 'app' || ui.tab !== 'team' || !z || z.role === 'admin';
  }
  protoRoles.addEventListener('click', function () {
    var z = findUser('zainab@relaypay.example'); if (!z) return;
    applyRole(z, 'admin', ui.user.name);
    ui.teamTab = 'admin'; flashRow(z.email); syncProtoRoles();
    announce('Sample role change applied: Zainab Bello is now an Admin.');
  });

  /* ---------- Init: signed in as admin (or ?as=specialist|admin|logged-out from the voice page) ---------- */
  var as = new URLSearchParams(location.search).get('as');
  if (as === 'specialist' || as === 'logged-out') { var vs = $('[data-proto-view]'); vs.value = as; vs.dispatchEvent(new Event('change')); }
  else signIn(findUser('tunde@relaypay.example'));

  window.RelayAuth = {
    users: USERS, signIn: signIn, signOut: signOut, show: show, setTab: setTab,
    openSetPassword: openSetPassword, openInvite: openInvite, renderTeam: renderTeam
  };
})();
