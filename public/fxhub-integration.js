// fx-dev-hub integration (optional). When revue is framed by the Hub, the Hub
// injects `window.createFxHub`; this script repurposes revue's own "Generate
// Review Prompt" button to also run the generated prompt through Claude. The
// answer + progress appear in the Hub's own results panel; here we only show a
// light status line so the prompt dialog is left intact.
//
// Standalone (revue opened directly in a browser), `window.createFxHub` is
// absent and this file does nothing — the normal Copy-prompt flow is unchanged.
(function () {
  if (!window.createFxHub) return; // not inside the Hub → keep standalone behavior

  window.createFxHub()
    .then(function (hub) {
      var btn = document.querySelector("#btn-submit");
      if (!btn) return;

      // Repurpose revue's own button (same element + styling, new label).
      // submitReview restores the label from data-idle-label after generating,
      // so the Claude label persists across generations.
      var LABEL = "Generate & Run in Claude";
      btn.dataset.idleLabel = LABEL;
      // Don't clobber the in-progress label if the handshake resolves mid-run
      // ("Generating…" is set by submitReview in app.js).
      if (btn.textContent !== "Generating…") btn.textContent = LABEL;

      // A light status line inside the result dialog — the answer + activity
      // live in the Hub's results panel, so we don't touch #result-prompt.
      function say(msg) {
        var modal = document.querySelector("#result-modal");
        if (!modal) return;
        var el = modal.querySelector("#fxhub-status");
        if (!el) {
          el = document.createElement("div");
          el.id = "fxhub-status";
          var h3 = modal.querySelector("h3");
          if (h3) h3.insertAdjacentElement("afterend", el);
          else modal.appendChild(el);
        }
        el.textContent = msg;
      }

      // revue generates the prompt (its existing flow) and announces it; we run
      // it through Claude and reflect status. `done`/`error` arrive without the
      // agent-results grant, so this works regardless of it.
      document.addEventListener("revue:prompt-generated", function (e) {
        var prompt = e.detail && e.detail.prompt;
        if (!prompt) return;
        say("Running in Claude… see the results panel below.");

        var job = hub.runAgent(prompt);
        job.addEventListener("status", function () {
          if (job.status === "done") {
            say("Claude finished — see the results panel below.");
          }
        });
        job.addEventListener("error", function (ev) {
          say("Claude run failed: " + (ev.error ? ev.error.message : "unknown"));
        });
      });
    })
    .catch(function () {
      /* handshake failed — behave as standalone */
    });
})();
