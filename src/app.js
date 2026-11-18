import JSZip from 'jszip';
import { buildProjectModel, searchProject } from './engine/parser';
import { traceProgramExecution } from './engine/tracer';
import {
  subscribeToAuth,
  signInWithGoogle,
  signOutUser,
  subscribeToCloudRepoHistory,
  saveRepoToFirestore,
  deleteRepoFromFirestore,
} from './firebaseClient.js';

// Application State
const state = {
  project: null,
  activeFilePath: '',
  activeFunctionName: '',
  selectedNode: null,
  viewMode: 'flow', // 'flow' | 'architecture' | 'dependencies' | 'trace' | 'history'
  selectedEntryPointId: '',
  customInputs: {},
  currentStepIndex: 0,
  isPlaying: false,
  playTimer: null,
  searchQuery: '',
  isImportModalOpen: true,
  expandedFolders: { src: true, config: true, tests: true, '/': true },
  collapsedNodes: new Set(),
  kindFilter: 'all',
  zoom: 0.88,
  pan: { x: 20, y: 16 },
  isDraggingCanvas: false,
  dragOrigin: { x: 0, y: 0 },
  rightTab: 'code', // 'code' | 'inspector' | 'simulator' | 'chat'
  aiExplanations: {},
  isGeneratingAI: false,
  aiError: null,
  chatMessages: [
    {
      role: 'assistant',
      text: 'Ask me anything about this repository — e.g. "Where does authentication happen?", "What happens when x <= 10?", or "Which functions call calculate()?"',
    },
  ],
  isChatLoading: false,
  // Database History State
  serverHistory: [],
  cloudHistory: [],
  currentUser: null,
  unsubscribeCloud: null,
};

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getMergedHistory() {
  const byKey = new Map();
  for (const item of [...state.cloudHistory, ...state.serverHistory]) {
    const key = (item.repoUrl || item.name || item.id).toLowerCase();
    if (!byKey.has(key)) {
      byKey.set(key, item);
    }
  }
  return Array.from(byKey.values()).sort(
    (a, b) => new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime()
  );
}

function getActiveFile() {
  if (!state.project || !state.project.files.length) return null;
  return (
    state.project.files.find((f) => f.path === state.activeFilePath) || state.project.files[0]
  );
}

function getActiveFunction() {
  const file = getActiveFile();
  if (!file) return null;
  return (
    file.functions.find((fn) => fn.name === state.activeFunctionName) ||
    file.functions[0] ||
    null
  );
}

function getTraceResult() {
  if (!state.project) {
    return {
      entryPointId: '',
      inputs: {},
      steps: [],
      visitedNodeIds: [],
      visitedEdgeIds: [],
      loopCounts: {},
      executionMode: 'sandboxed_interpreter',
    };
  }
  return traceProgramExecution(state.project, state.customInputs, state.selectedEntryPointId);
}

// Fetch saved repositories from backend database
async function fetchServerHistory() {
  try {
    const res = await fetch('/api/history');
    if (!res.ok) return;
    const data = await res.json();
    state.serverHistory = Array.isArray(data.repos) ? data.repos : [];
    renderHistoryUI();
  } catch (err) {
    console.error('Failed to load repository history:', err);
  }
}

// Persist repository to both Backend Database and Cloud Firestore (if signed in)
async function persistProjectToDatabase(recordInput) {
  try {
    const res = await fetch('/api/history', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(recordInput),
    });
    if (res.ok) {
      const data = await res.json();
      if (data.repo && state.currentUser) {
        await saveRepoToFirestore(data.repo);
      }
    }
  } catch (err) {
    console.error('Error saving repo to history:', err);
  }
  await fetchServerHistory();
}

async function deleteRepoFromHistory(repoId) {
  try {
    await fetch(`/api/history/${encodeURIComponent(repoId)}`, { method: 'DELETE' });
    if (state.currentUser) {
      await deleteRepoFromFirestore(repoId);
    }
  } catch (err) {
    console.error('Error deleting repo from history:', err);
  }
  await fetchServerHistory();
}

function loadSavedRecordIntoVisualizer(record) {
  if (!record || !Array.isArray(record.files) || record.files.length === 0) return;
  const built = buildProjectModel(
    record.id || `saved-${Date.now()}`,
    record.name || 'saved-repo',
    record.description || 'Loaded from saved repository history.',
    record.files,
    {},
    [],
    record.repoUrl || undefined
  );
  selectProject(built, false);
  closeImportModal();
  if (state.viewMode === 'history') {
    setViewMode('flow');
  } else {
    renderAll();
  }
}

function selectProject(nextProj, shouldSaveToDb = true, rawFilesForDb = null) {
  stopPlayTimer();
  state.project = nextProj;
  const firstFile = nextProj.files[0];
  state.activeFilePath = firstFile ? firstFile.path : '';
  const firstFn = firstFile && firstFile.functions[0];
  state.activeFunctionName = firstFn ? firstFn.name : '';
  state.selectedNode = firstFn && firstFn.nodes[0] ? firstFn.nodes[0] : null;
  state.selectedEntryPointId = nextProj.entryPoints[0] ? nextProj.entryPoints[0].id : '';
  state.customInputs = { ...(nextProj.defaultInputs || {}) };
  state.currentStepIndex = 0;
  state.collapsedNodes.clear();

  if (shouldSaveToDb) {
    const filesToSave =
      rawFilesForDb ||
      nextProj.files.map((f) => ({
        path: f.path,
        content: f.content,
      }));
    persistProjectToDatabase({
      id: nextProj.id,
      name: nextProj.name,
      description: nextProj.description,
      repoUrl: nextProj.repoUrl || '',
      files: filesToSave,
    });
  }

  renderAll();
}

function openImportModalWithFade() {
  state.isImportModalOpen = true;
  const modal = document.getElementById('import-modal');
  const card = document.getElementById('import-modal-card');
  if (modal && card) {
    modal.classList.remove('hidden');
    card.classList.remove('animate-fade-in');
    void card.offsetWidth;
    card.classList.add('animate-fade-in');
  }
  renderImportModalState();
  renderHistoryUI();
}

function closeImportModal() {
  state.isImportModalOpen = false;
  const modal = document.getElementById('import-modal');
  if (modal) {
    modal.classList.add('hidden');
  }
  renderImportModalState();
}

function setViewMode(mode) {
  state.viewMode = mode;
  renderAll();
}

function stopPlayTimer() {
  state.isPlaying = false;
  if (state.playTimer) {
    window.clearInterval(state.playTimer);
    state.playTimer = null;
  }
}

function togglePlayTrace() {
  if (!state.project) return;
  if (state.isPlaying) {
    stopPlayTimer();
    renderDebuggerBar();
    return;
  }
  const trace = getTraceResult();
  if (state.currentStepIndex >= trace.steps.length - 1) {
    state.currentStepIndex = 0;
  }
  state.isPlaying = true;
  renderDebuggerBar();
  state.playTimer = window.setInterval(() => {
    const currentTrace = getTraceResult();
    if (state.currentStepIndex >= currentTrace.steps.length - 1) {
      stopPlayTimer();
      renderAll();
      return;
    }
    stepToIndex(state.currentStepIndex + 1, false);
  }, 650);
}

function stepToIndex(stepIdx, stopPlaying = true) {
  if (!state.project) return;
  if (stopPlaying) stopPlayTimer();
  const trace = getTraceResult();
  const clamped = Math.max(0, Math.min(trace.steps.length - 1, stepIdx));
  state.currentStepIndex = clamped;
  const step = trace.steps[clamped];
  if (step) {
    state.activeFilePath = step.file;
    state.activeFunctionName = step.functionName;
    const fileObj = state.project.files.find((f) => f.path === step.file);
    const fnObj = fileObj && fileObj.functions.find((fn) => fn.name === step.functionName);
    const nodeObj = fnObj && fnObj.nodes.find((n) => n.id === step.nodeId);
    if (nodeObj) state.selectedNode = nodeObj;
  }
  renderAll();
}

function navigateToFileFunction(filePath, functionName) {
  if (!state.project) return;
  const targetFile = state.project.files.find((f) => f.path === filePath);
  if (!targetFile) return;
  state.activeFilePath = targetFile.path;
  const targetFn =
    (functionName && targetFile.functions.find((fn) => fn.name === functionName)) ||
    targetFile.functions[0];
  if (targetFn) {
    state.activeFunctionName = targetFn.name;
    state.selectedNode = targetFn.nodes[0] || null;
  }
  renderAll();
}

function selectNodeByLine(line) {
  const file = getActiveFile();
  if (!file) return;
  const activeFn = getActiveFunction();
  const fnForLine =
    file.functions.find((fn) => line >= fn.startLine && line <= fn.endLine) || activeFn;
  if (!fnForLine) return;

  state.activeFunctionName = fnForLine.name;
  const matchedNode =
    fnForLine.nodes.find(
      (n) =>
        n.kind !== 'function' &&
        line >= n.location.startLine &&
        line <= n.location.endLine
    ) || fnForLine.nodes[0];

  if (matchedNode) {
    state.selectedNode = matchedNode;
  }
  renderAll();
}

// Render Top Header & Workspace Visibility
function renderWorkspaceVisibility() {
  const emptyEl = document.getElementById('empty-workspace');
  const historyEl = document.getElementById('history-workspace');
  const activeEl = document.getElementById('active-workspace');

  // Update top nav active state
  document.querySelectorAll('.nav-view-btn').forEach((btn) => {
    const view = btn.getAttribute('data-nav-view');
    if (view === state.viewMode) {
      btn.classList.add('text-white', 'underline', 'underline-offset-4');
    } else {
      btn.classList.remove('text-white', 'underline', 'underline-offset-4');
    }
  });

  if (state.viewMode === 'history') {
    emptyEl?.classList.add('hidden');
    activeEl?.classList.add('hidden');
    historyEl?.classList.remove('hidden');
    return;
  }

  historyEl?.classList.add('hidden');
  if (state.project && getActiveFile()) {
    emptyEl?.classList.add('hidden');
    activeEl?.classList.remove('hidden');
  } else {
    activeEl?.classList.add('hidden');
    emptyEl?.classList.remove('hidden');
  }
}

function renderImportModalState() {
  const closeBtn = document.getElementById('close-import-modal-btn');
  if (closeBtn) {
    if (state.project !== null || getMergedHistory().length > 0) {
      closeBtn.classList.remove('hidden');
    } else {
      closeBtn.classList.add('hidden');
    }
  }
}

