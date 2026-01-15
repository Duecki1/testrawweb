const state = {
  config: null,
  currentPath: "",
  currentEntries: [],
  selection: new Map(),
  fileNav: null,
  navHandler: null,
  resizeHandler: null,
  tagOptions: [],
  dragDepth: 0,
};

const viewEl = document.getElementById("view");
const statusEl = document.getElementById("status");
const ROW_HEIGHT = 220;

function setStatus(message) {
  statusEl.textContent = message;
}

function escapeHtml(value) {
  if (!value) return "";
  return String(value)
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

function previewUrl(path, kind = "full") {
  return `/api/file/preview?path=${encodeURIComponent(path)}&kind=${encodeURIComponent(kind)}`;
}

function downloadUrl(path) {
  return `/api/file/download?path=${encodeURIComponent(path)}`;
}

// --- Image Orientation Utilities ---

function getImageRatio(img, orientation) {
  if (!img.naturalWidth || !img.naturalHeight) return 1.5;
  let width = img.naturalWidth;
  let height = img.naturalHeight;
  if ([5, 6, 7, 8].includes(orientation)) {
    [width, height] = [height, width];
  }
  return width / height;
}

// Replace the existing updateMasonryCard function in app.js

function updateMasonryCard(img) {
  const card = img.closest(".file-card");
  if (!card) return;

  const orientation = parseInt(img.dataset.orientation || "1", 10);
  const ratio = getImageRatio(img, orientation);
  
  // Calculate width based on fixed row height
  const width = Math.floor(ROW_HEIGHT * ratio);
  
  // 1. Set Container Size
  card.style.flexGrow = ratio; 
  card.style.flexBasis = `${width}px`;
  
  // 2. Handle Image Sizing & Rotation
  const isRotated = [5, 6, 7, 8].includes(orientation);
  
  // If rotated 90deg, the IMG's "width" is visually the "height".
  // To make object-fit work, we size the IMG tag to the SWAPPED dimensions
  // of the container.
  if (isRotated) {
    img.style.width = `${ROW_HEIGHT}px`; // The visual height
    img.style.height = `${width}px`;      // The visual width
  } else {
    img.style.width = "100%";
    img.style.height = "100%";
  }

  // 3. Apply Transform (Always include translate centering)
  let transform = "translate(-50%, -50%)";
  
  if (orientation > 1) {
      img.style.imageOrientation = "none";
      switch (orientation) {
        case 2: transform += " scaleX(-1)"; break;
        case 3: transform += " rotate(180deg)"; break;
        case 4: transform += " scaleY(-1)"; break;
        case 5: transform += " rotate(90deg) scaleX(-1)"; break;
        case 6: transform += " rotate(90deg)"; break;
        case 7: transform += " rotate(270deg) scaleX(-1)"; break;
        case 8: transform += " rotate(270deg)"; break;
      }
  } else {
      img.style.imageOrientation = "from-image";
  }
  
  img.style.transform = transform;
}

// 2. Logic for Detail View (Mathematical Fit)
function fitDetailImage(img) {
  const container = img.parentElement;
  if (!container) return;
  
  const cw = container.clientWidth;
  const ch = container.clientHeight;
  const iw = img.naturalWidth;
  const ih = img.naturalHeight;
  
  if (!iw || !ih) return;

  const orientation = parseInt(img.dataset.orientation || "1", 10);
  const isRotated = [5, 6, 7, 8].includes(orientation);
  
  // The dimensions the image *wants* to occupy visually
  const targetW = isRotated ? ih : iw;
  const targetH = isRotated ? iw : ih;
  
  // Calculate scale to fit container completely
  // We use the smaller scale factor to ensure it fits (contain)
  const scale = Math.min(cw / targetW, ch / targetH);

  // Set the base size to natural dimensions
  img.style.width = `${iw}px`;
  img.style.height = `${ih}px`;
  
  // Start building transform string: Center + Scale
  let transform = `translate(-50%, -50%) scale(${scale})`;
  
  // Append Rotation logic
  switch (orientation) {
    case 2: transform += " scaleX(-1)"; break;
    case 3: transform += " rotate(180deg)"; break;
    case 4: transform += " scaleY(-1)"; break;
    case 5: transform += " rotate(90deg) scaleX(-1)"; break;
    case 6: transform += " rotate(90deg)"; break;
    case 7: transform += " rotate(270deg) scaleX(-1)"; break;
    case 8: transform += " rotate(270deg)"; break;
  }
  
  img.style.transform = transform;
  img.classList.add('loaded');
}

// --- Common ---

function clearFileNav() {
  if (state.navHandler) {
    window.removeEventListener("keydown", state.navHandler);
  }
  state.fileNav = null;
  state.navHandler = null;
}

function clearResizeHandler() {
  if (state.resizeHandler) {
    window.removeEventListener("resize", state.resizeHandler);
  }
  state.resizeHandler = null;
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

async function fetchTagOptions() {
  try {
    const data = await apiGet("/api/tags");
    state.tagOptions = Array.isArray(data.tags) ? data.tags : [];
  } catch (err) {
    state.tagOptions = state.tagOptions || [];
  }
}

function renderTagOptions(tags) {
  return `
    <datalist id="tag-options">
      ${tags.map((tag) => `<option value="${escapeHtml(tag)}"></option>`).join("")}
    </datalist>
  `;
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
      setStatus("Library not configured");
    }
  } catch (err) {
    setStatus("Backend unavailable");
    viewEl.innerHTML = `<div class="loading">${escapeHtml(err.message)}</div>`;
    return;
  }

  await route();
}

