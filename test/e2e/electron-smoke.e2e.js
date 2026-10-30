/* global document, getComputedStyle, MutationObserver, window */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { _electron: electron } = require('playwright');
const { createElectronFixture } = require('../helpers/electron-fixture');

const projectRoot = path.resolve(__dirname, '..', '..');

async function capturePanelMotion(page, buttonId, panelId, expectedAnimationName, expectedClass) {
  await page.evaluate(({ id, expectedName, lifecycleClass }) => {
    const panel = document.getElementById(id);
    const workspace = document.getElementById('workspace-body');
    window.__panelMotionCapture = null;
    const observer = new MutationObserver(() => {
      if (!workspace.classList.contains(lifecycleClass)) return;
      const animationNames = getComputedStyle(panel).animationName.split(',').map(value => value.trim());
      window.__panelMotionCapture = {
        animationName: animationNames.includes(expectedName) ? expectedName : animationNames.join(','),
        lifecycleClass,
        motionState: panel.dataset.motionState,
        workspaceTransitionProperty: getComputedStyle(workspace).transitionProperty
      };
      observer.disconnect();
    });
    observer.observe(workspace, { attributes: true, attributeFilter: ['class'] });
  }, { id: panelId, expectedName: expectedAnimationName, lifecycleClass: expectedClass });
  await page.locator(buttonId).click();
  await page.waitForFunction(lifecycleClass => (
    window.__panelMotionCapture?.lifecycleClass === lifecycleClass
  ), expectedClass, { timeout: 5000 });
  return page.evaluate(() => window.__panelMotionCapture);
}

