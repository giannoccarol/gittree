const entities: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
};

export function encode(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, character => entities[character] ?? character);
}

export const HtmlEncoder = Object.freeze({
  encode
});

if (typeof window !== 'undefined') {
  (window as unknown as { HtmlEncoder: typeof HtmlEncoder }).HtmlEncoder = HtmlEncoder;
}

declare const module: { exports: unknown } | undefined;
if (typeof module !== 'undefined' && (module as { exports?: unknown }).exports) {
  (module as { exports: unknown }).exports = HtmlEncoder;
}
