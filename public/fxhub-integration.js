// fx-dev-hub integration (optional). When revue is framed by the Hub, the Hub
// injects `window.createFxHub`; this script then adds a "Run in Claude" button
// that runs the generated review prompt through Claude and shows the result.
//
// Standalone (revue opened directly in a browser), `window.createFxHub` is
// absent and this file does nothing — the normal "Copy prompt" flow is unchanged.
(function () {
  if (!window.createFxHub) return; // not inside the Hub → keep standalone behavior

  window.createFxHub()
    .then(function (hub) {
      function currentPrompt() {
        var bar = document.querySelector("#current-prompt-bar");
        var fromBar = bar && bar.dataset.prompt;
        var modal = document.querySelector("#result-prompt");
        return fromBar || (modal && modal.value) || "";
      }

      function panel() {
        var p = document.querySelector("#fxhub-panel");
        if (!p) {
          p = document.createElement("div");
          p.id = "fxhub-panel";
          p.style.cssText =
            "position:fixed;right:16px;bottom:16px;width:440px;max-height:60vh;" +
            "overflow:auto;background:#fff;color:#15141a;border:1px solid #d7d7db;" +
            "border-radius:8px;box-shadow:0 6px 24px rgba(0,0,0,.18);padding:12px 14px;" +
            "font:13px/1.5 system-ui;white-space:pre-wrap;z-index:9999;";
          document.body.appendChild(p);
        }
        return p;
      }

      function run() {
        var prompt = currentPrompt();
        if (!prompt) return;
        var p = panel();
        p.textContent = "Running the review prompt in Claude…";
        var job = hub.runAgent(prompt);
        var gotResult = false;
        job.addEventListener("result", function (e) {
          gotResult = true;
          p.textContent = e.detail; // needs the agent-results grant
        });
        job.addEventListener("error", function (e) {
          p.textContent = "Claude run failed: " + (e.error ? e.error.message : "unknown");
        });
        job.addEventListener("status", function () {
          if (job.status === "done" && !gotResult) {
            p.textContent = "Done. (Grant “Receive Claude's results” to see the answer here.)";
          }
        });
      }

      function addButton(container, label) {
        if (!container || container.querySelector(".fxhub-run")) return;
        var b = document.createElement("button");
        b.className = "fxhub-run";
        b.textContent = label;
        b.addEventListener("click", run);
        container.appendChild(b);
      }

      // The "Review prompt ready" bar, and the result modal's button row.
      addButton(document.querySelector("#current-prompt-bar"), "Run in Claude");
      var modalRow = document.querySelector("#result-modal div");
      addButton(modalRow, "Run in Claude");
    })
    .catch(function () {
      /* handshake failed — behave as standalone */
    });
})();