// Render History Tab & Modal History List
function renderHistoryUI() {
  const repos = getMergedHistory();
  const topCount = document.getElementById('top-history-count');
  if (topCount) topCount.textContent = String(repos.length);

  const modalCount = document.getElementById('modal-history-count');
  if (modalCount) modalCount.textContent = `${repos.length} saved`;

  const storageBadge = document.getElementById('history-storage-badge');
  if (storageBadge) {
    storageBadge.textContent = state.currentUser
      ? `Cloud Firestore + Local DB (${state.currentUser.email || 'Signed In'})`
      : 'Database: Persistent Local + Cloud Ready';
  }

  // 1. Render inside Import Modal quick-access list
  const modalList = document.getElementById('modal-history-list');
  if (modalList) {
    if (repos.length === 0) {
      modalList.innerHTML = `
        <div class="col-span-2 p-3 rounded-xl bg-[#14171f]/70 border border-white/[0.06] text-xs text-zinc-500 text-center">
          No repositories fetched yet. Import a GitHub URL, upload files, or paste code above to save it automatically.
        </div>
      `;
    } else {
      modalList.innerHTML = repos
        .map(
          (repo) => `
          <div class="p-3 rounded-xl bg-[#14171f] border border-blue-500/20 hover:border-blue-400/45 transition-colors flex items-center justify-between gap-2">
            <div class="min-w-0">
              <div class="text-xs font-semibold text-white truncate font-mono">${escapeHtml(repo.name)}</div>
              <div class="text-[11px] text-zinc-400 truncate mt-0.5">
                ${escapeHtml(repo.language || 'Code')} · ${Number(repo.fileCount || repo.files?.length || 1)} file(s)
              </div>
            </div>
            <div class="flex items-center gap-1.5 shrink-0">
              <button
                type="button"
                data-load-repo-id="${escapeHtml(repo.id)}"
                class="px-2.5 py-1 rounded-lg bg-blue-600 hover:bg-blue-500 text-[11px] font-semibold text-white transition-colors"
              >
                Load Map
              </button>
              <button
                type="button"
                data-delete-repo-id="${escapeHtml(repo.id)}"
                aria-label="Delete ${escapeHtml(repo.name)}"
                class="px-2 py-1 rounded-lg bg-white/[0.05] hover:bg-rose-500/20 text-[11px] text-zinc-400 hover:text-rose-300 transition-colors"
              >
                ✕
              </button>
            </div>
          </div>
        `
        )
        .join('');
    }
  }

  // 2. Render inside Dedicated History Tab View
  const historyContainer = document.getElementById('history-list-container');
  if (historyContainer) {
    if (repos.length === 0) {
      historyContainer.innerHTML = `
        <div class="col-span-2 p-8 rounded-2xl bg-[#14171f] border border-white/[0.08] text-center space-y-3">
          <div class="text-sm font-semibold text-white">No Saved Repositories Yet</div>
          <p class="text-xs text-zinc-400 max-w-md mx-auto">
            Whenever you fetch a GitHub repository, upload source files, or analyze a snippet, it is automatically stored in the database and listed here.
          </p>
        </div>
      `;
    } else {
      historyContainer.innerHTML = repos
        .map((repo) => {
          const formattedDate = repo.updatedAt
            ? new Date(repo.updatedAt).toLocaleString()
            : 'Recently saved';
          const fileNames = (repo.files || [])
            .slice(0, 4)
            .map((f) => f.path)
            .join(', ');
          return `
            <div class="p-4 rounded-2xl bg-[#14171f] border border-blue-500/25 hover:border-blue-400/50 transition-all flex flex-col justify-between gap-4">
              <div class="space-y-2">
                <div class="flex items-start justify-between gap-2">
                  <div>
                    <h2 class="text-sm font-bold text-white font-mono">${escapeHtml(repo.name)}</h2>
                    <p class="text-xs text-zinc-400 mt-0.5 line-clamp-2">${escapeHtml(repo.description || 'Saved repository snapshot')}</p>
                  </div>
                  <span class="px-2 py-0.5 rounded-md text-[10px] font-mono uppercase bg-blue-500/15 text-blue-300 border border-blue-400/30 shrink-0">
                    ${escapeHtml(repo.language || 'Code')}
                  </span>
                </div>
                ${
                  repo.repoUrl
                    ? `<div class="text-[11px] font-mono text-blue-300/80 truncate">${escapeHtml(repo.repoUrl)}</div>`
                    : ''
                }
                <div class="text-[11px] font-mono text-zinc-400 truncate">
                  Files (${Number(repo.fileCount || repo.files?.length || 1)}): <span class="text-zinc-300">${escapeHtml(fileNames)}</span>
                </div>
              </div>

              <div class="flex items-center justify-between pt-3 border-t border-white/[0.06]">
                <span class="text-[10px] font-mono text-zinc-500">${escapeHtml(formattedDate)}</span>
                <div class="flex items-center gap-2">
                  <button
                    type="button"
                    data-delete-repo-id="${escapeHtml(repo.id)}"
                    class="px-3 py-1.5 rounded-lg bg-white/[0.05] hover:bg-rose-500/20 border border-white/10 text-xs text-zinc-300 hover:text-rose-300 transition-colors"
                  >
                    Delete
                  </button>
                  <button
                    type="button"
                    data-load-repo-id="${escapeHtml(repo.id)}"
                    class="px-3.5 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-xs font-semibold text-white transition-colors"
                  >
                    Open Visual Map →
                  </button>
                </div>
              </div>
            </div>
          `;
        })
        .join('');
    }
  }

  // Bind click events for Load and Delete buttons
  document.querySelectorAll('[data-load-repo-id]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-load-repo-id');
      const target = repos.find((r) => r.id === id);
      if (target) loadSavedRecordIntoVisualizer(target);
    });
  });

  document.querySelectorAll('[data-delete-repo-id]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.getAttribute('data-delete-repo-id');
      if (id) deleteRepoFromHistory(id);
    });
  });

  renderImportModalState();
}

// Render Left Sidebar (Search, Project Summary, Entry Point, File Explorer)
function renderSidebar() {
  const project = state.project;
  const activeFile = getActiveFile();
  const activeFunction = getActiveFunction();
  if (!project || !activeFile) return;

  const summaryName = document.getElementById('project-summary-name');
  if (summaryName) summaryName.textContent = project.name;

  const totalFunctions = project.files.reduce((acc, f) => acc + f.functions.length, 0);
  const totalClasses = project.files.reduce((acc, f) => acc + f.classes.length, 0);

  const summaryStats = document.getElementById('project-summary-stats');
  if (summaryStats) {
    summaryStats.innerHTML = `
      <span>${project.files.length} files</span>
      <span>·</span>
      <span>${totalFunctions} funcs</span>
      <span>·</span>
      <span>${totalClasses} classes</span>
      <span>·</span>
      <span>${project.dependencies.length} deps</span>
    `;
  }

  const epSelect = document.getElementById('entry-point-select');
  if (epSelect) {
    epSelect.innerHTML = project.entryPoints
      .map(
        (ep) => `
        <option value="${escapeHtml(ep.id)}" ${ep.id === state.selectedEntryPointId ? 'selected' : ''}>
          ${escapeHtml(ep.file)} :: ${escapeHtml(ep.functionName)}()
        </option>
      `
      )
      .join('');
  }

  const explorerHeading = document.getElementById('file-explorer-heading');
  if (explorerHeading) {
    explorerHeading.textContent = `File Explorer (${project.files.length})`;
  }

  // Group files by folder
  const folderGroups = {};
  project.files.forEach((f) => {
    const key = f.folder || '/';
    if (!folderGroups[key]) folderGroups[key] = [];
    folderGroups[key].push(f);
  });

  const treeContainer = document.getElementById('file-explorer-tree');
  if (treeContainer) {
    treeContainer.innerHTML = Object.entries(folderGroups)
      .map(([folder, files]) => {
        const isExpanded = state.expandedFolders[folder] ?? true;
        const filesHtml = isExpanded
          ? `<div class="pl-3 space-y-1">
              ${files
                .map((file) => {
                  const isSelected = file.path === activeFile.path;
                  const nestedFns =
                    isSelected && file.functions.length > 0
                      ? `<div class="pl-5 py-0.5 space-y-0.5">
                          ${file.functions
                            .map(
                              (fn) => `
                              <button
                                type="button"
                                data-tree-fn="${escapeHtml(fn.name)}"
                                data-tree-fn-file="${escapeHtml(file.path)}"
                                class="w-full text-left px-2 py-1 rounded-md font-mono text-[11px] flex items-center justify-between transition-colors ${
                                  activeFunction && activeFunction.name === fn.name
                                    ? 'text-blue-300 bg-blue-500/15 font-medium'
                                    : 'text-zinc-400 hover:text-zinc-200'
                                }"
                              >
                                <span class="truncate">↳ ${escapeHtml(fn.name)}()</span>
                              </button>
                            `
                            )
                            .join('')}
                        </div>`
                      : '';
                  return `
                    <div class="space-y-0.5">
                      <button
                        type="button"
                        data-tree-file="${escapeHtml(file.path)}"
                        class="w-full text-left px-2.5 py-1.5 rounded-lg flex items-center justify-between text-xs transition-colors ${
                          isSelected
                            ? 'bg-[#25272f] text-white font-medium'
                            : 'text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.04]'
                        }"
                      >
                        <span class="font-mono truncate">${escapeHtml(file.name)}</span>
                        <span class="text-[10px] font-mono text-zinc-500 shrink-0 tabular-nums">${file.functions.length}fn</span>
                      </button>
                      ${nestedFns}
                    </div>
                  `;
                })
                .join('')}
            </div>`
          : '';

        return `
          <div class="space-y-1">
            <button
              type="button"
              data-toggle-folder="${escapeHtml(folder)}"
              class="w-full flex items-center gap-1.5 px-2 py-1 text-xs text-zinc-400 hover:text-white rounded-lg transition-colors"
            >
              <span class="font-mono text-[10px]">${isExpanded ? '▼' : '▶'}</span>
              <span class="font-mono truncate">${escapeHtml(folder)}</span>
            </button>
            ${filesHtml}
          </div>
        `;
      })
      .join('');

    treeContainer.querySelectorAll('[data-toggle-folder]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const folder = btn.getAttribute('data-toggle-folder');
        if (folder) {
          state.expandedFolders[folder] = !(state.expandedFolders[folder] ?? true);
          renderSidebar();
        }
      });
    });

    treeContainer.querySelectorAll('[data-tree-file]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const filePath = btn.getAttribute('data-tree-file');
        if (filePath) {
          state.viewMode = 'flow';
          navigateToFileFunction(filePath);
        }
      });
    });

    treeContainer.querySelectorAll('[data-tree-fn]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const fnName = btn.getAttribute('data-tree-fn');
        const filePath = btn.getAttribute('data-tree-fn-file');
        if (filePath && fnName) {
          state.viewMode = 'flow';
          navigateToFileFunction(filePath, fnName);
        }
      });
    });
  }
}

