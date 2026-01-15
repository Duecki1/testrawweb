const state = {
  config: null,
  currentPath: "",
  currentEntries: [],
  selection: new Map(),
  fileNav: null,
  navHandler: null,
  tagOptions: [],
  dragDepth: 0,
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

function previewUrl(path, kind = "full") {
  return `/api/file/preview?path=${encodeURIComponent(path)}&kind=${encodeURIComponent(
    kind
  )}`;
}

function downloadUrl(path) {
  return `/api/file/download?path=${encodeURIComponent(path)}`;
}

function applyOrientation(img, orientation) {
  const mapping = {
    2: "scaleX(-1)",
    3: "rotate(180deg)",
    4: "scaleY(-1)",
    5: "rotate(90deg) scaleX(-1)",
    6: "rotate(90deg)",
    7: "rotate(270deg) scaleX(-1)",
    8: "rotate(270deg)",
  };
  const transform = mapping[orientation] || "";
  img.style.transform = transform;
  img.style.transformOrigin = "center center";
  img.style.imageOrientation = transform ? "none" : "from-image";
}

function clearFileNav() {
  if (state.navHandler) {
    window.removeEventListener("keydown", state.navHandler);
  }
  state.fileNav = null;
  state.navHandler = null;
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
    viewEl.innerHTML = `<div class="card"><div class="notice">${escapeHtml(
      err.message
    )}</div></div>`;
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
    <section class="card setup-grid">
      <h2>Library not configured</h2>
      <div class="notice">
        Set RAW_MANAGER_LIBRARY_ROOT in your .env or docker-compose environment to the mounted library path,
        then restart the service.
      </div>
    </section>
  `;
}

async function renderExplorer(path) {
  clearFileNav();
  viewEl.innerHTML = `<div class="card"><div class="loading">Loading library...</div></div>`;
  try {
    const data = await apiGet(`/api/browse?path=${encodeURIComponent(path)}`);
    state.currentPath = data.path;
    state.currentEntries = data.entries;
    state.selection = new Map();
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
                  (dir) => {
                    const isSelected = state.selection.has(dir.path);
                    const selectedClass = isSelected ? " selected" : "";
                    return `
                <div class="folder-item${selectedClass}" data-action="open-folder" data-path="${encodeURIComponent(
                      dir.path
                    )}">
                  <button class="select-toggle${selectedClass}" data-action="toggle-select" data-kind="dir" data-path="${encodeURIComponent(
                      dir.path
                    )}" aria-label="Select folder"></button>
                  <span>${escapeHtml(dir.name)}</span>
                  <span class="badge">Open</span>
                </div>
              `;
                  }
                )
                .join("")}
              ${dirs.length === 0 ? "<div class=\"loading\">No subfolders.</div>" : ""}
            </div>
          </div>
        </div>
        <div class="card">
          <div class="action-bar">
            <div class="selection-pill" id="selection-count">0 selected</div>
            <div class="action-group">
              <button class="secondary-btn" id="select-all-btn">Select all</button>
              <button class="secondary-btn" id="new-folder-btn">New folder</button>
              <button class="secondary-btn" id="move-btn" disabled>Move</button>
              <button class="secondary-btn" id="delete-btn" disabled>Delete</button>
              <button class="secondary-btn" id="clear-selection" disabled>Clear</button>
            </div>
          </div>
          <div class="action-panel hidden" id="action-panel"></div>
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

function renderListRating(file) {
  const userRating = file.user_rating;
  const cameraRating = file.camera_rating;
  const displayRating = userRating ?? cameraRating ?? 0;
  const ghost = userRating == null && cameraRating != null;
  const buttons = [];
  for (let i = 1; i <= 5; i += 1) {
    const active = displayRating >= i ? " active" : "";
    const ghostClass = ghost ? " ghost" : "";
    buttons.push(
      `<button class="list-star${active}${ghostClass}" data-action="rate-file" data-path="${encodeURIComponent(
        file.path
      )}" data-rating="${i}">*</button>`
    );
  }
  const title = cameraRating != null ? `Camera rating: ${cameraRating}` : "";
  return `<div class="list-rating" title="${title}" data-user="${userRating ?? ""}" data-camera="${cameraRating ?? ""}" data-path="${encodeURIComponent(
    file.path
  )}">${buttons.join("")}</div>`;
}

