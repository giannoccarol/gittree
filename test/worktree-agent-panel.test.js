const test = require('node:test');
const assert = require('node:assert/strict');

let WorktreeAgentPanel;
try {
  const mod = require('../src/renderer/components/worktree-agent-panel.mts');
  WorktreeAgentPanel = mod.WorktreeAgentPanel || mod.default || mod;
} catch {
  WorktreeAgentPanel = require('../src/renderer/components/worktree-agent-panel');
}

class ClassList {
  constructor() { this.values = new Set(); }
  add(name) { this.values.add(name); }
  remove(name) { this.values.delete(name); }
  toggle(name, force) {
    if (force) this.values.add(name); else this.values.delete(name);
  }
  contains(name) { return this.values.has(name); }
}

function element(extra = {}) {
  return {
    classList: new ClassList(),
    dataset: {},
    attributes: {},
    setAttribute(name, value) { this.attributes[name] = value; },
    toggleAttribute(name, force) { if (force) this.attributes[name] = ''; else delete this.attributes[name]; },
    querySelectorAll() { return []; },
    ...extra
  };
}

function harness(t) {
  const modeButtons = [
    element({ dataset: { sidebarMode: 'repository' } }),
    element({ dataset: { sidebarMode: 'agents' } })
  ];
  const elements = {
    'sidebar-mode-switch': element(),
    'sidebar-branches-area': element(),
    'agent-sidebar': element(),
    'btn-new-branch': element(),
    'agent-card-list': element({ innerHTML: '' }),
    'agent-status-filter': element({ value: '' }),
    'agent-provider-filter': element({ value: '' }),
    'btn-new-agent-session': element(),
    'agent-drawer': element(),
    'worktree-list': element({ innerHTML: '', querySelectorAll: () => [] }),
    'worktree-count': element({ textContent: '' })
  };
  const pinned = element();
  const heading = element({ textContent: '' });
  const previousDocument = global.document;
  const previousTranslate = global.t;
  const previousEncoder = global.HtmlEncoder;
  global.t = key => key;
  global.HtmlEncoder = { encode: value => String(value) };
  global.document = {
    getElementById: id => elements[id],
    querySelectorAll: selector => selector === '[data-sidebar-mode]' ? modeButtons : [],
    querySelector: selector => {
      if (selector === '.sidebar-pinned-bottom') return pinned;
      if (selector === '[data-sidebar-mode="agents"]') return modeButtons[1];
      return heading;
    }
  };
  t.after(() => {
    global.document = previousDocument;
    global.t = previousTranslate;
    global.HtmlEncoder = previousEncoder;
  });
  const app = { pathKey: value => String(value).toLowerCase() };
  return { panel: new WorktreeAgentPanel(app), modeButtons, elements, pinned, heading };
}

test('sidebar toggle keeps Repository and Agents surfaces mutually exclusive', t => {
  const { panel, modeButtons, elements, pinned, heading } = harness(t);
  panel.setMode('agents');
  assert.equal(elements['sidebar-branches-area'].classList.contains('is-hidden'), true);
  assert.equal(elements['agent-sidebar'].classList.contains('is-hidden'), false);
  assert.equal(pinned.classList.contains('is-hidden'), true);
  assert.equal(modeButtons[1].attributes['aria-selected'], 'true');
  assert.equal(heading.textContent, 'agents.agents');

  panel.setMode('repository');
  assert.equal(elements['sidebar-branches-area'].classList.contains('is-hidden'), false);
  assert.equal(pinned.classList.contains('is-hidden'), false);
});

test('agent cards filter providers and prefer the active task for a worktree', t => {
  const { panel, elements } = harness(t);
  panel.repo = { path: 'C:\\repo' };
  panel.worktrees = [{ path: 'C:\\repo', branch: 'main' }];
  panel.tasks = [
    { id: 'old', worktreePath: 'C:\\repo', adapterId: 'claude', status: 'completed', updatedAt: '1' },
    { id: 'live', worktreePath: 'C:\\repo', adapterId: 'codex', status: 'running', updatedAt: '2', title: 'Live' }
  ];
  assert.equal(panel.associatedTask('c:\\REPO').id, 'live');
  elements['agent-provider-filter'].value = 'claude';
  panel.renderAgents();
  assert.match(elements['agent-card-list'].innerHTML, /agents\.noSessions/);
  elements['agent-provider-filter'].value = 'codex';
  panel.renderAgents();
  assert.match(elements['agent-card-list'].innerHTML, /Live/);
});

test('agent card keyboard activation opens the selected task', async t => {
  const { panel } = harness(t);
  panel.tasks = [{ id: 'task', worktreePath: 'C:\\repo' }];
  let activated = '';
  panel.activateTask = async task => { activated = task.id; };
  const card = element({
    dataset: { taskId: 'task', worktreePath: 'C:\\repo' },
    querySelectorAll: () => []
  });
  panel.bindAgentCard(card);
  let prevented = false;
  card.onkeydown({ key: 'Enter', target: { closest: () => null }, preventDefault: () => { prevented = true; } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(prevented, true);
  assert.equal(activated, 'task');
});

test('disabling agent sessions hides the mode and removes launch controls', t => {
  const { panel, modeButtons, elements } = harness(t);
  panel.repo = { path: 'C:\\repo' };
  panel.worktrees = [{ path: 'C:\\repo', branch: 'main' }];
  panel.setMode('agents');
  panel.applyEnabledState(false);
  assert.equal(panel.mode, 'repository');
  assert.equal(elements['sidebar-mode-switch'].classList.contains('is-hidden'), true);
  assert.equal(elements['sidebar-mode-switch'].attributes['aria-hidden'], 'true');
  assert.equal(modeButtons[1].classList.contains('is-hidden'), true);
  assert.equal(modeButtons[1].attributes['aria-disabled'], 'true');
  assert.equal(elements['agent-drawer'].classList.contains('is-hidden'), true);
  assert.doesNotMatch(elements['worktree-list'].innerHTML, /data-action="agent"/);

  panel.applyEnabledState(true);
  assert.equal(elements['sidebar-mode-switch'].classList.contains('is-hidden'), false);
  assert.equal(elements['sidebar-mode-switch'].attributes['aria-hidden'], 'false');
  assert.equal(modeButtons[1].classList.contains('is-hidden'), false);
  assert.equal(modeButtons[1].attributes['aria-disabled'], 'false');
});

test('terminal data is buffered until the task is selected and the terminal attaches', t => {
  const { panel } = harness(t);
  const writes = [];
  const terminal = { write: data => writes.push(data) };

  panel.onTerminalData({ taskId: 'early', data: 'fixture-ready\r\n' });
  panel.onTerminalData({ taskId: 'other', data: 'ignored' });
  assert.equal(panel.pendingTerminalData.get('early').parts.join(''), 'fixture-ready\r\n');

  panel.terminal = terminal;
  panel.selectedTaskId = 'early';
  panel.flushTerminalData();
  assert.deepEqual(writes, ['fixture-ready\r\n']);
  assert.equal(panel.pendingTerminalData.has('early'), false);

  panel.onTerminalData({ taskId: 'early', data: 'echo:hello\r\n' });
  assert.deepEqual(writes, ['fixture-ready\r\n', 'echo:hello\r\n']);
  assert.equal(panel.pendingTerminalData.has('early'), false);

  panel.selectedTaskId = 'other';
  panel.onTerminalData({ taskId: 'early', data: 'later' });
  assert.equal(panel.pendingTerminalData.get('early').parts.join(''), 'later');
  assert.deepEqual(writes.slice(1), ['echo:hello\r\n']);
});
