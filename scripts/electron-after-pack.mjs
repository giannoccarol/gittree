import fs from 'node:fs';
import path from 'node:path';

/**
 * Writes resources/package-type so the updater can tell AppImage apart from
 * native distro packages on Linux.
 */
export default async function afterPack(context) {
  if (context.electronPlatformName !== 'linux') return;

  const targetNames = (context.targets || [])
    .map(target => String(target.name || '').toLowerCase());
  let packageType = 'native';
  if (targetNames.includes('appimage')) packageType = 'appimage';
  else if (targetNames.includes('deb')) packageType = 'deb';
  else if (targetNames.includes('pacman')) packageType = 'pacman';

  const resourcesDir = path.join(context.appOutDir, 'resources');
  fs.mkdirSync(resourcesDir, { recursive: true });
  fs.writeFileSync(path.join(resourcesDir, 'package-type'), `${packageType}\n`, 'utf8');
}
