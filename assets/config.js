// Site configuration.
//
// Plain script, not an ES module: the pages are often opened straight from disk
// (file:///…), and module scripts are blocked by CORS on that protocol — which
// silently killed every button on the page.

(function () {
  // Where the site talks to the Geonix Wrench backend.
  //
  // Served from localhost (or opened as a file) we assume the dev backend on
  // :8000. Anywhere else needs the real deployed API — set PRODUCTION_API
  // before deploying or web checkout will fail with a network error.
  var LOCAL_API = 'http://127.0.0.1:8000';
  var PRODUCTION_API = null; // e.g. 'https://api.yourdomain.com'

  var isLocal =
    ['localhost', '127.0.0.1', ''].indexOf(window.location.hostname) !== -1 ||
    window.location.protocol === 'file:';

  window.GEONIX_CONFIG = {
    API_BASE_URL: isLocal ? LOCAL_API : PRODUCTION_API || LOCAL_API,
    IS_API_CONFIGURED: isLocal || Boolean(PRODUCTION_API),

    // Keep in step with the backend config (TEAM_MIN_SEATS / TEAM_PRICE_PER_SEAT).
    // These are display values; Stripe charges whatever the price objects are
    // set to in the dashboard. `python -m price_check` verifies they agree.
    TEAM_MIN_SEATS: 2,
    PRICE_PER_SEAT: 25,
    INDIVIDUAL_PRICE: 29,
  };
})();
