/**
 * The complete dashboard SPA — single inline HTML/CSS/JS bundle.
 * Served at GET /dashboard. Loaded once per page visit. All page state lives
 * client-side; the only server contract is the /api/user/* JSON endpoints.
 */

export const DASHBOARD_HTML = /* html */ `<!DOCTYPE html>
<html lang="it" data-theme="auto">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="csrf" content="{{CSRF_TOKEN}}" />
  <title>CrimeOpus Dashboard</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
  <style>
    :root {
      --bg: #0b0d10;
      --surface: #15181d;
      --surface-2: #1d2127;
      --border: #2a2f37;
      --text: #e6e8eb;
      --text-dim: #9aa2ad;
      --accent: #ff4757;
      --accent-dim: #c0392b;
      --success: #2ecc71;
      --warning: #f39c12;
      --danger: #e74c3c;
    }
    [data-theme="light"] {
      --bg: #f6f7f9;
      --surface: #ffffff;
      --surface-2: #eef0f3;
      --border: #d6d9de;
      --text: #1a1d22;
      --text-dim: #5a6471;
      --accent: #c0392b;
      --accent-dim: #962d22;
    }
    body { background: var(--bg); color: var(--text); }
    .card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; }
    .btn-accent { background: var(--accent); color: white; }
    .btn-accent:hover { background: var(--accent-dim); }
    .btn-outline { border: 1px solid var(--border); }
    .btn-outline:hover { background: var(--surface-2); }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { animation-duration: 0ms !important; transition-duration: 0ms !important; }
    }
  </style>
</head>
<body class="min-h-screen font-sans antialiased">
  <main id="app" class="container mx-auto p-6 max-w-4xl"></main>
  <div id="toast-container" class="fixed top-4 right-4 z-50 space-y-2"></div>

  <script>
    /* ─── i18n ──────────────────────────────────────────────────────── */
    const I18N = {
      it: {
        dashboard: 'Dashboard',
        login: 'Accedi',
        email: 'Email',
        requestPin: 'Richiedi PIN',
        havePin: 'Hai già un PIN dal bot?',
        verifyPin: 'Verifica PIN',
        pinExpired: 'PIN scaduto',
        openBot: 'Apri il bot Telegram e invia il PIN',
        polling: 'In attesa di conferma…',
        yourKey: 'La tua API Key',
        copy: 'Copia',
        copied: 'Copiato',
        rotate: 'Ruota',
        rotateConfirm: 'Sicuro? La chiave attuale verrà revocata immediatamente.',
        newKeyTitle: 'La tua nuova API Key (mostrata UNA volta)',
        newKeyDesc: 'Copiala adesso. Dopo aver chiuso questo dialog non sarà più visibile.',
        understood: 'Ho capito',
        monthUsage: 'Utilizzo del mese',
        tokens: 'token',
        tokensPerDay: 'Token / giorno',
        howToUse: 'Come usare la tua key',
        configHint: 'In opencode, aggiungi al tuo opencode.jsonc:',
        logout: 'Esci',
        settings: 'Impostazioni',
        securityLog: 'Log sicurezza',
        sessions: 'Sessioni',
        profile: 'Profilo',
        theme: 'Tema',
        language: 'Lingua',
        dark: 'Scuro',
        light: 'Chiaro',
        auto: 'Automatico',
        save: 'Salva',
        saved: 'Salvato',
        created: 'Creata',
        lastUsed: 'Ultimo uso',
        never: 'mai',
        event: 'Evento',
        ip: 'IP',
        date: 'Data',
        device: 'Dispositivo',
        current: 'Corrente',
        revoked: 'Revocata',
        revokeAll: 'Revoca tutte le altre',
        revokeConfirm: 'Revocare tutte le sessioni tranne quella corrente?',
        noEvents: 'Nessun evento',
        loadMore: 'Carica altri',
        nav_overview: 'Panoramica',
        nav_settings: 'Impostazioni',
        nav_security: 'Sicurezza',
        nav_sessions: 'Sessioni',
        error: 'Errore',
        previewCopied: 'Preview copiata. Per la chiave intera, ruota.',
        telegram: 'Telegram',
        updateProfile: 'Aggiorna profilo',
        updated: 'Aggiornato',
      },
      en: {
        dashboard: 'Dashboard',
        login: 'Sign in',
        email: 'Email',
        requestPin: 'Request PIN',
        havePin: 'Already have a PIN from the bot?',
        verifyPin: 'Verify PIN',
        pinExpired: 'PIN expired',
        openBot: 'Open the Telegram bot and send the PIN',
        polling: 'Waiting for confirmation…',
        yourKey: 'Your API Key',
        copy: 'Copy',
        copied: 'Copied',
        rotate: 'Rotate',
        rotateConfirm: 'Are you sure? The current key will be revoked immediately.',
        newKeyTitle: 'Your new API Key (shown ONCE)',
        newKeyDesc: 'Copy it now. After closing this dialog it will never be shown again.',
        understood: 'I understand',
        monthUsage: 'Monthly usage',
        tokens: 'tokens',
        tokensPerDay: 'Tokens / day',
        howToUse: 'How to use your key',
        configHint: 'In opencode, add to your opencode.jsonc:',
        logout: 'Sign out',
        settings: 'Settings',
        securityLog: 'Security log',
        sessions: 'Sessions',
        profile: 'Profile',
        theme: 'Theme',
        language: 'Language',
        dark: 'Dark',
        light: 'Light',
        auto: 'Auto',
        save: 'Save',
        saved: 'Saved',
        created: 'Created',
        lastUsed: 'Last used',
        never: 'never',
        event: 'Event',
        ip: 'IP',
        date: 'Date',
        device: 'Device',
        current: 'Current',
        revoked: 'Revoked',
        revokeAll: 'Revoke all others',
        revokeConfirm: 'Revoke all sessions except the current one?',
        noEvents: 'No events',
        loadMore: 'Load more',
        nav_overview: 'Overview',
        nav_settings: 'Settings',
        nav_security: 'Security',
        nav_sessions: 'Sessions',
        error: 'Error',
        previewCopied: 'Preview copied. For the full key, rotate.',
        telegram: 'Telegram',
        updateProfile: 'Update profile',
        updated: 'Updated',
      },
    };
    let _lang = localStorage.getItem('crimeopus_lang') || 'it';
    function t(key) { return (I18N[_lang] || I18N.it)[key] || key; }
    function setLang(l) { _lang = l; localStorage.setItem('crimeopus_lang', l); }

    /* ─── Constants & helpers ───────────────────────────────────────── */
    const CSRF = document.querySelector('meta[name="csrf"]')?.content || '';
    const $app = document.getElementById('app');
    const $toast = document.getElementById('toast-container');

    function esc(s) {
      return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
        .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
    }

    function toast(msg, kind, durationMs) {
      kind = kind || 'info';
      durationMs = durationMs || 3500;
      var colors = { info: 'bg-blue-600', success: 'bg-green-600', error: 'bg-red-600', warning: 'bg-yellow-600' };
      var el = document.createElement('div');
      el.className = 'px-4 py-3 rounded shadow-lg text-white ' + (colors[kind] || colors.info);
      el.textContent = msg;
      $toast.appendChild(el);
      setTimeout(function() { el.remove(); }, durationMs);
    }

    async function api(path, opts) {
      opts = opts || {};
      var headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
      if (CSRF && opts.method && opts.method !== 'GET') headers['X-CSRF'] = CSRF;
      var res = await fetch(path, Object.assign({ credentials: 'same-origin' }, opts, { headers: headers }));
      var body = null;
      try { body = await res.json(); } catch(e) {}
      return { status: res.status, body: body };
    }

    /* ─── Routing ───────────────────────────────────────────────────── */
    var ROUTES = {};
    function defineRoute(hash, render) { ROUTES[hash] = render; }

    var _chart = null;
    async function navigate() {
      if (_chart) { _chart.destroy(); _chart = null; }
      var hash = window.location.hash || '#/';
      var renderFn = ROUTES[hash] || ROUTES['#/'] || function() { return '<p>404</p>'; };
      $app.innerHTML = await renderFn();
    }
    window.addEventListener('hashchange', navigate);

    /* ─── Navbar ────────────────────────────────────────────────────── */
    function navHtml(me, active) {
      var items = [
        { hash: '#/', label: t('nav_overview'), icon: '📊' },
        { hash: '#/settings', label: t('nav_settings'), icon: '⚙️' },
        { hash: '#/security', label: t('nav_security'), icon: '🛡️' },
        { hash: '#/sessions', label: t('nav_sessions'), icon: '🔐' },
      ];
      var nav = items.map(function(it) {
        var cls = it.hash === active ? 'text-[var(--accent)] font-semibold' : 'text-[var(--text-dim)] hover:text-[var(--text)]';
        return '<a href="' + it.hash + '" class="flex items-center gap-1.5 text-sm ' + cls + '">' + it.icon + ' ' + esc(it.label) + '</a>';
      }).join('');
      return '<header class="flex items-center justify-between mb-6 flex-wrap gap-3">' +
        '<div class="flex items-center gap-1"><span class="text-xl font-bold text-[var(--accent)]">⚡</span><h1 class="text-xl font-bold">CrimeOpus</h1></div>' +
        '<nav class="flex items-center gap-4">' + nav + '</nav>' +
        '<div class="flex items-center gap-3 text-sm">' +
          '<span class="text-[var(--text-dim)]">' + esc(me.email || me.id) + '</span>' +
          '<button id="btn-logout" class="px-3 py-1 rounded btn-outline text-sm">' + esc(t('logout')) + '</button>' +
        '</div>' +
      '</header>';
    }

    /* ─── Login page (#/login) ──────────────────────────────────────── */
    defineRoute('#/login', function() {
      setTimeout(function() {
        document.getElementById('login-form')?.addEventListener('submit', onLoginSubmit);
        document.getElementById('pin-form')?.addEventListener('submit', onPinSubmit);
      }, 0);
      return '<div class="card p-8 max-w-md mx-auto mt-12">' +
        '<div class="text-center mb-6"><span class="text-4xl">⚡</span><h1 class="text-2xl font-bold mt-2">CrimeOpus</h1><p class="text-[var(--text-dim)] text-sm mt-1">' + esc(t('dashboard')) + '</p></div>' +
        '<form id="login-form" class="space-y-3 mb-6">' +
          '<label class="block text-sm" for="email">' + esc(t('email')) + '</label>' +
          '<input id="email" type="email" required class="w-full p-2 rounded bg-[var(--surface-2)] border border-[var(--border)]" />' +
          '<button type="submit" class="btn-accent w-full p-2 rounded font-medium">' + esc(t('requestPin')) + '</button>' +
        '</form>' +
        '<div id="pin-instructions" class="hidden mb-4 text-sm text-[var(--text-dim)]"></div>' +
        '<details>' +
          '<summary class="cursor-pointer text-sm text-[var(--text-dim)]">' + esc(t('havePin')) + '</summary>' +
          '<form id="pin-form" class="space-y-3 mt-3">' +
            '<input id="pin-input" placeholder="PIN" class="w-full p-2 rounded bg-[var(--surface-2)] border border-[var(--border)]" />' +
            '<button type="submit" class="w-full p-2 rounded bg-[var(--surface-2)] border border-[var(--border)]">' + esc(t('verifyPin')) + '</button>' +
          '</form>' +
        '</details>' +
      '</div>';
    });

    async function onLoginSubmit(ev) {
      ev.preventDefault();
      var email = document.getElementById('email').value.trim();
      var r = await api('/license/auth/start', { method: 'POST', body: JSON.stringify({ email: email }) });
      if (r.status !== 200) { toast(r.body?.error || t('error'), 'error'); return; }
      var inst = document.getElementById('pin-instructions');
      inst.innerHTML = esc(t('openBot')) + ' <strong>' + esc(r.body.pin) + '</strong>. ' + esc(t('polling'));
      inst.classList.remove('hidden');
      pollPin(r.body.pin);
    }
    async function onPinSubmit(ev) {
      ev.preventDefault();
      pollPin(document.getElementById('pin-input').value.trim());
    }

    async function pollPin(pin) {
      var start = Date.now();
      var tick = async function() {
        if (Date.now() - start > 10 * 60000) { toast(t('pinExpired'), 'error'); return; }
        var r = await api('/license/auth/poll/' + encodeURIComponent(pin));
        if (r.status === 200 && r.body?.session_token) {
          window.location.hash = '#/';
          navigate();
          return;
        }
        setTimeout(tick, 2000);
      };
      tick();
    }

    /* ─── Main dashboard (#/) ───────────────────────────────────────── */
    defineRoute('#/', async function() {
      var meR = await api('/api/user/me');
      if (meR.status === 401) { window.location.hash = '#/login'; return navigate(); }
      var me = meR.body;
      var keysR = await api('/api/user/keys');
      var keys = keysR.body?.keys || [];
      var usageR = await api('/api/user/usage');
      var usage = usageR.body || { current_period: null, daily: [] };
      var k = keys[0];

      setTimeout(function() {
        document.getElementById('btn-copy')?.addEventListener('click', function() {
          navigator.clipboard.writeText(k?.secret_preview || '');
          toast(t('previewCopied'), 'warning');
        });
        document.getElementById('btn-rotate')?.addEventListener('click', onRotate);
        document.getElementById('btn-logout')?.addEventListener('click', onLogout);
        renderUsageChart(usage.daily);
      }, 0);

      var used = usage.current_period?.used_tokens || 0;
      var cap = usage.current_period?.monthly_token_quota || 1;
      var pct = Math.min(100, Math.round((used / cap) * 100));

      return navHtml(me, '#/') +
        '<section class="card p-6 mb-6">' +
          '<h2 class="text-sm uppercase tracking-wider text-[var(--text-dim)] mb-3">' + esc(t('yourKey')) + '</h2>' +
          '<div class="flex items-center gap-3">' +
            '<code class="flex-1 px-3 py-2 rounded bg-[var(--surface-2)] font-mono text-sm">' + esc(k?.secret_preview || '—') + '</code>' +
            '<button id="btn-copy" class="px-3 py-2 rounded btn-outline text-sm">' + esc(t('copy')) + '</button>' +
            '<button id="btn-rotate" class="px-3 py-2 rounded border border-[var(--accent)] text-[var(--accent)] text-sm">' + esc(t('rotate')) + '</button>' +
          '</div>' +
          '<p class="text-xs text-[var(--text-dim)] mt-2">' +
            esc(t('created')) + ': ' + new Date(k?.created_at || Date.now()).toLocaleString() + ' · ' +
            esc(t('lastUsed')) + ': ' + (k?.last_used_at ? new Date(k.last_used_at).toLocaleString() : esc(t('never'))) +
          '</p>' +
        '</section>' +
        '<section class="card p-6 mb-6">' +
          '<h2 class="text-sm uppercase tracking-wider text-[var(--text-dim)] mb-3">' + esc(t('monthUsage')) + '</h2>' +
          '<p class="text-3xl font-bold">' + used.toLocaleString() + ' <span class="text-base font-normal text-[var(--text-dim)]">/ ' + cap.toLocaleString() + ' ' + esc(t('tokens')) + ' (' + pct + '%)</span></p>' +
          '<div class="w-full bg-[var(--surface-2)] rounded-full h-2 my-3 overflow-hidden"><div class="h-2 bg-[var(--accent)]" style="width: ' + pct + '%"></div></div>' +
          '<canvas id="usage-chart" height="120"></canvas>' +
        '</section>' +
        '<section class="card p-6 text-sm">' +
          '<h2 class="text-sm uppercase tracking-wider text-[var(--text-dim)] mb-3">' + esc(t('howToUse')) + '</h2>' +
          '<p class="text-[var(--text-dim)] mb-2">' + esc(t('configHint')) + '</p>' +
          '<pre class="bg-[var(--surface-2)] p-3 rounded text-xs overflow-x-auto"><code>"baseURL": "https://ai.crimecode.cc/v1"\\n"apiKey": "&lt;' + esc(t('yourKey')).toLowerCase() + '&gt;"</code></pre>' +
        '</section>';
    });

    function renderUsageChart(daily) {
      var ctx = document.getElementById('usage-chart');
      if (!ctx || !window.Chart) return;
      _chart = new Chart(ctx, {
        type: 'bar',
        data: { labels: daily.map(function(d){ return d.date; }), datasets: [{ label: t('tokensPerDay'), data: daily.map(function(d){ return d.tokens; }), backgroundColor: '#ff4757' }] },
        options: {
          responsive: true,
          plugins: { legend: { display: false } },
          scales: { y: { beginAtZero: true, ticks: { color: '#9aa2ad' } }, x: { ticks: { color: '#9aa2ad', maxRotation: 45 } } },
        },
      });
    }

    async function onRotate() {
      if (!confirm(t('rotateConfirm'))) return;
      var r = await api('/api/user/keys/rotate', { method: 'POST' });
      if (r.status !== 200) { toast(t('error') + ': ' + (r.body?.error || 'unknown'), 'error'); return; }
      var secret = r.body.key.secret;
      var back = document.createElement('div');
      back.className = 'fixed inset-0 bg-black/60 flex items-center justify-center z-50';
      back.innerHTML = '<div class="card p-6 max-w-lg">' +
        '<h2 class="text-lg font-semibold mb-3">' + esc(t('newKeyTitle')) + '</h2>' +
        '<p class="text-sm text-[var(--text-dim)] mb-3">' + esc(t('newKeyDesc')) + '</p>' +
        '<code class="block p-3 rounded bg-[var(--surface-2)] font-mono text-sm break-all">' + esc(secret) + '</code>' +
        '<div class="flex gap-2 mt-4 justify-end">' +
          '<button id="rotate-copy" class="px-3 py-2 rounded btn-outline">' + esc(t('copy')) + '</button>' +
          '<button id="rotate-close" class="px-3 py-2 rounded btn-accent">' + esc(t('understood')) + '</button>' +
        '</div></div>';
      document.body.appendChild(back);
      document.getElementById('rotate-copy').onclick = function() { navigator.clipboard.writeText(secret); toast(t('copied'), 'success'); };
      document.getElementById('rotate-close').onclick = function() { back.remove(); navigate(); };
    }

    async function onLogout() {
      document.cookie = 'crimeopus_session=; path=/; max-age=0';
      window.location.hash = '#/login';
      navigate();
    }

    /* ─── Settings page (#/settings) ────────────────────────────────── */
    defineRoute('#/settings', async function() {
      var meR = await api('/api/user/me');
      if (meR.status === 401) { window.location.hash = '#/login'; return navigate(); }
      var me = meR.body;
      var settR = await api('/api/user/settings');
      var sett = settR.body || { theme: 'auto', language: 'it' };

      setTimeout(function() {
        document.getElementById('btn-logout')?.addEventListener('click', onLogout);
        document.getElementById('profile-form')?.addEventListener('submit', onProfileSave);
        document.getElementById('settings-form')?.addEventListener('submit', onSettingsSave);
      }, 0);

      return navHtml(me, '#/settings') +
        '<section class="card p-6 mb-6">' +
          '<h2 class="text-sm uppercase tracking-wider text-[var(--text-dim)] mb-4">' + esc(t('profile')) + '</h2>' +
          '<form id="profile-form" class="space-y-3">' +
            '<div><label class="block text-sm mb-1">' + esc(t('email')) + '</label>' +
            '<input id="prof-email" type="email" value="' + esc(me.email || '') + '" class="w-full p-2 rounded bg-[var(--surface-2)] border border-[var(--border)]" /></div>' +
            '<div><label class="block text-sm mb-1">' + esc(t('telegram')) + '</label>' +
            '<input id="prof-tg" value="' + esc(me.telegram || '') + '" class="w-full p-2 rounded bg-[var(--surface-2)] border border-[var(--border)]" placeholder="@username" /></div>' +
            '<button type="submit" class="btn-accent px-4 py-2 rounded text-sm font-medium">' + esc(t('updateProfile')) + '</button>' +
          '</form>' +
        '</section>' +
        '<section class="card p-6">' +
          '<h2 class="text-sm uppercase tracking-wider text-[var(--text-dim)] mb-4">' + esc(t('settings')) + '</h2>' +
          '<form id="settings-form" class="space-y-3">' +
            '<div><label class="block text-sm mb-1">' + esc(t('theme')) + '</label>' +
            '<select id="sett-theme" class="w-full p-2 rounded bg-[var(--surface-2)] border border-[var(--border)]">' +
              '<option value="auto"' + (sett.theme==='auto'?' selected':'') + '>' + esc(t('auto')) + '</option>' +
              '<option value="dark"' + (sett.theme==='dark'?' selected':'') + '>' + esc(t('dark')) + '</option>' +
              '<option value="light"' + (sett.theme==='light'?' selected':'') + '>' + esc(t('light')) + '</option>' +
            '</select></div>' +
            '<div><label class="block text-sm mb-1">' + esc(t('language')) + '</label>' +
            '<select id="sett-lang" class="w-full p-2 rounded bg-[var(--surface-2)] border border-[var(--border)]">' +
              '<option value="it"' + (sett.language==='it'?' selected':'') + '>Italiano</option>' +
              '<option value="en"' + (sett.language==='en'?' selected':'') + '>English</option>' +
            '</select></div>' +
            '<button type="submit" class="btn-accent px-4 py-2 rounded text-sm font-medium">' + esc(t('save')) + '</button>' +
          '</form>' +
        '</section>';
    });

    async function onProfileSave(ev) {
      ev.preventDefault();
      var email = document.getElementById('prof-email').value.trim();
      var tg = document.getElementById('prof-tg').value.trim();
      var body = {};
      if (email) body.email = email;
      if (tg) body.telegram = tg;
      var r = await api('/api/user/me', { method: 'PATCH', body: JSON.stringify(body) });
      if (r.status === 200) toast(t('updated'), 'success');
      else toast(r.body?.error || t('error'), 'error');
    }

    async function onSettingsSave(ev) {
      ev.preventDefault();
      var theme = document.getElementById('sett-theme').value;
      var lang = document.getElementById('sett-lang').value;
      var r = await api('/api/user/settings', { method: 'POST', body: JSON.stringify({ theme: theme, language: lang }) });
      if (r.status === 200) {
        setLang(lang);
        document.documentElement.setAttribute('data-theme', theme === 'auto' ? '' : theme);
        toast(t('saved'), 'success');
        navigate();
      } else {
        toast(r.body?.error || t('error'), 'error');
      }
    }

    /* ─── Security log (#/security) ─────────────────────────────────── */
    defineRoute('#/security', async function() {
      var meR = await api('/api/user/me');
      if (meR.status === 401) { window.location.hash = '#/login'; return navigate(); }
      var me = meR.body;
      var logR = await api('/api/user/security-log?limit=50');
      var log = logR.body || { events: [], next_cursor: null };

      setTimeout(function() {
        document.getElementById('btn-logout')?.addEventListener('click', onLogout);
        if (log.next_cursor) {
          document.getElementById('btn-load-more')?.addEventListener('click', function() { loadMoreSecurity(log.next_cursor); });
        }
      }, 0);

      var rows = log.events.map(function(e) {
        return '<tr class="border-b border-[var(--border)]">' +
          '<td class="py-2 px-3 text-sm">' + esc(e.event) + '</td>' +
          '<td class="py-2 px-3 text-sm text-[var(--text-dim)]">' + esc(e.ip || '—') + '</td>' +
          '<td class="py-2 px-3 text-sm text-[var(--text-dim)]">' + new Date(e.created_at).toLocaleString() + '</td>' +
        '</tr>';
      }).join('');

      return navHtml(me, '#/security') +
        '<section class="card p-6">' +
          '<h2 class="text-sm uppercase tracking-wider text-[var(--text-dim)] mb-4">' + esc(t('securityLog')) + '</h2>' +
          (log.events.length === 0
            ? '<p class="text-sm text-[var(--text-dim)]">' + esc(t('noEvents')) + '</p>'
            : '<div class="overflow-x-auto"><table class="w-full"><thead><tr class="border-b border-[var(--border)]">' +
                '<th class="py-2 px-3 text-left text-sm text-[var(--text-dim)]">' + esc(t('event')) + '</th>' +
                '<th class="py-2 px-3 text-left text-sm text-[var(--text-dim)]">' + esc(t('ip')) + '</th>' +
                '<th class="py-2 px-3 text-left text-sm text-[var(--text-dim)]">' + esc(t('date')) + '</th>' +
              '</tr></thead><tbody id="security-tbody">' + rows + '</tbody></table></div>' +
              (log.next_cursor ? '<button id="btn-load-more" class="mt-4 px-4 py-2 rounded btn-outline text-sm">' + esc(t('loadMore')) + '</button>' : '')) +
        '</section>';
    });

    async function loadMoreSecurity(cursor) {
      var r = await api('/api/user/security-log?limit=50&before=' + cursor);
      var log = r.body || { events: [], next_cursor: null };
      var tbody = document.getElementById('security-tbody');
      if (!tbody) return;
      log.events.forEach(function(e) {
        var tr = document.createElement('tr');
        tr.className = 'border-b border-[var(--border)]';
        tr.innerHTML = '<td class="py-2 px-3 text-sm">' + esc(e.event) + '</td>' +
          '<td class="py-2 px-3 text-sm text-[var(--text-dim)]">' + esc(e.ip || '—') + '</td>' +
          '<td class="py-2 px-3 text-sm text-[var(--text-dim)]">' + new Date(e.created_at).toLocaleString() + '</td>';
        tbody.appendChild(tr);
      });
      var btn = document.getElementById('btn-load-more');
      if (log.next_cursor && btn) {
        btn.onclick = function() { loadMoreSecurity(log.next_cursor); };
      } else if (btn) {
        btn.remove();
      }
    }

    /* ─── Sessions page (#/sessions) ────────────────────────────────── */
    defineRoute('#/sessions', async function() {
      var meR = await api('/api/user/me');
      if (meR.status === 401) { window.location.hash = '#/login'; return navigate(); }
      var me = meR.body;
      var sessR = await api('/api/user/sessions');
      var sessions = sessR.body?.sessions || [];

      setTimeout(function() {
        document.getElementById('btn-logout')?.addEventListener('click', onLogout);
        document.getElementById('btn-revoke-all')?.addEventListener('click', onRevokeAll);
      }, 0);

      var rows = sessions.map(function(s) {
        var badge = s.is_current ? '<span class="text-xs bg-green-600 text-white px-1.5 py-0.5 rounded">' + esc(t('current')) + '</span>'
          : s.revoked ? '<span class="text-xs bg-red-600/20 text-red-400 px-1.5 py-0.5 rounded">' + esc(t('revoked')) + '</span>'
          : '';
        return '<tr class="border-b border-[var(--border)]">' +
          '<td class="py-2 px-3 text-sm">' + esc(s.device_label || '—') + '</td>' +
          '<td class="py-2 px-3 text-sm text-[var(--text-dim)]">' + new Date(s.last_seen_at).toLocaleString() + '</td>' +
          '<td class="py-2 px-3 text-sm">' + badge + '</td>' +
        '</tr>';
      }).join('');

      var hasOthers = sessions.some(function(s) { return !s.is_current && !s.revoked; });

      return navHtml(me, '#/sessions') +
        '<section class="card p-6">' +
          '<div class="flex items-center justify-between mb-4">' +
            '<h2 class="text-sm uppercase tracking-wider text-[var(--text-dim)]">' + esc(t('sessions')) + '</h2>' +
            (hasOthers ? '<button id="btn-revoke-all" class="px-3 py-1.5 rounded border border-[var(--danger)] text-[var(--danger)] text-sm">' + esc(t('revokeAll')) + '</button>' : '') +
          '</div>' +
          '<div class="overflow-x-auto"><table class="w-full"><thead><tr class="border-b border-[var(--border)]">' +
            '<th class="py-2 px-3 text-left text-sm text-[var(--text-dim)]">' + esc(t('device')) + '</th>' +
            '<th class="py-2 px-3 text-left text-sm text-[var(--text-dim)]">' + esc(t('lastUsed')) + '</th>' +
            '<th class="py-2 px-3 text-left text-sm text-[var(--text-dim)]">Status</th>' +
          '</tr></thead><tbody>' + rows + '</tbody></table></div>' +
        '</section>';
    });

    async function onRevokeAll() {
      if (!confirm(t('revokeConfirm'))) return;
      var r = await api('/api/user/sessions/revoke-all', { method: 'POST' });
      if (r.status === 200) { toast(t('saved'), 'success'); navigate(); }
      else toast(r.body?.error || t('error'), 'error');
    }

    /* ─── Boot ──────────────────────────────────────────────────────── */
    (async function() {
      // Apply saved theme
      var savedTheme = localStorage.getItem('crimeopus_theme');
      if (savedTheme && savedTheme !== 'auto') document.documentElement.setAttribute('data-theme', savedTheme);

      var r = await api('/api/user/me');
      if (r.status === 401) {
        if (window.location.hash !== '#/login') window.location.hash = '#/login';
      } else {
        if (!window.location.hash || window.location.hash === '#/login') window.location.hash = '#/';
        // load saved lang from server settings
        var settR = await api('/api/user/settings');
        if (settR.body?.language) setLang(settR.body.language);
        if (settR.body?.theme) {
          localStorage.setItem('crimeopus_theme', settR.body.theme);
          if (settR.body.theme !== 'auto') document.documentElement.setAttribute('data-theme', settR.body.theme);
        }
      }
      navigate();
    })();
  </script>
</body>
</html>`