// Render Global Search Dropdown
function renderSearchResults() {
  const dropdown = document.getElementById('global-search-results');
  if (!dropdown || !state.project) return;
  const q = state.searchQuery.trim();
  if (!q) {
    dropdown.classList.add('hidden');
    dropdown.innerHTML = '';
    return;
  }

  const results = searchProject(state.project, q);
  dropdown.classList.remove('hidden');
  if (results.length === 0) {
    dropdown.innerHTML = `<div class="p-3 text-xs text-zinc-500">No matching symbols found.</div>`;
    return;
  }

  dropdown.innerHTML = results
    .map(
      (res, idx) => `
      <button
        type="button"
        data-search-idx="${idx}"
        class="w-full text-left p-2.5 hover:bg-white/[0.06] transition-colors text-xs"
      >
        <div class="flex items-center justify-between font-mono">
          <span class="font-semibold text-blue-300">${escapeHtml(res.symbolName)}</span>
          <span class="text-[10px] text-zinc-400">${escapeHtml(res.file)}:${res.line}</span>
        </div>
        ${
          res.calledBy.length > 0
            ? `<div class="text-[10px] text-zinc-400 mt-1">Called by: <span class="font-mono text-zinc-300">${escapeHtml(res.calledBy.join(', '))}</span></div>`
            : ''
        }
        ${
          res.calls.length > 0
            ? `<div class="text-[10px] text-zinc-400">Calls: <span class="font-mono text-emerald-300">${escapeHtml(res.calls.join(', '))}</span></div>`
            : ''
        }
      </button>
    `
    )
    .join('');

  dropdown.querySelectorAll('[data-search-idx]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = Number(btn.getAttribute('data-search-idx'));
      const res = results[idx];
      if (!res) return;
      state.viewMode = 'flow';
      navigateToFileFunction(res.file, res.functionName);
      if (res.nodeId) {
        const f = state.project.files.find((fl) => fl.path === res.file);
        const fn = f && f.functions.find((fnItem) => fnItem.name === res.functionName);
        const n = fn && fn.nodes.find((nd) => nd.id === res.nodeId);
        if (n) state.selectedNode = n;
      }
      state.searchQuery = '';
      const input = document.getElementById('global-search-input');
      if (input) input.value = '';
      renderAll();
    });
  });
}

// Compute Control-Flow Graph Node Layout (Side-by-Side TRUE/FALSE branches)
function computeFlowLayout(fn, collapsedNodes, kindFilter) {
  if (!fn) {
    return { positions: {}, visibleNodes: [], visibleEdges: [] };
  }

  const hiddenIds = new Set();
  fn.edges.forEach((edge) => {
    if (
      collapsedNodes.has(edge.source) &&
      (edge.branchType === 'true' ||
        edge.branchType === 'false' ||
        edge.branchType === 'loop_body')
    ) {
      hiddenIds.add(edge.target);
    }
  });

  const visibleNodes = fn.nodes.filter((n) => {
    if (hiddenIds.has(n.id)) return false;
    if (kindFilter === 'all') return true;
    if (kindFilter === 'call') {
      return n.kind === 'call' || n.kind === 'start' || n.kind === 'end' || n.kind === 'function';
    }
    if (kindFilter === 'condition') {
      return (
        n.kind === 'condition' ||
        n.kind === 'branch_true' ||
        n.kind === 'branch_false' ||
        n.kind === 'start' ||
        n.kind === 'end'
      );
    }
    if (kindFilter === 'loop') {
      return n.kind === 'loop' || n.kind === 'start' || n.kind === 'end';
    }
    return true;
  });

  const visibleIds = new Set(visibleNodes.map((n) => n.id));
  const visibleEdges = fn.edges.filter(
    (e) => visibleIds.has(e.source) && visibleIds.has(e.target)
  );

  const positions = {};
  const centerX = 430;
  let currentY = 48;
  const verticalGap = 104;

  const nodeBranchSide = {};
  const parentConditionY = {};

  fn.edges.forEach((edge) => {
    if (edge.branchType === 'true') {
      nodeBranchSide[edge.target] = 'true';
    } else if (edge.branchType === 'false') {
      nodeBranchSide[edge.target] = 'false';
    }
  });

  let changed = true;
  let pass = 0;
  while (changed && pass < 8) {
    changed = false;
    pass++;
    fn.edges.forEach((edge) => {
      if (edge.branchType === 'normal' || edge.branchType === 'cross_file') {
        const srcSide = nodeBranchSide[edge.source];
        const targetNode = fn.nodes.find((n) => n.id === edge.target);
        if (srcSide && targetNode && targetNode.kind !== 'end' && !nodeBranchSide[edge.target]) {
          nodeBranchSide[edge.target] = srcSide;
          changed = true;
        }
      }
    });
  }

  let lastConditionY = null;
  let trueBranchCursorY = 0;
  let falseBranchCursorY = 0;
  let maxBranchY = 0;

  visibleNodes.forEach((node) => {
    const side = nodeBranchSide[node.id];
    if (node.kind === 'condition') {
      if (maxBranchY > 0) {
        currentY = Math.max(currentY, maxBranchY + verticalGap);
      }
      positions[node.id] = { x: centerX, y: currentY };
      lastConditionY = currentY;
      trueBranchCursorY = currentY + verticalGap;
      falseBranchCursorY = currentY + verticalGap;
      parentConditionY[node.id] = currentY;
      currentY += verticalGap;
    } else if (side === 'true' && lastConditionY !== null) {
      positions[node.id] = { x: centerX - 210, y: trueBranchCursorY };
      maxBranchY = Math.max(maxBranchY, trueBranchCursorY);
      trueBranchCursorY += verticalGap;
    } else if (side === 'false' && lastConditionY !== null) {
      positions[node.id] = { x: centerX + 210, y: falseBranchCursorY };
      maxBranchY = Math.max(maxBranchY, falseBranchCursorY);
      falseBranchCursorY += verticalGap;
    } else {
      if (maxBranchY > 0) {
        currentY = Math.max(currentY, maxBranchY + verticalGap);
        maxBranchY = 0;
        lastConditionY = null;
      }
      positions[node.id] = { x: centerX, y: currentY };
      currentY += verticalGap;
    }
  });

  return { positions, visibleNodes, visibleEdges };
}

function getNodePalette(kind, isSelected, isActiveStep, isVisited) {
  if (isActiveStep) {
    return {
      bg: '#102a24',
      border: '#34d399',
      badgeBg: '#059669',
      badgeText: '#ecfdf5',
      text: '#ffffff',
    };
  }
  if (isSelected) {
    return {
      bg: '#1e1b4b',
      border: '#818cf8',
      badgeBg: '#4f46e5',
      badgeText: '#e0e7ff',
      text: '#ffffff',
    };
  }
  switch (kind) {
    case 'start':
    case 'end':
      return {
        bg: '#16181d',
        border: isVisited ? '#34d399' : '#3f3f46',
        badgeBg: '#27272a',
        badgeText: '#d4d4d8',
        text: '#e4e4e7',
      };
    case 'condition':
      return {
        bg: '#231c12',
        border: isVisited ? '#fbbf24' : '#b45309',
        badgeBg: '#d97706',
        badgeText: '#fffbeb',
        text: '#fef3c7',
      };
    case 'loop':
      return {
        bg: '#1d162b',
        border: isVisited ? '#a78bfa' : '#6d28d9',
        badgeBg: '#7c3aed',
        badgeText: '#f5f3ff',
        text: '#ede9fe',
      };
    case 'call':
      return {
        bg: '#112229',
        border: isVisited ? '#22d3ee' : '#0e7490',
        badgeBg: '#0891b2',
        badgeText: '#ecfeff',
        text: '#cffafe',
      };
    case 'return':
      return {
        bg: '#0f241d',
        border: isVisited ? '#34d399' : '#047857',
        badgeBg: '#059669',
        badgeText: '#ecfdf5',
        text: '#d1fae5',
      };
    case 'exception':
      return {
        bg: '#2a1218',
        border: '#f43f5e',
        badgeBg: '#e11d48',
        badgeText: '#fff1f2',
        text: '#ffe4e6',
      };
    default:
      return {
        bg: '#18191e',
        border: isVisited ? '#60a5fa' : '#2e3039',
        badgeBg: '#272932',
        badgeText: '#a1a1aa',
        text: '#e4e4e7',
      };
  }
}