test('Electron opens a deep-linked repository and renders its deterministic history', async t => {
  const fixture = createElectronFixture({ withRemote: true });
  let application;
  let page;
  let failed = false;

  t.after(async () => {
    if (application) await application.close();
    fixture.cleanup();
  });

  try {
    application = await electron.launch({
      args: [
        projectRoot,
        '--no-sandbox',
        '--force-device-scale-factor=0.75',
        `--user-data-dir=${fixture.userData}`,
        fixture.deepLink
      ],
      cwd: projectRoot
    });
    await application.context().tracing.start({ screenshots: true, snapshots: true });
    page = await application.firstWindow();
    await page.locator('.repo-tab.active').waitFor({ timeout: 60000 });
    await page.locator('.graph-row').first().waitFor({ timeout: 60000 });
    await page.waitForFunction(() => (
      document.getElementById('workspace')?.dataset.loadState === 'settled'
    ), null, { timeout: 60000 });
    assert.ok(await page.evaluate(() => window.innerWidth > 1120));

    assert.equal(await page.locator('.repo-tab.active').count(), 1);
    assert.equal(await page.locator('#workspace').getAttribute('aria-busy'), 'false');
    assert.match(
      await page.locator('.repo-tab.active .repo-tab-name').getAttribute('title'),
      /repo/i
    );
    assert.ok(await page.locator('.graph-row').count() < 100);
    assert.match(await page.locator('.graph-row').first().innerText(), /Initial fixture commit/);

    const activeRepoTab = page.locator('.repo-tab.active');
    const pinTab = activeRepoTab.locator('.repo-tab-pin');
    await pinTab.click();
    assert.equal(await activeRepoTab.getAttribute('class'), 'repo-tab active is-pinned');
    assert.equal(await pinTab.getAttribute('aria-pressed'), 'true');
    assert.match(
      await page.evaluate(() => localStorage.getItem('gittree.repo-tabs.layout') || ''),
      /pinned/
    );

    await page.emulateMedia({ reducedMotion: 'no-preference' });
    assert.equal(await page.evaluate(() => (
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    )), false);
    const inspector = page.locator('#detail-panel');
    if (await inspector.evaluate(element => getComputedStyle(element).display === 'none')) {
      await page.locator('#btn-toggle-inspector').click();
      await page.waitForFunction(() => (
        getComputedStyle(document.getElementById('detail-panel')).display !== 'none'
      ));
    }
    await inspector.evaluate(async element => {
      await Promise.allSettled(element.getAnimations().map(animation => animation.finished));
    });
    await page.evaluate(() => {
      window.__sidebarToggleGraphRow = document.querySelector('.graph-row');
    });

    const panelMotions = [
      ['#btn-toggle-sidebar', 'sidebar', 'motion-panel-exit-left', 'is-sidebar-closing', 'closing'],
      ['#btn-toggle-sidebar', 'sidebar', 'motion-panel-enter-left', 'is-sidebar-opening', 'opening'],
      ['#btn-toggle-inspector', 'detail-panel', 'motion-panel-exit-right', 'is-inspector-closing', 'closing'],
      ['#btn-toggle-inspector', 'detail-panel', 'motion-panel-enter-right', 'is-inspector-opening', 'opening']
    ];
    for (const [buttonId, panelId, expectedName, expectedClass, expectedState] of panelMotions) {
      const motion = await capturePanelMotion(
        page, buttonId, panelId, expectedName, expectedClass
      );
      assert.equal(motion.animationName, expectedName);
      assert.equal(motion.motionState, expectedState);
      assert.equal(motion.workspaceTransitionProperty, 'none');
      if (panelId === 'sidebar' && expectedState === 'closing') {
        await page.waitForFunction(() => (
          document.getElementById('sidebar')?.dataset.motionState === 'idle'
        ));
        const isolatedSurfaces = await page.evaluate(() => {
          const main = document.querySelector('.workspace-body > .main');
          const inspector = document.getElementById('detail-panel');
          return {
            mainWidth: main.getBoundingClientRect().width,
            inspectorWidth: inspector.getBoundingClientRect().width,
            graphPreserved: document.querySelector('.graph-row') === window.__sidebarToggleGraphRow
          };
        });
        assert.ok(isolatedSurfaces.mainWidth >= 360);
        assert.ok(isolatedSurfaces.inspectorWidth >= 300);
        assert.equal(isolatedSurfaces.graphPreserved, true);
      }
    }

    await page.locator('.graph-row').first().click();
    await page.locator('#detail-meta:not(.is-hidden) #detail-files:not(:empty)').waitFor();
    const inspectorLayout = await page.evaluate(() => {
      const heading = document.querySelector('.detail-heading-row').getBoundingClientRect();
      const toolbar = document.querySelector('.detail-view-toolbar').getBoundingClientRect();
      const title = document.getElementById('detail-title').getBoundingClientRect();
      const controls = document.querySelector('.detail-window-controls').getBoundingClientRect();
      return {
        headingBottom: heading.bottom,
        toolbarTop: toolbar.top,
        titleRight: title.right,
        controlsLeft: controls.left,
        title: document.getElementById('detail-title').textContent,
        meta: document.getElementById('detail-meta').textContent
      };
    });
    assert.ok(inspectorLayout.headingBottom <= inspectorLayout.toolbarTop + 1);
    assert.ok(inspectorLayout.titleRight <= inspectorLayout.controlsLeft);
    assert.match(inspectorLayout.title, /Initial fixture commit/);
    assert.match(inspectorLayout.meta, /file/);

    await page.locator('#btn-maximize-inspector').click();
    await page.locator('#workspace-body.inspector-maximized').waitFor();
    const maximizedInspector = await page.evaluate(() => ({
      titleSize: getComputedStyle(document.getElementById('detail-title')).fontSize,
      bodyPadding: getComputedStyle(document.getElementById('detail-body')).paddingTop,
      splitActive: document.getElementById('btn-diff-split').classList.contains('active'),
      graphDisplay: getComputedStyle(document.getElementById('inspector-graph-panel')).display,
      filesDisplay: getComputedStyle(document.getElementById('inspector-files-panel')).display,
      graphRows: document.querySelectorAll('.inspector-graph-row').length,
      fileItems: document.querySelectorAll('.inspector-file-item').length,
      graphText: document.querySelector('.inspector-graph-row')?.innerText || ''
    }));
    assert.equal(maximizedInspector.titleSize, '20px');
    assert.equal(maximizedInspector.bodyPadding, '20px');
    assert.equal(maximizedInspector.splitActive, true);
    assert.equal(maximizedInspector.graphDisplay, 'flex');
    assert.equal(maximizedInspector.filesDisplay, 'flex');
    assert.ok(maximizedInspector.graphRows >= 1);
    assert.ok(maximizedInspector.fileItems >= 1);
    assert.match(maximizedInspector.graphText, /Initial fixture commit/);

    await page.locator('.inspector-graph-row').first().hover();
    await page.locator('.inspector-commit-tooltip.is-visible').waitFor();
    assert.match(
      await page.locator('.inspector-commit-tooltip').innerText(),
      /main|Initial fixture commit/i
    );
    await page.locator('.inspector-file-item').first().click();
    await page.locator('.diff-file-block.is-file-target').waitFor();
    assert.equal(
      await page.locator('.inspector-file-item').first().getAttribute('aria-selected'),
      'true'
    );
    await page.locator('#btn-toggle-inspector-files').click();
    assert.equal(
      await page.locator('#inspector-workspace').evaluate(element => (
        element.classList.contains('files-collapsed')
      )),
      true
    );
    await page.locator('#btn-toggle-inspector-files').click();
    await page.locator('#btn-maximize-inspector').click();
    await page.waitForFunction(() => (
      !document.getElementById('workspace-body').classList.contains('inspector-maximized')
    ));

    const detachedWindowPromise = application.waitForEvent('window');
    await page.locator('#btn-popout-inspector').click();
    const detachedInspector = await detachedWindowPromise;
    await detachedInspector.locator('.inspector-window-header').waitFor();
    await detachedInspector.locator('.diff-file-block').first().waitFor();
    await detachedInspector.locator('.inspector-file-item').first().waitFor();
    const detachedLayout = await detachedInspector.evaluate(() => ({
      width: window.innerWidth,
      title: document.getElementById('inspector-title').textContent,
      meta: document.getElementById('inspector-meta').textContent,
      contentPadding: getComputedStyle(document.getElementById('inspector-body')).paddingTop,
      diffBlocks: document.querySelectorAll('.diff-file-block').length,
      fileItems: document.querySelectorAll('.inspector-file-item').length,
      hasGraph: Boolean(document.getElementById('inspector-graph-panel')),
      filesDisplay: getComputedStyle(document.getElementById('inspector-files-panel')).display
    }));
    assert.ok(detachedLayout.width >= 900);
    assert.match(detachedLayout.title, /Initial fixture commit/);
    assert.match(detachedLayout.meta, /file/);
    assert.equal(detachedLayout.contentPadding, '20px');
    assert.ok(detachedLayout.diffBlocks >= 1);
    assert.ok(detachedLayout.fileItems >= 1);
    assert.equal(detachedLayout.hasGraph, false);
    assert.equal(detachedLayout.filesDisplay, 'flex');
    // The detached window renders the diff itself, so its layout controls work.
    await detachedInspector.locator('#inspector-mode-split').click();
    await detachedInspector.locator('#inspector-body .diff-split').waitFor();
    await detachedInspector.close();

    const branchSearch = page.locator('#branch-search');
    const branchSearchVisible = await branchSearch.isVisible();
    if (branchSearchVisible) {
      await branchSearch.fill('feature');
      await page.locator('#graph-view').getByText('feature/known-branch', { exact: true }).waitFor();
    }

    await page.evaluate(() => {
      const telemetry = { openRepoCalls: 0, loadStates: [] };
      const implementation = window.app.openRepo.bind(window.app);
      window.app.openRepo = (...args) => {
        telemetry.openRepoCalls += 1;
        return implementation(...args);
      };
      new MutationObserver(() => {
        telemetry.loadStates.push(document.getElementById('workspace')?.dataset.loadState);
      }).observe(document.getElementById('workspace'), {
        attributes: true,
        attributeFilter: ['data-load-state']
      });
      window.__remoteActionTelemetry = telemetry;
      window.__remoteActionGraphRow = document.querySelector('.graph-row');
      document.querySelector('.graph-view').scrollTop = 0;
    });
    await page.locator('#btn-fetch').click();
    await page.waitForFunction(() => (
      document.getElementById('btn-fetch')?.getAttribute('aria-busy') === 'true'
    ));
    await page.waitForFunction(() => (
      document.getElementById('btn-fetch')?.getAttribute('aria-busy') === 'false'
    ));
    const remoteActionTelemetry = await page.evaluate(() => ({
      ...window.__remoteActionTelemetry,
      graphRowPreserved: document.querySelector('.graph-row') === window.__remoteActionGraphRow,
      branchFilter: document.getElementById('branch-search')?.value,
      graphScrollTop: document.querySelector('.graph-view').scrollTop
    }));
    assert.equal(remoteActionTelemetry.openRepoCalls, 0);
    assert.equal(remoteActionTelemetry.loadStates.includes('loading'), false);
    assert.equal(remoteActionTelemetry.graphRowPreserved, true);
    assert.equal(remoteActionTelemetry.graphScrollTop, 0);
    assert.equal(remoteActionTelemetry.branchFilter, branchSearchVisible ? 'feature' : '');
    if (branchSearchVisible) await branchSearch.fill('');

    await page.getByRole('tab', { name: /Changes|Modifiche/ }).click();
    await page.locator('#changes-view:not(.is-hidden)').waitFor();
    await page.getByText('dirty.txt', { exact: true }).waitFor();
    assert.match(await page.locator('#changes-view').innerText(), /dirty\.txt/);

    await page.locator('#btn-settings').click();
    await page.locator('.settings-dialog .settings-nav').waitFor();
    const settingsLayout = await page.evaluate(() => {
      const dialog = document.querySelector('.settings-dialog');
      const navigation = document.querySelector('.settings-nav');
      const content = document.querySelector('.settings-scroll');
      return {
        dialogWidth: dialog.getBoundingClientRect().width,
        navigationWidth: navigation.getBoundingClientRect().width,
        contentPadding: getComputedStyle(content).paddingTop,
        activeSections: document.querySelectorAll('.settings-section.is-active:not([hidden])').length,
        activeNavigation: document.querySelector('[data-settings-nav].is-active')?.dataset.settingsNav
      };
    });
    assert.ok(settingsLayout.dialogWidth >= 900);
    assert.ok(settingsLayout.navigationWidth >= 200);
    assert.equal(settingsLayout.contentPadding, '32px');
    assert.equal(settingsLayout.activeSections, 1);
    assert.equal(settingsLayout.activeNavigation, 'appearance');
    await page.locator('[data-theme-choice="dark"]').click();
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
    assert.notEqual(
      await page.locator('.settings-nav').evaluate(element => getComputedStyle(element).backgroundColor),
      'rgba(0, 0, 0, 0)'
    );
    await page.locator('[data-theme-choice="light"]').click();
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
    await page.locator('[data-settings-nav="about"]').click();
    await page.locator('[data-settings-section="about"]:not([hidden])').waitFor();
    const diagnosticsButton = page.getByRole('button', {
      name: /Export diagnostics|Esporta diagnostica/
    });
    await diagnosticsButton.waitFor();
    assert.equal(await diagnosticsButton.isEnabled(), true);
    await page.getByText(/privacy-redacted ZIP|ZIP anonimizzato/).waitFor();

    await page.locator('[data-settings-close]').click();
    await page.evaluate(() => {
      window.__dialogResult = 'pending';
      window.app.dialogs.confirm({
        title: 'Accessibility contract',
        message: 'Keyboard cancellation must restore the workspace.',
        cancelLabel: 'Cancel',
        actionLabel: 'Continue'
      }).then(value => { window.__dialogResult = value; });
    });
    await page.getByRole('dialog', { name: 'Accessibility contract' }).waitFor();
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => window.__dialogResult === false);
    assert.equal(await page.getByRole('dialog').count(), 0);
  } catch (error) {
    failed = true;
    const artifactDirectory = path.join(projectRoot, 'test-results', 'electron-smoke');
    fs.mkdirSync(artifactDirectory, { recursive: true });
    const diagnostics = [];
    if (page) {
      await page.screenshot({
        path: path.join(artifactDirectory, 'failure.png'),
        fullPage: true
      }).catch(() => {});
      diagnostics.push(await page.evaluate(() => ({
        repo: window.app?.state?.repo?.path || null,
        tabs: window.app?.components?.repoTabs?.repos?.map(repo => repo.path) || [],
        activeIndex: window.app?.state?.activeRepoIndex ?? null,
        loadState: document.getElementById('workspace')?.dataset.loadState || null,
        busy: document.getElementById('workspace')?.getAttribute('aria-busy') || null,
        bodyText: document.body.innerText.slice(0, 500)
      })).catch(diagError => ({ evaluateFailed: String(diagError) })));
    }
    if (application) {
      diagnostics.push(await application.evaluate(() => ({
        argv: process.argv.slice(1),
        cwd: process.cwd()
      })).catch(mainError => ({ mainEvaluateFailed: String(mainError) })));
      const logPath = path.join(fixture.userData, 'logs', 'gittree.log');
      if (fs.existsSync(logPath)) {
        diagnostics.push({ mainLog: fs.readFileSync(logPath, 'utf8').slice(-2000) });
      }
      await application.context().tracing.stop({
        path: path.join(artifactDirectory, 'trace.zip')
      }).catch(() => {});
    }
    console.error('E2E diagnostics:', JSON.stringify(diagnostics, null, 2));
    throw error;
  } finally {
    if (!failed && application) await application.context().tracing.stop();
  }
});

