# Le Niapo Show – billetterie Creed House Prod

Booking page for **Le Niapo Show**: 26 décembre 2026, Minagri Kacyiru, Kigali. Billet 20 000 RWF.

Visitors see the flyer, tap **Réserver**, choose how many tickets, enter their name and WhatsApp number, then send a pre-filled reservation to Creed House Prod on WhatsApp. Each reservation is also saved as **en attente** (pending) in a Supabase database. The team sees it in the **admin dashboard** (`/admin.html`) and marks it **payée** once the money is received.

Once payment is confirmed, the client gets their **QR tickets** on WhatsApp, one per person. On the night, the **door app** (`/scan.html`) scans them, each one only once, and records cash sales at the gate. Collaborators get a **finance-only** view.

No framework and no build step: `index.html`, `styles.css`, `app.js` (booking), `admin.*` (dashboard), `billet.*` (tickets), `scan.*` (door), `config.js`, `assets/`.

## 1. Supabase setup (once, about 10 minutes)

1. Create a free project at https://supabase.com (region: closest to Kigali, e.g. Frankfurt or Cape Town).
2. **SQL Editor → New query**: paste all of [`supabase/schema.sql`](supabase/schema.sql), then **Run**.
3. **Authentication → Sign In / Providers → Email**: turn **off** "Allow new users to sign up". Only the accounts you create can log in.
4. **Authentication → Users → Add user → Create new user**: one per team member (email + password, tick "Auto confirm").
5. Give each of those emails a role. In the SQL Editor:
   ```sql
   insert into public.staff (email, name, role) values
     ('prenom1@exemple.com', 'Prénom 1', 'admin'),   -- everything
     ('porte1@exemple.com',  'Porte 1',  'door'),    -- door app only: scan + gate sales
     ('associe@exemple.com', 'Associé',  'viewer');  -- finance figures only, read-only
   ```
   Change a role: `update public.staff set role = 'viewer' where email = '...';`
   Remove someone: `delete from public.staff where email = '...';`
6. **Project Settings → API**: copy the **Project URL** and the **anon public** key into [`config.js`](config.js).

Until `config.js` is filled in, the booking page still works (WhatsApp only, nothing saved) and `/admin.html` says the database isn't connected.

**Updating the database:** when `schema.sql` changes, paste the whole file again and **Run**. It only adds what's missing; existing reservations are kept.

### What the rules allow

The database enforces these rules, not just the screens. A collaborator who opens the browser's developer tools still gets nothing but totals.

| Who | Can |
| --- | --- |
| **Visitors** | Only *add* a pending reservation. Can't read, change or delete anything. Total must equal billets × 20 000. |
| **admin** | See every reservation and its tickets, change status (pending → payée / annulée, or back), send tickets, use the door app. |
| **door** | Scan tickets, look up a booking by code, record gate sales, see entries and their own cash. No client list, no finance. |
| **viewer** | The till only: total collected, Mobile Money, Cash, tickets sold, tickets scanned at the door. No names, phones or codes. Read-only. |

The database records who confirmed each payment, who scanned each ticket and who made each gate sale, with the time. The browser can't fake these. Nothing can be deleted: cancelled reservations stay in the history.

## 2. Admin dashboard: `/admin.html`

Admins and viewers log in here. A door account is sent straight to the door app.