// Render Center Pane (Breadcrumbs, Sub-Toolbar, SVG Map or Alt Views, Debugger Bar)
function renderCenterPane() {
  const project = state.project;
  const activeFile = getActiveFile();
  const activeFunction = getActiveFunction();
  if (!project || !activeFile) return;

  // Breadcrumbs
  const crumbs = [
    { label: project.name, mode: 'architecture' },
    { label: activeFile.path, file: activeFile.path },
  ];
  if (activeFunction) {
    crumbs.push({
      label: `${activeFunction.name}()`,
      file: activeFile.path,
      functionName: activeFunction.name,
    });
  }
  if (state.selectedNode && state.selectedNode.kind !== 'function') {
    crumbs.push({
      label: state.selectedNode.label,
      file: activeFile.path,
      functionName: activeFunction?.name,
    });
  }

  const breadBar = document.getElementById('breadcrumbs-bar');
  if (breadBar) {
    breadBar.innerHTML = crumbs
      .map(
        (c, idx) => `
        <span class="flex items-center gap-1 shrink-0">
          ${idx > 0 ? '<span class="text-zinc-600">/</span>' : ''}
          <button
            type="button"
            data-crumb-idx="${idx}"
            class="px-2 py-0.5 rounded-md font-mono transition-colors ${
              idx === crumbs.length - 1
                ? 'bg-blue-500/15 text-blue-300 border border-blue-500/30 font-medium'
                : 'text-zinc-400 hover:text-white hover:bg-white/[0.06]'
            }"
          >
            ${escapeHtml(c.label)}
          </button>
        </span>
      `
      )
      .join('');

    breadBar.querySelectorAll('[data-crumb-idx]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = Number(btn.getAttribute('data-crumb-idx'));
        const crumb = crumbs[idx];
        if (!crumb) return;
        if (idx === 0) {
          setViewMode('architecture');
        } else if (crumb.file) {
          state.viewMode = 'flow';
          navigateToFileFunction(crumb.file, crumb.functionName);
        }
      });
    });
  }

  // Sub-view buttons
  document.querySelectorAll('.sub-view-btn').forEach((btn) => {
    const mode = btn.getAttribute('data-sub-view');
    if (mode === state.viewMode) {
      btn.className =
        'sub-view-btn px-2.5 py-1 rounded-md text-xs font-medium bg-blue-500/20 text-blue-300 border border-blue-500/40';
    } else {
      btn.className =
        'sub-view-btn px-2.5 py-1 rounded-md text-xs font-medium text-zinc-400 hover:text-zinc-200';
    }
  });

  // Kind filter buttons
  document.querySelectorAll('.kind-filter-btn').forEach((btn) => {
    const filter = btn.getAttribute('data-kind-filter');
    if (filter === state.kindFilter) {
      btn.className =
        'kind-filter-btn px-2 py-1 rounded text-[11px] font-medium bg-white/10 text-white';
    } else {
      btn.className =
        'kind-filter-btn px-2 py-1 rounded text-[11px] font-medium text-zinc-400 hover:text-zinc-200';
    }
  });

  const svgWrapper = document.getElementById('flow-svg-wrapper');
  const altView = document.getElementById('alt-map-view');
  const camControls = document.getElementById('camera-controls');
  const zoomLabel = document.getElementById('zoom-label');
  if (zoomLabel) zoomLabel.textContent = `${Math.round(state.zoom * 100)}%`;

  if (state.viewMode === 'flow') {
    svgWrapper?.classList.remove('hidden');
    camControls?.classList.remove('hidden');
    altView?.classList.add('hidden');
    renderFlowSvg();
  } else {
    svgWrapper?.classList.add('hidden');
    camControls?.classList.add('hidden');
    altView?.classList.remove('hidden');
    renderAltMapView();
  }

  renderDebuggerBar();
}

function renderFlowSvg() {
  const svg = document.getElementById('map-svg');
  const activeFunction = getActiveFunction();
  if (!svg || !activeFunction) return;

  const trace = getTraceResult();
  const activeStep = trace.steps[state.currentStepIndex] || null;
  const visitedNodeSet = new Set(
    trace.steps.slice(0, state.currentStepIndex + 1).map((s) => s.nodeId)
  );
  const visitedEdgeSet = new Set(trace.visitedEdgeIds);

  const { positions, visibleNodes, visibleEdges } = computeFlowLayout(
    activeFunction,
    state.collapsedNodes,
    state.kindFilter
  );

  const edgesSvg = visibleEdges
    .map((edge) => {
      const src = positions[edge.source];
      const tgt = positions[edge.target];
      if (!src || !tgt) return '';

      const isBackEdge = edge.branchType === 'loop_back' || tgt.y < src.y;
      const isVisited =
        visitedEdgeSet.has(edge.id) &&
        visitedNodeSet.has(edge.source) &&
        visitedNodeSet.has(edge.target);

      let strokeColor = '#3f3f46';
      let markerUrl = 'url(#arrow-default)';

      if (edge.branchType === 'true') {
        strokeColor = isVisited ? '#34d399' : '#059669';
        markerUrl = 'url(#arrow-true)';
      } else if (edge.branchType === 'false') {
        strokeColor = isVisited ? '#fbbf24' : '#b45309';
        markerUrl = 'url(#arrow-false)';
      } else if (edge.branchType === 'loop_back') {
        strokeColor = '#a78bfa';
        markerUrl = 'url(#arrow-loop)';
      } else if (edge.branchType === 'cross_file') {
        strokeColor = '#22d3ee';
        markerUrl = 'url(#arrow-call)';
      } else if (edge.branchType === 'exception') {
        strokeColor = '#f43f5e';
        markerUrl = 'url(#arrow-exception)';
      } else if (isVisited) {
        strokeColor = '#34d399';
        markerUrl = 'url(#arrow-true)';
      }

      let pathD = '';
      let labelX = (src.x + tgt.x) / 2;
      let labelY = (src.y + tgt.y) / 2;

      if (isBackEdge) {
        const rightCurveX = Math.max(src.x, tgt.x) + 190;
        pathD = `M ${src.x + 120} ${src.y} C ${rightCurveX} ${src.y}, ${rightCurveX} ${tgt.y}, ${tgt.x + 120} ${tgt.y}`;
        labelX = rightCurveX - 24;
        labelY = (src.y + tgt.y) / 2;
      } else {
        const startY = src.y + 32;
        const endY = tgt.y - 32;
        const midY = (startY + endY) / 2;
        pathD = `M ${src.x} ${startY} C ${src.x} ${midY}, ${tgt.x} ${midY}, ${tgt.x} ${endY}`;
      }

      return `
        <g>
          <path
            d="${pathD}"
            fill="none"
            stroke="${strokeColor}"
            stroke-width="${isVisited ? 2.5 : 1.75}"
            class="${isVisited ? 'animate-flow-edge' : ''}"
            marker-end="${markerUrl}"
          />
          ${
            edge.label
              ? `<g transform="translate(${labelX}, ${labelY})">
                  <rect x="-36" y="-10" width="72" height="20" rx="5" fill="#121317" stroke="${strokeColor}" stroke-width="1"></rect>
                  <text text-anchor="middle" dy="4" fill="${strokeColor}" font-size="10" font-family="JetBrains Mono, monospace" font-weight="600">
                    ${escapeHtml(edge.label)}
                  </text>
                </g>`
              : ''
          }
        </g>
      `;
    })
    .join('');

  const nodesSvg = visibleNodes
    .map((node) => {
      const pos = positions[node.id];
      if (!pos) return '';

      const isSelected = state.selectedNode && state.selectedNode.id === node.id;
      const isActiveStep = activeStep && activeStep.nodeId === node.id;
      const isVisited = visitedNodeSet.has(node.id);
      const palette = getNodePalette(node.kind, isSelected, isActiveStep, isVisited);
      const isCollapsible = node.kind === 'condition' || node.kind === 'loop';
      const isCollapsed = state.collapsedNodes.has(node.id);
      const loopIterations = trace.loopCounts[node.id] || 0;

      const labelStr =
        node.label.length > 30 ? `${node.label.slice(0, 28)}...` : node.label;

      return `
        <g
          transform="translate(${pos.x - 130}, ${pos.y - 30})"
          data-node-id="${escapeHtml(node.id)}"
          class="cursor-pointer"
        >
          <rect
            width="260"
            height="60"
            rx="${node.kind === 'start' || node.kind === 'end' ? 30 : 12}"
            fill="${palette.bg}"
            stroke="${palette.border}"
            stroke-width="${isSelected || isActiveStep ? 2.5 : 1.5}"
          />
          <rect
            x="12"
            y="10"
            width="68"
            height="16"
            rx="4"
            fill="${palette.badgeBg}"
          />
          <text
            x="46"
            y="21"
            text-anchor="middle"
            fill="${palette.badgeText}"
            font-size="9"
            font-family="JetBrains Mono, monospace"
            font-weight="600"
          >
            ${escapeHtml(node.kind.toUpperCase())}
          </text>
          <text
            x="246"
            y="21"
            text-anchor="end"
            fill="#71717a"
            font-size="10"
            font-family="JetBrains Mono, monospace"
          >
            L${node.location.startLine}
          </text>
          <text
            x="14"
            y="43"
            fill="${palette.text}"
            font-size="12"
            font-family="JetBrains Mono, monospace"
            font-weight="500"
          >
            ${escapeHtml(labelStr)}
          </text>
          ${
            loopIterations > 0
              ? `<g transform="translate(190, -10)">
                  <rect width="66" height="18" rx="9" fill="#6d28d9" stroke="#a78bfa" />
                  <text x="33" y="12" text-anchor="middle" fill="#ffffff" font-size="9" font-family="JetBrains Mono, monospace" font-weight="700">
                    ${loopIterations}x iter
                  </text>
                </g>`
              : ''
          }
          ${
            node.callTarget && node.callTarget.targetFile
              ? `<g transform="translate(175, 32)" data-call-portal="${escapeHtml(node.id)}">
                  <rect width="74" height="20" rx="5" fill="#083344" stroke="#06b6d4" stroke-width="1" />
                  <text x="37" y="13" text-anchor="middle" fill="#67e8f9" font-size="9.5" font-family="JetBrains Mono, monospace" font-weight="600">
                    Jump ↗
                  </text>
                </g>`
              : ''
          }
          ${
            isCollapsible
              ? `<g transform="translate(234, 34)" data-collapse-node="${escapeHtml(node.id)}">
                  <rect width="18" height="18" rx="4" fill="#27272a" stroke="#52525b" />
                  <text x="9" y="13" text-anchor="middle" fill="#e4e4e7" font-size="11" font-family="JetBrains Mono, monospace">
                    ${isCollapsed ? '+' : '−'}
                  </text>
                </g>`
              : ''
          }
        </g>
      `;
    })
    .join('');

  svg.innerHTML = `
    <defs>
      <marker id="arrow-default" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
        <path d="M 0 1 L 10 5 L 0 9 z" fill="#52525b" />
      </marker>
      <marker id="arrow-true" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
        <path d="M 0 1 L 10 5 L 0 9 z" fill="#34d399" />
      </marker>
      <marker id="arrow-false" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
        <path d="M 0 1 L 10 5 L 0 9 z" fill="#fbbf24" />
      </marker>
      <marker id="arrow-loop" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
        <path d="M 0 1 L 10 5 L 0 9 z" fill="#a78bfa" />
      </marker>
      <marker id="arrow-call" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
        <path d="M 0 1 L 10 5 L 0 9 z" fill="#22d3ee" />
      </marker>
      <marker id="arrow-exception" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
        <path d="M 0 1 L 10 5 L 0 9 z" fill="#f43f5e" />
      </marker>
    </defs>
    <g transform="translate(${state.pan.x}, ${state.pan.y}) scale(${state.zoom})">
      ${edgesSvg}
      ${nodesSvg}
    </g>
  `;

  // Bind SVG node interactions
  svg.querySelectorAll('[data-node-id]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const nodeId = el.getAttribute('data-node-id');
      const node = activeFunction.nodes.find((n) => n.id === nodeId);
      if (node) {
        state.selectedNode = node;
        renderCenterPane();
        renderRightPane();
      }
    });
  });

  svg.querySelectorAll('[data-call-portal]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const nodeId = el.getAttribute('data-call-portal');
      const node = activeFunction.nodes.find((n) => n.id === nodeId);
      if (node && node.callTarget && node.callTarget.targetFile) {
        navigateToFileFunction(node.callTarget.targetFile, node.callTarget.functionName);
      }
    });
  });

  svg.querySelectorAll('[data-collapse-node]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const nodeId = el.getAttribute('data-collapse-node');
      if (!nodeId) return;
      if (state.collapsedNodes.has(nodeId)) {
        state.collapsedNodes.delete(nodeId);
      } else {
        state.collapsedNodes.add(nodeId);
      }
      renderFlowSvg();
    });
  });
}

