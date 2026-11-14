const endpoint = process.env.GITTREE_CDP_ENDPOINT || 'http://127.0.0.1:9222/json';

async function connect() {
  const targets = await fetch(endpoint).then(response => response.json());
  const target = targets.find(item => item.type === 'page' && item.title === 'GitTree');
  if (!target) throw new Error(`GitTree renderer not found at ${endpoint}`);

  const socket = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  let nextId = 1;

  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  });

  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });

  return {
    async call(method, params = {}) {
      const id = nextId++;
      socket.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
    close() {
      if (socket.readyState === WebSocket.CLOSED) return Promise.resolve();
      return new Promise(resolve => {
        socket.addEventListener('close', resolve, { once: true });
        socket.close();
      });
    }
  };
}

async function evaluate(client, expression) {
  const result = await client.call('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  }
  return result.result.value;
}

async function waitForRenderer(client) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const ready = await evaluate(client, `Boolean(
      window.app?.state?.repo &&
      document.querySelector('.repo-tab') &&
      window.app?.components?.branchList?.data &&
      window.app?.components?.graphView?.loading === false &&
      window.app?.components?.graphView?.rows?.length >= 2 &&
      document.querySelectorAll('.graph-row').length >= 2 &&
      document.getElementById('workspace')?.getAttribute('aria-busy') === 'false'
    )`);
    if (ready) return;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('GitTree renderer did not finish loading a repository');
}