- **Viewer screen**: total collected, Mobile Money, Cash, tickets sold, tickets scanned at the door.
- **Overview** (admin): pending (and money expected), tickets paid, money collected (Mobile Money / Cash), entries at the door with a progress bar, sales per day for the last 14 days, online vs gate, promoter leaderboard (`?ref=`).
- **Activité** (admin): live feed of bookings, payments, tickets sent, entries and gate sales.
- Tabs **En attente / Billets à envoyer / Payées / Annulées / Toutes**, plus search by name, phone or code.
- **WhatsApp** on a pending card opens a chat with the buyer, pre-filled with their order, so you can send payment instructions.
- **Confirmer le paiement**: pick Mobile Money / Cash / Autre and add an optional note (e.g. the MoMo transaction ID). The tickets are created at this moment, one per person.
- **Envoyer les billets**: opens WhatsApp with a message and the client's private ticket link. The card then shows "billets envoyés" with the date, and the booking leaves the **Billets à envoyer** tab. **Renvoyer** sends the same link again (the QR codes don't change).
- Each paid card shows **Entrées 2 / 4** and a link to view the tickets as the client sees them.
- Live updates (green "Direct" dot) for admins; viewers' figures refresh every 30 seconds.
- **Exporter CSV**: every reservation with origin, entries and ticket-sent date. Opens in Excel or Google Sheets.

The page is `noindex` and not linked from the public site. Share the URL with the team only.

## Tickets: `/billet.html`

- After payment, the client receives `billet.html?k=…`: one ticket per person, each with its own QR code. The link is secret and impossible to guess, so treat it like the ticket itself.
- **Envoyer ce billet à un ami** (under each QR) shares just that one ticket (`billet.html?t=…`), so friends can arrive separately.
- **Enregistrer en PDF / imprimer**: one ticket per page.
- Each QR works **once**. After it's scanned, the ticket shows "Utilisé" with the time.
- If a booking is put back to pending or cancelled, its QR codes stop working at the door. Re-confirming it brings the same codes back.

## Door app: `/scan.html`

For `door` accounts (and admins, via the **Porte** button in the dashboard).

- **Scanner**: point the camera at the QR.
  - **Green** = let them in.
  - **Red** = already used (shows when and by whom) or not a valid ticket.
  - **Orange** = booking not paid or cancelled: call an admin.
- **Code**: type the booking code (LN-XXXXXX) if a phone screen is broken or out of battery, then let people in one by one or all at once.
- **Vente porte**: number of tickets, Cash or Mobile Money, optional name and number, then **Encaisser**. The sale is recorded as paid and those guests are counted as entered.
- The header shows entries / tickets sold. The gate tab shows **ma caisse**, the cash each person should hand over at the end of the night.

**Checklist for the night:** phones charged, plus a power bank. Mobile data or Wi-Fi at the door: each scan is checked online, which is what makes using a ticket twice impossible. Log in and test the camera on a test ticket before the doors open.

## 3. Change price, number, date…

Booking page: the `CONFIG` object at the top of [`app.js`](app.js).

| Key | What it does |
| --- | --- |
| `whatsappNumber` | Number that receives reservations (`+250791207108`). |
| `pricePerTicket`, `currency` | `20000`, `"RWF"`. **If you change the price**, also change `PRICE` in `admin.js` and `scan.js`, the `total_matches_price` check and the `20000` in `gate_sale` in `schema.sql` (then re-run it). |
| `maxTickets` | Max tickets per reservation (10; the database also allows 1–10). |
| `eventDate` | Countdown target. Currently midnight on 26 Dec: put the real start time when known, e.g. `2026-12-26T20:00:00+02:00`. |
| `eventLabel` | Event name used in the WhatsApp message. |
| `pageUrl` | Public URL, used in "Partager sur WhatsApp". |

Printed texts (date, venue, "Une nuit 100 % Gabon"…) and the link-preview tags live in [`index.html`](index.html). If the URL isn't `le-niapo-show.vercel.app`, update `canonical`, `og:url`, `og:image` and `twitter:image` too.

Flyer: `assets/niapo-flyer.jpg` (square). Link preview: `assets/og-image.jpg` (1200×630).

## 4. Deploy (Vercel)

Push this folder to a new GitHub repo, then on vercel.com **Add New → Project → import the repo** (framework: "Other", no build command). Or, from this folder: `npx vercel --prod`.

## Tracking promoters

Add `?ref=CODE` to the link you hand out, e.g. `https://le-niapo-show.vercel.app/?ref=INSTA`. The ref shows in the WhatsApp message, on the dashboard card and in the CSV.
