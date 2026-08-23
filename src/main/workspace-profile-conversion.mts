import * as nodeFs from 'node:fs';
import * as path from 'node:path';

type FileSystemLike = typeof nodeFs;

export interface ConversionResult {
  converted: boolean;
  source?: string;
  error?: string;
}

export interface ConvertWorkspaceProfileOptions {
  currentConfigPath: string;
  previousConfigPath?: string | null;
  fileSystem?: FileSystemLike;
  processId?: number;
  timestamp?: number;
}

function readPreviousWorkspace(fileSystem: FileSystemLike, configPath: string): string | null {
  const source = fileSystem.readFileSync(configPath, 'utf8');
  const parsed = JSON.parse(source);
  if (!parsed || !Array.isArray(parsed.repos) || parsed.repos.length === 0) return null;
  return source;
}

export function convertWorkspaceProfile({
  currentConfigPath,
  previousConfigPath,
  fileSystem = nodeFs,
  processId = process.pid,
  timestamp = Date.now()
}: ConvertWorkspaceProfileOptions): ConversionResult {
  if (fileSystem.existsSync(currentConfigPath)) return { converted: false };
  if (!previousConfigPath || path.resolve(previousConfigPath) === path.resolve(currentConfigPath)) {
    return { converted: false };
  }
  try {
    if (!fileSystem.existsSync(previousConfigPath)) return { converted: false };
    const source = readPreviousWorkspace(fileSystem, previousConfigPath);
    if (!source) return { converted: false };
    const directory = path.dirname(currentConfigPath);
    fileSystem.mkdirSync(directory, { recursive: true });
    const temporaryPath = `${currentConfigPath}.${processId}.${timestamp}.conversion.tmp`;
    try {
      fileSystem.writeFileSync(temporaryPath, source, { flag: 'wx' });
      fileSystem.renameSync(temporaryPath, currentConfigPath);
    } finally {
      fileSystem.rmSync(temporaryPath, { force: true });
    }
    return { converted: true, source: previousConfigPath };
  } catch (error) {
    return { converted: false, error: (error as Error).message };
  }
}