function renderAltMapView() {
  const container = document.getElementById('alt-map-view');
  const project = state.project;
  const activeFile = getActiveFile();
  if (!container || !project || !activeFile) return;

  if (state.viewMode === 'architecture') {
    container.innerHTML = `
      <div class="max-w-5xl mx-auto space-y-6">
        <div class="flex items-center justify-between">
          <div>
            <h2 class="text-base font-semibold text-white">High-Level Repository Architecture Map</h2>
            <p class="text-xs text-zinc-400">Click any file or function card to drill down into its interactive Control-Flow Graph.</p>
          </div>
          <span class="px-2.5 py-1 rounded-md text-xs font-mono bg-blue-500/10 text-blue-300 border border-blue-500/20">
            ${project.files.length} Files · ${project.dependencies.length} Cross-File Links
          </span>
        </div>
        <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          ${project.files
            .map((file) => {
              const isEntry = project.entryPoints.some((ep) => ep.file === file.path);
              return `
                <div class="p-4 rounded-xl border bg-[#15161b] ${
                  file.path === activeFile.path
                    ? 'border-blue-500/60 shadow-lg shadow-blue-500/5'
                    : 'border-white/[0.08] hover:border-white/20'
                } transition-all flex flex-col justify-between">
                  <div>
                    <div class="flex items-center justify-between gap-2 mb-2">
                      <span class="font-mono text-xs font-semibold text-white truncate">${escapeHtml(file.path)}</span>
                      <div class="flex items-center gap-1.5">
                        ${
                          isEntry
                            ? '<span class="px-1.5 py-0.5 text-[10px] font-mono rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">ENTRY</span>'
                            : ''
                        }
                        <span class="px-1.5 py-0.5 text-[10px] font-mono rounded bg-white/[0.06] text-zinc-300 uppercase">${escapeHtml(file.language)}</span>
                      </div>
                    </div>
                    <p class="text-xs text-zinc-400 mb-3 line-clamp-2">${escapeHtml(file.summary)}</p>
                    <div class="space-y-1.5">
                      <div class="text-[10px] font-mono uppercase tracking-wider text-zinc-500">Functions (${file.functions.length})</div>
                      <div class="flex flex-wrap gap-1.5">
                        ${file.functions
                          .map(
                            (fn) => `
                            <button
                              type="button"
                              data-arch-file="${escapeHtml(file.path)}"
                              data-arch-fn="${escapeHtml(fn.name)}"
                              class="px-2 py-1 rounded-md text-xs font-mono bg-[#1e2028] hover:bg-blue-500/20 text-zinc-200 hover:text-blue-300 border border-white/[0.06] transition-colors"
                            >
                              ${escapeHtml(fn.name)}()
                            </button>
                          `
                          )
                          .join('')}
                      </div>
                    </div>
                  </div>
                  <div class="mt-4 pt-2.5 border-t border-white/[0.06] flex items-center justify-between text-[11px] text-zinc-500 font-mono">
                    <span>${file.imports.length} imports</span>
                    <button
                      type="button"
                      data-arch-file="${escapeHtml(file.path)}"
                      class="text-blue-400 hover:text-blue-300"
                    >
                      Open Flow →
                    </button>
                  </div>
                </div>
              `;
            })
            .join('')}
        </div>
      </div>
    `;

    container.querySelectorAll('[data-arch-file]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const f = btn.getAttribute('data-arch-file');
        const fn = btn.getAttribute('data-arch-fn') || undefined;
        if (f) {
          state.viewMode = 'flow';
          navigateToFileFunction(f, fn);
        }
      });
    });
    return;
  }

  if (state.viewMode === 'dependencies') {
    container.innerHTML = `
      <div class="max-w-4xl mx-auto space-y-5">
        <div>
          <h2 class="text-base font-semibold text-white">Cross-File Call & Dependency Graph</h2>
          <p class="text-xs text-zinc-400">Direct module imports and cross-file function invocations detected via static analysis.</p>
        </div>
        <div class="space-y-2.5">
          ${project.dependencies
            .map(
              (dep) => `
              <div class="p-3.5 rounded-xl bg-[#15161b] border border-white/[0.08] flex flex-wrap items-center justify-between gap-4">
                <div class="flex items-center gap-3 font-mono text-xs">
                  <button
                    type="button"
                    data-dep-file="${escapeHtml(dep.sourceFile)}"
                    class="px-2.5 py-1 rounded-md bg-white/[0.05] hover:bg-white/10 text-zinc-200"
                  >
                    ${escapeHtml(dep.sourceFile)}
                  </button>
                  <span class="text-cyan-400 font-semibold">─── ${escapeHtml(dep.symbols.join(', '))} ──▶</span>
                  <button
                    type="button"
                    data-dep-file="${escapeHtml(dep.targetFile)}"
                    class="px-2.5 py-1 rounded-md bg-cyan-500/15 hover:bg-cyan-500/25 text-cyan-300 border border-cyan-500/30"
                  >
                    ${escapeHtml(dep.targetFile)}
                  </button>
                </div>
                <span class="text-[11px] font-mono text-zinc-400 uppercase px-2 py-0.5 rounded bg-white/[0.04]">
                  ${escapeHtml(dep.type)}
                </span>
              </div>
            `
            )
            .join('')}
        </div>
      </div>
    `;

    container.querySelectorAll('[data-dep-file]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const f = btn.getAttribute('data-dep-file');
        if (f) {
          state.viewMode = 'flow';
          navigateToFileFunction(f);
        }
      });
    });
    return;
  }

  if (state.viewMode === 'trace') {
    const trace = getTraceResult();
    container.innerHTML = `
      <div class="max-w-4xl mx-auto space-y-4">
        <div class="flex items-center justify-between">
          <div>
            <h2 class="text-base font-semibold text-white">Complete Execution Trace Sequence</h2>
            <p class="text-xs text-zinc-400">Deterministic sandboxed trace across files, branches, loops, and variable mutations.</p>
          </div>
          <span class="px-2.5 py-1 rounded-md text-xs font-mono bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
            ${trace.steps.length} Executed Steps
          </span>
        </div>
        <div class="space-y-2">
          ${trace.steps
            .map((step, idx) => {
              const isCurrent = idx === state.currentStepIndex;
              return `
                <button
                  type="button"
                  data-trace-step="${idx}"
                  class="w-full text-left p-3 rounded-xl border transition-all flex items-center justify-between gap-4 ${
                    isCurrent
                      ? 'bg-emerald-950/30 border-emerald-500/60 text-white'
                      : 'bg-[#15161b] border-white/[0.07] text-zinc-300 hover:border-white/20'
                  }"
                >
                  <div class="flex items-center gap-3 min-w-0">
                    <span class="px-2 py-0.5 rounded text-xs font-mono bg-white/[0.07] text-zinc-300">
                      #${step.stepIndex + 1}
                    </span>
                    <span class="font-mono text-xs text-blue-300 shrink-0">
                      ${escapeHtml(step.file)}:${step.line}
                    </span>
                    <span class="font-mono text-xs font-semibold truncate">
                      ${escapeHtml(step.label)}
                    </span>
                  </div>
                  <div class="text-xs text-zinc-400 font-mono truncate max-w-md">
                    ${escapeHtml(step.explanation)}
                  </div>
                </button>
              `;
            })
            .join('')}
        </div>
      </div>
    `;

    container.querySelectorAll('[data-trace-step]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = Number(btn.getAttribute('data-trace-step'));
        stepToIndex(idx);
      });
    });
  }
}

function renderDebuggerBar() {
  const trace = getTraceResult();
  const activeStep = trace.steps[state.currentStepIndex] || null;

  const playBtn = document.getElementById('trace-play-btn');
  if (playBtn) {
    playBtn.textContent = state.isPlaying ? 'Pause' : 'Play Trace';
  }

  const stepLabel = document.getElementById('trace-step-label');
  if (stepLabel) {
    stepLabel.textContent = `Step ${Math.min(state.currentStepIndex + 1, Math.max(trace.steps.length, 1))} / ${Math.max(trace.steps.length, 1)}`;
  }

  const slider = document.getElementById('trace-slider');
  if (slider) {
    slider.max = String(Math.max(trace.steps.length - 1, 0));
    slider.value = String(state.currentStepIndex);
  }

  const summary = document.getElementById('trace-status-summary');
  if (summary) {
    let html = '';
    if (activeStep && activeStep.branchDecision) {
      html += `
        <span class="px-2 py-0.5 rounded ${
          activeStep.branchDecision === 'TRUE'
            ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
            : 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
        }">
          Branch: ${escapeHtml(activeStep.branchDecision)}
        </span>
      `;
    }
    if (trace.error) {
      html += `
        <span class="px-2 py-0.5 rounded bg-rose-500/20 text-rose-300 border border-rose-500/30">
          ${escapeHtml(trace.error.type)} @ L${trace.error.line}
        </span>
      `;
    } else if (trace.finalOutput !== undefined) {
      html += `
        <span class="px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
          Output: ${escapeHtml(JSON.stringify(trace.finalOutput))}
        </span>
      `;
    }
    summary.innerHTML = html;
  }
}

