let selectionMode = false;
let currentHoverElement = null;
let currentTooltip = null;

const PAGE_KEY = window.location.origin + window.location.pathname;
const ENABLE_KEY = PAGE_KEY + ":enabled";
let highlightsEnabled = true;

// Read enabled state then highlight existing vulns
chrome.storage.sync.get({ [ENABLE_KEY]: true }, (data) => {
  highlightsEnabled = data[ENABLE_KEY];
  if (highlightsEnabled) {
    loadAndHighlightVulns();
  }
});

// Listen for messages from popup
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "START_SELECTION") {
    startSelectionMode();
  } else if (msg.type === "REFRESH_VULNS") {
    refreshVulnHighlights();
  } else if (msg.type === "SET_ENABLED") {
    highlightsEnabled = msg.enabled;
    if (highlightsEnabled) {
      refreshVulnHighlights();
    } else {
      clearAllHighlights();
    }
  } else if (msg.type === "GO_TO_VULN") {
    goToVuln(msg.selector);
  }
});

// ---- Selection Mode ----
function startSelectionMode() {
  selectionMode = true;
  document.addEventListener("mousemove", onMouseMoveHighlight);
  document.addEventListener("click", onClickSelectElement, true);
}

function stopSelectionMode() {
  selectionMode = false;
  if (currentHoverElement) {
    currentHoverElement.classList.remove("vt-hover-highlight");
    currentHoverElement = null;
  }
  document.removeEventListener("mousemove", onMouseMoveHighlight);
  document.removeEventListener("click", onClickSelectElement, true);
}

function onMouseMoveHighlight(e) {
  if (!selectionMode) return;

  if (currentHoverElement && currentHoverElement !== e.target) {
    currentHoverElement.classList.remove("vt-hover-highlight");
  }

  currentHoverElement = e.target;
  currentHoverElement.classList.add("vt-hover-highlight");
}

function onClickSelectElement(e) {
  if (!selectionMode) return;

  e.preventDefault();
  e.stopPropagation();

  const element = e.target;
  stopSelectionMode();

  const selector = getUniqueSelector(element);
  element.classList.remove("vt-hover-highlight");

  openVulnModal(element, selector);
}

// ---- Modal for adding vulnerability (single popup with all fields) ----
function openVulnModal(element, selector) {
  // Remove existing modal if any
  const existing = document.querySelector(".vt-modal-overlay");
  if (existing) existing.remove();

  const overlay = document.createElement("div");
  overlay.className = "vt-modal-overlay";

  const modal = document.createElement("div");
  modal.className = "vt-modal";

  modal.innerHTML = `
    <h3>Tag Vulnerability</h3>
    <div class="vt-modal-row">
      <span class="vt-modal-label">Target Field</span>
      <div style="font-size:11px; color:#6b7280; word-break:break-all;">${selector}</div>
    </div>

    <form id="vt-vuln-form">
      <div class="vt-modal-row">
        <label class="vt-modal-label">Bug Type</label>
        <input name="bugType" placeholder="e.g. Reflected XSS on search, CSRF on logout, Business logic bypass" />
      </div>

      <div class="vt-modal-row">
        <label class="vt-modal-label">Severity</label>
        <select name="severity">
          <option value="High">High</option>
          <option value="Medium">Medium</option>
          <option value="Low">Low</option>
        </select>
      </div>

      <div class="vt-modal-row">
        <label class="vt-modal-label">Status</label>
        <select name="status">
          <option value="Open">Open</option>
          <option value="In Progress">In Progress</option>
          <option value="Fixed">Fixed</option>
        </select>
      </div>

      <div class="vt-modal-row">
        <label class="vt-modal-label">Description</label>
        <textarea name="description" placeholder="Short description of the issue"></textarea>
      </div>

      <div class="vt-modal-row">
        <label class="vt-modal-label">Steps to Reproduce</label>
        <textarea name="steps" placeholder="1. Go to...\n2. Enter payload...\n3. Observe..."></textarea>
      </div>

      <div class="vt-modal-row">
        <label class="vt-modal-label">Payload</label>
        <textarea name="payload" placeholder="<script>alert(1)</script>"></textarea>
      </div>

      <div class="vt-modal-actions">
        <button type="button" class="vt-btn vt-btn-cancel">Cancel</button>
        <button type="submit" class="vt-btn vt-btn-save">Save</button>
      </div>
    </form>
  `;

  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  const form = modal.querySelector("#vt-vuln-form");
  const cancelBtn = modal.querySelector(".vt-btn-cancel");

  cancelBtn.addEventListener("click", () => {
    overlay.remove();
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();

    const formData = new FormData(form);
    const vuln = {
      id: Date.now().toString(),
      selector,
      type: formData.get("bugType") || "Bug",
      severity: formData.get("severity") || "High",
      status: formData.get("status") || "Open",
      description: formData.get("description") || "",
      steps: formData.get("steps") || "",
      payload: formData.get("payload") || "",
      url: PAGE_KEY,
      createdAt: new Date().toISOString()
    };

    saveVulnerability(vuln).then(() => {
      if (highlightsEnabled) {
        // reload everything from storage – fixes the “4th bug not showing” issue
        refreshVulnHighlights();
      }
      overlay.remove();
      alert("Vulnerability tagged and saved.");
    });
  });
}