async function route() {
  const path = window.location.pathname;
  if (!state.config?.configured) {
    renderNotConfigured();
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

function renderNotConfigured() {
  clearFileNav();
  viewEl.innerHTML = `
    <div class="loading">
      <h2>Library not configured</h2>
      <p>Set RAW_MANAGER_LIBRARY_ROOT in your .env or environment variables.</p>
    </div>
  `;
}

// --- EXPLORER VIEW ---

async function renderExplorer(path) {
  clearFileNav();
  clearResizeHandler();
  viewEl.innerHTML = `<div class="loading">Loading...</div>`;
  try {
    const data = await apiGet(`/api/browse?path=${encodeURIComponent(path)}`);
    state.currentPath = data.path;
    state.currentEntries = data.entries;
    state.selection = new Map();
    
    if (state.config?.library_root) {
      setStatus(`/${data.path || ""}`);
    }

    const dirs = data.entries.filter((entry) => entry.kind === "dir");
    const files = data.entries.filter((entry) => entry.kind === "file");

    const breadcrumb = renderBreadcrumbs(data.path);

    viewEl.innerHTML = `
      <section class="layout">
        <div class="sidebar">
          <div class="breadcrumbs">${breadcrumb}</div>
          <div class="folder-list">
            ${dirs.map((dir) => {
              const isSelected = state.selection.has(dir.path);
              return `
                <div class="folder-item${isSelected ? " selected" : ""}" 
                     data-action="open-folder" 
                     data-path="${encodeURIComponent(dir.path)}">
                  <span style="margin-right:8px; opacity:0.5;">/</span>
                  <span>${escapeHtml(dir.name)}</span>
                </div>
              `;
            }).join("")}
            ${dirs.length === 0 ? `<div style="padding:10px 16px; font-size:0.8rem; color:#444;">No subfolders</div>` : ""}
          </div>
        </div>
        <div class="files-card">
          <div class="files-header">
            <div class="action-bar">
              <div class="selection-pill" id="selection-count">0 selected</div>
              <button class="secondary-btn" id="select-all-btn">Select all</button>
              <button class="secondary-btn" id="new-folder-btn">New folder</button>
              <button class="secondary-btn" id="move-btn" disabled>Move</button>
              <button class="secondary-btn" id="delete-btn" disabled>Delete</button>
              <button class="secondary-btn" id="clear-selection" disabled>Clear</button>
            </div>
            <div class="action-panel hidden" id="action-panel"></div>
          </div>
          <div class="file-grid">
            ${files.map((file) => renderFileCard(file)).join("")}
            ${files.length === 0 ? `<div class="loading">No raw files in this folder.</div>` : ""}
          </div>
        </div>
      </section>
    `;

    bindExplorerHandlers();
  } catch (err) {
    viewEl.innerHTML = `<div class="loading">${escapeHtml(err.message)}</div>`;
  }
}

function renderBreadcrumbs(path) {
  const parts = path ? path.split("/") : [];
  const crumbs = [`<button data-action="open-root">Library</button>`];
  let built = "";
  parts.forEach((part) => {
    built = built ? `${built}/${part}` : part;
    crumbs.push(
      `<span style="margin:0 4px">/</span><button data-action="open-folder" data-path="${encodeURIComponent(built)}">${escapeHtml(part)}</button>`
    );
  });
  return crumbs.join("");
}

function renderListRating(file) {
  const userRating = file.user_rating;
  const cameraRating = file.camera_rating;
  const displayRating = userRating ?? cameraRating ?? 0;
  const buttons = [];
  for (let i = 1; i <= 5; i += 1) {
    const active = displayRating >= i ? " active" : "";
    buttons.push(
      `<button class="list-star${active}" data-action="rate-file" data-path="${encodeURIComponent(file.path)}" data-rating="${i}">★</button>`
    );
  }
  return `<div class="list-rating" data-user="${userRating ?? ""}" data-camera="${cameraRating ?? ""}" data-path="${encodeURIComponent(file.path)}">${buttons.join("")}</div>`;
}

function renderFileCard(file) {
  const isSelected = state.selection.has(file.path);

  return `
    <div class="file-card${isSelected ? " selected" : ""}" data-action="open-file" data-path="${encodeURIComponent(file.path)}">
      <div class="file-thumb-wrap">
        <img class="file-thumb" loading="lazy" 
             src="${previewUrl(file.path, 'full')}"
             data-preview="${encodeURIComponent(file.path)}" 
             data-orientation="${file.orientation ?? ""}" 
             alt="Preview" />
      </div>
      <div class="file-overlay">
        <div class="file-overlay-top">
          <button class="select-toggle${isSelected ? " selected" : ""}" 
                  data-action="toggle-select" 
                  data-kind="file" 
                  data-path="${encodeURIComponent(file.path)}">
            ${isSelected ? '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="4"><polyline points="20 6 9 17 4 12"></polyline></svg>' : ''}
          </button>
          ${renderListRating(file)}
        </div>
        <div class="file-name">${escapeHtml(file.name)}</div>
      </div>
    </div>
  `;
}

function updateSelectionUI() {
  const selectionCount = document.getElementById("selection-count");
  const moveBtn = document.getElementById("move-btn");
  const deleteBtn = document.getElementById("delete-btn");
  const clearBtn = document.getElementById("clear-selection");
  const count = state.selection.size;

  if (selectionCount) {
    selectionCount.textContent = count > 0 ? `${count} selected` : "0 selected";
  }

  if (moveBtn) moveBtn.disabled = count === 0;
  if (deleteBtn) deleteBtn.disabled = count === 0;
  if (clearBtn) clearBtn.disabled = count === 0;
}

function updateListRating(group, userRating) {
  group.dataset.user = Number.isNaN(userRating) ? "" : String(userRating);
  group.querySelectorAll(".list-star").forEach((star) => {
    const value = parseInt(star.dataset.rating || "0", 10);
    star.classList.toggle("active", (userRating || 0) >= value);
  });
}

function toggleSelection(path, kind, element) {
  if (state.selection.has(path)) {
    state.selection.delete(path);
  } else {
    state.selection.set(path, kind);
  }

  const isSelected = state.selection.has(path);
  if (element) {
    element.classList.toggle("selected", isSelected);
    element.innerHTML = isSelected 
      ? '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="4"><polyline points="20 6 9 17 4 12"></polyline></svg>'
      : '';
      
    const parent = element.closest(".file-card, .folder-item");
    if (parent) {
      parent.classList.toggle("selected", isSelected);
    }
  }

  updateSelectionUI();
}

function showActionPanel(content) {
  const panel = document.getElementById("action-panel");
  if (!panel) return;
  panel.innerHTML = content;
  panel.classList.remove("hidden");
}

function hideActionPanel() {
  const panel = document.getElementById("action-panel");
  if (!panel) return;
  panel.classList.add("hidden");
  panel.innerHTML = "";
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

  document.querySelectorAll("[data-action='rate-file']").forEach((item) => {
    item.addEventListener("click", async (event) => {
      event.stopPropagation();
      const group = item.closest(".list-rating");
      const path = decodeURIComponent(item.dataset.path || "");
      const rating = parseInt(item.dataset.rating || "0", 10);
      const current = parseInt(group.dataset.user || "", 10);
      const newRating = current === rating ? null : rating;
      try {
        await apiPost("/api/file/rating", { path, rating: newRating });
        updateListRating(group, newRating ?? NaN);
      } catch (err) {
        alert(err.message);
      }
    });
  });

  document.querySelectorAll("[data-action='toggle-select']").forEach((item) => {
    item.addEventListener("click", (event) => {
      event.stopPropagation();
      const path = decodeURIComponent(item.dataset.path || "");
      const kind = item.dataset.kind || "file";
      toggleSelection(path, kind, item);
    });
  });

  document.querySelectorAll("img[data-preview]").forEach((img) => {
    img.addEventListener("load", () => {
      updateMasonryCard(img);
    });
    if (img.complete && img.naturalWidth) {
      updateMasonryCard(img);
    }
  });

  state.resizeHandler = () => {
    document.querySelectorAll("img[data-preview]").forEach((img) => {
      if (img.complete && img.naturalWidth) {
        updateMasonryCard(img);
      }
    });
  };
  window.addEventListener("resize", state.resizeHandler);

  document.getElementById("select-all-btn")?.addEventListener("click", () => {
    state.selection = new Map();
    state.currentEntries.forEach((entry) => {
      state.selection.set(entry.path, entry.kind);
    });
    document.querySelectorAll(".file-card, .folder-item, .select-toggle").forEach(el => el.classList.add("selected"));
    document.querySelectorAll(".select-toggle").forEach(el => el.innerHTML = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="4"><polyline points="20 6 9 17 4 12"></polyline></svg>');
    updateSelectionUI();
  });

  document.getElementById("clear-selection")?.addEventListener("click", () => {
    state.selection = new Map();
    document.querySelectorAll(".selected").forEach(el => el.classList.remove("selected"));
    document.querySelectorAll(".select-toggle").forEach(el => el.innerHTML = '');
    updateSelectionUI();
  });

  document.getElementById("new-folder-btn")?.addEventListener("click", () => {
    showActionPanel(`
      <div class="panel-row">
        <input class="input" id="new-folder-name" placeholder="New folder name..." style="flex:1" />
        <button class="secondary-btn" id="panel-cancel">Cancel</button>
        <button class="primary-btn" id="panel-confirm">Create</button>
      </div>
    `);
    document.getElementById("panel-cancel").addEventListener("click", hideActionPanel);
    document.getElementById("panel-confirm").addEventListener("click", async () => {
      const name = document.getElementById("new-folder-name").value.trim();
      if (!name) return;
      const path = state.currentPath ? `${state.currentPath}/${name}` : name;
      try {
        await apiPost("/api/fs/mkdir", { path });
        hideActionPanel();
        await renderExplorer(state.currentPath);
      } catch (err) { alert(err.message); }
    });
  });

  document.getElementById("move-btn")?.addEventListener("click", () => {
    if (state.selection.size === 0) return;
    showActionPanel(`
      <div class="panel-row">
        <input class="input" id="move-dest" placeholder="Destination path..." value="${state.currentPath}" style="flex:1" />
        <button class="secondary-btn" id="panel-cancel">Cancel</button>
        <button class="primary-btn" id="panel-confirm">Move</button>
      </div>
    `);
    document.getElementById("panel-cancel").addEventListener("click", hideActionPanel);
    document.getElementById("panel-confirm").addEventListener("click", async () => {
      const destination = document.getElementById("move-dest").value.trim();
      const paths = Array.from(state.selection.keys());
      try {
        await apiPost("/api/fs/move", { paths, destination });
        hideActionPanel();
        state.selection.clear();
        await renderExplorer(state.currentPath);
      } catch (err) { alert(err.message); }
    });
  });

  document.getElementById("delete-btn")?.addEventListener("click", async () => {
    const paths = Array.from(state.selection.keys());
    if (paths.length === 0 || !confirm("Delete selected items permanently?")) return;
    const recursive = Array.from(state.selection.values()).includes("dir");
    try {
      await apiPost("/api/fs/delete", { paths, recursive });
      state.selection.clear();
      await renderExplorer(state.currentPath);
    } catch (err) { alert(err.message); }
  });
}


// --- DETAIL VIEW ---

async function renderFileDetail(path) {
  clearResizeHandler();
  viewEl.innerHTML = `<div class="loading">Loading details...</div>`;
  try {
    const meta = await apiGet(`/api/file/metadata?path=${encodeURIComponent(path)}`);
    const previewSrc = previewUrl(path, "full");
    
    // Determine siblings for navigation
    const folderPath = path.includes("/") ? path.split("/").slice(0, -1).join("/") : "";
    state.currentPath = folderPath;
    
    const siblingData = await apiGet(`/api/browse?path=${encodeURIComponent(folderPath)}`);
    const fileEntries = siblingData.entries.filter((entry) => entry.kind === "file");
    const index = fileEntries.findIndex((entry) => entry.path === path);
    const prevFile = index > 0 ? fileEntries[index - 1] : null;
    const nextFile = index >= 0 && index < fileEntries.length - 1 ? fileEntries[index + 1] : null;
    const posLabel = `${index + 1} / ${fileEntries.length}`;

    await fetchTagOptions();

    viewEl.innerHTML = `
      <section class="details-grid">
        <div class="preview-card">
          <div class="preview-toolbar">
            <button id="back-btn">← Back</button>
            <div class="meta-value" style="color:#fff">${escapeHtml(meta.name)} (${posLabel})</div>
            <div style="display:flex; gap:10px;">
              <button id="prev-btn" ${prevFile ? "" : "disabled"}>Prev</button>
              <button id="next-btn" ${nextFile ? "" : "disabled"}>Next</button>
            </div>
          </div>
          <img class="preview-img" src="${previewSrc}" data-orientation="${meta.orientation ?? ""}" alt="Preview" />
        </div>
        <div class="meta-card">
          <div class="meta-item">
            <div class="meta-label">Rating</div>
            <div class="stars" id="user-rating"></div>
          </div>
          <div class="meta-item">
            <div class="meta-label">Tags</div>
            <div class="tag-list" id="tag-list"></div>
            <div class="tag-input" style="display:flex; gap:4px; margin-top:4px;">
              <input class="input" id="tag-input" list="tag-options" placeholder="Add tag..." />
              <button id="tag-add" class="primary-btn">+</button>
            </div>
            ${renderTagOptions(state.tagOptions)}
          </div>
          <div class="meta-item">
            <div class="meta-label">Information</div>
            <div class="meta-value">${formatBytes(meta.file_size)}</div>
            <div class="meta-value">${escapeHtml(meta.taken_at || "Unknown Date")}</div>
            <div class="meta-value">${meta.gps_lat ? "Has Location Data" : "No Location Data"}</div>
          </div>
          <div class="meta-item">
            <a class="primary-btn" href="${downloadUrl(path)}" style="text-align:center; text-decoration:none;">Download Raw</a>
          </div>
        </div>
      </section>
    `;

    bindDetailHandlers(path, meta, prevFile, nextFile);
  } catch (err) {
    viewEl.innerHTML = `<div class="loading">${escapeHtml(err.message)}</div>`;
  }
}

function bindDetailHandlers(path, meta, prevFile, nextFile) {
  // Orientation & Sizing
  const img = document.querySelector(".preview-img");
  
  if (img) {
    const handleFit = () => fitDetailImage(img);
    if (img.complete) handleFit();
    img.addEventListener("load", handleFit);
    
    // Attach resize listener specifically for detail view
    state.resizeHandler = handleFit;
    window.addEventListener("resize", state.resizeHandler);
  }

  // Navigation
  document.getElementById("back-btn").addEventListener("click", () => {
    navigate(state.currentPath ? `/?path=${encodeURIComponent(state.currentPath)}` : "/");
  });

  const goPrev = () => { if (prevFile) navigate(`/file?path=${encodeURIComponent(prevFile.path)}`); };
  const goNext = () => { if (nextFile) navigate(`/file?path=${encodeURIComponent(nextFile.path)}`); };

  document.getElementById("prev-btn").addEventListener("click", goPrev);
  document.getElementById("next-btn").addEventListener("click", goNext);

  clearFileNav();
  state.navHandler = (event) => {
    const active = document.activeElement;
    if (active && ["INPUT", "TEXTAREA"].includes(active.tagName)) return;
    if (event.key === "ArrowLeft") goPrev();
    if (event.key === "ArrowRight") goNext();
    if (event.key === "Escape") document.getElementById("back-btn").click();
  };
  window.addEventListener("keydown", state.navHandler);

  // Ratings
  const ratingEl = document.getElementById("user-rating");
  renderStarControls(ratingEl, meta.user_rating, async (val) => {
    try {
      await apiPost("/api/file/rating", { path, rating: val });
    } catch (err) { alert(err.message); }
  });

  // Tags
  const tagList = document.getElementById("tag-list");
  const tagInput = document.getElementById("tag-input");
  const tagAdd = document.getElementById("tag-add");
  let tags = Array.isArray(meta.tags) ? [...meta.tags] : [];

  const renderTags = () => {
    tagList.innerHTML = tags.map(tag => `
      <span class="tag-pill">
        ${escapeHtml(tag)}
        <button data-tag="${encodeURIComponent(tag)}">×</button>
      </span>
    `).join("");
    
    tagList.querySelectorAll("button[data-tag]").forEach(btn => {
      btn.addEventListener("click", async () => {
        tags = tags.filter(t => t !== decodeURIComponent(btn.dataset.tag));
        await persistTags();
      });
    });
  };

  const persistTags = async () => {
    try {
      const res = await apiPost("/api/file/tags", { path, tags });
      tags = res.tags;
      renderTags();
      await fetchTagOptions();
    } catch (err) { alert(err.message); }
  };

  tagAdd.addEventListener("click", async () => {
    const val = tagInput.value.trim();
    if (!val) return;
    if (!tags.includes(val)) {
      tags.push(val);
      await persistTags();
    }
    tagInput.value = "";
  });
  
  tagInput.addEventListener("keydown", async (e) => {
    if (e.key === "Enter") {
        tagAdd.click();
    }
  });

  renderTags();
}

function renderStarControls(container, current, onChange) {
  container.innerHTML = "";
  for (let i = 1; i <= 5; i++) {
    const btn = document.createElement("button");
    btn.className = "star-btn" + (current >= i ? " active" : "");
    btn.textContent = "★";
    btn.onclick = async () => {
      const val = i === current ? 0 : i;
      await onChange(val === 0 ? null : val);
      renderStarControls(container, val === 0 ? null : val, onChange);
    };
    container.appendChild(btn);
  }
}

// --- DRAG AND DROP UPLOAD ---

function isRawFileName(name) {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  return ["arw", "dng", "cr2", "cr3", "nef", "raf", "orf", "rw2", "srw", "pef"].includes(ext);
}

async function uploadFiles(files) {
  const validFiles = files.filter((file) => isRawFileName(file.name));
  if (validFiles.length === 0) {
    alert("No supported RAW files found.");
    return;
  }
  const formData = new FormData();
  validFiles.forEach((file) => formData.append("file", file, file.name));
  
  setStatus(`Uploading ${validFiles.length} file(s)...`);
  try {
    const dest = state.currentPath || "";
    await fetch(`/api/fs/upload?path=${encodeURIComponent(dest)}`, {
      method: "POST",
      body: formData,
    });
    setStatus("Upload complete");
    if (window.location.pathname === "/") {
      await renderExplorer(state.currentPath);
    }
  } catch (err) {
    setStatus("Upload failed");
    alert("Upload failed");
  }
}

function setupDragAndDrop() {
  const overlay = document.getElementById("drop-overlay");
  if (!overlay) return;

  const show = () => overlay.classList.remove("hidden");
  const hide = () => overlay.classList.add("hidden");

  window.addEventListener("dragenter", (e) => { e.preventDefault(); state.dragDepth++; show(); });
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("dragleave", (e) => { 
    e.preventDefault(); 
    state.dragDepth--; 
    if (state.dragDepth <= 0) hide(); 
  });
  window.addEventListener("drop", async (e) => {
    e.preventDefault();
    state.dragDepth = 0;
    hide();
    const files = Array.from(e.dataTransfer.files);
    if (files.length) await uploadFiles(files);
  });
}

window.addEventListener("popstate", route);
window.addEventListener("DOMContentLoaded", () => {
  init();
  setupDragAndDrop();
});