// Build static fallback explanation for any selected node
function buildStaticNodeExplanation(node, activeFile, activeStep) {
  if (!node) return null;
  return {
    nodeId: node.id,
    provenance: activeStep ? 'runtime_observed' : 'static_proven',
    whatItDoes: node.description || `Executes ${node.kind} statement "${node.label}".`,
    whyItExists:
      node.kind === 'condition'
        ? `Controls program branching based on whether "${node.expression}" evaluates to TRUE or FALSE.`
        : node.kind === 'loop'
          ? `Repeatedly iterates over "${node.expression}" and updates accumulator state on each cycle.`
          : node.kind === 'call'
            ? `Delegates logic to ${node.callTarget?.functionName || node.label}${
                node.callTarget?.targetFile ? ` in ${node.callTarget.targetFile}` : ''
              }.`
            : node.kind === 'return'
              ? `Terminates the current function path and returns ${node.expression || 'a value'} to the caller.`
              : `Performs a sequential step inside ${node.functionName || activeFile.name}.`,
    inputs:
      node.variablesRead.length > 0
        ? node.variablesRead
        : ['Current function scope parameters'],
    outputs:
      node.variablesWritten.length > 0
        ? node.variablesWritten.map((v) => `Mutates variable "${v}"`)
        : node.kind === 'condition'
          ? ['Selects TRUE or FALSE execution branch']
          : ['Advances control flow to next node'],
    dependencies: node.callTarget
      ? [
          `${node.callTarget.functionName}() ${
            node.callTarget.targetFile ? `(${node.callTarget.targetFile})` : '(same file)'
          }`,
        ]
      : activeFile.imports.length > 0
        ? activeFile.imports
        : ['No external module dependencies'],
    possiblePaths:
      node.kind === 'condition'
        ? [
            `If (${node.expression}) is TRUE → executes True branch`,
            `If (${node.expression}) is FALSE → executes False / Else branch`,
          ]
        : ['Sequential flow to next statement in control-flow graph'],
    beginnerExplanation:
      node.kind === 'condition'
        ? `Think of this as a fork in the road: the program checks if "${node.expression}" is true. Depending on the answer, it takes one of two paths.`
        : node.kind === 'call'
          ? `Here the program pauses this file and jumps into another helper function (${node.label}) to do a specific job, then brings the answer back.`
          : `This step runs line ${node.location.startLine} of ${activeFile.name} and updates the program's working variables.`,
    confidenceNote: activeStep
      ? '100% Proven by Static AST Analysis + Observed in Sandboxed Execution Trace'
      : '100% Proven by Static AST & Control-Flow Graph Analysis',
  };
}

async function requestDeepGeminiNodeExplanation() {
  const node = state.selectedNode;
  const activeFile = getActiveFile();
  const project = state.project;
  if (!node || !activeFile || !project) return;

  const trace = getTraceResult();
  const activeStep = trace.steps[state.currentStepIndex] || null;

  state.isGeneratingAI = true;
  state.aiError = null;
  renderRightPane();

  try {
    const response = await fetch('/api/ai/explain-node', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        node,
        fileContent: activeFile.content,
        projectSummary: `${project.name}: ${project.description}`,
        runtimeObserved: activeStep ? activeStep.variables : null,
      }),
    });
    const data = await response.json();
    if (!response.ok) {
      state.aiError = data.error || 'Gemini API explanation unavailable.';
    } else {
      state.aiExplanations[node.id] = data;
    }
  } catch (err) {
    state.aiError = err instanceof Error ? err.message : 'Network error calling Gemini API';
  } finally {
    state.isGeneratingAI = false;
    renderRightPane();
  }
}

async function sendRepoChatMessage(question) {
  const project = state.project;
  const activeFile = getActiveFile();
  if (!project || !question.trim()) return;

  state.chatMessages.push({ role: 'user', text: question.trim() });
  state.isChatLoading = true;
  renderRightPane();

  const trace = getTraceResult();
  try {
    const projectContext = project.files
      .map(
        (f) =>
          `File ${f.path} (${f.language}):\nFunctions: ${f.functions
            .map((fn) => `${fn.name}(${fn.parameters.join(', ')}) [L${fn.startLine}-L${fn.endLine}]`)
            .join(', ')}\nContent:\n${f.content}`
      )
      .join('\n\n---\n\n');

    const response = await fetch('/api/ai/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question: question.trim(),
        projectContext,
        activeFile: activeFile?.path,
        activeNode: state.selectedNode
          ? `${state.selectedNode.label} (L${state.selectedNode.location.startLine})`
          : null,
        traceSummary: `Executed ${trace.steps.length} steps. Final output: ${JSON.stringify(
          trace.finalOutput
        )}. Error: ${trace.error ? trace.error.message : 'None'}`,
      }),
    });
    const data = await response.json();
    if (!response.ok) {
      const qLower = question.toLowerCase();
      const matchedFiles = project.files.filter(
        (f) =>
          f.path.toLowerCase().includes(qLower) || f.content.toLowerCase().includes(qLower)
      );
      const fallbackReply =
        matchedFiles.length > 0
          ? `[Proven by Static Analysis] Found relevant logic in ${matchedFiles
              .map((f) => `${f.path}`)
              .join(', ')}. (${data.error || 'Live AI key not set'})`
          : `[Proven by Static Analysis] Entry point starts at ${
              project.entryPoints[0]?.file || project.files[0]?.path
            } in ${
              project.entryPoints[0]?.functionName || 'main'
            }(). It connects across ${project.dependencies.length} module dependencies.`;
      state.chatMessages.push({ role: 'assistant', text: fallbackReply });
    } else {
      state.chatMessages.push({ role: 'assistant', text: data.answer });
    }
  } catch {
    state.chatMessages.push({
      role: 'assistant',
      text: '[Proven by Static Analysis] Unable to reach AI server; use the symbol search or click any node to inspect its static control flow.',
    });
  } finally {
    state.isChatLoading = false;
    renderRightPane();
  }
}

