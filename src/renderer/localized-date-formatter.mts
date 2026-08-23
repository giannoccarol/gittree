type FormatterFactory = (value: unknown, language: string) => string;

interface CreateOptions {
  DateTimeFormat?: typeof Intl.DateTimeFormat;
}

export function create({ DateTimeFormat = Intl.DateTimeFormat }: CreateOptions = {}): FormatterFactory {
  let activeLanguage: string | null = null;
  let formatter: Intl.DateTimeFormat | null = null;

  return (value: unknown, language: string): string => {
    if (!value) return '';
    const date = new Date(value as string | number | Date);
    if (Number.isNaN(date.getTime())) return date.toLocaleString(language, { dateStyle: 'short', timeStyle: 'short' });
    if (!formatter || activeLanguage !== language) {
      activeLanguage = language;
      formatter = new DateTimeFormat(language, { dateStyle: 'short', timeStyle: 'short' });
    }
    return formatter.format(date);
  };
}

export const LocalizedDateFormatter = Object.freeze({
  create
});

if (typeof window !== 'undefined') {
  (window as unknown as { LocalizedDateFormatter: typeof LocalizedDateFormatter }).LocalizedDateFormatter = LocalizedDateFormatter;
}

declare const module: { exports: unknown } | undefined;
if (typeof module !== 'undefined' && (module as { exports?: unknown }).exports) {
  (module as { exports: unknown }).exports = LocalizedDateFormatter;
}
