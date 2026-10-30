const test = require('node:test');
const assert = require('node:assert/strict');
const { createElement, installGraphViewDom } = require('./helpers/graph-view-harness');
const { CommitSummary } = require('../src/renderer/components/commit-summary.mts');

function walk(node, visit) {
  visit(node);
  for (const child of node.children || []) walk(child, visit);
}

function find(root, predicate) {
  const found = [];
  walk(root, node => { if (predicate(node)) found.push(node); });
  return found;
}

function setup() {
  const dom = installGraphViewDom();
  const container = createElement('div');
  const calls = [];
  const summary = new CommitSummary({
    container,
    translate: (key, options) => (options?.hash ? `${key}:${options.hash}` : key),
    onCopyHash: hash => calls.push(['copy', hash]),
    onCreateBranch: hash => calls.push(['branch', hash]),
    onMoreActions: (hash, anchor) => calls.push(['more', hash, anchor.dataset.summaryAction]),
    onSelectCommit: hash => calls.push(['select', hash]),
    onNavigate: direction => calls.push(['navigate', direction])
  });
  summary.mount();
  const click = node => container.dispatch('click', { target: { closest: () => node } });
  container.contains = () => true;
  return { ...dom, container, summary, calls, click };
}

const STATE = {
  hash: 'a'.repeat(40),
  body: 'Explain why.\n\nDetails.',
  parents: ['b'.repeat(40), 'c'.repeat(40)],
  refs: [{ shortName: 'main', type: 'branch' }, { shortName: 'v1.0.0', type: 'tag' }],
  canGoNewer: false,
  canGoOlder: true
};

test('the summary renders refs, parents, body and actions for a commit', () => {
  const { container, summary, calls, click, restore } = setup();
  try {
    assert.ok(container.classList.contains('is-hidden'));
    summary.update(STATE);
    assert.equal(container.classList.contains('is-hidden'), false);

    const badges = find(container, node => /^badge /.test(node.className));
    assert.deepEqual(badges.map(node => [node.className, node.textContent]), [
      ['badge badge-branch', 'main'],
      ['badge badge-tag', 'v1.0.0']
    ]);
    const parents = find(container, node => node.className === 'detail-commit-parent');
    assert.deepEqual(parents.map(node => node.textContent), ['bbbbbbb', 'ccccccc']);
    assert.equal(find(container, node => node.className === 'detail-commit-parents-label')[0].textContent, 'details.parents');
    assert.equal(find(container, node => /detail-commit-body\b/.test(node.className))[0].textContent, STATE.body);

    const steps = find(container, node => /detail-commit-step/.test(node.className));
    assert.deepEqual(steps.map(node => [node.dataset.summaryAction, Boolean(node.disabled)]), [['newer', true], ['older', false]]);

    for (const action of ['copy', 'branch', 'more', 'older']) {
      click(find(container, node => node.dataset?.summaryAction === action)[0]);
    }
    click(parents[1]);
    assert.deepEqual(calls, [
      ['copy', STATE.hash],
      ['branch', STATE.hash],
      ['more', STATE.hash, 'more'],
      ['navigate', 'older'],
      ['select', 'c'.repeat(40)]
    ]);

    summary.update(null);
    assert.ok(container.classList.contains('is-hidden'));
    assert.equal(container.children.length, 0);
  } finally {
    restore();
  }
});

test('a long body starts clamped and expands on request until another commit is shown', () => {
  const { container, summary, click, restore } = setup();
  try {
    const longBody = Array.from({ length: 8 }, (_, index) => `Paragraph ${index}.`).join('\n\n');
    summary.update({ ...STATE, body: longBody });
    const body = () => find(container, node => /detail-commit-body\b/.test(node.className))[0];
    const toggle = () => find(container, node => node.className === 'detail-commit-body-toggle')[0];
    assert.ok(body().classList.contains('is-clamped'));
    assert.equal(toggle().textContent, 'details.showMore');
    click(toggle());
    assert.equal(body().classList.contains('is-clamped'), false);
    assert.equal(toggle().textContent, 'details.showLess');
    summary.update({ ...STATE, hash: 'd'.repeat(40), body: longBody });
    assert.ok(body().classList.contains('is-clamped'));

    summary.update({ ...STATE, body: '', refs: [], parents: [] });
    assert.equal(find(container, node => node.className === 'detail-commit-refs').length, 0);
    assert.equal(find(container, node => /detail-commit-body/.test(node.className)).length, 0);
  } finally {
    restore();
  }
});

test('message bodies reflow hard-wrapped lines and keep paragraphs and lists', () => {
  const { reflowMessage } = require('../src/renderer/components/commit-summary.mts');
  assert.equal(
    reflowMessage('First line of a\nwrapped paragraph.\n\n- item one\n- item two\n  continued\nNext line'),
    'First line of a wrapped paragraph.\n\n- item one\n- item two\n  continued Next line'
  );
  assert.equal(reflowMessage('a\r\nb'), 'a b');
});