// Render Right Pane (Code, Explain & AI, Inputs & State, AI Chat)
function renderRightPane() {
  const container = document.getElementById('right-panel-body');
  const project = state.project;
  const activeFile = getActiveFile();
  const activeFunction = getActiveFunction();
  if (!container || !project || !activeFile) return;

  // Update tab buttons
  document.querySelectorAll('.right-tab-btn').forEach((btn) => {
    const tab = btn.getAttribute('data-right-tab');
    if (tab === state.rightTab) {
      btn.className =
        'right-tab-btn px-3 py-2 text-xs font-medium rounded-t-lg border-b-2 border-blue-400 text-white bg-[#1b1c22]';
    } else {
      btn.className =
        'right-tab-btn px-3 py-2 text-xs font-medium rounded-t-lg border-b-2 border-transparent text-zinc-400 hover:text-zinc-200';
    }
  });

  const trace = getTraceResult();
  const activeStep = trace.steps[state.currentStepIndex] || null;

  if (state.rightTab === 'code') {
    const codeLines = activeFile.content.split('\n');
    container.innerHTML = `
      <div class="p-3">
        <div class="flex items-center justify-between mb-2 px-1">
          <div class="flex items-center gap-2">
            <span class="font-mono text-xs font-semibold text-white">${escapeHtml(activeFile.path)}</span>
            <span class="px-1.5 py-0.5 text-[10px] font-mono rounded bg-white/[0.06] text-zinc-400 uppercase">
              ${escapeHtml(activeFile.language)}
            </span>
          </div>
          <span class="text-[11px] text-zinc-500">Click any line to highlight node</span>
        </div>
        <div class="rounded-xl bg-[#0c0d10] border border-white/[0.07] overflow-hidden font-mono text-xs">
          ${codeLines
            .map((lineText, idx) => {
              const lineNumber = idx + 1;
              const isSelectedNodeLine =
                state.selectedNode &&
                state.selectedNode.file === activeFile.path &&
                lineNumber >= state.selectedNode.location.startLine &&
                lineNumber <= state.selectedNode.location.endLine;
              const isActiveTraceLine =
                activeStep &&
                activeStep.file === activeFile.path &&
                activeStep.line === lineNumber;

              return `
                <button
                  type="button"
                  data-code-line="${lineNumber}"
                  class="w-full text-left flex items-start px-3 py-1 transition-colors border-l-2 ${
                    isActiveTraceLine
                      ? 'bg-emerald-500/20 border-emerald-400 text-emerald-100'
                      : isSelectedNodeLine
                        ? 'bg-blue-500/20 border-blue-400 text-white'
                        : 'border-transparent text-zinc-300 hover:bg-white/[0.04]'
                  }"
                >
                  <span class="w-8 shrink-0 text-right pr-3 text-zinc-600 select-none tabular-nums">
                    ${lineNumber}
                  </span>
                  <span class="whitespace-pre overflow-x-auto">${escapeHtml(lineText || ' ')}</span>
                </button>
              `;
            })
            .join('')}
        </div>
      </div>
    `;

    container.querySelectorAll('[data-code-line]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const line = Number(btn.getAttribute('data-code-line'));
        selectNodeByLine(line);
      });
    });
    return;
  }

  if (state.rightTab === 'inspector') {
    const node = state.selectedNode;
    const explanation =
      (node && state.aiExplanations[node.id]) ||
      buildStaticNodeExplanation(node, activeFile, activeStep);

    if (!node || !explanation) {
      container.innerHTML = `<div class="p-4 text-xs text-zinc-500">Select any node on the visual map to inspect its execution details.</div>`;
      return;
    }

    const provBadge =
      explanation.provenance === 'static_proven'
        ? '<span class="px-2 py-0.5 rounded text-[10px] font-mono bg-blue-500/15 text-blue-300 border border-blue-500/30">Proven by Static Analysis</span>'
        : explanation.provenance === 'runtime_observed'
          ? '<span class="px-2 py-0.5 rounded text-[10px] font-mono bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">Observed During Execution</span>'
          : '<span class="px-2 py-0.5 rounded text-[10px] font-mono bg-amber-500/15 text-amber-300 border border-amber-500/30">AI Inference (Gemini 4 Hydrogen)</span>';

    container.innerHTML = `
      <div class="p-4 space-y-4">
        <div class="p-3.5 rounded-xl bg-[#17181f] border border-white/[0.08] space-y-2">
          <div class="flex items-center justify-between gap-2">
            <span class="px-2 py-0.5 rounded text-[10px] font-mono uppercase font-semibold bg-blue-500/20 text-blue-300 border border-blue-500/30">
              ${escapeHtml(node.kind)}
            </span>
            ${provBadge}
          </div>
          <div class="font-mono text-sm font-semibold text-white break-all">
            ${escapeHtml(node.label)}
          </div>
          <div class="text-xs text-zinc-400 font-mono">
            ${escapeHtml(node.file)} · Line ${node.location.startLine} · ${escapeHtml(node.functionName || 'module')}()
          </div>
          <div class="pt-2 flex items-center gap-2">
            <button
              type="button"
              id="ask-gemini-node-btn"
              class="px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium transition-colors"
            >
              ${state.isGeneratingAI ? 'Analyzing with Gemini...' : 'Ask Gemini 4 Hydrogen (Deep Explain)'}
            </button>
          </div>
          ${
            state.aiError
              ? `<p class="text-[11px] text-amber-300 bg-amber-950/40 border border-amber-500/30 rounded-lg p-2 mt-2">${escapeHtml(state.aiError)}</p>`
              : ''
          }
        </div>

        <div class="space-y-3 text-xs">
          <div class="p-3 rounded-xl bg-[#15161c] border border-white/[0.06]">
            <div class="text-[11px] font-mono uppercase text-zinc-400 mb-1">What It Does</div>
            <p class="text-zinc-200 leading-relaxed">${escapeHtml(explanation.whatItDoes)}</p>
          </div>

          <div class="p-3 rounded-xl bg-[#15161c] border border-white/[0.06]">
            <div class="text-[11px] font-mono uppercase text-zinc-400 mb-1">Why It Exists</div>
            <p class="text-zinc-200 leading-relaxed">${escapeHtml(explanation.whyItExists)}</p>
          </div>

          <div class="grid grid-cols-2 gap-2.5">
            <div class="p-3 rounded-xl bg-[#15161c] border border-white/[0.06]">
              <div class="text-[11px] font-mono uppercase text-zinc-400 mb-1.5">Inputs / Reads</div>
              <ul class="space-y-1 font-mono text-[11px] text-cyan-300">
                ${(explanation.inputs || []).map((inp) => `<li>• ${escapeHtml(inp)}</li>`).join('')}
              </ul>
            </div>
            <div class="p-3 rounded-xl bg-[#15161c] border border-white/[0.06]">
              <div class="text-[11px] font-mono uppercase text-zinc-400 mb-1.5">Outputs / Writes</div>
              <ul class="space-y-1 font-mono text-[11px] text-emerald-300">
                ${(explanation.outputs || []).map((out) => `<li>• ${escapeHtml(out)}</li>`).join('')}
              </ul>
            </div>
          </div>

          <div class="p-3 rounded-xl bg-[#15161c] border border-white/[0.06]">
            <div class="text-[11px] font-mono uppercase text-zinc-400 mb-1.5">Possible Execution Paths</div>
            <ul class="space-y-1 text-zinc-300 font-mono text-[11px]">
              ${(explanation.possiblePaths || []).map((p) => `<li>→ ${escapeHtml(p)}</li>`).join('')}
            </ul>
          </div>

          ${
            activeStep
              ? `<div class="p-3 rounded-xl bg-[#15161c] border border-emerald-500/25">
                  <div class="text-[11px] font-mono uppercase text-emerald-400 mb-2">
                    Live Variable State (Step #${activeStep.stepIndex + 1})
                  </div>
                  <div class="grid grid-cols-2 gap-1.5 font-mono text-[11px]">
                    ${Object.entries(activeStep.variables || {})
                      .map(
                        ([k, v]) => `
                        <div class="px-2 py-1 rounded bg-black/40 border border-white/[0.05] flex items-center justify-between">
                          <span class="text-zinc-400">${escapeHtml(k)}:</span>
                          <span class="text-emerald-300 font-semibold truncate ml-1">${escapeHtml(JSON.stringify(v))}</span>
                        </div>
                      `
                      )
                      .join('')}
                  </div>
                </div>`
              : ''
          }
        </div>
      </div>
    `;

    const geminiBtn = document.getElementById('ask-gemini-node-btn');
    if (geminiBtn) {
      geminiBtn.addEventListener('click', () => {
        requestDeepGeminiNodeExplanation();
      });
    }
    return;
  }

  if (state.rightTab === 'simulator') {
    const inputEntries = Object.entries(state.customInputs || {});
    container.innerHTML = `
      <div class="p-4 space-y-4 text-xs">
        <div class="p-3.5 rounded-xl bg-[#16171d] border border-white/[0.08] space-y-3">
          <div class="flex items-center justify-between">
            <div>
              <h3 class="font-semibold text-white text-sm">Input & Branch Simulator</h3>
              <p class="text-zinc-400 text-[11px]">Modify input parameters to test TRUE/FALSE branches, loops, and runtime exceptions.</p>
            </div>
            <button
              type="button"
              id="run-trace-sim-btn"
              class="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-semibold transition-colors"
            >
              Run Trace
            </button>
          </div>

          <div class="space-y-2 pt-2 border-t border-white/[0.06]">
            ${
              inputEntries.length > 0
                ? inputEntries
                    .map(
                      ([key, val]) => `
                      <div class="flex items-center justify-between gap-2">
                        <label for="sim-input-${escapeHtml(key)}" class="font-mono text-zinc-300">${escapeHtml(key)}</label>
                        <input
                          id="sim-input-${escapeHtml(key)}"
                          data-sim-key="${escapeHtml(key)}"
                          type="text"
                          value="${escapeHtml(typeof val === 'string' ? val : JSON.stringify(val))}"
                          class="w-44 px-2.5 py-1 rounded-lg bg-[#0e0f13] border border-white/15 font-mono text-xs text-white focus:outline-none focus:border-blue-400"
                        />
                      </div>
                    `
                    )
                    .join('')
                : `<div class="flex items-center justify-between gap-2">
                    <label for="sim-input-x" class="font-mono text-zinc-300">x</label>
                    <input
                      id="sim-input-x"
                      data-sim-key="x"
                      type="text"
                      value="15"
                      class="w-44 px-2.5 py-1 rounded-lg bg-[#0e0f13] border border-white/15 font-mono text-xs text-white focus:outline-none focus:border-blue-400"
                    />
                  </div>`
            }
          </div>
        </div>

        <div class="p-3.5 rounded-xl bg-[#15161c] border border-white/[0.07] space-y-2">
          <div class="text-[11px] font-mono uppercase text-zinc-400">Trace Outcome Summary</div>
          <div class="font-mono text-xs space-y-1">
            <div>Steps Executed: <span class="text-white">${trace.steps.length}</span></div>
            <div>Return / Output: <span class="text-emerald-400 font-semibold">${escapeHtml(JSON.stringify(trace.finalOutput ?? 'None'))}</span></div>
          </div>
        </div>
      </div>
    `;

    container.querySelectorAll('[data-sim-key]').forEach((inputEl) => {
      inputEl.addEventListener('input', () => {
        const key = inputEl.getAttribute('data-sim-key');
        if (!key) return;
        const raw = inputEl.value;
        let parsed = raw;
        if (raw === 'true') parsed = true;
        else if (raw === 'false') parsed = false;
        else if (raw.trim() !== '' && !Number.isNaN(Number(raw))) parsed = Number(raw);
        state.customInputs[key] = parsed;
      });
    });

    const runBtn = document.getElementById('run-trace-sim-btn');
    if (runBtn) {
      runBtn.addEventListener('click', () => {
        state.currentStepIndex = 0;
        renderAll();
      });
    }
    return;
  }

  if (state.rightTab === 'chat') {
    container.innerHTML = `
      <div class="p-4 flex flex-col h-full justify-between space-y-3">
        <div class="space-y-2.5 overflow-y-auto pr-1 max-h-[460px]">
          ${state.chatMessages
            .map(
              (m) => `
              <div class="p-3 rounded-xl text-xs leading-relaxed ${
                m.role === 'user'
                  ? 'bg-blue-600/20 border border-blue-500/30 text-blue-100 ml-6'
                  : 'bg-[#17181f] border border-white/[0.07] text-zinc-200 mr-4'
              }">
                <div class="text-[10px] font-mono uppercase text-zinc-400 mb-1">
                  ${m.role === 'user' ? 'You' : 'Code Visualizer AI'}
                </div>
                <div class="whitespace-pre-wrap">${escapeHtml(m.text)}</div>
              </div>
            `
            )
            .join('')}
        </div>

        <form id="repo-chat-form" class="flex items-center gap-2 pt-2 border-t border-white/[0.08]">
          <input
            type="text"
            id="repo-chat-input"
            placeholder="Ask about functions, branches, or files..."
            aria-label="Ask AI about this repository"
            class="flex-1 bg-[#0e0f13] border border-white/15 rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:border-blue-400"
          />
          <button
            type="submit"
            disabled="${state.isChatLoading ? 'true' : ''}"
            class="px-3 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold"
          >
            ${state.isChatLoading ? '...' : 'Ask'}
          </button>
        </form>
      </div>
    `;

    const chatForm = document.getElementById('repo-chat-form');
    const chatInput = document.getElementById('repo-chat-input');
    if (chatForm && chatInput) {
      chatForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const val = chatInput.value;
        if (!val.trim()) return;
        chatInput.value = '';
        sendRepoChatMessage(val);
      });
    }
  }
}

function renderAll() {
  renderWorkspaceVisibility();
  renderHistoryUI();
  if (state.project && getActiveFile()) {
    renderSidebar();
    renderSearchResults();
    renderCenterPane();
    renderRightPane();
  }
}

