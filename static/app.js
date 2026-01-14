const state = {
  config: null,
  currentPath: "",
};

const viewEl = document.getElementById("view");
const statusEl = document.getElementById("status");

function setStatus(message) {
  statusEl.textContent = message;
}

function escapeHtml(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  let idx = 0;
  let value = bytes;
  while (value >= 1024 && idx < sizes.length - 1) {
    value /= 1024;
    idx += 1;
  }
  return `${value.toFixed(1)} ${sizes[idx]}`;
}

function previewUrl(path) {
  return `/api/file/preview?path=${encodeURIComponent(path)}`;
}

function downloadUrl(path) {
  return `/api/file/download?path=${encodeURIComponent(path)}`;
}

async function apiGet(url) {
  const res = await fetch(url);
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Request failed: ${res.status}`);
  }
  return res.json();
}

async function apiPost(url, payload) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Request failed: ${res.status}`);
  }
  return res.json();
}

function navigate(url) {
  window.history.pushState({}, "", url);
  route();
}

async function init() {
  try {
    state.config = await apiGet("/api/config");
    if (state.config.configured) {
      setStatus(`Library: ${state.config.library_root}`);
    } else {
      setStatus("Setup required");
    }
  } catch (err) {
    setStatus("Backend unavailable");
    viewEl.innerHTML = `<div class="card"><div class="notice">${escapeHtml(
      err.message
    )}</div></div>`;
    return;
  }

  await route();
}

async function route() {
  const path = window.location.pathname;
  if (!state.config?.configured && path !== "/setup") {
    navigate("/setup");
    return;
  }

  if (path === "/setup") {
    renderSetup();
    return;
  }

  if (path === "/file") {
    const query = new URLSearchParams(window.location.search);
    const filePath = query.get("path");
    if (!filePath) {
      navigate("/");
      return;
    }
    await renderFileDetail(filePath);
    return;
  }

  const query = new URLSearchParams(window.location.search);
  const browsePath = query.get("path") || "";
  await renderExplorer(browsePath);
}

function renderSetup() {
  viewEl.innerHTML = `
    <section class="card setup-grid">
      <h2>Initial setup</h2>
      <div class="notice">Pick the folder where your raw files live. The app will only read inside this path.</div>
      <form id="setup-form" class="setup-row">
        <label>
          Library root
          <input class="input" id="library-root" placeholder="/mnt/hdd/photos" required />
        </label>
        <button class="primary-btn" type="submit">Save library</button>
      </form>
    </section>
  `;

  const form = document.getElementById("setup-form");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const input = document.getElementById("library-root");
    const value = input.value.trim();
    if (!value) return;
    try {
      const config = await apiPost("/api/config", { library_root: value });
      state.config = config;
      setStatus(`Library: ${config.library_root}`);
      navigate("/");
    } catch (err) {
      alert(err.message);
    }
  });
}

async function renderExplorer(path) {
  viewEl.innerHTML = `<div class="card"><div class="loading">Loading library...</div></div>`;
  try {
    const data = await apiGet(`/api/browse?path=${encodeURIComponent(path)}`);
    state.currentPath = data.path;
    if (state.config?.library_root) {
      setStatus(`Library: ${state.config.library_root} - /${data.path || ""}`);
    }

    const dirs = data.entries.filter((entry) => entry.kind === "dir");
    const files = data.entries.filter((entry) => entry.kind === "file");

    const breadcrumb = renderBreadcrumbs(data.path);

    viewEl.innerHTML = `
      <section class="layout">
        <div class="sidebar">
          <div class="card">
            <div class="breadcrumbs">${breadcrumb}</div>
          </div>
          <div class="card">
            <div class="meta-label">Folders</div>
            <div class="folder-list">
              ${dirs
                .map(
                  (dir) => `
                <div class="folder-item" data-action="open-folder" data-path="${encodeURIComponent(
                  dir.path
                )}">
                  <span>${escapeHtml(dir.name)}</span>
                  <span class="badge">Open</span>
                </div>
              `
                )
                .join("")}
              ${dirs.length === 0 ? "<div class=\"loading\">No subfolders.</div>" : ""}
            </div>
          </div>
        </div>
        <div class="card">
          <div class="meta-label">Files</div>
          <div class="file-grid">
            ${files
              .map((file) => renderFileCard(file))
              .join("")}
            ${files.length === 0 ? "<div class=\"loading\">No raw files in this folder.</div>" : ""}
          </div>
        </div>
      </section>
    `;

    bindExplorerHandlers();
  } catch (err) {
    viewEl.innerHTML = `<div class="card"><div class="notice">${escapeHtml(
      err.message
    )}</div></div>`;
  }
}