const contractExpression = `
(async () => {
  // Polls a condition once per frame: debounced input and IPC-backed dialogs
  // settle asynchronously, so a synchronous check would race them.
  const settle = async (condition, timeout = 2000) => {
    const deadline = performance.now() + timeout;
    while (!condition()) {
      if (performance.now() > deadline) return false;
      await new Promise(resolve => requestAnimationFrame(resolve));
    }
    return true;
  };
  const activeTabs = [...document.querySelectorAll('.repo-tab.active')];
  const projectLoadingIndicators = [
    document.getElementById('branch-loading-indicator'),
    document.getElementById('workspace-loading-indicator'),
    document.getElementById('inspector-loading-indicator')
  ];
  window.app.setProjectLoading(true);
  const projectLoading = {
    indicatorsPresent: projectLoadingIndicators.every(Boolean),
    indicatorsVisible: projectLoadingIndicators.every(item => !item.classList.contains('is-hidden')),
    workspaceBusy: document.getElementById('workspace')?.getAttribute('aria-busy') === 'true',
    statusLive: projectLoadingIndicators.every(item => item.getAttribute('aria-live') === 'polite')
  };
  window.app.setProjectLoading(false);
  const nestedRows = [...document.querySelectorAll('#branch-list .branch-item')]
    .filter(row => {
      const title = row.querySelector('.branch-name')?.title || '';
      return title.replace(/^remotes\\//, '').includes('/');
    });
  const nestedLabels = nestedRows.map(row => row.querySelector('.branch-name')?.textContent || '');

  const branchList = window.app.components.branchList;
  const originalCheckout = branchList.checkout;
  const originalCheckoutRemote = branchList.checkoutRemote;
  const originalSelectedBranchKey = branchList.selectedBranchKey;
  const originalSelectedBranchElement = branchList.selectedBranchElement;
  const originalBranchMetadataByKey = branchList.branchMetadataByKey;
  branchList.branchMetadataByKey = new Map([
    ['local:feature/__renderer-ui-contract__', {
      name: 'feature/__renderer-ui-contract__',
      kind: 'local',
      upstream: 'origin/feature/__renderer-ui-contract__',
      ahead: 3,
      behind: 2
    }]
  ]);
  const target = branchList.branchRow(
    { name: 'feature/__renderer-ui-contract__' },
    branchList.current,
    false,
    '__renderer-ui-contract__'
  );
  branchList.container.appendChild(target);

  let activations = 0;
  branchList.checkout = () => { activations += 1; };
  branchList.checkoutRemote = () => { activations += 1; };

  target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  const afterSingleClick = activations;
  const selectedStyle = getComputedStyle(target);
  const activeRow = document.querySelector('#branch-list .branch-item.active');
  const activeStyle = activeRow ? getComputedStyle(activeRow) : null;
  const selectedLooksDistinct =
    selectedStyle.boxShadow === 'none' &&
    (!activeStyle || selectedStyle.backgroundColor !== activeStyle.backgroundColor);
  target.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  const afterDoubleClick = activations;
  const nestedIsIndented =
    target.classList.contains('is-nested') &&
    parseFloat(getComputedStyle(target).paddingLeft) >= 24;
  const aheadBadge = target.querySelector('.branch-sync-badge.is-ahead');
  const behindBadge = target.querySelector('.branch-sync-badge.is-behind');
  const branchCountersVisible =
    aheadBadge?.textContent.trim() === '3' &&
    behindBadge?.textContent.trim() === '2' &&
    Boolean(aheadBadge.title) &&
    Boolean(behindBadge.title);
  const branchCountersAreGrouped =
    target.querySelectorAll('.branch-sync-summary').length === 1 &&
    target.querySelector('.branch-sync-summary')?.contains(aheadBadge) &&
    target.querySelector('.branch-sync-summary')?.contains(behindBadge);

  const contextMenu = window.app.components.branchContextMenu;
  const contextMetadata = {
    current: branchList.current,
    defaultBranch: branchList.current,
    branches: [{ name: 'feature/__renderer-ui-contract__', kind: 'local', current: false, upstream: '' }],
    remotes: []
  };
  contextMenu.open(
    new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: innerWidth - 2,
      clientY: innerHeight - 2
    }),
    contextMetadata.branches[0],
    contextMetadata,
    { isClean: true },
    { type: null, conflicts: [] }
  );
  const contextRect = contextMenu.element.getBoundingClientRect();
  const contextOpens = !contextMenu.element.classList.contains('is-hidden');
  const contextClamped =
    contextRect.right <= innerWidth - 7 && contextRect.bottom <= innerHeight - 7;
  const contextHasStableActions =
    Boolean(contextMenu.element.querySelector('[data-action="checkout"]')) &&
    Boolean(contextMenu.element.querySelector('[data-action="merge"]')) &&
    Boolean(contextMenu.element.querySelector('[data-action="rebase"]')) &&
    Boolean(contextMenu.element.querySelector('[data-action="diff"]')) &&
    Boolean(contextMenu.element.querySelector('[data-action="delete"]'));
  const contextDisabledExplained = [...contextMenu.element.querySelectorAll('[aria-disabled="true"]')]
    .every(item => Boolean(item.title));
  document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  const contextOutsideClickCloses = contextMenu.element.classList.contains('is-hidden');
  contextMenu.open(
    new MouseEvent('contextmenu', { clientX: 20, clientY: 20 }),
    contextMetadata.branches[0],
    contextMetadata,
    { isClean: true },
    { type: null, conflicts: [] }
  );
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  const contextEscCloses = contextMenu.element.classList.contains('is-hidden');
  const dirtyMergeMetadata = {
    current: 'quality',
    defaultBranch: 'develop',
    branches: [
      { name: 'quality', kind: 'local', current: true, upstream: 'origin/quality' },
      { name: 'develop', kind: 'local', current: false, upstream: 'origin/develop' }
    ],
    remotes: [{ name: 'origin' }]
  };
  contextMenu.open(
    new MouseEvent('contextmenu', { clientX: 20, clientY: 20 }),
    dirtyMergeMetadata.branches[1],
    dirtyMergeMetadata,
    { isClean: false, modified: ['src/example.js'] },
    { type: null, conflicts: [] }
  );
  const dirtyMergeItem = contextMenu.element.querySelector('[data-action="merge"]');
  const dirtyMergePreviewAvailable =
    dirtyMergeItem?.getAttribute('aria-disabled') !== 'true' &&
    dirtyMergeItem?.textContent.includes('develop') &&
    dirtyMergeItem?.textContent.includes('quality');
  const originalMergeOpen = window.app.components.merge.open;
  let dirtyMergeDirection = null;
  window.app.components.merge.open = (source, targetBranch) => {
    dirtyMergeDirection = { source, target: targetBranch };
  };
  dirtyMergeItem?.click();
  window.app.components.merge.open = originalMergeOpen;
  const dirtyMergeUsesCurrentAsTarget =
    dirtyMergeDirection?.source === 'develop' &&
    dirtyMergeDirection?.target === 'quality';
  contextMenu.close();

  branchList.checkout = originalCheckout;
  branchList.checkoutRemote = originalCheckoutRemote;
  target.remove();
  branchList.selectedBranchKey = originalSelectedBranchKey;
  branchList.selectedBranchElement =
    originalSelectedBranchElement?.isConnected ? originalSelectedBranchElement : null;
  branchList.selectedBranchElement?.classList.add('selected');
  branchList.branchMetadataByKey = originalBranchMetadataByKey;

  const repoTabs = window.app.components.repoTabs;
  const originalRepoSyncState = repoTabs.syncByRepoPath
    ? new Map(repoTabs.syncByRepoPath)
    : null;
  let tabSyncVisible = false;
  if (typeof repoTabs.updateSync === 'function') {
    repoTabs.updateSync(window.app.state.repo.path, {
      branch: 'quality',
      ahead: 2,
      behind: 4,
      upstream: 'origin/quality'
    });
    const activeTab = document.querySelector('.repo-tab.active');
    tabSyncVisible =
      activeTab?.querySelector('.repo-tab-sync .is-ahead')?.textContent.trim() === '2' &&
      activeTab?.querySelector('.repo-tab-sync .is-behind')?.textContent.trim() === '4';
    repoTabs.updateSync(window.app.state.repo.path, {
      branch: 'quality',
      ahead: 0,
      behind: 0,
      upstream: 'origin/quality'
    });
    tabSyncVisible = tabSyncVisible &&
      !document.querySelector('.repo-tab.active .repo-tab-sync');
    repoTabs.syncByRepoPath = originalRepoSyncState || new Map();
    repoTabs.render();
  }

  const commandBar = document.querySelector('.workspace-command-bar');
  const workspaceBody = document.getElementById('workspace-body');
  const remoteActions = ['btn-fetch', 'btn-pull', 'btn-push']
    .map(id => document.getElementById(id));

  const originalInspectorState = window.app.inspectorState;
  const originalInspectorStorage = localStorage.getItem('gittree.workspace.inspector');
  window.app.setInspectorState('open', false);
  document.getElementById('btn-maximize-inspector').click();
  const maximizes = window.app.inspectorState === 'maximized' &&
    workspaceBody.classList.contains('inspector-maximized');
  const splitWhenMaximized =
    window.app.components.diffViewer.mode === 'split' &&
    document.getElementById('btn-diff-split').classList.contains('active');
  document.getElementById('btn-maximize-inspector').click();
  document.getElementById('btn-close-inspector').click();
  const closes = window.app.inspectorState === 'closed' &&
    workspaceBody.classList.contains('inspector-closed');
  const inspectorPersists =
    localStorage.getItem('gittree.workspace.inspector') === 'closed';
  document.getElementById('btn-toggle-inspector').click();
  const reopens = window.app.inspectorState === 'open' &&
    !workspaceBody.classList.contains('inspector-closed');
  window.app.setInspectorState(originalInspectorState, false);
  if (originalInspectorStorage == null) localStorage.removeItem('gittree.workspace.inspector');
  else localStorage.setItem('gittree.workspace.inspector', originalInspectorStorage);

  const detailTitleStyle = getComputedStyle(document.getElementById('detail-title'));
  const originalTheme = document.documentElement.dataset.theme;
  const originalThemeStorage = localStorage.getItem(Theme.storageKey);
  const themeSmoke = {};
  Theme.themes.forEach(theme => {
    Theme.apply(theme, false);
    const panelBackground = getComputedStyle(document.getElementById('detail-panel')).backgroundColor;
    themeSmoke[theme] = panelBackground.startsWith('rgb(');
  });
  Theme.apply(originalTheme, false);
  if (originalThemeStorage == null) localStorage.removeItem(Theme.storageKey);
  else localStorage.setItem(Theme.storageKey, originalThemeStorage);

  const branchGroupsStorageKey = 'gittree.sidebar.branchGroups';
  const originalBranchGroupsStorage = localStorage.getItem(branchGroupsStorageKey);
  branchList.persistSet(branchGroupsStorageKey, new Set(['local']));
  const branchGroupsPersist = JSON.parse(localStorage.getItem(branchGroupsStorageKey)).includes('local');
  if (originalBranchGroupsStorage == null) localStorage.removeItem(branchGroupsStorageKey);
  else localStorage.setItem(branchGroupsStorageKey, originalBranchGroupsStorage);

  const sidebarSectionsStorageKey = 'gittree.sidebar.sections';
  const originalSidebarSectionsStorage = localStorage.getItem(sidebarSectionsStorageKey);
  const stashHeader = document.querySelector('[data-section="stashes"] .sidebar-section-header');
  stashHeader.click();
  const stashStateAfterClick = stashHeader.classList.contains('collapsed');
  const sidebarSectionsPersist =
    JSON.parse(localStorage.getItem(sidebarSectionsStorageKey)).includes('stashes') ===
    stashStateAfterClick;
  stashHeader.click();
  if (originalSidebarSectionsStorage == null) localStorage.removeItem(sidebarSectionsStorageKey);
  else localStorage.setItem(sidebarSectionsStorageKey, originalSidebarSectionsStorage);

  const graphView = window.app.components.graphView;
  const graphColumnsStorageKey = 'gittree.history.columns';
  const originalGraphColumnsStorage = localStorage.getItem(graphColumnsStorageKey);
  const originalGraphColumnWidths = graphView.columnWidths
    ? { ...graphView.columnWidths }
    : null;
  const originalHasPersistedGraphColumns = graphView.hasPersistedColumnWidths;
  const graphHeaders = [...document.querySelectorAll('.graph-column-header')];
  const graphColumnHandles = [...document.querySelectorAll('.graph-column-resizer')];
  const graphHeaderNames = graphHeaders.map(header =>
    header.querySelector('.graph-column-label')?.textContent.trim()
  );
  const messageHandle = document.querySelector(
    '.graph-column-resizer[data-column="message"]'
  );
  let graphResizeUsesPreview = false;
  let graphColumnResizes = false;
  let graphColumnPersists = false;
  let graphColumnRestores = false;
  let graphColumnsStayAligned = false;
  let graphKeyboardResize = false;

  if (messageHandle && graphView.columnWidths) {
    // Start from the default width, so a width persisted near the maximum
    // cannot clamp the resize; the original widths are restored below.
    graphView.resizeColumn('message', graphView.columnDefinitions.message.default, false);
    const initialWidth = graphView.columnWidths.message;
    messageHandle.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true,
      button: 0,
      clientX: 300
    }));
    document.dispatchEvent(new PointerEvent('pointermove', {
      bubbles: true,
      clientX: 348
    }));
    await new Promise(resolve => requestAnimationFrame(resolve));
    graphResizeUsesPreview =
      graphView.columnWidths.message === initialWidth &&
      getComputedStyle(messageHandle).transform !== 'none';
    document.dispatchEvent(new PointerEvent('pointerup', {
      bubbles: true,
      clientX: 348
    }));
    graphColumnResizes = graphView.columnWidths.message === initialWidth + 48;
    graphColumnPersists =
      JSON.parse(localStorage.getItem(graphColumnsStorageKey)).message ===
      graphView.columnWidths.message;
    graphColumnRestores =
      graphView.restoreColumnWidths().widths.message === graphView.columnWidths.message;
    const visibleGraphRow = document.querySelector('.graph-row');
    graphColumnsStayAligned =
      Boolean(visibleGraphRow) &&
      getComputedStyle(document.querySelector('.graph-header')).gridTemplateColumns ===
      getComputedStyle(visibleGraphRow).gridTemplateColumns;

    const pointerWidth = graphView.columnWidths.message;
    messageHandle.dispatchEvent(new KeyboardEvent('keydown', {
      bubbles: true,
      key: 'ArrowRight'
    }));
    graphKeyboardResize = graphView.columnWidths.message === pointerWidth + 8;
  }

  if (originalGraphColumnWidths && graphView.setColumnWidths) {
    graphView.setColumnWidths(originalGraphColumnWidths, false);
  }
  graphView.hasPersistedColumnWidths = originalHasPersistedGraphColumns;
  if (originalGraphColumnsStorage == null) localStorage.removeItem(graphColumnsStorageKey);
  else localStorage.setItem(graphColumnsStorageKey, originalGraphColumnsStorage);

  const historyStateKey = graphView.historyStateStorageKey;
  const originalHistoryStateStorage = localStorage.getItem(historyStateKey);
  const originalHistoryFilters = { ...graphView.filters };
  const originalHistorySort = graphView.sortMode;
  const historyQuery = document.getElementById('history-filter-query');
  const historySort = document.getElementById('history-sort');
  const filterHash = graphView.rows[0]?.commit.hash.slice(0, 10) || '';
  if (historyQuery && filterHash) {
    historyQuery.value = filterHash;
    historyQuery.dispatchEvent(new Event('input', { bubbles: true }));
    await settle(() => graphView.filters.query === filterHash);
  }
  const historyFilterWorks =
    Boolean(filterHash) &&
    graphView.visibleRows.length >= 1 &&
    graphView.visibleRows.every(row => row.commit.hash.includes(filterHash));
  if (historySort) {
    historySort.value = 'date-asc';
    historySort.dispatchEvent(new Event('change', { bubbles: true }));
  }
  const storedHistoryState = JSON.parse(localStorage.getItem(historyStateKey) || '{}')[
    window.app.state.repo.path
  ];
  const historyControlsContract = {
    present:
      Boolean(historyQuery) &&
      Boolean(document.getElementById('history-filter-author')) &&
      Boolean(document.getElementById('history-filter-ref')) &&
      Boolean(historySort),
    filterWorks: historyFilterWorks,
    sortWorks:
      graphView.sortMode === 'date-asc' &&
      Boolean(document.querySelector('.graph-sort-marker')),
    persists:
      storedHistoryState?.query === filterHash &&
      storedHistoryState?.sort === 'date-asc'
  };
  graphView.filters = originalHistoryFilters;
  graphView.sortMode = originalHistorySort;
  graphView.syncHistoryControls();
  graphView.applyFilter();
  graphView.renderViewport(true);
  if (originalHistoryStateStorage == null) localStorage.removeItem(historyStateKey);
  else localStorage.setItem(historyStateKey, originalHistoryStateStorage);

  const originalLanguage = i18next.language;
  await i18next.changeLanguage('it');
  I18n.translateDOM();
  const italianSmoke =
    document.querySelector('.toolbar-title h2').textContent === 'Cronologia commit';
  await i18next.changeLanguage('en');
  I18n.translateDOM();
  const englishSmoke =
    document.querySelector('.toolbar-title h2').textContent === 'Commit history';
  await i18next.changeLanguage(originalLanguage);
  I18n.translateDOM();
  Theme.syncControls();
  const updateState = await window.gitTree.getUpdateState();
  const productIcon = document.querySelector('.welcome-brand img');
  const platform = window.gitTree.platform;
  const platformShortcut = document.querySelector('[data-platform-shortcut="search"]');
  const repositoryShortcutLabels = {
    fetch: window.app.shortcutLabel('fetch'),
    pull: window.app.shortcutLabel('pull'),
    push: window.app.shortcutLabel('push'),
    newBranch: window.app.shortcutLabel('newBranch')
  };
  const toolbarShortcutsAreUncluttered =
    !document.querySelector('#btn-fetch kbd, #btn-pull kbd, #btn-push kbd, #btn-new-branch kbd');
  const windowMaximizeButton = document.querySelector('#workspace .window-maximize');
  let windowChromeTracksState = false;
  let windowControlsMatchPlatform = false;
  let shortcutMatchesPlatform = false;

  if (platform && window.gitTree.getWindowState) {
    const originalWindowState = await window.gitTree.getWindowState();
    const toggledWindowState = {
      ...originalWindowState,
      isMaximized: !originalWindowState.isMaximized
    };
    window.app.updateWindowChrome(toggledWindowState);
    const maximizeIcon = windowMaximizeButton.querySelector('i');
    windowChromeTracksState =
      maximizeIcon.classList.contains(
        toggledWindowState.isMaximized
          ? (platform === 'win32' ? 'ph-copy-simple' : 'ph-corners-in')
          : 'ph-square'
      );
    windowControlsMatchPlatform =
      platform === 'darwin'
        ? getComputedStyle(windowMaximizeButton.parentElement).display === 'none'
        : getComputedStyle(windowMaximizeButton.parentElement).display !== 'none';
    shortcutMatchesPlatform =
      platformShortcut?.textContent.trim() === (platform === 'darwin' ? '⌘P' : 'Ctrl+P') &&
      repositoryShortcutLabels.fetch === (platform === 'darwin' ? '⌘⇧F' : 'Ctrl+Shift+F') &&
      repositoryShortcutLabels.pull === (platform === 'darwin' ? '⌘⇧L' : 'Ctrl+Shift+L') &&
      repositoryShortcutLabels.push === (platform === 'darwin' ? '⌘⇧P' : 'Ctrl+Shift+P') &&
      repositoryShortcutLabels.newBranch === (platform === 'darwin' ? '⌘⇧B' : 'Ctrl+Shift+B');
    window.app.updateWindowChrome(originalWindowState);
  }
  const recentCommitDate = new Date();
  recentCommitDate.setMinutes(recentCommitDate.getMinutes() - 5);
  const renderedRecentCommitDate = graphView.fmtDate(recentCommitDate.toISOString());
  const expectedRecentCommitDate = recentCommitDate.toLocaleString(i18next.language, {
    dateStyle: 'short',
    timeStyle: 'short'
  });
  const workspaceScrollbarStyle = getComputedStyle(
    document.querySelector('.graph-view'),
    '::-webkit-scrollbar'
  );
  const tabsScrollbarStyle = getComputedStyle(
    document.querySelector('.repo-tab-container'),
    '::-webkit-scrollbar'
  );
  const tabsThumbStyle = getComputedStyle(
    document.querySelector('.repo-tab-container'),
    '::-webkit-scrollbar-thumb'
  );
  const scrollbarThumbStyle = getComputedStyle(
    document.querySelector('.graph-view'),
    '::-webkit-scrollbar-thumb'
  );

  const originalWorkspaceMode = window.app.workspaceMode;
  const workspaceModeStorageKey = window.app.workspaceModeKey();
  const originalWorkspaceModeStorage = localStorage.getItem(workspaceModeStorageKey);
  window.app.setWorkspaceMode('changes');
  const changesView = window.app.components.changes;
  const changesModeVisible =
    !document.getElementById('changes-view').classList.contains('is-hidden') &&
    document.getElementById('main-view').classList.contains('is-hidden');
  const changesModePersists =
    localStorage.getItem(workspaceModeStorageKey) === 'changes';
  const changesRowsBounded =
    document.querySelectorAll('.changes-file-row').length < 100;
  const changesPollingRespectsFocus =
    document.hasFocus() ? Boolean(changesView.pollTimer) : !changesView.pollTimer;
  const changesApisExplicit = [
    'getWorkingTree',
    'getWorkingDiff',
    'stagePaths',
    'unstagePaths',
    'stageHunks',
    'unstageHunks',
    'getIdentity',
    'setIdentity',
    'commitChanges'
  ].every(name => typeof window.gitTree[name] === 'function');

  const originalSelectedHashes = [...graphView.selectedHashes];
  const originalSelectedHash = graphView.selectedHash;
  const originalSelectionAnchor = graphView.selectionAnchor;
  const selectionFixture = graphView.visibleRows.slice(0, 2).map(row => row.commit.hash);
  let commitMultiSelect = false;
  let commitContextOpens = false;
  let commitContextHasActions = false;
  let commitTagDialogOpens = false;
  if (selectionFixture.length === 2) {
    graphView.select(selectionFixture[0], false);
    graphView.selectFromEvent(selectionFixture[1], {
      shiftKey: false,
      ctrlKey: platform !== 'darwin',
      metaKey: platform === 'darwin'
    });
    commitMultiSelect = graphView.selectedHashes.size === 2;
    const commitContext = window.app.components.commitContextMenu;
    commitContext.open(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: innerWidth - 2,
        clientY: innerHeight - 2
      }),
      [...graphView.selectedHashes]
    );
    commitContextOpens = !commitContext.element.classList.contains('is-hidden');
    commitContextHasActions =
      Boolean(commitContext.element.querySelector('[data-action="create-tag"]')) &&
      Boolean(commitContext.element.querySelector('[data-action="rebase"]')) &&
      Boolean(commitContext.element.querySelector('[data-action="cherry-pick"]'));
    commitContext.close();
    commitContext.open(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: 40,
        clientY: 40
      }),
      [selectionFixture[0]]
    );
    const createTagItem = commitContext.element.querySelector('[data-action="create-tag"]');
    createTagItem?.click();
    commitTagDialogOpens = await settle(() =>
      !document.getElementById('modal-overlay').classList.contains('is-hidden') &&
      Boolean(document.querySelector('.tag-create-dialog'))
    );
    document.querySelector('.tag-create-dialog [data-cancel]')?.click();
    commitContext.close();
  }
  graphView.selectedHashes = new Set(originalSelectedHashes);
  graphView.selectedHash = originalSelectedHash;
  graphView.selectionAnchor = originalSelectionAnchor;
  graphView.updateVisibleSelection();

  window.app.setWorkspaceMode('pullRequests');
  const pullRequestModeVisible =
    !document.getElementById('pull-requests-view').classList.contains('is-hidden');
  const pullRequestControls =
    document.querySelectorAll('[data-pr-provider]').length === 3 &&
    document.querySelectorAll('[data-pr-filter]').length === 4 &&
    Boolean(document.getElementById('pr-search')) &&
    Boolean(document.getElementById('btn-pr-auth'));
  const reviewApisExplicit = [
    'getProviderStatus',
    'loginProvider',
    'cancelProviderLogin',
    'logoutProvider',
    'getPullRequests',
    'getPullRequestDetail',
    'getPullRequestDiff',
    'saveReviewDraft',
    'submitReview',
    'resolveReviewThread',
    'checkoutPullRequestSource'
  ].every(name => typeof window.gitTree[name] === 'function');
  const localStorageHasSecrets = Object.keys(localStorage).some(key => (
    /token|oauth|reviewdraft/i.test(key) ||
    /accessToken|refreshToken/i.test(localStorage.getItem(key) || '')
  ));
  const settingsButton = document.getElementById('btn-settings');
  let settingsOpens = false;
  let settingsHasAutoFetch = false;
  let settingsHasAccounts = false;
  let settingsHasShortcuts = false;
  let settingsShortcutsDedicated = false;
  if (window.app.components.settings && settingsButton) {
    await window.app.components.settings.open();
    const settingsDialog = document.querySelector('.settings-dialog');
    settingsOpens = Boolean(settingsDialog) &&
      !document.getElementById('modal-overlay').classList.contains('is-hidden');
    settingsHasAutoFetch =
      Boolean(settingsDialog?.querySelector('[data-settings-section="auto-fetch"]')) &&
      Boolean(settingsDialog?.querySelector('[data-auto-fetch-project]')) &&
      Boolean(settingsDialog?.querySelector('[data-auto-fetch-project-interval]')) &&
      !Boolean(settingsDialog?.querySelector('[data-auto-fetch-branch]'));
    settingsHasAccounts =
      Boolean(settingsDialog?.querySelector('[data-settings-section="accounts"]')) &&
      Boolean(settingsDialog?.querySelector('#settings-account-form'));
    const shortcutNavigation = settingsDialog?.querySelector('[data-settings-section="shortcuts"]');
    settingsHasShortcuts = Boolean(shortcutNavigation);
    shortcutNavigation?.click();
    settingsShortcutsDedicated =
      Boolean(settingsDialog?.querySelector('.settings-shortcut-content')) &&
      document.querySelectorAll('.settings-shortcut-list kbd').length === 6;
    window.app.components.settings.close();
  }

  const originalCreateBranch = branchList.createBranch;
  const originalRefresh = window.app.refresh;
  const createdBranches = [];
  branchList.createBranch = async (_repoPath, name) => {
    createdBranches.push(name);
    return { success: true, name };
  };
  window.app.refresh = async () => {};
  const submitQuickBranch = async (selector, description) => {
    document.querySelector(selector)?.click();
    await Promise.resolve();
    const branchDialog = document.querySelector('.quick-branch-dialog');
    const input = branchDialog?.querySelector('[name="description"]');
    if (!input) return { opens: false, preview: false };
    input.value = description;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const expected = BranchNaming.compose('feature', description, branchList.metadata);
    const preview = branchDialog.querySelector('[data-branch-preview]')?.textContent === expected;
    branchDialog.querySelector('form').requestSubmit();
    await new Promise(resolve => setTimeout(resolve, 0));
    return { opens: true, preview };
  };
  const plusBranchResult = await submitQuickBranch('#btn-new-branch', 'Renderer Plus Contract');
  branchList.createBranch = originalCreateBranch;
  window.app.refresh = originalRefresh;
  const quickBranchContract = {
    plusOpens: plusBranchResult.opens,
    previewsConvention: plusBranchResult.preview,
    creates: createdBranches.length === 1,
    closesAfterSuccess:
      document.getElementById('modal-overlay').classList.contains('is-hidden')
  };
  window.app.setWorkspaceMode(originalWorkspaceMode, false);
  if (originalWorkspaceModeStorage == null) localStorage.removeItem(workspaceModeStorageKey);
  else localStorage.setItem(workspaceModeStorageKey, originalWorkspaceModeStorage);

  return {
    activeTab: {
      count: activeTabs.length,
      matchesCurrentRepo:
        activeTabs[0]?.querySelector('.repo-tab-name')?.title === window.app.state.repo.path,
      selectedOnStartup:
        activeTabs.length === 1 &&
        activeTabs[0]?.querySelector('.repo-tab-name')?.title === window.app.state.repo.path,
      syncVisible: tabSyncVisible
    },
    projectLoading,
    branchLabels: {
      checked: nestedLabels.length,
      sample: nestedLabels.slice(0, 5),
      synthetic: target.querySelector('.branch-name')?.textContent,
      showLeafOnly:
        target.querySelector('.branch-name')?.textContent === '__renderer-ui-contract__' &&
        nestedLabels.every(label => !label.includes('/')),
      nestedIsIndented,
      countersVisible: branchCountersVisible,
      countersAreGrouped: branchCountersAreGrouped
    },
    branchActivation: {
      afterSingleClick,
      afterDoubleClick,
      requiresDoubleClick: afterSingleClick === 0 && afterDoubleClick === 1,
      selectedLooksDistinct
    },
    branchContextMenu: {
      opens: contextOpens,
      clamped: contextClamped,
      stableActions: contextHasStableActions,
      disabledExplained: contextDisabledExplained,
      outsideClickCloses: contextOutsideClickCloses,
      escapeCloses: contextEscCloses,
      rightClickDoesNotCheckout: afterSingleClick === 0,
      dirtyMergePreviewAvailable,
      dirtyMergeUsesCurrentAsTarget
    },
    graph: {
      virtualRows: document.querySelectorAll('.graph-row').length,
      boundedDom: document.querySelectorAll('.graph-row').length < 100,
      rendersLanes: Boolean(document.querySelector('.graph-lanes .graph-lane-node')),
      columnHeaders: graphHeaderNames,
      graphColumnNamed: graphHeaderNames[0] === 'Graph',
      allColumnsResizable: graphColumnHandles.length === 5,
      resizeUsesTransformPreview: graphResizeUsesPreview,
      columnResizes: graphColumnResizes,
      columnPersists: graphColumnPersists,
      columnRestores: graphColumnRestores,
      columnsStayAligned: graphColumnsStayAligned,
      keyboardResize: graphKeyboardResize,
      filtersAndSorting: historyControlsContract,
      dateIncludesCalendarAndTime:
        renderedRecentCommitDate === expectedRecentCommitDate
    },
    workspaceToolbar: {
      actionsMovedAboveWorkspace:
        remoteActions.every(action => action?.parentElement?.parentElement === commandBar) &&
        Boolean(commandBar.compareDocumentPosition(workspaceBody) & Node.DOCUMENT_POSITION_FOLLOWING),
      searchRemainsInHistory: !commandBar.contains(document.getElementById('global-search'))
    },
    workspaceModes: {
      changesVisible: changesModeVisible,
      persistsPerRepository: changesModePersists,
      pullRequestsVisible: pullRequestModeVisible
    },
    changes: {
      boundedDom: changesRowsBounded,
      pollingRespectsFocus: changesPollingRespectsFocus,
      composerPresent: Boolean(document.getElementById('commit-composer')),
      explicitApis: changesApisExplicit
    },
    commitActions: {
      multiSelect: commitMultiSelect,
      contextOpens: commitContextOpens,
      contextHasActions: commitContextHasActions,
      tagDialogOpens: commitTagDialogOpens,
      createTagApi: typeof window.gitTree.createTag === 'function'
    },
    pullRequests: {
      controlsPresent: pullRequestControls,
      explicitApis: reviewApisExplicit,
      noSecretsInLocalStorage: !localStorageHasSecrets
    },
    settings: {
      buttonPresent: Boolean(settingsButton),
      opens: settingsOpens,
      autoFetch: settingsHasAutoFetch,
      accounts: settingsHasAccounts,
      shortcuts: settingsHasShortcuts,
      shortcutsDedicated: settingsShortcutsDedicated,
      toolbarShortcutsUncluttered: toolbarShortcutsAreUncluttered
    },
    quickBranch: {
      ...quickBranchContract
    },
    inspector: {
      maximizes,
      splitWhenMaximized,
      closes,
      reopens,
      persists: inspectorPersists,
      compactTitle:
        detailTitleStyle.overflow === 'hidden' &&
        detailTitleStyle.textOverflow === 'ellipsis' &&
        detailTitleStyle.getPropertyValue('-webkit-line-clamp') === '2'
    },
    persistence: {
      branchGroups: branchGroupsPersist,
      sidebarSections: sidebarSectionsPersist
    },
    themes: {
      available: Theme.themes,
      smoke: themeSmoke
    },
    localization: {
      english: englishSmoke,
      italian: italianSmoke
    },
    platformChrome: {
      platform,
      tracksWindowState: windowChromeTracksState,
      nativeControlsWhereExpected: windowControlsMatchPlatform,
      shortcutMatchesPlatform
    },
    scrollbars: {
      workspaceTargetIsLarge:
        parseFloat(workspaceScrollbarStyle.width) >= 14 &&
        parseFloat(workspaceScrollbarStyle.height) >= 14,
      tabsScrollbarSlimCustom:
        parseFloat(tabsScrollbarStyle.height) >= 8 &&
        parseFloat(tabsScrollbarStyle.height) < 12 &&
        parseFloat(tabsThumbStyle.borderTopWidth) >= 2.5,
      thumbIsVisible:
        scrollbarThumbStyle.backgroundColor !== 'rgba(0, 0, 0, 0)' &&
        parseFloat(scrollbarThumbStyle.minHeight) >= 44
    },
    releaseShell: {
      iconLoaded: productIcon?.complete && productIcon?.naturalWidth === 1024,
      updaterDisabledInDevelopment:
        updateState.status === 'disabled' &&
        document.getElementById('btn-update').classList.contains('is-hidden')
    }
  };
})()
`;

