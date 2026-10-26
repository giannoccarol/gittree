const { execFileSync } = require('node:child_process');
const path = require('node:path');

// Deterministic PRNG so every run builds the same history for the same seed.
function createRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function gitEnvironment(cwd) {
  return {
    ...process.env,
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    XDG_CONFIG_HOME: path.join(path.dirname(cwd), '.xdg')
  };
}

/**
 * Builds a production-shaped history with `git fast-import`: a main line,
 * short-lived feature branches merged with merge commits, unmerged local and
 * remote-tracking branches, lightweight and annotated tags, many authors and
 * committer dates that interleave across branches.
 */
function buildFastImportStream({ commits = 1000, seed = 1, authors = 120 } = {}) {
  const random = createRandom(seed);
  const chunks = [];
  const people = Array.from({ length: authors }, (_, index) => ({
    name: `Developer ${String(index).padStart(3, '0')}`,
    email: `dev${index}@example.test`
  }));
  const areas = ['graph', 'changes', 'diff', 'hosting', 'ipc', 'settings', 'merge', 'tags'];
  const verbs = ['add', 'fix', 'refine', 'remove', 'speed up', 'document', 'test', 'rename'];
  let mark = 0;
  let produced = 0;
  let clock = 1_600_000_000;
  let mainTip;
  let mainCommits = 0;
  let branchSequence = 0;
  const active = [];
  const leftovers = [];
  const tags = [];

  const pickAuthor = () => people[Math.floor((random() ** 2) * people.length)];
  const data = text => `data ${Buffer.byteLength(text)}\n${text}\n`;

  const writeCommit = ({ ref, from, merge, subject }) => {
    mark += 1;
    produced += 1;
    clock += 60 + Math.floor(random() * 900);
    // Some commits keep an older author date, like rebased or cherry-picked work.
    const authorTime = random() < 0.1 ? clock - Math.floor(random() * 86_400 * 30) : clock;
    const author = pickAuthor();
    const committer = random() < 0.8 ? author : pickAuthor();
    const file = `src/${areas[produced % areas.length]}/file-${produced % 37}.txt`;
    let block = `commit ${ref}\nmark :${mark}\n`;
    block += `author ${author.name} <${author.email}> ${authorTime} +0100\n`;
    block += `committer ${committer.name} <${committer.email}> ${clock} +0100\n`;
    block += data(`${subject}\n\nSynthetic body for change ${produced}.`);
    if (from) block += `from :${from}\n`;
    if (merge) block += `merge :${merge}\n`;
    block += `M 100644 inline ${file}\n${data(`change ${produced}\n`)}\n`;
    chunks.push(block);
    return mark;
  };

  const subjectFor = () => {
    const area = areas[Math.floor(random() * areas.length)];
    const verb = verbs[Math.floor(random() * verbs.length)];
    return `${verb} ${area} behavior #${produced + 1}`;
  };

  mainTip = writeCommit({ ref: 'refs/heads/main', subject: 'initial synthetic commit' });
  mainCommits += 1;

  while (produced < commits) {
    const roll = random();
    if (active.length < 6 && roll < 0.12) {
      branchSequence += 1;
      active.push({
        name: `feature/topic-${branchSequence}`,
        tip: mainTip,
        remaining: 1 + Math.floor(random() * 8)
      });
      continue;
    }
    const branch = active.length && random() < 0.55
      ? active[Math.floor(random() * active.length)]
      : null;
    if (!branch) {
      mainTip = writeCommit({ ref: 'refs/heads/main', from: mainTip, subject: subjectFor() });
      mainCommits += 1;
      if (mainCommits % 400 === 0) tags.push({ name: `v0.${mainCommits / 400}.0`, mark: mainTip });
      continue;
    }
    branch.tip = writeCommit({
      ref: `refs/heads/${branch.name}`,
      from: branch.tip,
      subject: subjectFor()
    });
    branch.remaining -= 1;
    if (branch.remaining > 0) continue;
    active.splice(active.indexOf(branch), 1);
    if (random() < 0.85 && produced < commits) {
      mainTip = writeCommit({
        ref: 'refs/heads/main',
        from: mainTip,
        merge: branch.tip,
        subject: `Merge branch '${branch.name}'`
      });
      mainCommits += 1;
    } else {
      leftovers.push(branch);
    }
  }
  leftovers.push(...active);

  chunks.push(`reset refs/heads/main\nfrom :${mainTip}\n\n`);
  const keptBranches = new Set(['refs/heads/main']);
  leftovers.forEach((branch, index) => {
    const ref = index % 2 === 0
      ? `refs/heads/${branch.name}`
      : `refs/remotes/origin/${branch.name}`;
    if (ref.startsWith('refs/heads/')) keptBranches.add(ref);
    chunks.push(`reset ${ref}\nfrom :${branch.tip}\n\n`);
  });
  tags.forEach((tag, index) => {
    if (index % 3 === 0) {
      chunks.push(`tag ${tag.name}\nfrom :${tag.mark}\ntagger Release Bot <release@example.test> ${clock} +0100\n${data(`Release ${tag.name}`)}`);
    } else {
      chunks.push(`reset refs/tags/${tag.name}\nfrom :${tag.mark}\n\n`);
    }
  });
  return { stream: chunks.join(''), keptBranches, produced };
}

function writeSyntheticHistory(repository, options = {}) {
  const { stream, keptBranches, produced } = buildFastImportStream(options);
  const env = gitEnvironment(repository);
  execFileSync('git', ['fast-import', '--quiet'], {
    cwd: repository,
    input: stream,
    env,
    maxBuffer: 64 * 1024 * 1024
  });
  // fast-import keeps every branch it wrote; drop merged feature branches.
  const stale = execFileSync('git', ['for-each-ref', '--format=%(refname)', 'refs/heads'], {
    cwd: repository,
    env,
    encoding: 'utf8'
  }).split('\n').filter(ref => ref && !keptBranches.has(ref));
  if (stale.length) {
    execFileSync('git', ['update-ref', '--stdin'], {
      cwd: repository,
      env,
      input: stale.map(ref => `delete ${ref}\n`).join('')
    });
  }
  // Remote-tracking main lags behind local main, as after local work.
  execFileSync('git', ['update-ref', 'refs/remotes/origin/main', 'main~5'], { cwd: repository, env });
  execFileSync('git', ['reset', '--hard', '--quiet', 'main'], { cwd: repository, env });
  return { commits: produced };
}

module.exports = { buildFastImportStream, writeSyntheticHistory };