function renderBreadcrumbs(path) {
  const parts = path ? path.split("/") : [];
  const crumbs = [
    `<button data-action="open-root">Library</button>`,
  ];
  let built = "";
  parts.forEach((part) => {
    built = built ? `${built}/${part}` : part;
    crumbs.push(
      `<button data-action="open-folder" data-path="${encodeURIComponent(
        built
      )}">${escapeHtml(part)}</button>`
    );
  });
  return crumbs.join(" / ");
}

function renderFileCard(file) {
  const rating = file.user_rating ?? file.camera_rating;
  const ratingLabel = file.user_rating != null ? "User" : "Cam";
  const tags = file.tags
    .map((tag) => `<span class="badge tag">${escapeHtml(tag)}</span>`)
    .join("");
  const scanBadge = file.needs_scan
    ? `<span class="badge">scan</span>`
    : "";

  return `
    <div class="file-card" data-action="open-file" data-path="${encodeURIComponent(
      file.path
    )}">
      <img class="file-thumb" data-preview="${encodeURIComponent(
        file.path
      )}" alt="Preview" />
      <div class="file-meta">
        <div class="file-name">${escapeHtml(file.name)}</div>
        <div class="badge-row">
          ${rating != null ? `<span class="badge">${ratingLabel}: ${rating}*</span>` : ""}
          ${scanBadge}
          ${tags}
        </div>
      </div>
    </div>
  `;
}

function bindExplorerHandlers() {
  document.querySelectorAll("[data-action='open-folder']").forEach((item) => {
    item.addEventListener("click", () => {
      const path = decodeURIComponent(item.dataset.path || "");
      navigate(path ? `/?path=${encodeURIComponent(path)}` : "/");
    });
  });

  const rootBtn = document.querySelector("[data-action='open-root']");
  if (rootBtn) {
    rootBtn.addEventListener("click", () => navigate("/"));
  }

  document.querySelectorAll("[data-action='open-file']").forEach((item) => {
    item.addEventListener("click", () => {
      const path = decodeURIComponent(item.dataset.path || "");
      navigate(`/file?path=${encodeURIComponent(path)}`);
    });
  });

  document.querySelectorAll("img[data-preview]").forEach((img) => {
    const path = decodeURIComponent(img.dataset.preview || "");
    img.src = previewUrl(path);
    img.addEventListener("error", () => {
      img.removeAttribute("data-preview");
      img.src = "";
      img.alt = "No preview";
    });
  });
}

async function renderFileDetail(path) {
  viewEl.innerHTML = `<div class="card"><div class="loading">Loading file...</div></div>`;
  try {
    const meta = await apiGet(`/api/file/metadata?path=${encodeURIComponent(path)}`);
    const previewSrc = previewUrl(path);
    const mapEmbed = meta.gps_lat != null && meta.gps_lon != null;

    viewEl.innerHTML = `
      <section class="details-grid">
        <div class="card preview-card">
          <button class="secondary-btn" id="back-btn">Back to folder</button>
          <img class="preview-img" src="${previewSrc}" alt="Preview" />
          <div class="tag-list" id="tag-list"></div>
        </div>
        <div class="card">
          <div class="meta-list">
            <div class="meta-item">
              <div class="meta-label">File</div>
              <div class="meta-value">${escapeHtml(meta.name)}</div>
            </div>
            <div class="meta-item">
              <div class="meta-label">Size</div>
              <div class="meta-value">${formatBytes(meta.file_size)}</div>
            </div>
            <div class="meta-item">
              <div class="meta-label">Captured</div>
              <div class="meta-value">${escapeHtml(meta.taken_at || "Unknown")}</div>
            </div>
            <div class="meta-item">
              <div class="meta-label">Camera rating</div>
              <div class="meta-value">${meta.camera_rating ?? "None"}</div>
            </div>
            <div class="meta-item">
              <div class="meta-label">Your rating</div>
              <div class="stars" id="user-rating"></div>
            </div>
            <div class="meta-item">
              <div class="meta-label">Tags</div>
              <div class="tag-input">
                <input class="input" id="tag-input" placeholder="portrait, bts, favorites" />
                <button class="secondary-btn" id="tag-add">Add</button>
              </div>
            </div>
            <div class="meta-item">
              <div class="meta-label">Download</div>
              <a class="primary-btn" href="${downloadUrl(path)}">Download raw</a>
            </div>
            ${mapEmbed ? renderMap(meta.gps_lat, meta.gps_lon) : ""}
          </div>
        </div>
      </section>
    `;

    bindDetailHandlers(path, meta);
  } catch (err) {
    viewEl.innerHTML = `<div class="card"><div class="notice">${escapeHtml(
      err.message
    )}</div></div>`;
  }
}

