/* RelayPay — signed-in header for the voice support home page.
   The Supabase session persists in localStorage across pages, but this page
   used to render static "Log in / Sign up" links regardless, so coming back
   from /customer looked like being logged out. Isolated from app.js: if the
   SDK or /api/whoami fails, the logged-out header simply stays. */
(function () {
  'use strict';

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var supabaseClient = null;

  async function whoami() {
    var sessionResult = await supabaseClient.auth.getSession();
    var session = sessionResult.data && sessionResult.data.session;
    if (!session) return null;
    var res = await fetch('/api/whoami', { headers: { Authorization: 'Bearer ' + session.access_token } });
    return res.ok ? res.json() : null;
  }

  function showSignedIn(who) {
    var person = who.kind === 'staff' ? who.profile : who.account;
    $('[data-account-name]').textContent = person.fullName || person.email;
    var home = $('[data-account-home]');
    if (who.kind === 'staff') {
      home.textContent = 'Support queue';
      home.href = '/' + (who.profile.role === 'admin' ? 'admin' : 'specialist');
    }
    $('[data-account-out]').hidden = true;
    $('[data-account-in]').hidden = false;
  }

  $('[data-action="log-out"]').addEventListener('click', async function () {
    try { await supabaseClient.auth.signOut(); } catch (e) { /* ignore */ }
    location.reload();
  });

  (async function init() {
    if (!window.supabase) return;
    try {
      var config = await (await fetch('/api/config')).json();
      supabaseClient = window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey);
      var who = await whoami();
      if (who && (who.account || who.profile)) showSignedIn(who);
    } catch (e) {
      console.error('home-account: could not restore session', e);
    }
  })();
})();
