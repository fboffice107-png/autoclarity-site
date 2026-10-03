/* One optional question reused on intake and the existing approval page. */
(function () {
  "use strict";
  function esc(value) {
    return String(value || "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  window.AutoClarityDiscovery = {
    render: function (options) {
      if (!options || !options.length) return "";
      return '<div class="field"><label for="discoverySource">Just curious, how did you hear about AutoClarity? (Optional)</label>' +
        '<select id="discoverySource" name="discoverySource"><option value="">Select an option (optional)</option>' +
        options.map(function (o) { return '<option value="' + esc(o.value) + '" data-detail="' + esc(o.detail) + '">' + esc(o.label) + '</option>'; }).join("") +
        '</select></div><div class="field" id="discoveryDetailField" hidden>' +
        '<label for="discoveryDetail" id="discoveryDetailLabel"></label>' +
        '<input id="discoveryDetail" name="discoveryDetail" type="text" maxlength="500" disabled /></div>';
    },
    bind: function (root) {
      var source = root.querySelector("#discoverySource");
      if (!source) return;
      var field = root.querySelector("#discoveryDetailField");
      var detail = root.querySelector("#discoveryDetail");
      var label = root.querySelector("#discoveryDetailLabel");
      function update(clear) {
        var option = source.options[source.selectedIndex];
        var kind = option && option.getAttribute("data-detail");
        field.hidden = !kind;
        detail.disabled = !kind;
        if (clear || !kind) detail.value = "";
        label.textContent = kind === "other" ? "Where did you hear about us? (Optional)"
          : "Do you remember which video or account? (Optional)";
      }
      source.addEventListener("change", function () { update(true); });
      update(false);
    },
    read: function (root) {
      var source = root.querySelector("#discoverySource");
      var detail = root.querySelector("#discoveryDetail");
      return { discoverySource: source ? source.value : "", discoveryDetail: detail && !detail.disabled ? detail.value : "" };
    }
  };
})();
