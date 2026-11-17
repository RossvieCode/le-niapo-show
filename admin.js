/* ==========================================================================
   Le Niapo Show – team dashboard
   admin  – everything: reservations, confirm payments, send tickets, live feed
   viewer – collaborators: the finance overview only (finance_summary), read-only
   door   – sent to the door app (scan.html)
   Reservations arrive "pending" from the booking page. After payment an admin
   confirms them here; the database stamps who confirmed and issues the tickets.
   ========================================================================== */
(function () {
  'use strict';

  const PRICE = 20000;
  const EVENT = 'Le Niapo Show (26 déc. 2026, Minagri Kacyiru)';
  const SITE = 'https://le-niapo-show.vercel.app/'; // public URL, used in the ticket links sent to clients

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const db = window.niapoDb || null;

  const fmt = (n) => String(Math.round(n || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  const money = (n) => fmt(n) + ' RWF';
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const when = (iso) => {
    if (!iso) return '';
    try {
      return new Intl.DateTimeFormat('fr-FR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Kigali' }).format(new Date(iso));
    } catch (e) { return iso; }
  };
  const who = (email) => String(email || '?').split('@')[0];
  // 0788 123 456 / 788123456 → 250788123456 (Rwanda); anything with a country code is kept
  const waNumber = (phone) => {
    let d = String(phone || '').replace(/[^0-9]/g, '');
    if (d.startsWith('00')) d = d.slice(2);
    else if (d.length === 10 && d.startsWith('07')) d = '250' + d.slice(1);
    else if (d.length === 9 && d.startsWith('7')) d = '250' + d;
    return d;
  };
  const waTo = (r, text) => 'https://wa.me/' + waNumber(r.phone) + '?text=' + encodeURIComponent(text);
  const ticketLink = (r) => SITE + 'billet.html?k=' + r.ticket_key;
  const payMsg = (r) => 'Bonjour ' + r.name + ', ici Creed House Prod. Merci pour votre réservation ' + r.code +
    ' pour ' + EVENT + ' : ' + r.qty + ' billet(s), total ' + money(r.total) + '.\nVoici comment régler : ';
  const ticketMsg = (r) => 'Bonjour ' + r.name + ', paiement bien reçu ✅\nRéservation ' + r.code + ' confirmée : ' +
    r.qty + ' billet(s) pour ' + EVENT + '.\n\n' + (r.qty > 1 ? 'Vos billets (un QR code par personne) :\n' : 'Votre billet :\n') +
    ticketLink(r) + '\n\nPrésentez le QR code à l\'entrée. À très vite !';
  const canSend = (r) => r.status === 'confirmed' && !!r.phone;

  const state = { role: '', rows: new Map(), tickets: new Map(), sum: null, tab: 'pending', q: '', me: '', payId: null, fresh: new Set() };

  /* ---------- views ---------- */
  const views = { setup: $('#v-setup'), login: $('#v-login'), denied: $('#v-denied'), dash: $('#v-dash') };
  function show(name) { Object.keys(views).forEach((k) => { views[k].hidden = k !== name; }); }

  if (!db) { show('setup'); return; }

  /* ---------- auth ---------- */
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
    if (!session) { entered = false; stopLive(); state.rows.clear(); state.tickets.clear(); state.role = ''; show('login'); }
  });

  async function enter(session) {
    state.me = session.user.email || '';
    const { data: role, error } = await db.rpc('my_role');
    if (role === 'door') { location.replace('scan.html'); return; }
    if (error || (role !== 'admin' && role !== 'viewer')) {
      $('#d-email').textContent = state.me;
      show('denied');
      return;
    }
    state.role = role;
    const admin = role === 'admin';
    $$('[data-admin-only]').forEach((el) => { el.hidden = !admin; });
    $$('[data-viewer-only]').forEach((el) => { el.hidden = admin; });
    $('#role-l').textContent = admin ? 'Admin' : 'Finances';
    $('#me').textContent = state.me;
    show('dash');
    if (admin) {
      await load();
      startLive();
    } else {
      startPolling();
    }
    loadSummary();
  }

  /* ---------- data ---------- */
  async function fetchAll(table, cols, order) {
    const pageSize = 1000;
    const all = [];
    for (let from = 0; ; from += pageSize) {
      const { data, error } = await db.from(table).select(cols).order(order, { ascending: false }).range(from, from + pageSize - 1);
      if (error) { toast('Erreur de chargement : ' + error.message); break; }
      all.push(...data);
      if (data.length < pageSize) break;
    }
    return all;
  }

  async function load() {
    const [rows, tickets] = await Promise.all([
      fetchAll('reservations', '*', 'created_at'),
      fetchAll('tickets', 'id,reservation_id,seq,checked_in_at,checked_in_by', 'created_at')
    ]);
    state.rows = new Map(rows.map((r) => [r.id, r]));
    state.tickets = new Map(tickets.map((t) => [t.id, t]));
    render();
  }

  // totals come from the database for both roles, so admin and viewer always see the same figures
  let sumBusy = false, sumAgain = false;
  async function loadSummary() {
    if (sumBusy) { sumAgain = true; return; }
    sumBusy = true;
    const { data, error } = await db.rpc('finance_summary');
    sumBusy = false;
    if (!error && data) { state.sum = data; renderOverview(); }
    if (sumAgain) { sumAgain = false; loadSummary(); }
  }
  let sumTimer = 0;
  const summarySoon = () => { clearTimeout(sumTimer); sumTimer = setTimeout(loadSummary, 800); };

  let channel = null, poll = 0;
  function startLive() {
    stopLive();
    channel = db.channel('reservations-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'reservations' }, (p) => {
        const r = p.new;
        if (!r || !r.id) return;
        if (p.eventType === 'INSERT') {
          state.fresh.add(r.id);
          toast(r.origin === 'gate'
            ? 'Vente porte : ' + r.qty + ' billet(s) · ' + (r.payment_method || '') + ' · ' + who(r.sold_by)
            : 'Nouvelle réservation : ' + r.name + ' · ' + r.qty + ' billet(s)');
        }
        state.rows.set(r.id, r);
        render();
        summarySoon();
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tickets' }, (p) => {
        const t = p.new;
        if (!t || !t.id) return;
        state.tickets.set(t.id, t);
        render();
        summarySoon();
      })
      .subscribe((status) => { $('#live').classList.toggle('on', status === 'SUBSCRIBED'); });
  }
  function startPolling() {
    stopLive();
    poll = setInterval(loadSummary, 30000);
    $('#live').classList.add('on');
  }
  function stopLive() {
    if (channel) { db.removeChannel(channel); channel = null; }
    clearInterval(poll);
    $('#live').classList.remove('on');
  }
  // catch anything missed while the phone was locked / tab hidden
  document.addEventListener('visibilitychange', () => {
    if (document.hidden || views.dash.hidden) return;
    if (state.role === 'admin') load();
    loadSummary();
  });

  async function update(id, patch) {
    const { data, error } = await db.from('reservations').update(patch).eq('id', id).select().single();
    if (error) { toast('Échec : ' + error.message); return null; }
    state.rows.set(data.id, data);
    render();
    summarySoon();
    return data;
  }
  const markSent = (id) => { const r = state.rows.get(id); if (r && !r.ticket_sent_at) update(id, { ticket_sent_at: new Date().toISOString() }); };

  /* ---------- overview (admin + viewer) ---------- */
  function hbars(el, items, fmtVal) {
    const max = Math.max(1, ...items.map((i) => i.v));
    el.innerHTML = items.length ? items.map((i) =>
      '<div class="hbar"><div class="hbar-l"><span>' + esc(i.k) + '</span><b>' + esc(fmtVal(i)) + '</b></div>' +
      '<div class="hbar-t"><span style="width:' + (100 * i.v / max).toFixed(1) + '%"></span></div></div>').join('')
      : '<p class="chart-empty">Pas encore de données.</p>';
  }

  function renderOverview() {
    const s = state.sum;
    if (!s) return;
    const m = s.by_method || {}, o = s.by_origin || {};
    const gate = o.gate || { tickets: 0, amount: 0 };

    // collaborators: just the till
    $('#vw-total').textContent = fmt(s.collected);
    $('#vw-momo').textContent = fmt(m['Mobile Money']);
    $('#vw-cash').textContent = fmt(m.Cash);
    $('#vw-tickets').textContent = s.tickets_sold;
    $('#vw-in').textContent = s.entries;    $('#vw-in-bar').style.width = (s.tickets_sold ? Math.round(100 * s.entries / s.tickets_sold) : 0) + '%';
    if (state.role !== 'admin') return;

    $('#st-pending').textContent = s.pending_count;
    $('#st-pending-s').textContent = s.pending_tickets + ' billets · ' + money(s.expected) + ' attendus';
    $('#st-tickets').textContent = s.tickets_sold;
    $('#st-tickets-s').textContent = s.bookings_paid + ' réservation(s)' + (gate.tickets ? ' · ' + gate.tickets + ' à la porte' : '');
    $('#st-revenue').textContent = fmt(s.collected);
    $('#st-revenue-s').textContent = 'Mobile Money ' + fmt(m['Mobile Money']) + ' · Cash ' + fmt(m.Cash) + (m.Autre ? ' · Autre ' + fmt(m.Autre) : '');
    const pct = s.tickets_sold ? Math.round(100 * s.entries / s.tickets_sold) : 0;
    $('#st-entries').textContent = s.entries;
    $('#st-entries-s').textContent = 'sur ' + s.tickets_sold + ' billets · ' + pct + ' %';
    $('#st-entries-bar').style.width = pct + '%';

    // last 14 days, empty days included
    const days = new Map((s.by_day || []).map((d) => [d.day, d]));
    const list = [];
    const today = new Date(new Date().toLocaleString('en-US', { timeZone: 'Africa/Kigali' }));
    for (let i = 13; i >= 0; i--) {
      const d = new Date(today); d.setDate(d.getDate() - i);
      const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
      const v = days.get(key) || { tickets: 0, amount: 0 };
      list.push({ key, label: String(d.getDate()), day: d, tickets: v.tickets, amount: v.amount });
    }
    const max = Math.max(1, ...list.map((d) => d.amount));
    const fr = new Intl.DateTimeFormat('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' });
    $('#ch-day').innerHTML = list.map((d) =>
      '<div class="vbar" title="' + esc(fr.format(d.day) + ' : ' + d.tickets + ' billet(s) · ' + money(d.amount)) + '">' +
      '<span class="vbar-v">' + (d.tickets || '') + '</span>' +
      '<div class="vbar-t"><span style="height:' + (100 * d.amount / max).toFixed(1) + '%"></span></div>' +
      '<span class="vbar-l">' + d.label + '</span></div>').join('');
    const week = list.slice(-7).reduce((n, d) => n + d.amount, 0);
    $('#ch-day-s').textContent = '· 7 derniers jours : ' + money(week);

    hbars($('#ch-method'), ['Mobile Money', 'Cash', 'Autre'].filter((k) => m[k]).map((k) => ({ k, v: m[k] })), (i) => money(i.v));
    hbars($('#ch-origin'), [['online', 'En ligne'], ['gate', 'À la porte']].filter(([k]) => o[k]).map(([k, label]) =>
      ({ k: label, v: o[k].amount, t: o[k].tickets })), (i) => i.t + ' billets · ' + money(i.v));
    hbars($('#ch-ref'), (s.by_ref || []).slice(0, 8).map((r) => ({ k: r.ref === '—' ? 'Sans lien promo' : r.ref, v: r.tickets, a: r.amount })),
      (i) => i.v + ' billets · ' + money(i.a));
  }

  /* ---------- live activity feed (admin) ---------- */
  function renderFeed() {
    const ev = [];
    const name = (r) => '<b>' + esc(r.name) + '</b>';
    state.rows.forEach((r) => {
      if (r.origin === 'gate') {
        ev.push({ at: r.created_at, k: 'gate', h: 'Vente porte · ' + r.qty + ' billet(s) · ' + esc(money(r.total)) + ' ' + esc(r.payment_method || '') + ' · par ' + esc(who(r.sold_by)) });
        return;
      }
      ev.push({ at: r.created_at, k: 'new', h: 'Réservation ' + name(r) + ' · ' + r.qty + ' billet(s)' + (r.ref ? ' · réf ' + esc(r.ref) : '') });
      if (r.confirmed_at) ev.push({ at: r.confirmed_at, k: 'paid', h: 'Paiement ' + name(r) + ' · ' + esc(money(r.total)) + ' ' + esc(r.payment_method || '') + ' · par ' + esc(who(r.confirmed_by)) });
      if (r.ticket_sent_at) ev.push({ at: r.ticket_sent_at, k: 'sent', h: 'Billets envoyés à ' + name(r) });
      if (r.status === 'cancelled') ev.push({ at: r.updated_at, k: 'cancel', h: 'Annulée ' + name(r) + (r.updated_by ? ' · par ' + esc(who(r.updated_by)) : '') });
    });
    state.tickets.forEach((t) => {
      const r = state.rows.get(t.reservation_id);
      if (!t.checked_in_at || !r || r.origin === 'gate') return;
      ev.push({ at: t.checked_in_at, k: 'in', h: 'Entrée ' + name(r) + ' · billet ' + t.seq + '/' + r.qty + ' · ' + esc(who(t.checked_in_by)) });
    });
    ev.sort((a, b) => (a.at < b.at ? 1 : -1));
    $('#feed').innerHTML = ev.length
      ? ev.slice(0, 20).map((e) => '<li class="' + e.k + '"><span>' + e.h + '</span><time>' + esc(when(e.at)) + '</time></li>').join('')
      : '<li class="chart-empty">Rien pour le moment.</li>';
  }

  /* ---------- reservation list (admin) ---------- */
  const sorted = () => Array.from(state.rows.values()).sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  const unsent = (r) => canSend(r) && !r.ticket_sent_at;

  function entriesOf() {
    const n = new Map();
    state.tickets.forEach((t) => { if (t.checked_in_at) n.set(t.reservation_id, (n.get(t.reservation_id) || 0) + 1); });
    return n;
  }

  function matches(r) {
    if (state.tab === 'unsent') { if (!unsent(r)) return false; }
    else if (state.tab !== 'all' && r.status !== state.tab) return false;
    if (!state.q) return true;
    const q = state.q.toLowerCase();
    const digits = q.replace(/[^0-9]/g, '');
    return (r.name || '').toLowerCase().includes(q) ||
      (r.code || '').toLowerCase().includes(q) ||
      (r.participants || '').toLowerCase().includes(q) ||
      (digits.length >= 3 && String(r.phone || '').replace(/[^0-9]/g, '').includes(digits));
  }

  const label = { pending: 'En attente', confirmed: 'Payée', cancelled: 'Annulée' };

  function card(r, entries) {
    const rows = [];
    if (r.phone) rows.push(['Téléphone', '<a href="' + esc(waTo(r, 'Bonjour ' + r.name + ', ')) + '" target="_blank" rel="noopener">' + esc(r.phone) + '</a>']);
    rows.push(['Billets', esc(r.qty) + ' × ' + money(PRICE)]);
    rows.push(['Total', '<span class="res-total">' + money(r.total) + '</span>']);
    if (r.participants) rows.push(['Avec', esc(r.participants)]);
    if (r.ref) rows.push(['Réf', esc(r.ref)]);
    if (r.payment_method) rows.push(['Paiement', esc(r.payment_method)]);
    if (r.note) rows.push(['Note', esc(r.note)]);
    if (r.status === 'confirmed') {
      rows.push(['Entrées', '<span class="res-in' + (entries ? ' some' : '') + '">' + entries + ' / ' + r.qty + '</span> · <a href="' + esc(ticketLink(r)) + '" target="_blank" rel="noopener">voir les billets</a>']);
    }

    let meta = r.origin === 'gate'
      ? 'Vendue à la porte le ' + esc(when(r.created_at)) + ' par ' + esc(who(r.sold_by))
      : 'Reçue le ' + esc(when(r.created_at));
    if (r.status === 'confirmed' && r.origin !== 'gate') meta += ' · <b>payée ' + esc(when(r.confirmed_at)) + ' par ' + esc(r.confirmed_by || '?') + '</b>';
    if (r.ticket_sent_at) meta += ' · billets envoyés ' + esc(when(r.ticket_sent_at));
    if (r.status === 'cancelled') meta += ' · annulée ' + esc(when(r.updated_at)) + (r.updated_by ? ' par ' + esc(r.updated_by) : '');

    let btns = '';
    if (r.status === 'pending') {
      btns = '<button type="button" class="ck-btn b-pay" data-act="pay" data-id="' + r.id + '">Confirmer le paiement</button>' +
        '<a class="ck-btn b-wa" href="' + esc(waTo(r, payMsg(r))) + '" target="_blank" rel="noopener">WhatsApp</a>' +
        '<button type="button" class="ck-btn b-soft" data-act="cancel" data-id="' + r.id + '">Annuler</button>';
    } else if (r.status === 'confirmed') {
      if (canSend(r)) {
        btns = '<a class="ck-btn ' + (r.ticket_sent_at ? 'b-wa' : 'b-pay') + '" data-sent="' + r.id + '" href="' + esc(waTo(r, ticketMsg(r))) + '" target="_blank" rel="noopener">' +
          (r.ticket_sent_at ? 'Renvoyer les billets' : 'Envoyer les billets') + '</a>';
      }
      btns += '<button type="button" class="ck-btn b-soft" data-act="reopen" data-id="' + r.id + '">Remettre en attente</button>';
    } else {
      btns = '<button type="button" class="ck-btn b-soft" data-act="reopen" data-id="' + r.id + '">Rétablir</button>';
    }

    const pill = '<span class="pill ' + r.status + '">' + label[r.status] + '</span>' + (r.origin === 'gate' ? '<span class="pill gate">Porte</span>' : '');
    return '<article class="res ' + r.status + (state.fresh.has(r.id) ? ' fresh' : '') + '">' +
      '<div class="res-top"><div><div class="res-name">' + esc(r.name) + '</div><div class="res-code">' + esc(r.code) + '</div></div>' +
      '<div class="res-pills">' + pill + '</div></div>' +
      '<dl class="res-grid">' + rows.map(([k, v]) => '<dt>' + k + '</dt><dd>' + v + '</dd>').join('') + '</dl>' +
      '<div class="res-meta">' + meta + '</div>' +
      '<div class="res-btns">' + btns + '</div></article>';
  }

  function render() {
    if (state.role !== 'admin') return;
    const all = sorted();
    const count = (s) => all.filter((r) => r.status === s).length;
    const counts = { pending: count('pending'), unsent: all.filter(unsent).length, confirmed: count('confirmed'), cancelled: count('cancelled'), all: all.length };
    $$('[data-count]').forEach((el) => { el.textContent = counts[el.dataset.count]; });
    $$('.adm-tab').forEach((t) => { const on = t.dataset.tab === state.tab; t.setAttribute('aria-selected', String(on)); t.tabIndex = on ? 0 : -1; });

    const entries = entriesOf();
    const list = all.filter(matches);
    $('#list').innerHTML = list.map((r) => card(r, entries.get(r.id) || 0)).join('');
    state.fresh.clear();
    renderFeed();

    const empty = $('#empty');
    empty.hidden = list.length > 0;
    if (!list.length) {
      empty.textContent = state.q ? 'Aucun résultat pour « ' + state.q + ' ».'
        : state.tab === 'pending' ? 'Aucune réservation en attente. Tout est à jour.'
        : state.tab === 'unsent' ? 'Tous les billets payés ont été envoyés.'
        : 'Rien ici pour le moment.';
    }
  }

  /* ---------- interactions ---------- */
  const tabs = $$('.adm-tab');
  const pickTab = (t) => { state.tab = t.dataset.tab; render(); };
  tabs.forEach((t, i) => {
    t.addEventListener('click', () => pickTab(t));
    // tablist keyboard pattern: arrows move and select, Home/End jump
    t.addEventListener('keydown', (e) => {
      const n = tabs.length;
      const j = e.key === 'ArrowRight' ? (i + 1) % n : e.key === 'ArrowLeft' ? (i - 1 + n) % n : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : -1;
      if (j < 0) return;
      e.preventDefault();
      tabs[j].focus();
      pickTab(tabs[j]);
    });
  });
  $('#q').addEventListener('input', (e) => { state.q = e.target.value.trim(); render(); });

  const dlg = $('#dlg-pay');
  const dp = { form: $('#pay-form'), sum: $('#dp-sum'), note: $('#dp-note'), err: $('#dp-err'), ok: $('#dp-ok') };

  $('#list').addEventListener('click', async (e) => {
    const sent = e.target.closest('a[data-sent]');
    if (sent) { markSent(sent.dataset.sent); return; } // the link itself opens WhatsApp
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    const r = state.rows.get(b.dataset.id);
    if (!r) return;
    if (b.dataset.act === 'pay') {
      state.payId = r.id;
      dp.sum.textContent = r.name + ' · ' + r.code + ' · ' + r.qty + ' billet(s) · ' + money(r.total);
      dp.note.value = '';
      dp.err.hidden = true;
      dp.form.querySelector('input[value="Mobile Money"]').checked = true;
      if (dlg.showModal) dlg.showModal(); else dlg.setAttribute('open', '');
    } else if (b.dataset.act === 'cancel') {
      if (!confirm('Annuler la réservation ' + r.code + ' de ' + r.name + ' ?')) return;
      b.disabled = true;
      if (await update(r.id, { status: 'cancelled' })) toast('Réservation ' + r.code + ' annulée.');
    } else if (b.dataset.act === 'reopen') {
      if (r.status === 'confirmed' && !confirm('Remettre ' + r.code + ' en attente ? Le paiement ne sera plus compté et ses billets ne passeront plus à l\'entrée.')) return;
      b.disabled = true;
      if (await update(r.id, { status: 'pending' })) toast('Réservation ' + r.code + ' remise en attente.');
    }
  });

  $('#dp-cancel').addEventListener('click', () => dlg.close());
  dp.form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = state.payId;
    if (!id) return;
    dp.ok.disabled = true; dp.ok.textContent = 'Enregistrement…';
    const method = dp.form.querySelector('input[name="method"]:checked').value;
    const r = await update(id, { status: 'confirmed', payment_method: method, note: dp.note.value.trim() || null });
    dp.ok.disabled = false; dp.ok.textContent = 'Confirmer';
    if (!r) { dp.err.textContent = 'Impossible d\'enregistrer. Réessayez.'; dp.err.hidden = false; return; }
    dlg.close();
    toast('Paiement confirmé · ' + r.code, canSend(r) ? waTo(r, ticketMsg(r)) : null, r.id);
  });

  /* ---------- CSV export (opens in Excel / Google Sheets) ---------- */
  $('#csv').addEventListener('click', () => {
    const entries = entriesOf();
    const cols = [
      ['Code', 'code'], ['Statut', (r) => label[r.status]], ['Origine', (r) => (r.origin === 'gate' ? 'Porte' : 'En ligne')],
      ['Nom', 'name'], ['Téléphone', 'phone'], ['Billets', 'qty'], ['Total (RWF)', 'total'], ['Participants', 'participants'],
      ['Réf', 'ref'], ['Paiement', 'payment_method'], ['Note', 'note'], ['Reçue le', (r) => when(r.created_at)],
      ['Payée le', (r) => when(r.confirmed_at)], ['Confirmée par', 'confirmed_by'], ['Vendue par', 'sold_by'],
      ['Billets envoyés le', (r) => when(r.ticket_sent_at)], ['Entrées', (r) => entries.get(r.id) || 0]
    ];
    const cell = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
    const lines = [cols.map((c) => cell(c[0])).join(';')];
    sorted().reverse().forEach((r) => {
      lines.push(cols.map(([, k]) => cell(typeof k === 'function' ? k(r) : r[k])).join(';'));
    });
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'le-niapo-reservations-' + new Date().toISOString().slice(0, 10) + '.csv';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
  });

  /* ---------- toast ---------- */
  let toastTimer = 0, toastId = null;
  function toast(text, waHref, id) {
    const t = $('#toast');
    $('#toast-txt').textContent = text;
    const wa = $('#toast-wa');
    wa.hidden = !waHref;
    if (waHref) wa.href = waHref;
    toastId = id || null;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, waHref ? 12000 : 5000);
  }
  $('#toast-x').addEventListener('click', () => { $('#toast').hidden = true; });
  $('#toast-wa').addEventListener('click', () => { $('#toast').hidden = true; if (toastId) markSent(toastId); });

  db.auth.getSession().then(({ data }) => { if (!data.session) show('login'); });
})();