async function main() {
  const client = await connect();
  try {
    await waitForRenderer(client);
    const contracts = await evaluate(client, contractExpression);
    console.log(JSON.stringify(contracts, null, 2));

    if (!contracts.activeTab.selectedOnStartup ||
        !contracts.activeTab.syncVisible ||
        !Object.values(contracts.projectLoading).every(Boolean) ||
        !contracts.branchLabels.showLeafOnly ||
        !contracts.branchLabels.nestedIsIndented ||
        !contracts.branchLabels.countersVisible ||
        !contracts.branchLabels.countersAreGrouped ||
        !contracts.branchActivation.requiresDoubleClick ||
        !contracts.branchActivation.selectedLooksDistinct ||
        !Object.values(contracts.branchContextMenu).every(Boolean) ||
        !contracts.graph.boundedDom ||
        !contracts.graph.rendersLanes ||
        !contracts.graph.graphColumnNamed ||
        !contracts.graph.allColumnsResizable ||
        !contracts.graph.resizeUsesTransformPreview ||
        !contracts.graph.columnResizes ||
        !contracts.graph.columnPersists ||
        !contracts.graph.columnRestores ||
        !contracts.graph.columnsStayAligned ||
        !contracts.graph.keyboardResize ||
        !Object.values(contracts.graph.filtersAndSorting).every(Boolean) ||
        !contracts.graph.dateIncludesCalendarAndTime ||
        !contracts.workspaceToolbar.actionsMovedAboveWorkspace ||
        !contracts.workspaceToolbar.searchRemainsInHistory ||
        !Object.values(contracts.workspaceModes).every(Boolean) ||
        !Object.values(contracts.changes).every(Boolean) ||
        !Object.values(contracts.commitActions).every(Boolean) ||
        !Object.values(contracts.pullRequests).every(Boolean) ||
        !Object.values(contracts.settings).every(Boolean) ||
        !Object.values(contracts.quickBranch).every(Boolean) ||
        !contracts.inspector.maximizes ||
        !contracts.inspector.splitWhenMaximized ||
        !contracts.inspector.closes ||
        !contracts.inspector.reopens ||
        !contracts.inspector.persists ||
        !contracts.inspector.compactTitle ||
        !contracts.persistence.branchGroups ||
        !contracts.persistence.sidebarSections ||
        !Object.values(contracts.themes.smoke).every(Boolean) ||
        contracts.themes.available.length !== 2 ||
        !contracts.localization.english ||
        !contracts.localization.italian ||
        !Object.values(contracts.platformChrome)
          .filter(value => typeof value === 'boolean')
          .every(Boolean) ||
        !Object.values(contracts.scrollbars).every(Boolean) ||
        !Object.values(contracts.releaseShell).every(Boolean)) {
      process.exitCode = 1;
    }
  } finally {
    await client.close();
  }
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
