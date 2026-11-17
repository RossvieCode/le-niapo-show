/* ==========================================================================
   Le Niapo Show – door app (door staff and admins)
   Scan a ticket QR → the database admits it once (check_in). Fallback by
   booking code, and cash / Mobile Money sales at the gate (gate_sale).
   ========================================================================== */
(function () {
  'use strict';

  const PRICE = 20000;
  const MAX = 10;

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const db = window.niapoDb || null;

  const fmt = (n) => String(Math.round(n || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  const money = (n) => fmt(n) + ' RWF';
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const hour = (iso) => {
    try {
      return new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Kigali' }).format(new Date(iso));
    } catch (e) { return ''; }
  };
  const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

  // QR content is billet.html?t=<token>; accept a bare token too
  function tokenFrom(text) {
    const s = String(text || '');
    try {
      const t = new URL(s).searchParams.get('t');
      if (t && UUID.test(t)) return t.match(UUID)[0];
    } catch (e) { /* not a URL */ }
    const m = s.match(UUID);
    return m ? m[0] : null;
  }

  const state = { tab: 'scan', me: '', qty: 1, busy: false, last: '', lastAt: 0, paused: false };

  /* ---------- views ---------- */
  const views = { setup: $('#v-setup'), login: $('#v-login'), denied: $('#v-denied'), app: $('#v-app') };
  function show(name) { Object.keys(views).forEach((k) => { views[k].hidden = k !== name; }); }

  if (!db) { show('setup'); return; }

  /* ---------- auth (same accounts as the admin dashboard) ---------- */
  const lf = { form: $('#login-form'), email: $('#l-email'), pass: $('#l-pass'), err: $('#l-err'), btn: $('#l-btn') };
  lf.form.addEventListener('submit', async (e) => {
    e.preventDefault();
    lf.err.hidden = true;
    if (!lf.email.value || !lf.pass.value) { lf.err.textContent = 'Email et mot de passe requis.'; lf.err.hidden = false; return; }
    lf.btn.disabled = true; lf.btn.textContent = 'Connexion…';
    const { error } = await db.auth.signInWithPassword({ email: lf.email.value.trim(), password: lf.pass.value });
    lf.btn.disabled = false; lf.btn.textContent = 'Se connecter';
    if (error) { lf.err.textContent = 'Email ou mot de passe incorrect.'; lf.err.hidden = false; return; }
    lf.pass.value = '';
  });
  $$('[data-logout]').forEach((b) => b.addEventListener('click', () => db.auth.signOut()));

  let entered = false;
  db.auth.onAuthStateChange((event, session) => {
    // deferred: awaiting other Supabase calls inside this callback can deadlock the client
    if (session && !entered) { entered = true; setTimeout(() => enter(session), 0); }
    if (!session) { entered = false; stopCam(); clearInterval(sumTimer); show('login'); }
  });

  let sumTimer = 0;
  async function enter(session) {
    state.me = session.user.email || '';
    const { data: role } = await db.rpc('my_role');
    if (role !== 'door' && role !== 'admin') {
      $('#d-email').textContent = state.me;
      show('denied');
      return;
    }
    $('#me').textContent = state.me.split('@')[0];
    show('app');
    setTab('scan');
    refreshSummary();
    clearInterval(sumTimer);
    sumTimer = setInterval(refreshSummary, 20000);
  }

  async function refreshSummary() {
    const { data: s } = await db.rpc('door_summary');
    if (!s) return;
    $('#c-in').textContent = s.entries;
    $('#c-sold').textContent = s.sold;
    $('#my-cash').innerHTML = s.my_tickets
      ? 'Ma caisse ce soir : <b>' + esc(money(s.my_cash)) + '</b> cash · ' + esc(money(s.my_momo)) + ' MoMo · ' + esc(s.my_tickets) + ' billet(s)'
      : 'Aucune vente enregistrée par vous pour l\'instant.';
  }

  /* ---------- tabs ---------- */
  function setTab(tab) {
    state.tab = tab;
    $$('.sc-tabs .adm-tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.tab === tab)));
    $('#p-scan').hidden = tab !== 'scan';
    $('#p-code').hidden = tab !== 'code';
    $('#p-sale').hidden = tab !== 'sale';
    if (tab === 'scan') startCam(); else stopCam();
    if (tab === 'code') $('#code-in').focus();
  }
  $$('.sc-tabs .adm-tab').forEach((t) => t.addEventListener('click', () => setTab(t.dataset.tab)));

  /* ---------- feedback: full-screen colour, sound, vibration ---------- */
  let audio = null;
  function beep(good) {
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      const o = audio.createOscillator(), g = audio.createGain();
      o.type = good ? 'sine' : 'square';
      o.frequency.value = good ? 1046 : 220;
      g.gain.value = 0.18;
      o.connect(g); g.connect(audio.destination);
      o.start(); o.stop(audio.currentTime + (good ? 0.15 : 0.45));
    } catch (e) { /* no audio */ }
    if (navigator.vibrate) navigator.vibrate(good ? 80 : [200, 100, 200]);
  }

  let resTimer = 0;
  function result(kind, title, detail) {
    const r = $('#res');
    r.className = 'sc-res ' + kind;
    $('#res-ico').textContent = kind === 'ok' ? '✓' : kind === 'warn' ? '!' : '✕';
    $('#res-h').textContent = title;
    $('#res-p').innerHTML = detail || '';
    r.hidden = false;
    state.paused = true;
    beep(kind === 'ok');
    clearTimeout(resTimer);
    resTimer = setTimeout(closeResult, kind === 'ok' ? 2200 : 4500);
  }
  function closeResult() {
    clearTimeout(resTimer);
    $('#res').hidden = true;
    state.paused = false;
  }
  $('#res').addEventListener('click', closeResult);

  function showCheckIn(c) {
    const who = esc(c.name) + ' · billet ' + esc(c.seq) + '/' + esc(c.qty) + '<br><small>' + esc(c.code) + '</small>';
    if (c.result === 'ok') {
      result('ok', 'Entrée validée', who + (c.qty > 1 ? '<br>' + esc(c.entered) + '/' + esc(c.qty) + ' du groupe entrés' : ''));
    } else if (c.result === 'already') {
      result('bad', 'Déjà utilisé', who + '<br>Entré à ' + esc(hour(c.used_at)) + (c.used_by ? ' (' + esc(c.used_by.split('@')[0]) + ')' : ''));
    } else if (c.result === 'not_paid') {
      result('warn', c.status === 'cancelled' ? 'Réservation annulée' : 'Pas encore payé', who + '<br>Ne pas faire entrer. Voir un responsable.');
    } else {
      result('bad', 'Billet invalide', 'Ce QR code n\'est pas un billet du Niapo Show.');
    }
  }

  async function admit(token) {
    if (state.busy) return null;
    state.busy = true;
    const { data, error } = await db.rpc('check_in', { t: token });
    state.busy = false;
    if (error) { result('bad', 'Erreur réseau', 'Vérifiez la connexion internet et réessayez.<br><small>' + esc(error.message) + '</small>'); return null; }
    showCheckIn(data);
    refreshSummary();
    return data;
  }

  /* ---------- camera scanner ---------- */
  const video = $('#video');
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  let stream = null, raf = 0, lastScan = 0, detector = null;

  if ('BarcodeDetector' in window) {
    window.BarcodeDetector.getSupportedFormats().then((f) => {
      if (f.indexOf('qr_code') >= 0) detector = new window.BarcodeDetector({ formats: ['qr_code'] });
    }).catch(() => {});
  }

  function camMsg(text, button) {
    $('#cam-msg').hidden = !text;
    $('#cam-txt').textContent = text || '';
    $('#cam-start').hidden = !button;
  }

  async function startCam() {
    if (stream) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      camMsg('Caméra indisponible sur ce navigateur. Utilisez Chrome ou Safari, ou l\'onglet Code.', false);
      return;
    }
    camMsg('Ouverture de la caméra…', false);
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
      if (state.tab !== 'scan') { stopCam(); return; }
      video.srcObject = stream;
      await video.play();
      camMsg('', false);
      raf = requestAnimationFrame(loop);
    } catch (e) {
      stream = null;
      camMsg('Autorisez l\'accès à la caméra pour scanner les billets.', true);
    }
  }
  function stopCam() {
    cancelAnimationFrame(raf);
    if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
    video.srcObject = null;
  }
  $('#cam-start').addEventListener('click', startCam);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopCam();
    else if (!views.app.hidden && state.tab === 'scan') startCam();
  });

  async function decode() {
    if (detector) {
      const codes = await detector.detect(video);
      return codes.length ? codes[0].rawValue : null;
    }
    const w = 480, h = Math.round(w * video.videoHeight / video.videoWidth) || 360;
    canvas.width = w; canvas.height = h;
    ctx.drawImage(video, 0, 0, w, h);
    const img = ctx.getImageData(0, 0, w, h);
    const code = window.jsQR && window.jsQR(img.data, w, h, { inversionAttempts: 'dontInvert' });
    return code ? code.data : null;
  }

  async function loop(ts) {
    if (!stream) return;
    if (!state.paused && !state.busy && ts - lastScan > 150 && video.readyState >= 2) {
      lastScan = ts;
      try {
        const text = await decode();
        if (text) onCode(text);
      } catch (e) { /* frame not ready */ }
    }
    raf = requestAnimationFrame(loop);
  }

  function onCode(text) {
    const token = tokenFrom(text);
    const now = Date.now();
    // the same QR stays in front of the camera for a moment: ignore repeats
    if ((token || text) === state.last && now - state.lastAt < 3000) return;
    state.last = token || text; state.lastAt = now;
    if (!token) { result('bad', 'Billet invalide', 'Ce QR code n\'est pas un billet du Niapo Show.'); return; }
    admit(token);
  }

  /* ---------- manual code ---------- */
  let found = null;
  function renderFound() {
    const box = $('#code-res');
    if (!found) { box.innerHTML = ''; return; }
    const b = found;
    const left = (b.tickets || []).filter((t) => !t.used_at);
    let html = '<div class="adm-card sc-found"><div class="res-top"><div><div class="res-name">' + esc(b.name) + '</div>' +
      '<div class="res-code">' + esc(b.code) + ' · ' + esc(b.qty) + ' billet(s)</div></div>' +
      '<span class="pill ' + esc(b.status) + '">' + ({ pending: 'Non payée', confirmed: 'Payée', cancelled: 'Annulée' }[b.status] || '') + '</span></div>';
    if (b.status !== 'confirmed') {
      html += '<p class="sc-warn">' + (b.status === 'cancelled' ? 'Réservation annulée.' : 'Paiement pas encore confirmé.') + ' Ne pas faire entrer : voir un responsable.</p>';
    } else {
      html += '<ul class="sc-tix">' + b.tickets.map((t) => '<li><span>Billet ' + esc(t.seq) + '/' + esc(b.qty) + '</span>' +
        (t.used_at ? '<span class="sc-used">Entré à ' + esc(hour(t.used_at)) + '</span>'
          : '<button type="button" class="ck-btn b-pay" data-token="' + esc(t.token) + '">Faire entrer</button>') + '</li>').join('') + '</ul>';
      if (left.length > 1) html += '<button type="button" class="ck-btn adm-primary" data-all>Faire entrer les ' + left.length + ' restants</button>';
    }
    box.innerHTML = html + '</div>';
  }

  async function lookup() {
    const raw = $('#code-in').value.trim();
    if (!raw) return;
    const { data, error } = await db.rpc('lookup_code', { c: raw });
    if (error) { result('bad', 'Erreur réseau', esc(error.message)); return; }
    found = data;
    if (!found) { $('#code-res').innerHTML = '<p class="adm-empty">Aucune réservation avec le code « ' + esc(raw.toUpperCase()) + ' ».</p>'; return; }
    renderFound();
  }

  $('#code-form').addEventListener('submit', (e) => { e.preventDefault(); lookup(); });
  $('#code-res').addEventListener('click', async (e) => {
    const one = e.target.closest('button[data-token]');
    const all = e.target.closest('button[data-all]');
    if (!one && !all) return;
    e.target.closest('button').disabled = true;
    if (one) {
      await admit(one.dataset.token);
    } else {
      const left = found.tickets.filter((t) => !t.used_at);
      let n = 0;
      for (const t of left) {
        const { data } = await db.rpc('check_in', { t: t.token });
        if (data && data.result === 'ok') n++;
      }
      result(n ? 'ok' : 'bad', n ? n + ' entrée(s) validée(s)' : 'Aucune entrée', esc(found.name) + '<br><small>' + esc(found.code) + '</small>');
      refreshSummary();
    }
    lookup();
  });

  /* ---------- gate sale ---------- */
  function renderSale() {
    $('#s-qty').textContent = state.qty;
    $('#s-dec').disabled = state.qty <= 1;
    $('#s-inc').disabled = state.qty >= MAX;
    $('#s-total').textContent = money(state.qty * PRICE);
  }
  $('#s-inc').addEventListener('click', () => { state.qty = Math.min(MAX, state.qty + 1); renderSale(); });
  $('#s-dec').addEventListener('click', () => { state.qty = Math.max(1, state.qty - 1); renderSale(); });

  $('#p-sale').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#s-err');
    err.hidden = true;
    const method = $('input[name="s-method"]:checked').value;
    const name = $('#s-name').value.trim();
    const phone = $('#s-phone').value.trim();
    if (name && name.length < 2) { err.textContent = 'Nom trop court (ou laissez vide).'; err.hidden = false; return; }
    if (phone && phone.replace(/[^0-9]/g, '').length < 8) { err.textContent = 'Numéro incomplet (ou laissez vide).'; err.hidden = false; return; }
    if (!confirm('Encaisser ' + money(state.qty * PRICE) + ' en ' + method + ' pour ' + state.qty + ' billet(s) ?')) return;

    const ok = $('#s-ok');
    ok.disabled = true;
    const { data, error } = await db.rpc('gate_sale', { n: state.qty, method, buyer: name || null, tel: phone || null });
    ok.disabled = false;
    if (error) { err.textContent = 'Vente non enregistrée : ' + error.message; err.hidden = false; return; }
    result('ok', 'Vente enregistrée', esc(data.qty) + ' entrée(s) · ' + esc(money(data.total)) + ' ' + esc(data.method) + '<br><small>' + esc(data.code) + '</small>');
    state.qty = 1;
    $('#s-name').value = '';
    $('#s-phone').value = '';
    $('input[name="s-method"][value="Cash"]').checked = true;
    renderSale();
    refreshSummary();
  });

  renderSale();
  db.auth.getSession().then(({ data }) => { if (!data.session) show('login'); });
})();