test('Electron welcome is full-bleed and exposes only About and updates', async t => {
  const fixture = createElectronFixture();
  let application;

  t.after(async () => {
    if (application) await application.close();
    fixture.cleanup();
  });

  application = await electron.launch({
    args: [
      projectRoot,
      '--no-sandbox',
      '--force-device-scale-factor=0.75',
      `--user-data-dir=${fixture.userData}`
    ],
    cwd: projectRoot
  });
  const page = await application.firstWindow();
  await page.locator('#welcome-screen:not(.is-hidden)').waitFor({ timeout: 60000 });

  const welcomeLayout = await page.locator('.welcome-card').evaluate(element => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      borderWidths: [
        style.borderTopWidth,
        style.borderRightWidth,
        style.borderBottomWidth,
        style.borderLeftWidth
      ],
      borderRadius: style.borderRadius,
      boxShadow: style.boxShadow,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      viewport: { width: window.innerWidth, height: window.innerHeight }
    };
  });
  assert.deepEqual(welcomeLayout.borderWidths, ['0px', '0px', '0px', '0px']);
  assert.equal(welcomeLayout.borderRadius, '0px');
  assert.equal(welcomeLayout.boxShadow, 'none');
  assert.equal(welcomeLayout.rect.x, 0);
  assert.equal(welcomeLayout.rect.y, 0);
  assert.ok(Math.abs(welcomeLayout.rect.width - welcomeLayout.viewport.width) <= 1);
  assert.ok(Math.abs(welcomeLayout.rect.height - welcomeLayout.viewport.height) <= 1);

  await page.waitForFunction(() => (
    typeof document.getElementById('btn-welcome-settings')?.onclick === 'function'
  ));
  const welcomeSettings = page.getByRole('button', { name: /Settings|Impostazioni/ });
  await welcomeSettings.click();
  await page.locator('.settings-dialog.settings-dialog-about').waitFor();
  assert.equal(await page.locator('[data-settings-section]').count(), 1);
  assert.equal(await page.locator('[data-settings-section="about"]').count(), 1);
  assert.equal(await page.locator('[data-settings-section="appearance"]').count(), 0);
  assert.equal(await page.locator('#btn-check-update').isVisible(), true);
  assert.equal(await page.locator('#btn-export-diagnostics').count(), 0);
});

