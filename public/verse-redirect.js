// Loaded only by the server-rendered `/v/<id>` permalink page (see
// src/worker.js). Crawlers that don't execute JS still see the real verse
// text and OG/Twitter tags server-rendered into that page. Real browsers run
// this and hand off into the full app via its existing hash deep-link route,
// replacing history so the permalink page doesn't sit in the back-button chain.
(function () {
  "use strict";
  var m = location.pathname.match(/\/v\/([A-Za-z]+\.\d+\.\d+)\/?$/);
  if (!m) return;
  location.replace("/#" + m[1]);
})();
