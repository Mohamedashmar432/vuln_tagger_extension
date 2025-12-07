// ====== CONFIG: backend base URL ======
const API_BASE_URL = "http://127.0.0.1:8000"; // change if you host remotely

let currentPageKey = null;
let enabledKey = null;
let currentVulns = [];
let highlightsEnabled = true;

let currentProject = {
  id: null,
  key: null,
  name: null,
};

// ---------- Helpers ----------
function getActiveTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      resolve(tabs[0]);
    });
  });
}

function apiFetch(path, options = {}) {
  const url = API_BASE_URL + path;
  return fetch(url, {
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    ...options,
  }).then(async (res) => {
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`API error ${res.status}: ${text}`);
    }
    if (res.status === 204) return null;
    return res.json();
  });
}

function formatDateTime(isoString) {
  if (!isoString) return "";
  try {
    const d = new Date(isoString);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    const hours = String(d.getHours()).padStart(2, "0");
    const mins = String(d.getMinutes()).padStart(2, "0");
    return `${year}-${month}-${day} ${hours}:${mins}`;
  } catch (e) {
    return isoString;
  }
}

// Mask project key in UI (but keep real key in memory/storage)
function maskKey(key) {
  if (!key) return "";
  // show only last 4 chars, mask rest
  const visible = key.slice(-4);
  const masked = "•".repeat(Math.max(key.length - 4, 4));
  return masked + visible;
}

// ---------- Project UI ----------
function updateProjectUI() {
  const nameSpan = document.getElementById("project-name-display");
  const keyBox = document.getElementById("project-key-display");

  if (currentProject.id && currentProject.key) {
    nameSpan.textContent = currentProject.name || currentProject.id;
    keyBox.textContent = maskKey(currentProject.key);
    keyBox.style.display = "block";
  } else {
    nameSpan.textContent = "No project selected";
    keyBox.style.display = "none";
  }
}

function loadProjectFromStorage() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(
      ["vt_project_id", "vt_project_key", "vt_project_name"],
      (data) => {
        currentProject.id = data.vt_project_id || null;
        currentProject.key = data.vt_project_key || null;
        currentProject.name = data.vt_project_name || null;
        updateProjectUI();
        resolve();
      }
    );
  });
}

function saveProjectToStorage() {
  return new Promise((resolve) => {
    chrome.storage.sync.set(
      {
        vt_project_id: currentProject.id,
        vt_project_key: currentProject.key,
        vt_project_name: currentProject.name,
      },
      resolve
    );
  });
}

// Project buttons
document.getElementById("btn-show-create").addEventListener("click", () => {
  document.getElementById("create-project-form").style.display = "block";
  document.getElementById("existing-project-form").style.display = "none";
});

document.getElementById("btn-show-existing").addEventListener("click", () => {
  document.getElementById("create-project-form").style.display = "none";
  document.getElementById("existing-project-form").style.display = "block";
});

document.getElementById("btn-copy-key").addEventListener("click", () => {
  if (!currentProject.key) {
    alert("No project key to copy. Create or join a project first.");
    return;
  }
  // Copy silently; only show alert if it fails
  navigator.clipboard.writeText(currentProject.key).catch(() => {
    alert("Failed to copy project key");
  });
});

// Create project
document.getElementById("btn-create-project").addEventListener("click", async () => {
  const nameInput = document.getElementById("create-project-name");
  const projectName = nameInput.value.trim();
  if (!projectName) {
    alert("Please enter a project name.");
    return;
  }

  const tab = await getActiveTab();
  const baseUrl = tab && tab.url ? new URL(tab.url).origin : "";

  try {
    const result = await apiFetch("/projects/create", {
      method: "POST",
      body: JSON.stringify({
        project_name: projectName,
        base_url: baseUrl,
      }),
    });

    currentProject.id = result.project_id;
    currentProject.key = result.project_key;
    currentProject.name = result.project_name || projectName;

    await saveProjectToStorage();
    updateProjectUI();
    // No success popup (keep it clean)
  } catch (err) {
    console.error(err);
    alert("Failed to create project: " + err.message);
  }
});