// Initialize DOM Event Listeners
function initApp() {
  // Fetch initial saved repositories from backend database
  fetchServerHistory();

  // Subscribe to Firebase Auth & Cloud Firestore History
  subscribeToAuth((user) => {
    state.currentUser = user;
    const authBtn = document.getElementById('cloud-auth-btn');
    if (authBtn) {
      authBtn.textContent = user
        ? `Cloud Sync: ${user.displayName || user.email || 'Active'} (Sign Out)`
        : 'Cloud Sync (Sign In)';
    }
    if (state.unsubscribeCloud) {
      state.unsubscribeCloud();
      state.unsubscribeCloud = null;
    }
    if (user) {
      state.unsubscribeCloud = subscribeToCloudRepoHistory(user, (cloudItems) => {
        state.cloudHistory = cloudItems;
        renderHistoryUI();
      });
    } else {
      state.cloudHistory = [];
      renderHistoryUI();
    }
  });

  // Cloud Sign-In / Sign-Out button
  document.getElementById('cloud-auth-btn')?.addEventListener('click', async () => {
    try {
      if (state.currentUser) {
        await signOutUser();
      } else {
        await signInWithGoogle();
      }
    } catch (err) {
      console.error('Auth action error:', err);
    }
  });

  // Top bar Brand link
  document.getElementById('brand-link')?.addEventListener('click', (e) => {
    e.preventDefault();
    if (state.project) {
      setViewMode('flow');
    } else {
      openImportModalWithFade();
    }
  });

  // Top navigation buttons (Architecture, Execution Flow, Dependencies, Trace Steps, History)
  document.querySelectorAll('.nav-view-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const mode = btn.getAttribute('data-nav-view');
      if (!mode) return;
      if (mode === 'history') {
        closeImportModal();
        setViewMode('history');
        return;
      }
      if (!state.project) {
        openImportModalWithFade();
        return;
      }
      setViewMode(mode);
    });
  });

  // Sub-toolbar view mode buttons
  document.querySelectorAll('.sub-view-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const mode = btn.getAttribute('data-sub-view');
      if (mode) setViewMode(mode);
    });
  });

  // Sub-toolbar kind filter buttons
  document.querySelectorAll('.kind-filter-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const f = btn.getAttribute('data-kind-filter');
      if (f) {
        state.kindFilter = f;
        renderCenterPane();
      }
    });
  });

  // Right pane tabs
  document.querySelectorAll('.right-tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tab = btn.getAttribute('data-right-tab');
      if (tab) {
        state.rightTab = tab;
        renderRightPane();
      }
    });
  });

  // Open Import Modal buttons
  document.getElementById('header-import-btn')?.addEventListener('click', openImportModalWithFade);
  document.getElementById('empty-import-btn')?.addEventListener('click', openImportModalWithFade);
  document.getElementById('sidebar-import-btn')?.addEventListener('click', openImportModalWithFade);
  document.getElementById('history-new-import-btn')?.addEventListener('click', openImportModalWithFade);

  // Open History Tab buttons
  const goToHistoryTab = () => {
    closeImportModal();
    setViewMode('history');
  };
  document.getElementById('empty-history-btn')?.addEventListener('click', goToHistoryTab);
  document.getElementById('sidebar-history-btn')?.addEventListener('click', goToHistoryTab);
  document.getElementById('modal-open-full-history-btn')?.addEventListener('click', goToHistoryTab);

  // Close Import Modal button
  document.getElementById('close-import-modal-btn')?.addEventListener('click', closeImportModal);

  // Global Symbol Search input
  const searchInput = document.getElementById('global-search-input');
  searchInput?.addEventListener('input', (e) => {
    state.searchQuery = e.target.value || '';
    renderSearchResults();
  });

  // Entry Point selector
  const epSelect = document.getElementById('entry-point-select');
  epSelect?.addEventListener('change', (e) => {
    const val = e.target.value;
    state.selectedEntryPointId = val;
    if (state.project) {
      const ep = state.project.entryPoints.find((item) => item.id === val);
      if (ep) {
        navigateToFileFunction(ep.file, ep.functionName);
      }
    }
  });

  // SVG Map Pan & Zoom
  const svgWrapper = document.getElementById('flow-svg-wrapper');
  svgWrapper?.addEventListener('mousedown', (e) => {
    if (e.target.closest('[data-node-id]')) return;
    state.isDraggingCanvas = true;
    state.dragOrigin = { x: e.clientX - state.pan.x, y: e.clientY - state.pan.y };
  });
  window.addEventListener('mousemove', (e) => {
    if (!state.isDraggingCanvas) return;
    state.pan = { x: e.clientX - state.dragOrigin.x, y: e.clientY - state.dragOrigin.y };
    renderFlowSvg();
  });
  window.addEventListener('mouseup', () => {
    state.isDraggingCanvas = false;
  });
  svgWrapper?.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const delta = e.deltaY < 0 ? 0.08 : -0.08;
      state.zoom = Number(Math.min(1.8, Math.max(0.45, state.zoom + delta)).toFixed(2));
      renderCenterPane();
    },
    { passive: false }
  );

  document.getElementById('zoom-in-btn')?.addEventListener('click', () => {
    state.zoom = Math.min(1.8, Number((state.zoom + 0.12).toFixed(2)));
    renderCenterPane();
  });
  document.getElementById('zoom-out-btn')?.addEventListener('click', () => {
    state.zoom = Math.max(0.45, Number((state.zoom - 0.12).toFixed(2)));
    renderCenterPane();
  });
  document.getElementById('zoom-reset-btn')?.addEventListener('click', () => {
    state.zoom = 0.88;
    state.pan = { x: 20, y: 16 };
    renderCenterPane();
  });

  // Step-by-Step Debugger controls
  document.getElementById('trace-restart-btn')?.addEventListener('click', () => stepToIndex(0));
  document.getElementById('trace-prev-btn')?.addEventListener('click', () =>
    stepToIndex(Math.max(0, state.currentStepIndex - 1))
  );
  document.getElementById('trace-next-btn')?.addEventListener('click', () => {
    const trace = getTraceResult();
    stepToIndex(Math.min(trace.steps.length - 1, state.currentStepIndex + 1));
  });
  document.getElementById('trace-play-btn')?.addEventListener('click', togglePlayTrace);
  document.getElementById('trace-slider')?.addEventListener('input', (e) => {
    stepToIndex(Number(e.target.value));
  });

  // Import Modal Mode Switchers (Git/Upload vs Write/Paste Code)
  const gitForm = document.getElementById('github-import-form');
  const pasteForm = document.getElementById('paste-code-form');
  const errEl = document.getElementById('import-error-msg');

  const showImportError = (msg) => {
    if (!errEl) return;
    if (!msg) {
      errEl.classList.add('hidden');
      errEl.textContent = '';
    } else {
      errEl.textContent = msg;
      errEl.classList.remove('hidden');
    }
  };

  document.getElementById('switch-paste-mode-btn')?.addEventListener('click', () => {
    showImportError(null);
    gitForm?.classList.add('hidden');
    pasteForm?.classList.remove('hidden');
  });

  document.getElementById('back-to-git-btn')?.addEventListener('click', () => {
    showImportError(null);
    pasteForm?.classList.add('hidden');
    gitForm?.classList.remove('hidden');
  });

  // GitHub URL Import submit
  gitForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const urlInput = document.getElementById('repo-url-input');
    const submitBtn = document.getElementById('submit-github-btn');
    const trimmed = (urlInput?.value || '').trim();
    if (!trimmed) {
      showImportError('Please enter a GitHub repository URL or upload your project files.');
      return;
    }

    showImportError(null);
    if (submitBtn) submitBtn.textContent = 'Analyzing Repo...';
    try {
      const response = await fetch('/api/repo/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repoUrl: trimmed }),
      });
      const data = await response.json();
      if (!response.ok) {
        showImportError(data.error || 'Could not import repository.');
      } else {
        const built = buildProjectModel(
          data.id || `git-${Date.now()}`,
          data.name,
          data.description,
          data.files,
          {},
          [],
          trimmed
        );
        // Already saved on server during /api/repo/import, also sync to Firestore if signed in
        if (data.savedRecord && state.currentUser) {
          saveRepoToFirestore(data.savedRecord);
        }
        await fetchServerHistory();
        selectProject(built, false);
        closeImportModal();
        setViewMode('flow');
      }
    } catch (err) {
      showImportError(err instanceof Error ? err.message : 'Failed to import Git URL');
    } finally {
      if (submitBtn) submitBtn.textContent = 'Import Repository';
    }
  });

  // File & Folder Upload handlers
  const fileUploadInput = document.getElementById('file-upload-input');
  const folderUploadInput = document.getElementById('folder-upload-input');
  document.getElementById('upload-files-btn')?.addEventListener('click', () => {
    fileUploadInput?.click();
  });
  document.getElementById('upload-folder-btn')?.addEventListener('click', () => {
    folderUploadInput?.click();
  });

  const handleFilesSelected = async (e) => {
    const fileList = e.target.files;
    if (!fileList || fileList.length === 0) return;
    showImportError(null);

    try {
      const rawFiles = [];
      for (let i = 0; i < fileList.length; i++) {
        const file = fileList[i];
        if (file.name.endsWith('.zip')) {
          const zip = await JSZip.loadAsync(file);
          const entries = Object.keys(zip.files);
          for (const entryPath of entries) {
            const zipEntry = zip.files[entryPath];
            if (
              !zipEntry.dir &&
              !entryPath.includes('node_modules/') &&
              !entryPath.includes('.git/') &&
              /\.(py|ts|tsx|js|jsx|java|cpp|c|rs|go|php|cs|html|css|json|md)$/i.test(entryPath)
            ) {
              const text = await zipEntry.async('string');
              rawFiles.push({ path: entryPath, content: text });
            }
          }
        } else {
          const text = await file.text();
          const relPath = file.webkitRelativePath || `src/${file.name}`;
          rawFiles.push({ path: relPath, content: text });
        }
      }

      if (rawFiles.length === 0) {
        showImportError('No readable source files found in selection.');
        return;
      }

      const projName = rawFiles[0].path.split('/')[0] || 'uploaded-project';
      const built = buildProjectModel(
        `upload-${Date.now()}`,
        projName,
        `Uploaded ${rawFiles.length} source file(s) for interactive visualization.`,
        rawFiles,
        {}
      );
      selectProject(built, true, rawFiles);
      closeImportModal();
      setViewMode('flow');
    } catch (err) {
      showImportError(err instanceof Error ? err.message : 'Error reading uploaded files');
    }
  };

  fileUploadInput?.addEventListener('change', handleFilesSelected);
  folderUploadInput?.addEventListener('change', handleFilesSelected);

  // Paste Code Build Visual Map handler
  document.getElementById('build-pasted-map-btn')?.addEventListener('click', () => {
    const filenameInput = document.getElementById('pasted-filename-input');
    const codeTextarea = document.getElementById('pasted-code-textarea');
    const filePath = (filenameInput?.value || 'src/main.py').trim() || 'src/main.py';
    const code = codeTextarea?.value || '';

    if (!code.trim()) {
      showImportError('Please paste or type source code before analyzing.');
      return;
    }

    showImportError(null);
    const rawFiles = [{ path: filePath, content: code }];
    const built = buildProjectModel(
      `snippet-${Date.now()}`,
      filePath.split('/').pop() || 'custom-code',
      'Custom source code analyzed into AST, Control-Flow Graph, and Execution Model.',
      rawFiles,
      {}
    );
    selectProject(built, true, rawFiles);
    closeImportModal();
    setViewMode('flow');
  });

  renderAll();
}

initApp();
