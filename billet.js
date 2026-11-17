/* ==========================================================================
   Le Niapo Show – client ticket page
   billet.html?k=<key>   every ticket of a booking (the link sent on WhatsApp)
   billet.html?t=<token> one ticket (forwarded by the buyer to a friend)
   Each QR encodes billet.html?t=<token>; the door app reads the token from it.
   ========================================================================== */
(function () {
  'use strict';

  const EVENT = { title: 'Le Niapo Show', date: 'Samedi 26 déc. 2026', place: 'Minagri, Kacyiru · Kigali' };

  const $ = (sel, root) => (root || document).querySelector(sel);
  const db = window.niapoDb || null;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const when = (iso) => {
    try {
      return new Intl.DateTimeFormat('fr-FR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Kigali' }).format(new Date(iso));
    } catch (e) { return ''; }
  };
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const ticketUrl = (token) => location.origin + location.pathname + '?t=' + token;

  function show(id) {
    ['b-loading', 'b-error', 'b-inactive', 'b-ok'].forEach((x) => { $('#' + x).hidden = x !== id; });
  }

  function qrSvg(text) {
    const qr = window.qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    return qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
  }

  function ticket(b, t, single) {
    const used = !!t.used_at;
    const share = !single && b.qty > 1
      ? '<a class="bt-share" href="' + esc('https://wa.me/?text=' + encodeURIComponent('Ton billet pour ' + EVENT.title + ' (' + EVENT.date + ', ' + EVENT.place + ') : ' + ticketUrl(t.token))) + '" target="_blank" rel="noopener">Envoyer ce billet à un ami</a>'
      : '';
    return '<article class="bt-tk' + (used ? ' used' : '') + '">' +
      '<div class="ticket">' +
        '<div class="stub"><div>BILLET</div></div>' +
        '<div class="tk">' +
          '<div class="tk-top"><div class="tk-title">' + esc(EVENT.title) + '</div><div class="tk-code">' + esc(t.seq) + ' / ' + esc(b.qty) + '</div></div>' +
          '<div class="tk-sub">' + esc(EVENT.date) + ' · ' + esc(EVENT.place) + '</div>' +
          '<div class="bt-qr" role="img" aria-label="QR code du billet ' + esc(t.seq) + '">' + qrSvg(ticketUrl(t.token)) + '</div>' +
          '<dl>' +
            '<div class="row"><dt>Nom</dt><dd>' + esc(b.name) + '</dd></div>' +
            '<div class="row"><dt>Réservation</dt><dd>' + esc(b.code) + '</dd></div>' +
            '<div class="row total"><dt>Statut</dt><dd class="bt-st">' + (used ? 'Utilisé · ' + esc(when(t.used_at)) : 'Valide') + '</dd></div>' +
          '</dl>' +
        '</div>' +
      '</div>' + share +
    '</article>';
  }

  async function start() {
    const params = new URLSearchParams(location.search);
    const k = (params.get('k') || '').trim();
    const t = (params.get('t') || '').trim();
    const single = !k && !!t;
    const id = k || t;
    if (!db || !UUID.test(id)) { show('b-error'); return; }

    const { data: b, error } = single
      ? await db.rpc('get_ticket', { t: id })
      : await db.rpc('get_booking', { k: id });
    if (error || !b) { show('b-error'); return; }

    if (b.status !== 'confirmed') {
      if (b.status === 'cancelled') {
        $('#b-inactive-h').textContent = 'Réservation annulée';
        $('#b-inactive-p').textContent = 'La réservation ' + b.code + ' a été annulée. Contactez Creed House Prod sur WhatsApp si c\'est une erreur.';
      } else {
        $('#b-inactive-p').textContent = 'La réservation ' + b.code + ' attend la confirmation du paiement. Vos billets apparaîtront ici dès qu\'elle est confirmée : gardez ce lien.';
      }
      show('b-inactive');
      return;
    }

    const list = b.tickets || [];
    $('#b-title').textContent = single ? 'Votre billet' : (list.length > 1 ? 'Vos ' + list.length + ' billets' : 'Votre billet');
    $('#b-lead').textContent = single
      ? 'Billet ' + list[0].seq + ' sur ' + b.qty + ' · réservation ' + b.code
      : (list.length > 1 ? 'Un QR code par personne. Envoyez à chaque ami son billet avec le bouton sous le QR.' : 'Présentez ce QR code à l\'entrée.');
    $('#b-list').innerHTML = list.map((x) => ticket(b, x, single)).join('');
    show('b-ok');
  }

  $('#b-print').addEventListener('click', () => window.print());
  start().catch(() => show('b-error'));
})();