// Join existing project
document.getElementById("btn-join-project").addEventListener("click", async () => {
  const keyInput = document.getElementById("existing-project-key");
  const projectKey = keyInput.value.trim();
  if (!projectKey) {
    alert("Please paste a project key.");
    return;
  }

  try {
    const result = await apiFetch("/projects/resolve", {
      method: "POST",
      body: JSON.stringify({
        project_key: projectKey,
      }),
    });

    currentProject.id = result.project_id;
    currentProject.key = projectKey;
    currentProject.name = result.project_name || result.project_id;

    await saveProjectToStorage();
    updateProjectUI();
    // No success popup
  } catch (err) {
    console.error(err);
    alert("Failed to join project: " + err.message);
  }
});

// ---------- Bug reporting & highlights ----------

// Report bug button (start selection in content script)
document.getElementById("select-element").addEventListener("click", async () => {
  const tab = await getActiveTab();
  if (!tab) return;
  chrome.tabs.sendMessage(tab.id, { type: "START_SELECTION" });
});

// Toggle highlights ON/OFF
document.getElementById("toggle-highlights").addEventListener("change", async (e) => {
  const checked = e.target.checked;
  highlightsEnabled = checked;
  if (!currentPageKey) return;
  chrome.storage.sync.set({ [enabledKey]: highlightsEnabled });

  const tab = await getActiveTab();
  if (!tab) return;
  chrome.tabs.sendMessage(tab.id, { type: "SET_ENABLED", enabled: highlightsEnabled });
});

// Load vulns & highlight state for current page (still local storage for now)
async function loadVulns() {
  const tab = await getActiveTab();
  if (!tab || !tab.url) return;

  const url = new URL(tab.url);
  currentPageKey = url.origin + url.pathname;
  enabledKey = currentPageKey + ":enabled";

  chrome.storage.sync.get([currentPageKey, enabledKey], (data) => {
    currentVulns = data[currentPageKey] || [];
    highlightsEnabled = data[enabledKey];
    if (highlightsEnabled === undefined) highlightsEnabled = true;

    const toggle = document.getElementById("toggle-highlights");
    toggle.checked = highlightsEnabled;

    renderVulnList();

    getActiveTab().then((tab2) => {
      if (!tab2) return;
      chrome.tabs.sendMessage(tab2.id, {
        type: "SET_ENABLED",
        enabled: highlightsEnabled,
      });
    });
  });
}

