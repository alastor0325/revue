// fx-dev-hub integration (optional). When revue is framed by the Hub, the Hub
// injects `window.createFxHub`; this script repurposes revue's own "Generate
// Review Prompt" button so it also runs the generated prompt through Claude and
// shows the answer in revue's existing result dialog — no extra UI.
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

      // revue generates the prompt (its existing flow) and announces it; we run
      // that prompt through Claude and stream the answer into the result
      // dialog's textarea, which revue already opened and styled.
      document.addEventListener("revue:prompt-generated", function (e) {
        var prompt = e.detail && e.detail.prompt;
        if (!prompt) return;
        var out = document.querySelector("#result-prompt");
        if (out) out.value = "Running the review in Claude…";

        var job = hub.runAgent(prompt);
        var gotResult = false;
        job.addEventListener("result", function (ev) {
          gotResult = true;
          if (out) out.value = ev.detail; // needs the agent-results grant
        });
        job.addEventListener("error", function (ev) {
          if (out) {
            out.value =
              "Claude run failed: " + (ev.error ? ev.error.message : "unknown");
          }
        });
        job.addEventListener("status", function () {
          if (job.status === "done" && !gotResult && out) {
            out.value =
              "Claude finished. Grant “Receive Claude's results” to show the answer here.";
          }
        });
      });
    })
    .catch(function () {
      /* handshake failed — behave as standalone */
    });
})();
