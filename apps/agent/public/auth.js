/* RelayPay Support — auth, roles and team.
   Real Supabase Auth + the /api/dashboard/* endpoints in apps/agent/src/dashboard/routes.ts.
   Staff accounts only get created via admin invite (no public self-signup);
   role is stored server-side in the `profiles` table. */
(function () {
  'use strict';

  var ROLE_LABEL = { specialist: 'Specialist', admin: 'Admin' };
  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  var article = function (role) { return role === 'admin' ? 'an ' : 'a '; };
  // Visual + a11y feedback for anything async: disables the button and
  // shows a spinner (CSS, keyed off aria-busy) so clicking never looks like
  // nothing happened while a request is in flight.
  function setBusy(button, busy) {
    if (!button) return;
    button.disabled = !!busy;
    button.setAttribute('aria-busy', busy ? 'true' : 'false');
  }

  var TEAM = [];
  var findUser = function (email) {
    var e = String(email || '').trim().toLowerCase();
    return TEAM.filter(function (u) { return u.email.toLowerCase() === e; })[0];
  };
  function mapProfile(p) {
    return {
      id: p.id,
      email: p.email,
      name: p.fullName,
      role: p.role,
      status: p.status,
      invitedBy: p.invitedByName,
      roleChanged: p.roleChanged ? { date: new Date(p.roleChanged.at), by: p.roleChanged.by } : null,
    };
  }

  var ui = { user: null, view: 'app', tab: 'queue', invitee: null, editing: null, newRow: null, teamTab: 'admin', roleMenu: null, pending: null };
  var TAB_ORDER = ['admin', 'specialist'];
  var fmtDate = function (d) { return d.getDate() + ' ' + ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()]; };
  var possessive = function (n) { return /s$/i.test(n) ? n + '’' : n + '’s'; };

  /* ---------- Supabase client + API helper ---------- */
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

  async function fetchMe() {
    try { return (await api('/api/dashboard/me')).profile; }
    catch (e) { return null; }
  }
  // /login is universal — staff and customers both authenticate here, then
  // get routed by whoami() to /admin, /specialist or /customer.
  async function whoami() {
    try { return await api('/api/whoami'); }
    catch (e) { return null; }
  }
  async function fetchTeam() {
    var data = await api('/api/dashboard/team');
    return data.team.map(mapProfile);
  }

  /* ---------- Screens ---------- */
  function show(view) {
    ui.view = view;
    $$('[data-screen]').forEach(function (el) { el.hidden = el.dataset.screen !== view; });
    var h = $('[data-screen="' + view + '"] [data-screen-heading]');
    if (h) h.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }

  function setTab(t) {
    if ((t === 'team' || t === 'audit') && (!ui.user || ui.user.role !== 'admin')) t = 'queue';
    ui.tab = t;
    $$('[data-tab]').forEach(function (b) { b.setAttribute('aria-current', b.dataset.tab === t ? 'page' : 'false'); });
    $$('[data-queue-only]').forEach(function (el) { el.hidden = t !== 'queue'; });
    $('[data-team-view]').hidden = t !== 'team';
    $('[data-audit-view]').hidden = t !== 'audit';
    if (t === 'team') {
      ui.editing = null; ui.roleMenu = null;
      fetchTeam().then(function (team) { TEAM = team; renderTeam(); }).catch(function (e) {
        console.error('Failed to load team', e);
      });
    }
    if (t === 'audit') { refreshAuditTab(); startAuditPolling(); } else { stopAuditPolling(); }
    if (t !== 'queue' && window.RelayQueue) window.RelayQueue.stopToolCallsPolling();
  }

  function signIn(profile, opts) {
    opts = opts || {};
    ui.user = { id: profile.id, email: profile.email, name: profile.fullName || profile.name, role: profile.role };
    $$('[data-current-user]').forEach(function (el) { el.textContent = ui.user.name || ui.user.email; });
    if (window.RelayQueue) window.RelayQueue.setCurrentUser(ui.user.name || ui.user.email);
    $('[data-tab="team"]').hidden = ui.user.role !== 'admin';
    $('[data-tab="audit"]').hidden = ui.user.role !== 'admin';
    // Universal login (/login, /admin or /specialist all show the same form)
    // lands on the role-specific URL once signed in, regardless of which one
    // was used to get here.
    var targetPath = '/' + ui.user.role;
    if (location.pathname !== targetPath) history.replaceState(null, '', targetPath);
    show('app'); setTab('queue');
    if (window.RelayQueue) window.RelayQueue.reload();
    if (opts.welcome) showWelcome(ui.user.name || ui.user.email);
  }

  async function signOut() {
    try { await supabaseClient.auth.signOut(); } catch (e) { /* ignore */ }
    stopAuditPolling();
    ui.user = null; closeInvite(true); closeRole(true); closeRemove(true); resetAuthForms();
    if (location.pathname !== '/login') history.replaceState(null, '', '/login');
    show('login');
  }

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
      var submitBtn = form.querySelector('button[type="submit"]');
      if (submitBtn && submitBtn.getAttribute('aria-busy') === 'true') return;
      var first = null;
      Object.keys(rules).forEach(function (k) { if (!check(k, true) && !first) first = k; });
      if (first) { fieldEl(first).querySelector('input, select').focus(); return; }
      setBusy(submitBtn, true);
      Promise.resolve(onValid()).finally(function () { setBusy(submitBtn, false); });
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
  }, async function () {
    var email = val('#login-email'), password = $('#login-password').value;
    var signInResult = await supabaseClient.auth.signInWithPassword({ email: email, password: password });
    var who = signInResult.error ? null : await whoami();
    if (!who) {
      loginErr.hidden = false;
      $('#login-password').value = '';
      $('#login-password').focus();
      return;
    }
    loginErr.hidden = true; login.reset();
    if (who.kind === 'customer') {
      api('/api/customer/login-event', { method: 'POST' }).catch(function () {});
      location.href = '/customer';
      return;
    }
    api('/api/dashboard/login-event', { method: 'POST' }).catch(function () {});
    signIn(who.profile);
  });
  $('[data-login-form]').addEventListener('input', function () { loginErr.hidden = true; });

  /* Set password — from an invite or password-reset link */
  var setPw = bindForm($('[data-setpw-form]'), {
    name: function () { return $('[data-sp-name-field]').hidden ? '' : (val('#sp-name').length < 2 ? 'Enter your full name' : ''); },
    password: passwordRule('#sp-password'),
    confirm: confirmRule('#sp-password', '#sp-confirm')
  }, async function () {
    var u = ui.invitee;
    var password = $('#sp-password').value;
    var needName = $('[data-sp-name-field]').hidden === false;
    var { error } = await supabaseClient.auth.updateUser({ password: password });
    if (error) return;
    if (needName) {
      try { await api('/api/dashboard/team/' + encodeURIComponent(u.id) + '/name', { method: 'PATCH', body: { name: val('#sp-name') } }); }
      catch (e) { /* non-fatal — they can rename later from Team */ }
    }
    ui.invitee = null; setPw.reset();
    var me = await fetchMe();
    api('/api/dashboard/login-event', { method: 'POST' }).catch(function () {});
    signIn(me || u, { welcome: true });
  });

  function openSetPassword(u) {
    ui.invitee = u; ui.user = null;
    var needName = !u.fullName && !u.name;
    $('[data-sp-name-row]').hidden = needName;
    $('[data-sp-name]').textContent = u.fullName || u.name || '';
    $('[data-sp-email]').textContent = u.email;
    $('[data-sp-role]').textContent = ROLE_LABEL[u.role] || u.role;
    $('[data-sp-name-field]').hidden = !needName;
    setPw.reset();
    show('set-password');
  }

  function resetAuthForms() { login.reset(); loginErr.hidden = true; }

  /* ---------- Password visibility toggle (shared by every password field) ---------- */
  document.addEventListener('click', function (e) {
    var b = e.target.closest('[data-action="toggle-password"]');
    if (!b) return;
    var field = b.closest('.password-field');
    var input = field && field.querySelector('input');
    if (!input) return;
    var show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    b.setAttribute('aria-pressed', show ? 'true' : 'false');
    b.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    $('svg[data-icon="eye"]', b).hidden = show;
    $('svg[data-icon="eye-off"]', b).hidden = !show;
  });

  /* ---------- Team table ---------- */
  var PENCIL = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.5 2.5l3 3L5 14H2v-3z"/></svg>';

  function roleMenuHtml(u) {
    var open = ui.roleMenu === u.email;
    var opts = TAB_ORDER.filter(function (r) { return r !== u.role; });
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
      $('[data-team-count="' + r + '"]').textContent = TEAM.filter(function (u) { return u.role === r; }).length;
      var t = $('[data-team-tab="' + r + '"]'), on = r === ui.teamTab;
      t.setAttribute('aria-selected', on ? 'true' : 'false'); t.tabIndex = on ? 0 : -1;
    });
    $('[data-team-panel]').setAttribute('aria-labelledby', 'tt-' + ui.teamTab);
    var list = TEAM.filter(function (u) { return u.role === ui.teamTab; });
    if (!list.length) {
      var empty = { admin: 'No admins.', specialist: 'No specialists yet. Invite one to get started.' }[ui.teamTab];
      $('[data-team-body]').innerHTML = '<tr class="team-row team-row--empty"><td class="team-row__cell team-row__cell--empty" colspan="6">' + empty + '</td></tr>';
      return;
    }
    $('[data-team-body]').innerHTML = list.map(function (u) {
      var you = ui.user && u.id === ui.user.id;
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
        ? '<span class="status-label status-label--invited">Invited, pending</span>'
        : '<span class="status-label status-label--active">Active</span>';
      return '<tr class="team-row team-row--' + u.status + ' team-row--' + u.role + (ui.newRow === u.email ? ' team-row--new' : '') + '" data-email="' + esc(u.email) + '">' +
        '<td class="team-row__cell team-row__cell--name">' + nameCell + '</td>' +
        '<td class="team-row__cell team-row__cell--email">' + esc(u.email) + '</td>' +
        '<td class="team-row__cell team-row__cell--role"><span class="role-badge role-badge--' + u.role + '">' + ROLE_LABEL[u.role] + '</span></td>' +
        '<td class="team-row__cell team-row__cell--status"><div class="team-row__status">' + status + '</div></td>' +
        '<td class="team-row__cell team-row__cell--changed">' + (u.roleChanged
          ? '<span class="team-row__changed">' + esc(fmtDate(u.roleChanged.date)) + ' by ' + esc(u.roleChanged.by || 'unknown') + '</span>'
          : '<span class="team-row__changed team-row__changed--none" aria-label="Never changed">—</span>') + '</td>' +
        '<td class="team-row__cell team-row__cell--actions">' + (you ? '' : '<div class="team-row__actions">' + roleMenuHtml(u) +
          '<button class="link-quiet link-quiet--danger action-remove" type="button" data-act="remove" aria-label="Remove ' + esc(u.name || u.email) + '">Remove</button></div>') + '</td>' +
      '</tr>';
    }).join('');
  }

  function announce(t) { var a = $('[data-team-announce]'); a.textContent = ''; setTimeout(function () { a.textContent = t; }, 40); }
  function rowFor(email) { return $('.team-row[data-email="' + email.replace(/"/g, '\\"') + '"]'); }

  async function saveName(u, name) {
    await api('/api/dashboard/team/' + encodeURIComponent(u.id) + '/name', { method: 'PATCH', body: { name: name } });
    u.name = name;
    if (ui.user && ui.user.id === u.id) {
      ui.user.name = name;
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
    }
  });
  teamBody.addEventListener('submit', function (e) {
    e.preventDefault();
    var row = e.target.closest('.team-row'), u = findUser(row.dataset.email);
    var input = $('#name-edit-input'), v = input.value.trim();
    if (!v) { input.setAttribute('aria-invalid', 'true'); $('#name-edit-error').hidden = false; input.focus(); return; }
    var saveBtn = e.target.querySelector('.name-edit__save');
    setBusy(saveBtn, true);
    saveName(u, v).then(function () {
      ui.editing = null; renderTeam();
      announce('Name updated to ' + v);
      $('.action-edit-name', rowFor(u.email)).focus();
    }).catch(function () {
      setBusy(saveBtn, false);
      $('#name-edit-error').textContent = 'Could not save — try again.'; $('#name-edit-error').hidden = false;
    });
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
  var roleModal = $('[data-role-modal]'), roleScrim = $('[data-role-scrim]'), roleOpener = null, roleBusy = false;
  function openRole(u, role) {
    ui.pending = { user: u, role: role };
    roleOpener = $('.action-change-role', rowFor(u.email));
    var n = u.name || u.email, label = ROLE_LABEL[role];
    $('[data-role-title]').textContent = 'Change ' + possessive(n) + ' role to ' + label + '?';
    $('[data-role-change]').innerHTML = '<span class="role-badge role-badge--' + u.role + '">' + ROLE_LABEL[u.role] + '</span><span class="role-modal__arrow" aria-hidden="true">→</span><span class="role-badge role-badge--' + role + '">' + label + '</span>';
    $('[data-role-text]').textContent = n + ' will get an email letting them know their role changed and who changed it.';
    roleModal.hidden = false; roleScrim.hidden = false;
    $('[data-role-confirm]').focus();
  }
  function closeRole(silent) {
    if (roleModal.hidden) return;
    roleModal.hidden = true; roleScrim.hidden = true; ui.pending = null;
    if (!silent && roleOpener && document.contains(roleOpener)) roleOpener.focus();
  }
  $('[data-role-confirm]').addEventListener('click', async function () {
    var p = ui.pending; if (!p || roleBusy) return;
    roleBusy = true; setBusy(this, true);
    try {
      await api('/api/dashboard/team/' + encodeURIComponent(p.user.id) + '/role', { method: 'PATCH', body: { role: p.role } });
      p.user.role = p.role;
      p.user.roleChanged = { date: new Date(), by: ui.user.name || ui.user.email };
      closeRole(true);
      ui.teamTab = p.role; flashRow(p.user.email);
      $('.action-change-role', rowFor(p.user.email)).focus();
      announce((p.user.name || p.user.email) + ' is now ' + article(p.role) + ROLE_LABEL[p.role] + '. Showing ' + ROLE_LABEL[p.role] + 's.');
    } catch (e) {
      $('[data-role-text]').textContent = e.data && e.data.error === 'would_remove_last_admin'
        ? 'This would leave RelayPay support with no admins, so this change was not made.'
        : 'Could not change this role — try again.';
    } finally {
      roleBusy = false; setBusy(this, false);
    }
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
  var rmModal = $('[data-remove-modal]'), rmScrim = $('[data-remove-scrim]'), rmOpener = null, rmUser = null, rmBusy = false;
  function claimedOpen(u) {
    var cases = (window.RelayQueue && window.RelayQueue.cases) || [];
    return u.name ? cases.filter(function (c) { return c.claimedBy === u.name && c.status !== 'closed'; }) : [];
  }
  function openRemove(u, opener) {
    rmUser = u; rmOpener = opener;
    var n = u.name || u.email, open = claimedOpen(u);
    $('[data-remove-title]').textContent = 'Remove ' + n + ' from RelayPay support?';
    var t = u.status === 'invited'
      ? 'Their invite link will stop working and they’ll be removed from the team.'
      : 'They’ll lose access immediately and won’t be able to log in.';
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
  $('[data-remove-confirm]').addEventListener('click', async function () {
    var u = rmUser; if (!u || rmBusy) return;
    rmBusy = true; setBusy(this, true);
    try {
      await api('/api/dashboard/team/' + encodeURIComponent(u.id), { method: 'DELETE' });
      TEAM.splice(TEAM.indexOf(u), 1);
      closeRemove(true);
      renderTeam();
      if (window.RelayQueue) window.RelayQueue.reload();
      var next = $('.team-row .action-remove') || $('[data-team-tab="' + ui.teamTab + '"]');
      next.focus();
      announce((u.name || u.email) + ' was removed from the team.');
    } catch (e) {
      $('[data-remove-text]').textContent = e.data && e.data.error === 'would_remove_last_admin'
        ? 'This would leave RelayPay support with no admins, so this person was not removed.'
        : 'Could not remove this person — try again.';
    } finally {
      rmBusy = false; setBusy(this, false);
    }
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

  /* ---------- Invite modal ---------- */
  var modal = $('[data-invite-modal]'), scrim = $('[data-invite-scrim]'), inviteOpener = null;
  var invite = bindForm($('[data-invite-form]'), {
    email: function () {
      var m = emailRule('#invite-email', 'Enter their email')();
      if (m) return m;
      var u = findUser(val('#invite-email'));
      if (u && u.status === 'invited') return 'This person already has a pending invite.';
      if (u) return 'This person is already on the team as ' + article(u.role) + ROLE_LABEL[u.role] + '.';
      return '';
    },
    role: function () { return ''; }
  }, async function () {
    var email = val('#invite-email'), role = $('#invite-role').value;
    try {
      await api('/api/dashboard/team/invite', { method: 'POST', body: { email: email, role: role } });
      closeInvite();
      ui.teamTab = role;
      var team = await fetchTeam(); TEAM = team; renderTeam();
      var invited = findUser(email);
      if (invited) flashRow(invited.email);
      announce('Invite sent to ' + email);
    } catch (e) {
      $('[data-invite-note]').textContent = 'Could not send this invite — try again.';
      $('[data-invite-note]').hidden = false;
    }
  });

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

  /* ---------- Audit log ---------- */
  var CATEGORY_LABEL = { call: 'Call', tool: 'Tool', case: 'Case', email: 'Email', team: 'Team', account: 'Account' };
  var auditTimer = null;
  function fmtAuditTime(iso) {
    var d = new Date(iso);
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) + ', ' +
      d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }
  function renderAuditLog(events) {
    var list = $('[data-audit-list]'), empty = $('[data-audit-empty]');
    if (!events.length) { list.innerHTML = ''; empty.hidden = false; return; }
    empty.hidden = true;
    list.innerHTML = events.map(function (e) {
      var failed = /^Failed to/.test(e.message);
      return '<li class="audit-row audit-row--' + esc(e.category) + (failed ? ' audit-row--failed' : '') + '">' +
        '<span class="audit-row__cat">' + esc(CATEGORY_LABEL[e.category] || e.category) + '</span>' +
        '<span class="audit-row__msg">' + esc(e.message) + '</span>' +
        '<span class="audit-row__time tabular">' + fmtAuditTime(e.created_at) + '</span>' +
      '</li>';
    }).join('');
  }
  async function loadAuditLog() {
    try {
      var data = await api('/api/dashboard/audit-log');
      renderAuditLog(data.events);
    } catch (e) {
      console.error('Failed to load audit log', e);
    }
  }
  function startAuditPolling() {
    stopAuditPolling();
    auditTimer = setInterval(refreshAuditTab, 8000);
  }
  function stopAuditPolling() {
    if (auditTimer) { clearInterval(auditTimer); auditTimer = null; }
  }
  function refreshAuditTab() {
    loadAuditLog();
    loadToolCallLog();
  }

  /* ---------- Tool calls (structured, filterable, CSV export) ---------- */
  var TOOL_CALL_LOG = [];
  var toolCallFilters = { tool: 'all', status: 'all' };

  function populateToolFilterOptions() {
    var select = $('[data-tool-filter]');
    var tools = Array.prototype.slice.call(
      new Set(TOOL_CALL_LOG.map(function (t) { return t.tool_name; }))
    ).sort();
    var current = select.value;
    select.innerHTML = '<option value="all">All tools</option>' +
      tools.map(function (name) { return '<option value="' + esc(name) + '">' + esc(name) + '</option>'; }).join('');
    select.value = tools.indexOf(current) >= 0 ? current : 'all';
  }

  function filteredToolCalls() {
    return TOOL_CALL_LOG.filter(function (t) {
      if (toolCallFilters.tool !== 'all' && t.tool_name !== toolCallFilters.tool) return false;
      if (toolCallFilters.status !== 'all' && t.status !== toolCallFilters.status) return false;
      return true;
    });
  }

  function toolCallTableRowHTML(t) {
    var time = new Date(t.created_at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    return '<tr class="' + (t.status !== 'success' ? 'row-flagged' : '') + '">' +
      '<td><span class="tool-call-table__tool">' + esc(t.tool_name) + '</span></td>' +
      '<td>' + esc(t.purpose || '') +
        (t.input_summary ? '<div class="tool-call-table__detail">' + esc(t.input_summary) + '</div>' : '') + '</td>' +
      '<td>' + esc(t.result_summary || '') +
        (t.error_message ? '<div class="tool-call-table__error">' + esc(t.error_message) + '</div>' : '') + '</td>' +
      '<td><span class="tool-call-badge tool-call-badge--' + esc(t.status) + '">' + esc(t.status) + '</span></td>' +
      '<td class="tool-call-table__time">' + time + '</td>' +
    '</tr>';
  }

  function renderToolCallTable() {
    var body = $('[data-tool-call-body]'), empty = $('[data-tool-call-empty]');
    // /api/dashboard/tool-calls already returns newest-first — no reverse needed.
    var rows = filteredToolCalls();
    if (!rows.length) { body.innerHTML = ''; empty.hidden = false; return; }
    empty.hidden = true;
    body.innerHTML = rows.map(toolCallTableRowHTML).join('');
  }

  async function loadToolCallLog() {
    try {
      var data = await api('/api/dashboard/tool-calls');
      TOOL_CALL_LOG = data.toolCalls;
      populateToolFilterOptions();
      renderToolCallTable();
    } catch (e) {
      console.error('Failed to load tool call log', e);
    }
  }

  $('[data-tool-filter]').addEventListener('change', function (e) { toolCallFilters.tool = e.target.value; renderToolCallTable(); });
  $('[data-tool-status-filter]').addEventListener('change', function (e) { toolCallFilters.status = e.target.value; renderToolCallTable(); });

  function csvField(v) {
    var s = v == null ? '' : String(v);
    return '"' + s.replace(/"/g, '""') + '"';
  }
  $('[data-act="export-tool-calls-csv"]').addEventListener('click', function (e) {
    e.preventDefault();
    var header = ['Tool', 'Purpose', 'Input Summary', 'Result Summary', 'Status', 'Error Message', 'Time'];
    var rows = filteredToolCalls().map(function (t) {
      return [t.tool_name, t.purpose, t.input_summary, t.result_summary, t.status, t.error_message, t.created_at];
    });
    var csv = [header].concat(rows).map(function (row) { return row.map(csvField).join(','); }).join('\r\n');
    var blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = 'tool-calls.csv';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  });

  /* ---------- Navigation ---------- */
  $$('[data-tab]').forEach(function (b) {
    b.addEventListener('click', function () {
      setTab(b.dataset.tab);
      if (b.dataset.tab === 'team') $('#team-title').focus({ preventScroll: true });
    });
  });
  $$('[data-logout]').forEach(function (b) { b.addEventListener('click', function () { signOut(); }); });

  /* ---------- Init ---------- */
  // A Supabase invite/recovery link redirects here with #access_token=...&type=invite
  // in the URL hash; supabase-js (detectSessionInUrl, on by default) turns that into a
  // real session before this code runs, so all that's left is recognizing the "type"
  // and routing to the set-password screen instead of straight into the app.
  async function handleAuthRedirect() {
    var hashParams = new URLSearchParams(location.hash.replace(/^#/, ''));
    var type = hashParams.get('type');
    if (type !== 'invite' && type !== 'recovery') return false;
    history.replaceState(null, '', location.pathname + location.search);
    var me = await fetchMe();
    if (!me) return false;
    openSetPassword(me);
    return true;
  }

  (async function init() {
    await initSupabaseClient();
    if (await handleAuthRedirect()) return;

    var sessionResult = await supabaseClient.auth.getSession();
    if (sessionResult.data && sessionResult.data.session) {
      var who = await whoami();
      if (who && who.kind === 'customer') { location.href = '/customer'; return; }
      if (who && who.kind === 'staff') { signIn(who.profile); return; }
    }
    show('login');
  })();

  window.RelayAuth = {
    signIn: signIn, signOut: signOut, show: show, setTab: setTab,
    openSetPassword: openSetPassword, openInvite: openInvite, renderTeam: renderTeam,
    api: api
  };
})();
