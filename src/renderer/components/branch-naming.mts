export interface BranchMetadata {
  branches?: Array<{ name?: unknown; kind?: unknown; remote?: unknown }>;
}

export const BranchNaming = {
  aliases: {
    feature: ['feature', 'features', 'feat'],
    bugfix: ['bugfix', 'bug', 'fix', 'hotfix']
  } as Record<string, string[]>,

  branchNames(metadata: BranchMetadata = {}): string[] {
    return (metadata.branches ?? [])
      .map(branch => {
        const name = String((branch as { name?: unknown }).name ?? '');
        if ((branch as { kind?: unknown }).kind !== 'remote') return name;
        const remote = String((branch as { remote?: unknown }).remote ?? '');
        return remote && name.startsWith(`${remote}/`)
          ? name.slice(remote.length + 1)
          : name.split('/').slice(1).join('/');
      })
      .filter(Boolean);
  },

  detectPrefix(type: string, metadata: BranchMetadata = {}): string {
    const aliases: string[] = (this.aliases[type] ?? []);
    const counts = new Map<string, number>(aliases.map(alias => [alias, 0]));
    this.branchNames(metadata).forEach((name: string) => {
      const prefix = name.split('/')[0].toLowerCase();
      if (counts.has(prefix)) counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
    });
    return aliases.reduce(
      (best, candidate) => (counts.get(candidate) ?? 0) > (counts.get(best) ?? 0) ? candidate : best,
      aliases[0] ?? type
    );
  },

  slugify(value: unknown): string {
    return String(value ?? '')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .trim()
      .toLowerCase()
      .replace(/[\s_]+/g, '-')
      .replace(/[^a-z0-9.-]+/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^[.-]+|[.-]+$/g, '');
  },

  compose(type: string, value: unknown, metadata: BranchMetadata = {}): string {
    if (type === 'custom') {
      return String(value ?? '')
        .split('/')
        .map(part => this.slugify(part))
        .filter(Boolean)
        .join('/');
    }
    const slug = this.slugify(value);
    if (!slug) return '';
    return `${this.detectPrefix(type, metadata)}/${slug}`;
  }
};

if (typeof window !== 'undefined') {
  (window as unknown as { BranchNaming: typeof BranchNaming }).BranchNaming = BranchNaming;
}

declare const module: { exports: unknown } | undefined;
if (typeof module !== 'undefined' && (module as { exports?: unknown }).exports) {
  (module as { exports: unknown }).exports = BranchNaming;
}