function renderFileCard(file) {
  const tags = file.tags
    .map((tag) => `<span class="badge tag">${escapeHtml(tag)}</span>`)
    .join("");
  const scanBadge = file.needs_scan
    ? `<span class="badge">scan</span>`
    : "";
  const isSelected = state.selection.has(file.path);
  const selectedClass = isSelected ? " selected" : "";

  return `
    <div class="file-card${selectedClass}" data-action="open-file" data-path="${encodeURIComponent(
      file.path
    )}">
      <div class="file-card-top">
        <button class="select-toggle${selectedClass}" data-action="toggle-select" data-kind="file" data-path="${encodeURIComponent(
          file.path
        )}" aria-label="Select file"></button>
        ${renderListRating(file)}
      </div>
      <div class="file-thumb-wrap">
        <img class="file-thumb" loading="lazy" data-preview="${encodeURIComponent(
          file.path
        )}" data-orientation="${
          file.orientation && file.orientation > 0 ? file.orientation : ""
        }" alt="Preview" />
      </div>
      <div class="file-meta">
        <div class="file-name">${escapeHtml(file.name)}</div>
        <div class="badge-row">
          ${scanBadge}
          ${tags}
        </div>
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
  const dirCount = Array.from(state.selection.values()).filter(
    (kind) => kind === "dir"
  ).length;

  if (selectionCount) {
    selectionCount.textContent =
      dirCount > 0 ? `${count} selected (${dirCount} folder)` : `${count} selected`;
  }

  if (moveBtn) moveBtn.disabled = count === 0;
  if (deleteBtn) deleteBtn.disabled = count === 0;
  if (clearBtn) clearBtn.disabled = count === 0;
}

function updateListRating(group, userRating) {
  const cameraRating = parseInt(group.dataset.camera || "", 10);
  const displayRating = Number.isNaN(userRating)
    ? Number.isNaN(cameraRating)
      ? 0
      : cameraRating
    : userRating;
  const ghost = Number.isNaN(userRating) && !Number.isNaN(cameraRating);

  group.dataset.user = Number.isNaN(userRating) ? "" : String(userRating);
  group.querySelectorAll(".list-star").forEach((star) => {
    const value = parseInt(star.dataset.rating || "0", 10);
    star.classList.toggle("active", displayRating >= value);
    star.classList.toggle("ghost", ghost);
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
      if (!group) return;
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
    const path = decodeURIComponent(img.dataset.preview || "");
    img.src = previewUrl(path, "thumb");
    const orientation = Number(img.dataset.orientation || 0);
    if (orientation) {
      applyOrientation(img, orientation);
    }
    img.addEventListener("error", () => {
      img.removeAttribute("data-preview");
      img.src = "";
      img.alt = "No preview";
    });
  });

  const selectAllBtn = document.getElementById("select-all-btn");
  if (selectAllBtn) {
    selectAllBtn.addEventListener("click", () => {
      state.selection = new Map();
      state.currentEntries.forEach((entry) => {
        state.selection.set(entry.path, entry.kind);
      });
      document
        .querySelectorAll("[data-action='toggle-select']")
        .forEach((toggle) => {
          const path = decodeURIComponent(toggle.dataset.path || "");
          if (state.selection.has(path)) {
            toggle.classList.add("selected");
            const parent = toggle.closest(".file-card, .folder-item");
            if (parent) parent.classList.add("selected");
          }
        });
      updateSelectionUI();
    });
  }

  const clearSelectionBtn = document.getElementById("clear-selection");
  if (clearSelectionBtn) {
    clearSelectionBtn.addEventListener("click", () => {
      state.selection = new Map();
      document
        .querySelectorAll("[data-action='toggle-select']")
        .forEach((toggle) => {
          toggle.classList.remove("selected");
          const parent = toggle.closest(".file-card, .folder-item");
          if (parent) parent.classList.remove("selected");
        });
      updateSelectionUI();
    });
  }

  const newFolderBtn = document.getElementById("new-folder-btn");
  if (newFolderBtn) {
    newFolderBtn.addEventListener("click", () => {
      showActionPanel(`
        <div class="panel-row">
          <div class="panel-field">
            <div class="meta-label">New folder</div>
            <input class="input" id="new-folder-name" placeholder="e.g. selects" />
          </div>
          <div class="panel-actions">
            <button class="secondary-btn" id="panel-cancel">Cancel</button>
            <button class="primary-btn" id="panel-confirm">Create</button>
          </div>
        </div>
      `);

      const cancelBtn = document.getElementById("panel-cancel");
      const confirmBtn = document.getElementById("panel-confirm");
      const input = document.getElementById("new-folder-name");

      cancelBtn?.addEventListener("click", hideActionPanel);
      confirmBtn?.addEventListener("click", async () => {
        const name = input.value.trim();
        if (!name) return;
        const path = state.currentPath ? `${state.currentPath}/${name}` : name;
        try {
          await apiPost("/api/fs/mkdir", { path });
          hideActionPanel();
          await renderExplorer(state.currentPath);
        } catch (err) {
          alert(err.message);
        }
      });
    });
  }

  const moveBtn = document.getElementById("move-btn");
  if (moveBtn) {
    moveBtn.addEventListener("click", () => {
      if (state.selection.size === 0) return;
      showActionPanel(`
        <div class="panel-row">
          <div class="panel-field">
            <div class="meta-label">Move selected to</div>
            <input class="input" id="move-dest" placeholder="Folder path" />
          </div>
          <div class="panel-actions">
            <button class="secondary-btn" id="panel-cancel">Cancel</button>
            <button class="primary-btn" id="panel-confirm">Move</button>
          </div>
        </div>
      `);

      const cancelBtn = document.getElementById("panel-cancel");
      const confirmBtn = document.getElementById("panel-confirm");
      const input = document.getElementById("move-dest");
      if (input) {
        input.value = state.currentPath || "";
      }

      cancelBtn?.addEventListener("click", hideActionPanel);
      confirmBtn?.addEventListener("click", async () => {
        const destination = input.value.trim();
        const paths = Array.from(state.selection.keys());
        try {
          await apiPost("/api/fs/move", { paths, destination });
          hideActionPanel();
          state.selection = new Map();
          await renderExplorer(state.currentPath);
        } catch (err) {
          alert(err.message);
        }
      });
    });
  }

  const deleteBtn = document.getElementById("delete-btn");
  if (deleteBtn) {
    deleteBtn.addEventListener("click", async () => {
      const paths = Array.from(state.selection.keys());
      if (paths.length === 0) return;
      const dirCount = Array.from(state.selection.values()).filter(
        (kind) => kind === "dir"
      ).length;
      const message =
        dirCount > 0
          ? "Delete selected items? Folders will be removed recursively."
          : "Delete selected files?";
      if (!confirm(message)) return;
      try {
        await apiPost("/api/fs/delete", {
          paths,
          recursive: dirCount > 0,
        });
        state.selection = new Map();
        await renderExplorer(state.currentPath);
      } catch (err) {
        alert(err.message);
      }
    });
  }

  updateSelectionUI();
}

async function renderFileDetail(path) {
  viewEl.innerHTML = `<div class="card"><div class="loading">Loading file...</div></div>`;
  try {
    const meta = await apiGet(`/api/file/metadata?path=${encodeURIComponent(path)}`);
    const previewSrc = previewUrl(path, "full");
    const mapEmbed = meta.gps_lat != null && meta.gps_lon != null;
    const folderPath = path.includes("/") ? path.split("/").slice(0, -1).join("/") : "";
    state.currentPath = folderPath;
    const siblingData = await apiGet(`/api/browse?path=${encodeURIComponent(folderPath)}`);
    const fileEntries = siblingData.entries.filter((entry) => entry.kind === "file");
    const index = fileEntries.findIndex((entry) => entry.path === path);
    const prevFile = index > 0 ? fileEntries[index - 1] : null;
    const nextFile = index >= 0 && index < fileEntries.length - 1 ? fileEntries[index + 1] : null;
    const positionLabel =
      index >= 0 ? `${index + 1} / ${fileEntries.length}` : `0 / ${fileEntries.length}`;

    await fetchTagOptions();

    viewEl.innerHTML = `
      <section class="details-grid">
        <div class="card preview-card">
          <button class="secondary-btn" id="back-btn">Back to folder</button>
          <div class="nav-row">
            <button class="secondary-btn" id="prev-btn" ${prevFile ? "" : "disabled"}>Prev</button>
            <div class="meta-label">${positionLabel}</div>
            <button class="secondary-btn" id="next-btn" ${nextFile ? "" : "disabled"}>Next</button>
          </div>
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
                <input class="input" id="tag-input" list="tag-options" placeholder="portrait, bts, favorites" />
                <button class="secondary-btn" id="tag-add">Add</button>
              </div>
              ${renderTagOptions(state.tagOptions)}
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

    bindDetailHandlers(path, meta, prevFile, nextFile);
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

function bindDetailHandlers(path, meta, prevFile, nextFile) {
  const backBtn = document.getElementById("back-btn");
  backBtn.addEventListener("click", () => {
    const backPath = state.currentPath;
    navigate(backPath ? `/?path=${encodeURIComponent(backPath)}` : "/");
  });

  const previewImg = document.querySelector(".preview-img");
  if (previewImg) {
    if (meta.orientation) {
      applyOrientation(previewImg, meta.orientation);
    }
    previewImg.addEventListener("error", () => {
      previewImg.removeAttribute("src");
      previewImg.alt = "No preview available";
    });
  }

  const prevBtn = document.getElementById("prev-btn");
  const nextBtn = document.getElementById("next-btn");
  if (prevBtn && prevFile) {
    prevBtn.addEventListener("click", () => {
      navigate(`/file?path=${encodeURIComponent(prevFile.path)}`);
    });
  }
  if (nextBtn && nextFile) {
    nextBtn.addEventListener("click", () => {
      navigate(`/file?path=${encodeURIComponent(nextFile.path)}`);
    });
  }

  clearFileNav();
  state.fileNav = { prev: prevFile, next: nextFile };
  state.navHandler = (event) => {
    const active = document.activeElement;
    if (active && ["INPUT", "TEXTAREA"].includes(active.tagName)) {
      return;
    }
    if (event.key === "ArrowLeft" && state.fileNav?.prev) {
      navigate(`/file?path=${encodeURIComponent(state.fileNav.prev.path)}`);
    }
    if (event.key === "ArrowRight" && state.fileNav?.next) {
      navigate(`/file?path=${encodeURIComponent(state.fileNav.next.path)}`);
    }
  };
  window.addEventListener("keydown", state.navHandler);

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

  const refreshTagOptions = async () => {
    await fetchTagOptions();
    const datalist = document.getElementById("tag-options");
    if (datalist) {
      datalist.innerHTML = state.tagOptions
        .map((tag) => `<option value="${escapeHtml(tag)}"></option>`)
        .join("");
    }
  };

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
      await refreshTagOptions();
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

function isRawFileName(name) {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  return [
    "arw",
    "dng",
    "cr2",
    "cr3",
    "nef",
    "raf",
    "orf",
    "rw2",
    "srw",
    "pef",
  ].includes(ext);
}

async function uploadFiles(files) {
  const validFiles = files.filter((file) => isRawFileName(file.name));
  if (validFiles.length === 0) {
    alert("No supported RAW files found.");
    return;
  }
  const formData = new FormData();
  validFiles.forEach((file) => {
    formData.append("file", file, file.name);
  });
  const dest = state.currentPath || "";
  setStatus(`Uploading ${validFiles.length} file(s)...`);
  const response = await fetch(
    `/api/fs/upload?path=${encodeURIComponent(dest)}`,
    {
      method: "POST",
      body: formData,
    }
  );
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || `Upload failed: ${response.status}`);
  }
  if (window.location.pathname === "/") {
    await renderExplorer(state.currentPath);
  }
  setStatus(`Upload complete (${validFiles.length})`);
}

function setupDragAndDrop() {
  const overlay = document.getElementById("drop-overlay");
  if (!overlay) return;

  const show = () => overlay.classList.remove("hidden");
  const hide = () => overlay.classList.add("hidden");

  window.addEventListener("dragenter", (event) => {
    event.preventDefault();
    state.dragDepth += 1;
    show();
  });

  window.addEventListener("dragover", (event) => {
    event.preventDefault();
  });

  window.addEventListener("dragleave", (event) => {
    event.preventDefault();
    state.dragDepth = Math.max(0, state.dragDepth - 1);
    if (state.dragDepth === 0) {
      hide();
    }
  });

  window.addEventListener("drop", async (event) => {
    event.preventDefault();
    state.dragDepth = 0;
    hide();
    if (!state.config?.configured) return;
    const files = Array.from(event.dataTransfer?.files || []);
    if (!files.length) return;
    try {
      await uploadFiles(files);
    } catch (err) {
      alert(err.message);
      setStatus("Upload failed");
    }
  });
}

window.addEventListener("popstate", route);
window.addEventListener("DOMContentLoaded", () => {
  init();
  setupDragAndDrop();
});