function renderVulnList() {
  const list = document.getElementById("vuln-list");
  list.innerHTML = "";

  if (!currentVulns.length) {
    const div = document.createElement("div");
    div.className = "empty-state";
    div.textContent = "No vulnerabilities tagged on this page yet.";
    list.appendChild(div);
    return;
  }

  currentVulns.forEach((vuln) => {
    const card = document.createElement("div");
    card.classList.add("vuln-card");
    const sev = (vuln.severity || "Low").toLowerCase();

    if (sev === "high") card.classList.add("severity-high");
    else if (sev === "medium") card.classList.add("severity-medium");
    else card.classList.add("severity-low");

    card.dataset.id = vuln.id;

    // ----- Header: Bug name + severity + status only -----
    const header = document.createElement("div");
    header.className = "vuln-header";

    const left = document.createElement("div");
    left.className = "vuln-title";
    left.textContent = vuln.type || "Bug";

    const badges = document.createElement("div");

    const sevBadge = document.createElement("span");
    sevBadge.className =
      "badge badge-severity-" +
      (sev === "high" ? "high" : sev === "medium" ? "medium" : "low");
    sevBadge.textContent = vuln.severity || "Low";

    const statusBadge = document.createElement("span");
    statusBadge.className = "badge badge-status";
    statusBadge.textContent = vuln.status || "Open";

    const chevron = document.createElement("span");
    chevron.className = "chevron";
    chevron.textContent = "▼";

    badges.appendChild(sevBadge);
    badges.appendChild(statusBadge);

    header.appendChild(left);
    header.appendChild(badges);
    header.appendChild(chevron);

    // ----- Body -----
    const body = document.createElement("div");
    body.className = "vuln-body";

    const reportedAt = formatDateTime(vuln.createdAt);

    body.innerHTML = `
      <div class="field-label">Reported</div>
      <div style="font-size:11px; color:#4b5563; margin-bottom:4px;">
        ${reportedAt || "Unknown"}
      </div>

      <div class="field-label">Target Field (selector)</div>
      <input class="vt-input" data-field="selector" disabled />

      <div class="field-label">Bug Type</div>
      <input class="vt-input" data-field="type" placeholder="e.g. Reflected XSS on search" />

      <div class="field-label">Severity</div>
      <select class="vt-select" data-field="severity">
        <option value="High">High</option>
        <option value="Medium">Medium</option>
        <option value="Low">Low</option>
      </select>

      <div class="field-label">Status</div>
      <select class="vt-select" data-field="status">
        <option value="Open">Open</option>
        <option value="In Progress">In Progress</option>
        <option value="Fixed">Fixed</option>
      </select>

      <div class="field-label">Description</div>
      <textarea class="vt-textarea" data-field="description"></textarea>

      <div class="field-label">Steps to Reproduce</div>
      <textarea class="vt-textarea" data-field="steps"></textarea>

      <div class="field-label">Payload</div>
      <textarea class="vt-textarea" data-field="payload"></textarea>
    `;

    // Fill existing values
    body.querySelector('[data-field="selector"]').value = vuln.selector || "";
    body.querySelector('[data-field="type"]').value = vuln.type || "";
    body.querySelector('[data-field="severity"]').value = vuln.severity || "High";
    body.querySelector('[data-field="status"]').value = vuln.status || "Open";
    body.querySelector('[data-field="description"]').value = vuln.description || "";
    body.querySelector('[data-field="steps"]').value = vuln.steps || "";
    body.querySelector('[data-field="payload"]').value = vuln.payload || "";

    const actions = document.createElement("div");
    actions.className = "vuln-actions";

    const saveBtn = document.createElement("button");
    saveBtn.className = "btn-small btn-save";
    saveBtn.textContent = "Save";
    saveBtn.dataset.id = vuln.id;

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "btn-small";
    deleteBtn.style.background = "#ef4444";
    deleteBtn.style.color = "white";
    deleteBtn.textContent = "Delete";
    deleteBtn.dataset.id = vuln.id;

    actions.appendChild(deleteBtn);
    actions.appendChild(saveBtn);
    body.appendChild(actions);

    // Header click: expand & scroll to element
    header.addEventListener("click", async () => {
      const isOpen = body.classList.contains("open");
      body.classList.toggle("open", !isOpen);
      chevron.textContent = isOpen ? "▼" : "▲";

      const tab = await getActiveTab();
      if (!tab) return;
      chrome.tabs.sendMessage(tab.id, {
        type: "GO_TO_VULN",
        selector: vuln.selector,
      });
    });

    card.appendChild(header);
    card.appendChild(body);
    list.appendChild(card);
  });

  // Save
  list.querySelectorAll(".btn-save").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      saveVulnEdits(id);
    });
  });

  // Delete
  list.querySelectorAll(".btn-small").forEach((btn) => {
    if (btn.textContent !== "Delete") return;
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      deleteVuln(id);
    });
  });
}

function saveVulnEdits(id) {
  const card = document.querySelector(`.vuln-card[data-id="${id}"]`);
  if (!card) return;

  const body = card.querySelector(".vuln-body");
  const get = (field) => body.querySelector(`[data-field="${field}"]`).value;

  const index = currentVulns.findIndex((v) => v.id === id);
  if (index === -1) return;

  const updated = {
    ...currentVulns[index], // keep createdAt
    type: get("type"),
    severity: get("severity"),
    status: get("status"),
    description: get("description"),
    steps: get("steps"),
    payload: get("payload"),
  };

  currentVulns[index] = updated;

  chrome.storage.sync.set({ [currentPageKey]: currentVulns }, async () => {
    const tab = await getActiveTab();
    if (!tab) return;
    chrome.tabs.sendMessage(tab.id, { type: "REFRESH_VULNS" });
    renderVulnList();
  });
}

function deleteVuln(id) {
  const index = currentVulns.findIndex((v) => v.id === id);
  if (index === -1) return;

  currentVulns.splice(index, 1);

  chrome.storage.sync.set({ [currentPageKey]: currentVulns }, async () => {
    const tab = await getActiveTab();
    if (!tab) return;
    chrome.tabs.sendMessage(tab.id, { type: "REFRESH_VULNS" });
    renderVulnList();
  });
}

document.addEventListener("DOMContentLoaded", async () => {
  await loadProjectFromStorage();
  await loadVulns();
});
