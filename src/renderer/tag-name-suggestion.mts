export interface TagSuggestion {
  latest: string | null;
  next: string;
}

function normalizeNames(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return values
    .filter((name): name is string => typeof name === 'string')
    .map(name => name.trim())
    .filter(name => name.length > 0);
}

function readNames(source: unknown): string[] {
  if (Array.isArray(source)) return normalizeNames(source);
  if (!source || typeof source !== 'object') return [];
  const record = source as { error?: unknown; all?: unknown };
  if (record.error) return [];
  return normalizeNames(record.all);
}

function isDigit(character: string): boolean {
  return character >= '0' && character <= '9';
}

function digitRun(value: string, start: number): {
  end: number;
  leadingZeros: number;
  significant: string;
} {
  let index = start;
  while (value[index] === '0') index += 1;
  const leadingZeros = index - start;
  const significantStart = index;
  while (isDigit(value[index] ?? '')) index += 1;
  return {
    end: index,
    leadingZeros,
    significant: value.slice(significantStart, index)
  };
}

// Highest released tag from the names returned by `git.tags()`. Order matches
// Git's default version sort (`git tag --sort=-version:refname` / strverscmp):
// digit runs compare as integers, so v1.10.0 beats v1.9.0 and v10.0.0 beats
// v2.0.0, while a non-digit prefix still participates (`v1.9.0` beats
// `release-10`). simple-git's `latest` field is not used: it drops every name
// that does not contain a dot.
function compareReleasedTags(left: string, right: string): number {
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length || rightIndex < right.length) {
    const leftChar = left[leftIndex] ?? '';
    const rightChar = right[rightIndex] ?? '';
    if (isDigit(leftChar) && isDigit(rightChar)) {
      const leftRun = digitRun(left, leftIndex);
      const rightRun = digitRun(right, rightIndex);
      leftIndex = leftRun.end;
      rightIndex = rightRun.end;
      if (leftRun.significant.length !== rightRun.significant.length) {
        return leftRun.significant.length > rightRun.significant.length ? 1 : -1;
      }
      if (leftRun.significant !== rightRun.significant) {
        return leftRun.significant > rightRun.significant ? 1 : -1;
      }
      if (leftRun.leadingZeros !== rightRun.leadingZeros) {
        return leftRun.leadingZeros < rightRun.leadingZeros ? 1 : -1;
      }
      continue;
    }
    if (leftChar === rightChar) {
      leftIndex += 1;
      rightIndex += 1;
      continue;
    }
    if (leftChar === '') return -1;
    if (rightChar === '') return 1;
    return leftChar > rightChar ? 1 : -1;
  }
  return 0;
}

function latestReleasedTag(names: string[]): string | null {
  if (!names.length) return null;
  return names.reduce((latest, name) => (
    compareReleasedTags(name, latest) > 0 ? name : latest
  ));
}

function incrementDigits(digits: string): string {
  const chars = digits.split('');
  let carry = 1;
  for (let index = chars.length - 1; index >= 0 && carry; index -= 1) {
    const sum = Number(chars[index]) + carry;
    chars[index] = String(sum % 10);
    carry = Math.floor(sum / 10);
  }
  return `${carry ? '1' : ''}${chars.join('')}`;
}

function nextTagName(name: string): string {
  const match = /^(.*?)(\d+)$/.exec(name);
  if (!match) return '';
  return `${match[1] ?? ''}${incrementDigits(match[2] ?? '')}`;
}

export function suggest(source: unknown): TagSuggestion {
  const latest = latestReleasedTag(readNames(source));
  if (!latest) return { latest: null, next: '' };
  return { latest, next: nextTagName(latest) };
}

export const TagNameSuggestion = Object.freeze({ suggest });

if (typeof window !== 'undefined') {
  (window as unknown as { TagNameSuggestion: typeof TagNameSuggestion }).TagNameSuggestion = TagNameSuggestion;
}

declare const module: { exports: unknown } | undefined;
if (typeof module !== 'undefined' && (module as { exports?: unknown }).exports) {
  (module as { exports: unknown }).exports = TagNameSuggestion;
}
