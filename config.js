/* ==========================================================================
   Supabase connection, shared by the booking page and the admin dashboard.
   Supabase → Project Settings → API: copy "Project URL" and the "anon public" key.
   The anon key is meant to be public: the database rules (supabase/schema.sql)
   only let visitors ADD a pending reservation, never read or change one.
   Leave both empty and the page still works (WhatsApp only, nothing saved).
   ========================================================================== */
window.NIAPO_DB = {
  url: 'https://amhtxdzeopexxkfwsxie.supabase.co',
  anonKey: 'sb_publishable_DqECG3yILUxTFpTki1LD3g_BdwukPKk'
};

window.niapoDb = (function () {
  const c = window.NIAPO_DB;
  if (!c.url || !c.anonKey || !window.supabase) return null;
  return window.supabase.createClient(c.url, c.anonKey);
})();