function renderMap(lat, lon) {
  const delta = 0.01;
  const bbox = [lon - delta, lat - delta, lon + delta, lat + delta].join(",");
  const mapUrl = `https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&marker=${lat},${lon}&layer=mapnik`;
  const linkUrl = `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=16/${lat}/${lon}`;
  return `
    <div class="meta-item">
      <div class="meta-label">Location</div>
      <div class="meta-value">${lat.toFixed(5)}, ${lon.toFixed(5)}</div>
      <iframe class="map-frame" src="${mapUrl}"></iframe>
      <a class="secondary-btn" href="${linkUrl}" target="_blank" rel="noreferrer">Open map</a>
    </div>
  `;
}

function bindDetailHandlers(path, meta) {
  const backBtn = document.getElementById("back-btn");
  backBtn.addEventListener("click", () => {
    const backPath = state.currentPath;
    navigate(backPath ? `/?path=${encodeURIComponent(backPath)}` : "/");
  });

  const previewImg = document.querySelector(".preview-img");
  if (previewImg) {
    previewImg.addEventListener("error", () => {
      previewImg.removeAttribute("src");
      previewImg.alt = "No preview available";
    });
  }

  const ratingEl = document.getElementById("user-rating");
  renderStarControls(ratingEl, meta.user_rating, async (value) => {
    try {
      await apiPost("/api/file/rating", { path, rating: value });
    } catch (err) {
      alert(err.message);
    }
  });

  const tagList = document.getElementById("tag-list");
  const tagInput = document.getElementById("tag-input");
  const tagAdd = document.getElementById("tag-add");

  let tags = Array.isArray(meta.tags) ? [...meta.tags] : [];

  const renderTags = () => {
    tagList.innerHTML = tags
      .map(
        (tag) => `
        <span class="tag-pill">
          ${escapeHtml(tag)}
          <button data-tag="${encodeURIComponent(tag)}">x</button>
        </span>
      `
      )
      .join("");

    tagList.querySelectorAll("button[data-tag]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const remove = decodeURIComponent(btn.dataset.tag);
        tags = tags.filter((tag) => tag !== remove);
        await persistTags(tags);
      });
    });
  };

  tagAdd.addEventListener("click", async () => {
    const raw = tagInput.value.trim();
    if (!raw) return;
    const newTags = raw
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean);
    tags = Array.from(new Set([...tags, ...newTags]));
    tagInput.value = "";
    await persistTags(tags);
  });

  const persistTags = async (nextTags) => {
    try {
      const response = await apiPost("/api/file/tags", { path, tags: nextTags });
      tags = response.tags;
      renderTags();
    } catch (err) {
      alert(err.message);
    }
  };

  renderTags();
}

function renderStarControls(container, current, onChange) {
  container.innerHTML = "";
  for (let i = 1; i <= 5; i += 1) {
    const btn = document.createElement("button");
    btn.className = "star-btn" + (current != null && i <= current ? " active" : "");
    btn.textContent = "*";
    btn.addEventListener("click", async () => {
      const value = i === current ? 0 : i;
      await onChange(value === 0 ? null : value);
      renderStarControls(container, value === 0 ? null : value, onChange);
    });
    container.appendChild(btn);
  }
}

window.addEventListener("popstate", route);
window.addEventListener("DOMContentLoaded", init);
