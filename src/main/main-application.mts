// @ts-nocheck
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function resolvePreloadPath(base: string): string {
  const candidates = [
    // Sandboxed renderers only support CommonJS preload scripts.
    path.join(__dirname, '..', `${base}.cjs`),
    path.join(__dirname, '..', `${base}.mjs`),
    path.join(__dirname, '..', `${base}.js`)
  ];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch (_error) {
      // ignore missing candidates
    }
  }
  return candidates[2];
}

import { GitService } from './git-service.mts';
import { RepoManager } from './repo-manager.mts';
import { RepositoryWorkspace } from './repository-workspace.mts';
import { scanRepositories } from './repository-scanner.mts';
import { UpdateService } from './update-service.mts';
import { CredentialVault } from './credential-vault.mts';
import { HostingService } from './hosting-service.mts';
import { loadOAuthConfig } from './oauth-config.mts';
import { buildPullRequestUrl } from './provider-links.mts';
import { getGitVersion } from './git-version.mts';
import { Logger } from './logger.mts';
import { parseDeepLink } from './deep-link.mts';
import { createHandlerRegistry } from './ipc/handler-registry.mts';
import { registerGitHandlers } from './ipc/git-handlers.mts';
import { registerHostingHandlers } from './ipc/hosting-handlers.mts';
import { registerRepositoryHandlers } from './ipc/repository-handlers.mts';
import { registerWindowApplicationHandlers } from './ipc/window-application-handlers.mts';
import { registerAgentHandlers } from './ipc/agent-handlers.mts';
import { registerAiHandlers } from './ipc/ai-handlers.mts';
import { AgentSessionService } from './agents/agent-session-service.mts';
import { resolveAgentExecutable } from './agents/agent-adapters.mts';
import { AiService } from './ai/ai-service.mts';
import { createPty } from './agents/pty-factory.mts';
import { createInspectorWindowController } from './inspector-window-controller.mts';
import { createApplicationRuntime } from './application-runtime.mts';
import { performHandoverRelaunch, startStaleInstallWatch } from './version-watch.mts';
import { DiagnosticsExporter } from './diagnostics-exporter.mts';
import { isWorkingTreeRepository } from './working-tree-repository.mts';
import { convertWorkspaceProfile } from './workspace-profile-conversion.mts';

const ALLOWED_EXTERNAL_HOSTS = new Set([
  'github.com',
  'www.github.com',
  'gitlab.com',
  'www.gitlab.com',
  'dev.azure.com',
  'bitbucket.org',
  'www.bitbucket.org'
]);

export function isSafeExternalUrl(url: unknown) {
  if (typeof url !== 'string' || url.length > 8192) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && ALLOWED_EXTERNAL_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}

export function createMainApplication(options) {
  return new MainApplication(options);
}

function createModules(dependencies) {
  return {
    GitService: dependencies.GitService || GitService,
    RepoManager: dependencies.RepoManager || RepoManager,
    RepositoryWorkspace: dependencies.RepositoryWorkspace || RepositoryWorkspace,
    scanRepositories: dependencies.scanRepositories || scanRepositories,
    UpdateService: dependencies.UpdateService || UpdateService,
    CredentialVault: dependencies.CredentialVault || CredentialVault,
    HostingService: dependencies.HostingService || HostingService,
    loadOAuthConfig: dependencies.loadOAuthConfig || loadOAuthConfig,
    buildPullRequestUrl: dependencies.buildPullRequestUrl || buildPullRequestUrl,
    getGitVersion: dependencies.getGitVersion || getGitVersion,
    Logger: dependencies.Logger || Logger,
    parseDeepLink: dependencies.parseDeepLink || parseDeepLink,
    createInspectorWindowController: dependencies.createInspectorWindowController ||
      createInspectorWindowController,
    DiagnosticsExporter: dependencies.DiagnosticsExporter || DiagnosticsExporter,
    isWorkingTreeRepository: dependencies.isWorkingTreeRepository || isWorkingTreeRepository,
    convertWorkspaceProfile: dependencies.convertWorkspaceProfile || convertWorkspaceProfile,
    AgentSessionService: dependencies.AgentSessionService || AgentSessionService,
    AiService: dependencies.AiService || AiService,
    createPty: dependencies.createPty || createPty
  };
}

