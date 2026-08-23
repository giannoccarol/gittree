const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const source = path.join(projectRoot, 'icon.png');
const buildDirectory = path.join(projectRoot, 'build');
const destination = path.join(buildDirectory, 'icon.png');
const oauthDestination = path.join(buildDirectory, 'oauth-config.json');

function readPngMetadata(buffer) {
  const signature = '89504e470d0a1a0a';
  if (buffer.subarray(0, 8).toString('hex') !== signature) {
    throw new Error('icon.png is not a valid PNG image');
  }
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
    colorType: buffer[25]
  };
}

if (!fs.existsSync(source)) {
  throw new Error('Missing icon.png in the repository root');
}

const sourceBuffer = fs.readFileSync(source);
const metadata = readPngMetadata(sourceBuffer);
if (metadata.width < 512 || metadata.height < 512 || metadata.width !== metadata.height) {
  throw new Error('icon.png must be square and at least 512×512 pixels');
}
if (metadata.colorType !== 4 && metadata.colorType !== 6) {
  throw new Error('icon.png must include an alpha channel');
}

fs.mkdirSync(buildDirectory, { recursive: true });
fs.copyFileSync(source, destination);
fs.writeFileSync(oauthDestination, JSON.stringify({
  githubClientId: process.env.GITTREE_GITHUB_CLIENT_ID || '',
  gitlabClientId: process.env.GITTREE_GITLAB_CLIENT_ID || ''
}, null, 2));
console.log(`Prepared build/icon.png (${metadata.width}×${metadata.height}, alpha channel)`);

function copyRecursiveSync(src, dest) {
  if (!fs.existsSync(src)) return;
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyRecursiveSync(path.join(src, entry), path.join(dest, entry));
    }
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

function ensureRendererAssets() {
  const distRenderer = path.join(projectRoot, 'dist', 'renderer');
  fs.mkdirSync(distRenderer, { recursive: true });
  const htmlFiles = ['index.html', 'inspector-window.html'];
  for (const file of htmlFiles) {
    const srcPath = path.join(projectRoot, 'src', 'renderer', file);
    const destPath = path.join(distRenderer, file);
    if (fs.existsSync(srcPath)) {
      fs.copyFileSync(srcPath, destPath);
    }
  }
  // i18n.js is the documented classic-script exception (ADR-0008): it must be
  // shipped verbatim so its globals (window.I18n, window.t) stay intact.
  copyRecursiveSync(
    path.join(projectRoot, 'src', 'renderer', 'styles'),
    path.join(distRenderer, 'styles')
  );
  const i18nSource = path.join(projectRoot, 'src', 'renderer', 'i18n.js');
  const i18nDest = path.join(distRenderer, 'i18n.js');
  if (fs.existsSync(i18nSource)) {
    fs.copyFileSync(i18nSource, i18nDest);
  }
  const iconDest = path.join(projectRoot, 'dist', 'icon.png');
  if (!fs.existsSync(iconDest) && fs.existsSync(source)) {
    fs.copyFileSync(source, iconDest);
  }
}

if (process.argv.includes('--renderer-only')) {
  ensureRendererAssets();
  console.log('Renderer assets copied to dist/renderer');
} else {
  ensureRendererAssets();
}