test('Electron runs a fixture agent in an isolated worktree and blocks dirty removal', async t => {
  const fixture = createElectronFixture();
  const agentRoot = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'gittree-agent-root-'));
  const cliRoot = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'gittree-agent-cli-'));
  const fixtureScript = path.join(cliRoot, 'fixture-agent.js');
  fs.writeFileSync(fixtureScript, [
    "process.stdout.write('fixture-ready\\n');",
    "process.stdin.on('data', data => process.stdout.write('echo:' + data));",
    'setInterval(() => {}, 1000);'
  ].join('\n'));
  if (process.platform === 'win32') {
    fs.copyFileSync(process.execPath, path.join(cliRoot, 'codex.exe'));
  } else {
    fs.symlinkSync(process.execPath, path.join(cliRoot, 'codex'));
  }
  fs.writeFileSync(path.join(fixture.userData, 'agent-workspace.json'), JSON.stringify({
    version: 1,
    settings: {
      worktreeRoot: agentRoot,
      maxConcurrent: 4,
      enabledAdapters: ['codex', 'claude', 'opencode']
    },
    tasks: []
  }));
  let application;
  const processOutput = [];
  t.after(async () => {
    if (application) await application.close().catch(() => {});
    fixture.cleanup();
    fs.rmSync(agentRoot, { recursive: true, force: true });
    fs.rmSync(cliRoot, { recursive: true, force: true });
  });

  application = await electron.launch({
    args: [projectRoot, '--no-sandbox', `--user-data-dir=${fixture.userData}`, fixture.deepLink],
    cwd: projectRoot,
    env: { ...process.env, PATH: `${cliRoot}${path.delimiter}${process.env.PATH || ''}` }
  });
  application.process().stdout?.on('data', chunk => processOutput.push(String(chunk)));
  application.process().stderr?.on('data', chunk => processOutput.push(String(chunk)));
  const page = await application.firstWindow();
  page.on('crash', () => {
    const logPath = path.join(fixture.userData, 'logs', 'gittree.log');
    const mainLog = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').slice(-4000) : '';
    console.error('Agent E2E renderer crashed', { processOutput, mainLog });
  });
  await page.locator('.repo-tab.active').waitFor({ timeout: 60000 });
  await page.waitForFunction(() => document.getElementById('workspace')?.dataset.loadState === 'settled');
  await page.locator('[data-sidebar-mode="agents"]').click();
  await page.locator('#btn-new-agent-session').click();
  await page.getByRole('dialog').waitFor();
  await page.locator('input[name="title"]').fill('Fixture agent');
  await page.locator('textarea[name="prompt"]').fill(fixtureScript);
  await page.locator('select[name="adapterId"]').selectOption('codex');
  await page.getByRole('dialog').locator('button[type="submit"]').click();
  await page.locator('#agent-drawer:not(.is-hidden)').waitFor({ timeout: 60000 });
  await page.locator('[data-agent-drawer-tab="terminal"]').click();
  await page.waitForFunction(() => (
    window.app.components.worktreeAgents.terminal?.buffer.active
      .getLine(0)?.translateToString(true).includes('fixture-ready')
  ), null, { timeout: 60000 });
  await page.locator('.xterm-helper-textarea').click();
  await page.keyboard.type('hello');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => (
    Array.from(
      { length: window.app.components.worktreeAgents.terminal?.buffer.active.length || 0 },
      (_value, index) => window.app.components.worktreeAgents.terminal.buffer.active
        .getLine(index)?.translateToString(true) || ''
    ).join('\n').includes('echo:hello')
  ), null, { timeout: 10000 });
  const resizeResult = await page.evaluate(() => {
    const taskId = window.app.components.worktreeAgents.selectedTaskId;
    return window.gitTree.resizeAgentTerminal(taskId, 110, 35);
  });
  assert.equal(resizeResult?.error, undefined);
  await page.locator('#btn-stop-agent').click();
  await page.waitForFunction(() => {
    const panel = window.app.components.worktreeAgents;
    return panel.tasks.find(task => task.id === panel.selectedTaskId)?.status === 'stopped';
  }, null, { timeout: 10000 });

  const paths = await page.evaluate(() => {
    const panel = window.app.components.worktreeAgents;
    const task = panel.tasks.find(item => item.id === panel.selectedTaskId);
    return { repositoryPath: task.repositoryPath, worktreePath: task.worktreePath };
  });
  fs.writeFileSync(path.join(paths.worktreePath, 'dirty-agent.txt'), 'dirty\n');
  const removal = await page.evaluate(({ repositoryPath, worktreePath }) => (
    window.gitTree.removeWorktree(repositoryPath, worktreePath)
  ), paths);
  assert.match(removal.error, /modified|untracked|working tree|worktree/i);
});