class MainApplication {
  constructor({
  electron,
  argv = process.argv,
  platform = process.platform,
  processHost = process,
  dependencies = {}
  }) {
  if (!electron?.app || !electron?.BrowserWindow || !electron?.ipcMain) {
    throw new TypeError('Electron application dependencies are required');
  }
  const {
    app, BrowserWindow, ipcMain, dialog, Menu, nativeTheme, safeStorage, session, shell
  } = electron;
  this.electron = {
    app, BrowserWindow, ipcMain, dialog, Menu, nativeTheme, safeStorage, session, shell
  };
  this.modules = createModules(dependencies);

  this.argv = argv;
  this.platform = platform;
  this.processHost = processHost;
  this.mainWindow = null;
  this.repositoryWorkspace = null;
  this.updateService = null;
  this.hostingService = null;
  this.agentSessionService = null;
  this.aiService = null;
  this.credentialVault = null;
  this.logger = null;
  this.inspectorController = null;
  this.disposeHandlers = () => {};
  this.processListenersAttached = false;
  this.allowWindowClose = false;
  this.closeConfirmationPending = false;
  this.stopStaleInstallWatch = () => {};
  this.handleUnhandledRejection = this.handleUnhandledRejection.bind(this);
  this.handleUncaughtException = this.handleUncaughtException.bind(this);
  this.runtime = createApplicationRuntime({
    host: app,
    argv,
    platform,
    appVersion: app.getVersion(),
    onHandoverRelaunch: () => {
      performHandoverRelaunch({
        app,
        onBeforeQuit: () => {
          this.updateService?.destroy();
        }
      });
    },
    initialize: () => this.initialize(),
    createWindow: () => this.createWindow(),
    getMainWindow: () => this.mainWindow,
    getWindowCount: () => BrowserWindow.getAllWindows().length,
    focusMainWindow: () => this.focusMainWindow(),
    handleDeepLink: url => this.handleDeepLink(url),
    teardown: () => this.teardown()
  });
  }

