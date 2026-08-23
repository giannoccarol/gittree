import * as fs from 'node:fs';
import * as path from 'node:path';

export function validClientId(value: unknown): string {
  return typeof value === 'string' && /^[A-Za-z0-9_.-]{6,200}$/.test(value)
    ? value
    : '';
}

export interface OAuthConfig {
  github: string;
  gitlab: string;
}

export function loadOAuthConfig(app: { isPackaged: boolean; resourcesPath?: string | undefined }): OAuthConfig {
  let packaged: Record<string, unknown> = {};
  if (app.isPackaged) {
    try {
      packaged = JSON.parse(
        fs.readFileSync(path.join(app.resourcesPath ?? process.resourcesPath, 'oauth-config.json'), 'utf8')
      );
    } catch { /* packaged config is optional */ }
  }
  return {
    github: validClientId(
      process.env.GITTREE_GITHUB_CLIENT_ID || (packaged.githubClientId as string | undefined)
    ),
    gitlab: validClientId(
      process.env.GITTREE_GITLAB_CLIENT_ID || (packaged.gitlabClientId as string | undefined)
    )
  };
}
