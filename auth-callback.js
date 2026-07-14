(async () => {
  function getConfig() {
    const cfg = window.SUPABASE_CONFIG || {};
    if (!cfg.url || !cfg.anonKey) return null;
    return cfg;
  }

  function getClient() {
    const cfg = getConfig();
    if (!cfg) throw new Error("Missing SUPABASE_CONFIG (url/anonKey).");

    if (!window.supabase?.createClient) {
      throw new Error("Supabase JS not loaded. Ensure vendor/supabase.min.js is included on auth-callback.html.");
    }

    return window.supabase.createClient(cfg.url, cfg.anonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true
      }
    });
  }

  try {
    const sb = getClient();

    // If we returned from OAuth, exchange the code for a session
    const href = window.location.href;
    const hasCode = /[?&]code=/.test(href);

    if (hasCode) {
      const { error } = await sb.auth.exchangeCodeForSession(href);
      if (error) throw error;
    }

    // Confirm session exists now
    const { data, error } = await sb.auth.getSession();
    if (error) throw error;

    if (!data?.session) {
      throw new Error("No session found after OAuth.");
    }

    setTimeout(() => window.close(), 250);
  } catch (e) {
    document.body.textContent = "Sign in failed. You can close this tab.";
  }
})();