  sendToRenderer(channel, data) {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(channel, data);
    }
  }

  getWindowState() {
    return {
      isMaximized: Boolean(this.mainWindow?.isMaximized()),
      isFullScreen: Boolean(this.mainWindow?.isFullScreen())
    };
  }

  sendWindowState() {
    this.sendToRenderer('window:state', this.getWindowState());
  }

  lockDownWindow(win) {
    const rendererUrl = pathToFileURL(path.join(__dirname, '..', 'renderer')).toString();
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (event, url) => {
      if (!url.startsWith(rendererUrl)) event.preventDefault();
    });
    win.webContents.on('will-attach-webview', event => event.preventDefault());
  }

  createWindow() {
    const { app, BrowserWindow } = this.electron;
    const iconPath = app.isPackaged
      ? path.join(app.getAppPath(), 'icon.png')
      : path.join(__dirname, '..', '..', 'icon.png');
    const windowOptions = {
      width: 1280,
      height: 820,
      minWidth: 900,
      minHeight: 600,
      backgroundColor: '#f7f9fc',
      autoHideMenuBar: true,
      icon: iconPath,
      webPreferences: {
        preload: resolvePreloadPath('preload'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false
      }
    };
    if (this.platform === 'darwin') {
      windowOptions.titleBarStyle = 'hiddenInset';
      windowOptions.trafficLightPosition = { x: 18, y: 18 };
    } else {
      windowOptions.frame = false;
    }
    this.mainWindow = new BrowserWindow(windowOptions);
    this.lockDownWindow(this.mainWindow);
    this.mainWindow.webContents.on('render-process-gone', (_event, details) => {
      this.logger?.error('Renderer process gone', details);
    });
    this.mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
    if (this.updateService) this.updateService.setWindow(this.mainWindow);
    else this.updateService = new this.modules.UpdateService(this.mainWindow, {
      notify: (channel, payload) => this.sendToRenderer(channel, payload)
    });
    this.mainWindow.webContents.once('did-finish-load', () => {
      this.updateService.initialize();
      if (app.isPackaged) {
        this.stopStaleInstallWatch?.();
        this.stopStaleInstallWatch = startStaleInstallWatch({
          app,
          runningVersion: app.getVersion(),
          notify: payload => this.sendToRenderer('app:stale-install', payload)
        });
      }
      this.sendWindowState();
    });
    for (const event of ['maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen']) {
      this.mainWindow.on(event, () => this.sendWindowState());
    }
    this.mainWindow.on('closed', () => {
      this.mainWindow = null;
    });
    this.mainWindow.on('close', event => {
      if (this.allowWindowClose || !this.agentSessionService?.getActiveCount?.()) return;
      event.preventDefault();
      this.confirmAgentShutdown();
    });
  }

  async confirmAgentShutdown() {
    if (this.closeConfirmationPending) return;
    this.closeConfirmationPending = true;
    try {
      const result = await this.electron.dialog.showMessageBox(this.mainWindow, {
        type: 'warning',
        title: 'Agent sessions are still running',
        message: 'Stop active agents and quit GitTree?',
        detail: 'GitTree will interrupt each CLI, wait up to five seconds, then terminate remaining process trees.',
        buttons: ['Stop agents and quit', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        noLink: true
      });
      if (result.response !== 0) return;
      await this.agentSessionService.shutdown({ timeoutMs: 5000 });
      this.allowWindowClose = true;
      this.mainWindow?.close();
    } finally {
      this.closeConfirmationPending = false;
    }
  }

  focusMainWindow() {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;
    if (this.mainWindow.isMinimized()) this.mainWindow.restore();
    this.mainWindow.focus();
  }

  getGitService(repoPath) {
    return this.repositoryWorkspace.getGitService(repoPath);
  }

  async getHostingRepository(repoPath, provider) {
    const metadata = await this.getGitService(repoPath).getBranchMetadata();
    const remote = metadata.remotes.find(item => (
      item.provider?.provider === provider &&
      (
        (provider === 'github' && item.provider.host === 'github.com') ||
        (provider === 'gitlab' && item.provider.host === 'gitlab.com') ||
        provider === 'azure'
      )
    ));
    if (!remote?.provider) {
      throw new Error(`No supported ${provider} remote was found in this repository`);
    }
    const repository = { ...remote.provider, remoteName: remote.name };
    if (provider === 'azure') {
      const organization = remote.provider.organization || '';
      const project = remote.provider.project || '';
      if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/.test(organization)) {
        throw new Error('Unsupported Azure organization in remote URL');
      }
      if (!/^[^/\\:#%?&<>]{1,128}$/.test(project)) {
        throw new Error('Unsupported Azure project in remote URL');
      }
      repository.host = 'dev.azure.com';
    }
    return repository;
  }

  registerIpcHandlers() {
    const {
      app, BrowserWindow, ipcMain, dialog, nativeTheme, shell
    } = this.electron;
    const registry = createHandlerRegistry({
      handle: ipcMain.handle.bind(ipcMain),
      removeHandler: ipcMain.removeHandler.bind(ipcMain),
      assertManagedRepo: repoPath => this.repositoryWorkspace.assertManaged(repoPath)
    });
    const { registerHandler, registerManagedRepoHandler } = registry;
    this.disposeHandlers = registry.dispose;
    this.inspectorController = this.modules.createInspectorWindowController({
      BrowserWindow,
      getMainWindow: () => this.mainWindow,
      lockDownWindow: window => this.lockDownWindow(window),
      iconPath: () => app.isPackaged
        ? path.join(app.getAppPath(), 'icon.png')
        : path.join(__dirname, '..', '..', 'icon.png'),
      preloadPath: resolvePreloadPath('preload-inspector'),
      htmlPath: path.join(__dirname, '..', 'renderer', 'inspector-window.html'),
      sendToRenderer: (channel, payload) => this.sendToRenderer(channel, payload)
    });
    const diagnosticsExporter = new this.modules.DiagnosticsExporter({
      app,
      logger: this.logger,
      getGitVersion: this.modules.getGitVersion,
      showSaveDialog: options => dialog.showSaveDialog(this.mainWindow, options),
      getUpdateState: () => this.updateService?.getState() || { status: 'not-ready' },
      getRepositories: () => this.repositoryWorkspace.list()
    });
    registerWindowApplicationHandlers({
      registerHandler,
      registerManagedRepoHandler,
      getMainWindow: () => this.mainWindow,
      getWindowState: () => this.getWindowState(),
      setTheme: (theme, background) => {
        const safeTheme = theme === 'dark' ? 'dark' : 'light';
        nativeTheme.themeSource = safeTheme;
        if (this.mainWindow) {
          const safeBackground = /^#[0-9a-f]{6}$/i.test(background || '')
            ? background
            : (safeTheme === 'dark' ? '#000000' : '#f7f9fc');
          this.mainWindow.setBackgroundColor(safeBackground);
        }
        return safeTheme;
      },
      openExternal(url) {
        if (isSafeExternalUrl(url)) shell.openExternal(url);
      },
      openPath: repoPath => shell.openPath(repoPath),
      platform: this.platform,
      getAppVersion: () => app.getVersion(),
      getGitVersion: this.modules.getGitVersion,
      exportDiagnostics: () => diagnosticsExporter.export(),
      getUpdateService: () => this.updateService,
      isPackaged: app.isPackaged,
      showOpenDialog: (...args) => dialog.showOpenDialog(...args),
      authorizeDirectory: directoryPath => this.repositoryWorkspace.authorizeDirectory(directoryPath),
      openInspector: payload => this.inspectorController.open(payload),
      updateInspector: payload => this.inspectorController.update(payload)
    });
    registerGitHandlers({
      registerManagedRepoHandler,
      getGitService: repoPath => this.getGitService(repoPath),
      consumeAuthorizedDirectory: directoryPath => (
        this.repositoryWorkspace.consumeAuthorizedDirectory(directoryPath)
      ),
      authorizeCreatedRepository: repoPath => this.repositoryWorkspace.authorizeDirectory(repoPath),
      assertWorktreeRemovable: repoPath => this.agentSessionService.assertWorktreeRemovable(repoPath),
      sendToRenderer: (channel, payload) => this.sendToRenderer(channel, payload)
    });
    registerHostingHandlers({
      registerHandler,
      registerManagedRepoHandler,
      assertManagedRepo: repoPath => this.repositoryWorkspace.assertManaged(repoPath),
      getHostingRepository: (repoPath, provider) => this.getHostingRepository(repoPath, provider),
      getGitService: repoPath => this.getGitService(repoPath),
      hostingService: this.hostingService,
      credentialVault: this.credentialVault,
      buildPullRequestUrl: this.modules.buildPullRequestUrl,
      isSafeExternalUrl,
      openExternal: url => shell.openExternal(url)
    });
    registerRepositoryHandlers({
      registerHandler,
      repositoryWorkspace: this.repositoryWorkspace,
      consumeAuthorizedDirectory: directoryPath => (
        this.repositoryWorkspace.consumeAuthorizedDirectory(directoryPath)
      ),
      isWorkingTreeRepository: this.modules.isWorkingTreeRepository,
      createGitService: repoPath => new this.modules.GitService(repoPath),
      scanRepositories: this.modules.scanRepositories,
      sendToRenderer: (channel, payload) => this.sendToRenderer(channel, payload),
      logger: this.logger
    });
    registerAgentHandlers({
      registerHandler,
      registerManagedRepoHandler,
      agentSessionService: this.agentSessionService,
      repositoryWorkspace: this.repositoryWorkspace,
      showOpenDialog: (...args) => dialog.showOpenDialog(...args),
      getMainWindow: () => this.mainWindow
    });
    registerAiHandlers({
      registerHandler,
      registerManagedRepoHandler,
      aiService: this.aiService
    });
  }

  handleDeepLink(url) {
    const repoPath = this.modules.parseDeepLink(url);
    if (!repoPath) return;
    this.modules.isWorkingTreeRepository(repoPath).then(isRepository => {
      if (!isRepository) return;
      const repository = this.repositoryWorkspace.addTrustedRepository(repoPath);
      if (!repository) return;
      this.logger?.info('Repository opened via deep link', { path: repoPath });
      this.sendToRenderer('deep-link:open-repo', repository);
      this.focusMainWindow();
    });
  }

  async initialize() {
    const { app, Menu, nativeTheme, safeStorage, session, shell } = this.electron;
    app.setName('GitTree');
    app.setAppUserModelId('com.lorenzogit.gittree');
    nativeTheme.themeSource = 'light';
    if (this.platform === 'darwin' && app.dock) {
      app.dock.setIcon(path.join(__dirname, '..', '..', 'icon.png'));
    }
    this.logger = new this.modules.Logger(path.join(app.getPath('userData'), 'logs'));
    const logLevelArg = this.argv.find(argument => argument.startsWith('--log-level='));
    if (logLevelArg) {
      const levels = { debug: 0, info: 1, warn: 2, error: 3 };
      const requested = levels[logLevelArg.slice('--log-level='.length)];
      if (requested !== undefined) this.logger.setLevel(requested);
    }
    this.logger.info('GitTree started', { version: app.getVersion(), platform: this.platform });
    const userDataPath = app.getPath('userData');
    const workspaceConfigPath = path.join(userDataPath, 'repos.json');
    const conversion = this.modules.convertWorkspaceProfile({
      currentConfigPath: workspaceConfigPath,
      previousConfigPath: path.join(path.dirname(userDataPath), 'gittree-minimal', 'repos.json')
    });
    if (conversion.converted) {
      this.logger.info('Previous repository workspace converted', { source: conversion.source });
    } else if (conversion.error) {
      this.logger.warn?.('Repository workspace conversion failed', {
        error: conversion.error
      });
    }
    const repoManager = new this.modules.RepoManager({ configPath: workspaceConfigPath });
    this.repositoryWorkspace = new this.modules.RepositoryWorkspace({ repoStore: repoManager });
    this.agentSessionService = new this.modules.AgentSessionService({
      storagePath: path.join(app.getPath('userData'), 'agent-workspace.json'),
      repositoryWorkspace: this.repositoryWorkspace,
      createPty: this.modules.createPty,
      extraEnv: () => (this.aiService ? this.aiService.getAgentEnvironment() : {}),
      emit: (channel, payload) => this.sendToRenderer(channel, payload)
    });
    this.credentialVault = new this.modules.CredentialVault({
      storagePath: path.join(app.getPath('userData'), 'hosting-vault.bin'),
      safeStorage,
      platform: this.platform
    });
    this.aiService = new this.modules.AiService({
      storagePath: path.join(app.getPath('userData'), 'ai-settings.json'),
      vault: this.credentialVault,
      fetch,
      spawn: this.modules.createPty,
      resolveExecutable: resolveAgentExecutable,
      getStagedDiff: repoPath => this.getGitService(repoPath).getStagedDiff(),
      getUnstagedDiff: repoPath => this.getGitService(repoPath).getUnstagedDiff(),
      getBranchComparison: (repoPath, base, compare) => (
        this.getGitService(repoPath).getBranchComparison(base, compare)
      ),
      getConflictBlock: async (repoPath, file, blockIndex) => {
        const conflict = await this.getGitService(repoPath).readConflict(file);
        const block = conflict.blocks?.[blockIndex];
        if (!block) return null;
        return {
          file: conflict.path,
          base: block.base,
          current: block.current,
          incoming: block.incoming
        };
      },
      getCommitContext: async (repoPath, hash) => {
        const detail = await this.getGitService(repoPath).getCommitDetail(hash);
        if (!detail) return null;
        return {
          message: detail.message,
          author: detail.author_name,
          date: detail.date,
          diff: detail.diff
        };
      },
      getHistoryCandidates: async (repoPath, maxCount) => {
        const log = await this.getGitService(repoPath).getLog(maxCount);
        return (log?.all || []).map(commit => ({
          hash: commit.hash,
          subject: String(commit.message || '').split('\n')[0]
        }));
      },
      getBlameRows: async (repoPath, file, hash) => (
        (await this.getGitService(repoPath).getBlame(file, hash)).rows
      )
    });
    await this.aiService.initialize();
    this.hostingService = new this.modules.HostingService({
      vault: this.credentialVault,
      oauthConfig: this.modules.loadOAuthConfig(app),
      openExternal: url => shell.openExternal(url),
      onAuthState: state => this.sendToRenderer('auth:provider-state', state)
    });
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => {
      callback(false);
    });
    session.defaultSession.setPermissionCheckHandler(() => false);
    this.registerIpcHandlers();
    Menu.setApplicationMenu(null);
  }

  async teardown() {
    this.disposeHandlers();
    this.disposeHandlers = () => {};
    this.inspectorController?.destroy?.();
    this.inspectorController = null;
    this.updateService?.destroy?.();
    this.updateService = null;
    this.stopStaleInstallWatch?.();
    this.stopStaleInstallWatch = () => {};
    this.hostingService?.destroy?.();
    this.hostingService = null;
    this.agentSessionService?.destroy?.();
    this.agentSessionService = null;
    this.aiService = null;
    if (this.mainWindow && !this.mainWindow.isDestroyed()) this.mainWindow.destroy();
    this.mainWindow = null;
  }

  handleUnhandledRejection(error) {
    const message = error instanceof Error ? (error.stack || error.message) : String(error);
    console.error('[GitTree] Unhandled rejection:', message);
    this.logger?.error('Unhandled rejection', { message });
  }

  handleUncaughtException(error) {
    console.error('[GitTree] Uncaught exception:', error);
    this.logger?.error('Uncaught exception', {
      message: error instanceof Error ? error.message : String(error)
    });
  }

  attachProcessListeners() {
    if (this.processListenersAttached) return;
    this.processListenersAttached = true;
    this.processHost.on('unhandledRejection', this.handleUnhandledRejection);
    this.processHost.on('uncaughtException', this.handleUncaughtException);
  }

  detachProcessListeners() {
    if (!this.processListenersAttached) return;
    this.processListenersAttached = false;
    this.processHost.removeListener('unhandledRejection', this.handleUnhandledRejection);
    this.processHost.removeListener('uncaughtException', this.handleUncaughtException);
  }

  async start() {
    this.attachProcessListeners();
    try {
      const started = await this.runtime.start();
      if (!started) this.detachProcessListeners();
      return started;
    } catch (error) {
      this.detachProcessListeners();
      throw error;
    }
  }

  async stop() {
    this.detachProcessListeners();
    await this.runtime.stop();
  }
}
