/**
 * Copies plain text from a user action. The app denies every permission
 * request, which includes the asynchronous Clipboard API, so a copy command
 * on a temporary text field (allowed during a click or key press) follows.
 */
export async function copyText(text: string, doc: Document = document): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return copyWithCommand(text, doc);
  }
}

function copyWithCommand(text: string, doc: Document): boolean {
  const field = doc.createElement('textarea');
  field.value = text;
  field.setAttribute('readonly', '');
  field.setAttribute('aria-hidden', 'true');
  field.className = 'clipboard-buffer';
  const active = doc.activeElement as HTMLElement | null;
  doc.body.appendChild(field);
  field.select();
  try {
    return doc.execCommand('copy');
  } catch {
    return false;
  } finally {
    field.remove();
    active?.focus?.({ preventScroll: true });
  }
}
