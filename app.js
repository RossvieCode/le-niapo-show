/* ==========================================================================
   CONFIG – every editable value lives here. Change, commit, push: done.
   (Database keys are in config.js.)
   ========================================================================== */
const CONFIG = {
  whatsappNumber: '+250791207108',           // where reservations are sent (any format, digits are kept)
  pricePerTicket: 20000,                     // if you change it, also change the check in supabase/schema.sql
  currency: 'RWF',
  maxTickets: 10,
  eventDate: '2026-12-26T00:00:00+02:00',    // countdown target (ISO with Kigali timezone)
  eventLabel: 'Le Niapo Show (26 déc. 2026, Minagri Kacyiru, Kigali)',
  pageUrl: 'https://le-niapo-show.vercel.app/'
};

(function () {
  'use strict';

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const docEl = document.documentElement;
  const reduceMotion = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const db = window.niapoDb || null;

  // 20000 → "20 000 RWF"
  const money = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' ' + CONFIG.currency;
  // LN-7K3QXP: no 0/O/1/I so it reads cleanly over the phone
  const newCode = () => {
    const abc = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
    let s = '';
    for (let i = 0; i < 6; i++) s += abc[Math.floor(Math.random() * abc.length)];
    return 'LN-' + s;
  };

  // ?ref=CODE → tracked in the WhatsApp message and the dashboard (letters, digits, - and _ only)
  const ref = (() => {
    try {
      const raw = new URLSearchParams(location.search).get('ref') || '';
      return raw.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32);
    } catch (e) { return ''; }
  })();

  const state = {
    step: 0, qty: 1,
    name: '', phone: '', friends: '',
    bump: 0, code: newCode(), touched: { name: false, phone: false },
    saved: false, saving: false
  };

  const total = () => state.qty * CONFIG.pricePerTicket;
  const nameValid = () => state.name.trim().length >= 2;
  const phoneValid = () => state.phone.replace(/[^0-9]/g, '').length >= 8;
  const detailsValid = () => nameValid() && phoneValid();

  function waLink() {
    const lines = [
      'Bonjour Creed House Prod, je réserve pour ' + CONFIG.eventLabel + '.',
      '',
      'Réservation : ' + state.code,
      'Nom : ' + state.name.trim(),
      'WhatsApp : ' + state.phone.trim(),
      'Billets : ' + state.qty + ' x ' + money(CONFIG.pricePerTicket)
    ];
    if (state.friends.trim()) lines.push('Participants : ' + state.friends.trim());
    lines.push('TOTAL : ' + money(total()));
    if (ref) lines.push('Réf : ' + ref);
    lines.push('', 'Merci de me donner les infos pour le paiement.');
    const wa = String(CONFIG.whatsappNumber).replace(/[^0-9]/g, '');
    return 'https://wa.me/' + wa + '?text=' + encodeURIComponent(lines.join('\n'));
  }

  function shareLink() {
    const text = 'Le Niapo Show à Kigali le 26 déc. ! Minagri Kacyiru, billet ' +
      money(CONFIG.pricePerTicket) + '. Réserve ta place ici : ' + CONFIG.pageUrl;
    return 'https://wa.me/?text=' + encodeURIComponent(text);
  }

  /* ---------- save the reservation as "pending" for the admin dashboard ---------- */
  // Fire-and-forget: WhatsApp opens whatever happens here.
  function saveReservation() {
    if (!db || state.saved || state.saving) return;
    state.saving = true;
    db.from('reservations').insert({
      code: state.code,
      name: state.name.trim(),
      phone: state.phone.trim(),
      participants: state.friends.trim() || null,
      qty: state.qty,
      total: total(),
      ref: ref || null
    }).then(({ error }) => {
      state.saving = false;
      // 23505 = code already stored (e.g. resent): treat as saved
      if (!error || error.code === '23505') state.saved = true;
      else console.warn('Réservation non enregistrée', error);
    }, (err) => { state.saving = false; console.warn('Réservation non enregistrée', err); });
  }

  /* ---------- static values from CONFIG ---------- */
  const setAll = (attr, val) => $$('[' + attr + ']').forEach((el) => { el.textContent = val; });
  setAll('data-price', money(CONFIG.pricePerTicket));

  /* ---------- elements ---------- */
  const views = { landing: $('#view-landing'), flow: $('#view-flow'), done: $('#view-done') };
  const stepEls = [null, $('#step1'), $('#step2'), $('#step3')];
  const el = {
    qty: $('#qty'), dec: $('#dec'), inc: $('#inc'),
    name: $('#ck-name'), phone: $('#ck-phone'), friends: $('#ck-friends'),
    errName: $('#err-name'), errPhone: $('#err-phone'), friendsField: $('#friends-field'),
    next: $('#next'), wa: $('#wa'), waAgain: $('#wa-again'), share: $('#share'),
    tName: $('#t-name'), tPhone: $('#t-phone'), tPlaces: $('#t-places')
  };

  /* ---------- render ---------- */
  function render() {
    const s = state;

    views.landing.hidden = s.step !== 0;
    views.flow.hidden = !(s.step >= 1 && s.step <= 3);
    views.done.hidden = s.step !== 4;
    stepEls.forEach((node, i) => { if (node) node.hidden = s.step !== i; });

    $$('#stepper li').forEach((li, i) => {
      li.classList.toggle('done', s.step >= i + 1);
      if (s.step === i + 1) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current');
    });

    // step 1
    el.qty.textContent = s.qty;
    el.qty.className = s.bump % 2 ? 'ck-qA' : 'ck-qB';
    el.dec.disabled = s.qty <= 1;
    el.inc.disabled = s.qty >= CONFIG.maxTickets;

    // step 2
    el.friendsField.hidden = s.qty <= 1;
    const showName = s.touched.name && !nameValid();
    const showPhone = s.touched.phone && !phoneValid();
    el.errName.hidden = !showName; el.name.setAttribute('aria-invalid', String(showName));
    el.errPhone.hidden = !showPhone; el.phone.setAttribute('aria-invalid', String(showPhone));

    // step 3 ticket
    el.tName.textContent = s.name.trim();
    el.tPhone.textContent = s.phone.trim();
    el.tPlaces.textContent = s.qty + ' × ' + money(CONFIG.pricePerTicket);

    // shared totals
    setAll('data-total', money(total()));
    setAll('data-qty', s.qty);
    setAll('data-code', s.code);

    // bottom bar actions
    const invalid = s.step === 2 && !detailsValid();
    el.next.hidden = !(s.step === 1 || s.step === 2);
    el.next.setAttribute('aria-disabled', String(invalid));
    el.wa.hidden = s.step !== 3;
    const link = waLink();
    el.wa.href = link;
    el.waAgain.href = link;
    el.share.href = shareLink();
  }

  /* ---------- navigation (with browser back support) ---------- */
  function replay(node) {
    if (!node || reduceMotion) return;
    node.classList.remove('ck-up');
    void node.offsetWidth; // restart entrance animation
    node.classList.add('ck-up');
  }

  function goTo(step, push) {
    if (step >= 3 && !detailsValid()) step = Math.min(step, 2);
    const prev = state.step;
    state.step = step;
    render();
    if (push !== false && history.pushState) history.pushState({ step }, '');
    if (prev === step) return;

    window.scrollTo(0, 0);
    if (step >= 1 && step <= 3) {
      if (prev === 0 || prev === 4) replay($('.mini'));
      replay(stepEls[step]);
      const h = $('.h2', stepEls[step]);
      if (h && prev !== 0) h.focus({ preventScroll: true });
    } else if (step === 4) {
      replay(views.done);
      $('.done-h').focus({ preventScroll: true });
    } else {
      $$('.ck-up', views.landing).forEach(replay);
    }
    onScroll();
  }

  try { history.replaceState({ step: 0 }, ''); } catch (e) { /* file:// in some browsers */ }
  window.addEventListener('popstate', (e) => {
    const step = e.state && typeof e.state.step === 'number' ? e.state.step : 0;
    goTo(step, false);
  });

  $$('[data-go]').forEach((b) => b.addEventListener('click', () => goTo(Number(b.dataset.go))));
  $('#back').addEventListener('click', () => {
    if (history.state && history.state.step === state.step && state.step > 0) history.back();
    else goTo(Math.max(0, state.step - 1));
  });

  el.next.addEventListener('click', () => {
    if (state.step === 2 && !detailsValid()) {
      state.touched.name = true; state.touched.phone = true;
      render();
      (nameValid() ? el.phone : el.name).focus();
      return;
    }
    goTo(state.step + 1);
  });

  // a new booking after a change → new code, so the dashboard never mixes two orders
  const changed = () => { if (state.saved) { state.saved = false; state.code = newCode(); } };

  el.inc.addEventListener('click', () => { changed(); state.qty = Math.min(CONFIG.maxTickets, state.qty + 1); state.bump++; render(); });
  el.dec.addEventListener('click', () => { changed(); state.qty = Math.max(1, state.qty - 1); state.bump++; render(); });

  [['name', el.name], ['phone', el.phone], ['friends', el.friends]].forEach(([key, input]) => {
    input.addEventListener('input', () => { changed(); state[key] = input.value; render(); });
    input.addEventListener('blur', () => { if (key in state.touched && input.value) { state.touched[key] = true; render(); } });
  });
  el.name.addEventListener('keydown', (e) => { if (e.key === 'Enter') el.phone.focus(); });
  el.phone.addEventListener('keydown', (e) => { if (e.key === 'Enter') el.next.click(); });

  el.wa.addEventListener('click', () => { saveReservation(); setTimeout(() => goTo(4), 400); });
  el.waAgain.addEventListener('click', saveReservation); // retries if the first save failed

  $('#restart').addEventListener('click', () => {
    state.code = newCode();
    state.saved = false;
    goTo(0);
  });

  /* ---------- countdown ---------- */
  const target = Date.parse(CONFIG.eventDate);
  const pad = (n) => String(n).padStart(2, '0');
  const cd = { d: $('#cd-d'), h: $('#cd-h'), m: $('#cd-m'), s: $('#cd-s') };
  function tick() {
    const diff = Math.max(0, target - Date.now());
    const secs = Math.floor((diff % 60000) / 1000);
    cd.d.textContent = pad(Math.floor(diff / 86400000));
    cd.h.textContent = pad(Math.floor((diff % 86400000) / 3600000));
    cd.m.textContent = pad(Math.floor((diff % 3600000) / 60000));
    cd.s.textContent = pad(secs);
    cd.s.className = 'cd-n gold ' + (secs % 2 ? 'ck-tA' : 'ck-tB');
  }
  tick();
  setInterval(tick, 1000);

  /* ---------- scroll effects fallback ---------- */
  const hdr = $('#hdr');
  const setHdr = () => docEl.style.setProperty('--hdr', hdr.offsetHeight + 'px');
  setHdr();
  window.addEventListener('resize', setHdr);

  if (docEl.classList.contains('io')) {
    const io = new IntersectionObserver((entries) => {
      entries.forEach((en) => {
        if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); }
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -6% 0px' });
    $$('.ck-rev, .ck-revL, .ck-revR, .ck-zoom').forEach((n) => io.observe(n));
  }

  const jsScroll = docEl.classList.contains('js-scroll');
  const jsPar = docEl.classList.contains('js-par');
  const progress = $('#progress');
  const par = $('#par');
  const sticky = $('#sticky');
  let ticking = false;
  function update() {
    ticking = false;
    if (state.step !== 0) return;
    const y = window.scrollY || docEl.scrollTop;
    if (jsScroll) {
      const max = Math.max(1, docEl.scrollHeight - window.innerHeight);
      progress.style.transform = 'scaleX(' + Math.min(1, y / max) + ')';
      sticky.classList.toggle('show', y > 400);
    }
    if (jsPar) {
      const p = Math.min(1, Math.max(0, y / 520));
      par.style.transform = 'translateY(' + (70 * p) + 'px) scale(' + (1 - 0.1 * p) + ')';
      par.style.opacity = String(1 - 0.45 * p);
    }
  }
  function onScroll() {
    if (!jsScroll && !jsPar) return;
    if (!ticking) { ticking = true; requestAnimationFrame(update); }
  }
  window.addEventListener('scroll', onScroll, { passive: true });

  render();
  update();
})();
