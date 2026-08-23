import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';

export const RECIPES = Object.freeze([
  { files: ['bun.lock', 'bun.lockb'], id: 'bun-frozen', command: 'bun', args: ['install', '--frozen-lockfile'] },
  { files: ['pnpm-lock.yaml'], id: 'pnpm-frozen', command: 'pnpm', args: ['install', '--frozen-lockfile'] },
  { files: ['yarn.lock'], id: 'yarn-immutable', command: 'yarn', args: ['install', '--immutable'] },
  { files: ['package-lock.json', 'npm-shrinkwrap.json'], id: 'npm-ci', command: 'npm', args: ['ci'] }
]);

export interface SetupRecipe {
  id: string;
  command: string;
  args: string[];
}

export function detectSetupRecipe(
  directory: string,
  { fileSystem = nodeFs }: { fileSystem?: typeof nodeFs } = {}
): SetupRecipe | null {
  for (const recipe of RECIPES) {
    if (recipe.files.some(file => fileSystem.existsSync(nodePath.join(directory, file)))) {
      return { id: recipe.id, command: recipe.command, args: [...recipe.args] };
    }
  }
  return null;
}