// ---- Helper: generate a simple selector ----
function getUniqueSelector(el) {
  if (el.id) return `#${el.id}`;
  if (el.name) return `${el.tagName.toLowerCase()}[name="${el.name}"]`;

  let path = [];
  let current = el;
  while (current && current.nodeType === 1 && path.length < 5) {
    let selector = current.tagName.toLowerCase();
    if (current.className) {
      const cls = current.className.split(" ").filter(Boolean)[0];
      if (cls) selector += `.${cls}`;
    }
    path.unshift(selector);
    current = current.parentElement;
  }
  return path.join(" > ");
}

// ---- Storage functions ----
function saveVulnerability(vuln) {
  return new Promise((resolve) => {
    chrome.storage.sync.get([PAGE_KEY], (data) => {
      const existing = data[PAGE_KEY] || [];
      existing.push(vuln);
      chrome.storage.sync.set({ [PAGE_KEY]: existing }, resolve);
    });
  });
}

// ---- On page load: highlight existing vulns ----
function loadAndHighlightVulns() {
  chrome.storage.sync.get([PAGE_KEY], (data) => {
    const vulns = data[PAGE_KEY] || [];
    vulns.forEach(vuln => {
      const el = document.querySelector(vuln.selector);
      if (el) {
        highlightElementWithVuln(el, vuln);
      }
    });
  });
}

function refreshVulnHighlights() {
  clearAllHighlights();
  if (!highlightsEnabled) return;
  loadAndHighlightVulns();
}

function clearAllHighlights() {
  document.querySelectorAll(".vt-vuln-icon").forEach(el => el.remove());
  document.querySelectorAll(".vt-vuln-highlight").forEach(el => {
    el.classList.remove("vt-vuln-highlight", "vt-sev-high", "vt-sev-medium", "vt-sev-low", "vt-jump-flash");
  });
  if (currentTooltip) {
    currentTooltip.remove();
    currentTooltip = null;
  }
}

function highlightElementWithVuln(el, vuln) {
  el.classList.add("vt-vuln-highlight");

  const sev = (vuln.severity || "Low").toLowerCase();
  if (sev === "high") el.classList.add("vt-sev-high");
  else if (sev === "medium") el.classList.add("vt-sev-medium");
  else el.classList.add("vt-sev-low");

  // Remove existing icon if any (avoid duplicates)
  const oldIcon = el.querySelector(".vt-vuln-icon");
  if (oldIcon) oldIcon.remove();

  const icon = document.createElement("div");
  icon.className = "vt-vuln-icon";

  if (sev === "high") icon.classList.add("vt-icon-high");
  else if (sev === "medium") icon.classList.add("vt-icon-medium");
  else icon.classList.add("vt-icon-low");

  icon.textContent = "!";

  icon.addEventListener("click", (e) => {
    e.stopPropagation();
    showVulnTooltip(e.clientX, e.clientY, vuln, el);
  });

  const style = getComputedStyle(el);
  if (!["relative", "absolute", "fixed"].includes(style.position)) {
    el.style.position = "relative";
  }
  el.appendChild(icon);
}

// ---- Tooltip with vuln details, nicer UI ----
function showVulnTooltip(x, y, vuln, element) {
  if (currentTooltip) currentTooltip.remove();

  const tooltip = document.createElement("div");
  tooltip.className = "vt-tooltip";
  tooltip.style.left = x + 10 + "px";
  tooltip.style.top = y + 10 + "px";

  const sev = (vuln.severity || "Low").toLowerCase();
  const sevClass =
    sev === "high"
      ? "vt-tooltip-badge-sev-high"
      : sev === "medium"
      ? "vt-tooltip-badge-sev-medium"
      : "vt-tooltip-badge-sev-low";

  tooltip.innerHTML = `
    <div class="vt-tooltip-header">
      <div class="vt-tooltip-title">${vuln.type || "Bug"}</div>
      <div class="vt-tooltip-badges">
        <span class="vt-tooltip-badge ${sevClass}">${vuln.severity || "Low"}</span>
        <span class="vt-tooltip-badge" style="background:#e5e7eb;">${vuln.status || "Open"}</span>
      </div>
    </div>
    <div class="vt-tooltip-section">
      <div class="vt-tooltip-label">Description</div>
      <div>${escapeHtml(vuln.description || "")}</div>
    </div>
    <div class="vt-tooltip-section">
      <div class="vt-tooltip-label">Steps to Reproduce</div>
      <div style="white-space:pre-wrap;">${escapeHtml(vuln.steps || "")}</div>
    </div>
    <div class="vt-tooltip-section">
      <div class="vt-tooltip-label">Payload</div>
      <code>${escapeHtml(vuln.payload || "")}</code>
    </div>
    <button id="vt-reproduce">Auto Reproduce</button>
  `;

  document.body.appendChild(tooltip);
  currentTooltip = tooltip;

  const onDocClick = (e) => {
    if (!tooltip.contains(e.target)) {
      tooltip.remove();
      currentTooltip = null;
      document.removeEventListener("click", onDocClick);
    }
  };
  setTimeout(() => document.addEventListener("click", onDocClick), 0);

  tooltip.querySelector("#vt-reproduce").addEventListener("click", () => {
    try {
      const tag = element.tagName.toLowerCase();
      if (tag === "input" || tag === "textarea") {
        element.value = vuln.payload || "";
      }
      alert("Payload injected into the field (check behavior).");
    } catch (e) {
      console.error(e);
    }
  });
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ---- Scroll / jump to element when user clicks card in portal ----
function goToVuln(selector) {
  if (!selector) return;
  const el = document.querySelector(selector);
  if (!el) return;

  el.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
  el.classList.add("vt-jump-flash");
  setTimeout(() => el.classList.remove("vt-jump-flash"), 1500);
}
