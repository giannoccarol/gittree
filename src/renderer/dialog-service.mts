type Encode = (value: unknown) => string;

interface DialogDocument extends Document {
  activeElement: Element | null;
}

export interface DialogOpenOptions {
  markup: string;
  titleId: string;
  cancelValue: unknown;
  bind: (finish: (value: unknown) => void) => void;
}

export interface ConfirmOptions {
  title: string;
  message: string;
  cancelLabel: string;
  actionLabel: string;
  danger?: boolean;
}

export interface PromptOptions {
  title: string;
  label: string;
  value?: string;
  cancelLabel: string;
  actionLabel: string;
  maxLength?: number;
}

export interface FormOptions<T = unknown> {
  title: string;
  fields: string;
  extract: (form: HTMLFormElement) => T;
  cancelLabel: string;
  actionLabel: string;
  danger?: boolean;
}

let nextDialogId = 1;

export class DialogService {
  document: DialogDocument;
  overlay: HTMLElement;
  dialog: HTMLElement;
  encode: Encode;
  private activeCancel: (() => void) | null;

  constructor(options: {
    document?: DialogDocument;
    overlay?: HTMLElement;
    dialog?: HTMLElement;
    encode?: Encode;
  } = {}) {
    this.document = options.document ?? document as DialogDocument;
    this.overlay = options.overlay ?? this.document.getElementById('modal-overlay')! as HTMLElement;
    this.dialog = options.dialog ?? this.document.getElementById('modal-dialog')! as HTMLElement;
    this.encode = options.encode ?? ((value: unknown) => HtmlEncoder.encode(value));
    this.activeCancel = null;
  }

  confirm({ title, message, cancelLabel, actionLabel, danger = false }: ConfirmOptions): Promise<unknown> {
    const id = `dialog-title-${nextDialogId++}`;
    return this.open<unknown>({
      markup: `<h3 id="${id}">${this.encode(title)}</h3><p>${this.encode(message)}</p>
        <div class="confirm-actions">
          <button class="btn" type="button" data-cancel>${this.encode(cancelLabel)}</button>
          <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" type="button" data-confirm>${this.encode(actionLabel)}</button>
        </div>`,
      titleId: id,
      cancelValue: false,
      bind: (finish: (value: unknown) => void) => {
        const confirmButton = this.dialog.querySelector('[data-confirm]') as HTMLElement | null;
        if (confirmButton) confirmButton.onclick = () => finish(true);
      }
    });
  }

  prompt({ title, label, value = '', cancelLabel, actionLabel, maxLength = 1000 }: PromptOptions): Promise<string | null> {
    const safeMaxLength = Math.max(1, Math.min(65536, Number(maxLength) || 1000));
    return this.form<string>({
      title,
      fields: `<label>${this.encode(label)}
        <input name="value" value="${this.encode(value)}" maxlength="${safeMaxLength}" required autofocus>
      </label>`,
      cancelLabel,
      actionLabel,
      extract: form => (form.elements as unknown as Record<string, HTMLInputElement>).value.value
    });
  }

  form<T>({ title, fields, extract, cancelLabel, actionLabel, danger = false }: FormOptions<T>): Promise<T | null> {
    const id = `dialog-title-${nextDialogId++}`;
    return this.open<T | null>({
      markup: `<form class="branch-dialog-form">
        <h3 id="${id}">${this.encode(title)}</h3>${fields}
        <div class="confirm-actions">
          <button class="btn" type="button" data-cancel>${this.encode(cancelLabel)}</button>
          <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" type="submit">${this.encode(actionLabel)}</button>
        </div>
      </form>`,
      titleId: id,
      cancelValue: null,
      bind: (finish: (value: unknown) => void) => {
        const formElement = this.dialog.querySelector('form') as HTMLFormElement | null;
        if (!formElement) return;
        formElement.onsubmit = event => {
          event.preventDefault();
          finish(extract(event.currentTarget as HTMLFormElement));
        };
      }
    });
  }

  open<T>({ markup, titleId, cancelValue, bind }: DialogOpenOptions): Promise<T> {
    if (this.activeCancel) this.activeCancel();
    const previousFocus = this.document.activeElement;
    this.dialog.className = 'confirm-dialog';
    this.dialog.innerHTML = markup;
    this.dialog.setAttribute('role', 'dialog');
    this.dialog.setAttribute('aria-modal', 'true');
    this.dialog.setAttribute('aria-labelledby', titleId);
    this.overlay.classList.remove('is-hidden');

    return new Promise(resolve => {
      let finished = false;
      const finish = (value: unknown) => {
        if (finished) return;
        finished = true;
        this.document.removeEventListener('keydown', onKeydown);
        this.overlay.onclick = null;
        this.overlay.classList.add('is-hidden');
        this.dialog.innerHTML = '';
        this.dialog.removeAttribute('role');
        this.dialog.removeAttribute('aria-modal');
        this.dialog.removeAttribute('aria-labelledby');
        this.activeCancel = null;
        if (previousFocus?.isConnected) (previousFocus as HTMLElement).focus();
        resolve(value as T);
      };
      const onKeydown = (event: KeyboardEvent) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          finish(cancelValue);
          return;
        }
        if (event.key !== 'Tab') return;
        const focusable = [...this.dialog.querySelectorAll(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])'
        )] as HTMLElement[];
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && this.document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && this.document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      };
      this.activeCancel = () => finish(cancelValue);
      this.document.addEventListener('keydown', onKeydown);
      this.overlay.onclick = event => {
        if (event.target === this.overlay) finish(cancelValue);
      };
      const cancelButton = this.dialog.querySelector('[data-cancel]') as HTMLElement | null;
      if (cancelButton) cancelButton.onclick = () => finish(cancelValue);
      bind(finish);
      (this.dialog.querySelector('[autofocus], input, select, textarea, [data-confirm]') as HTMLElement | null)?.focus();
    });
  }
}

if (typeof window !== 'undefined') {
  (window as unknown as { DialogService: typeof DialogService }).DialogService = DialogService;
}

declare const module: { exports: unknown } | undefined;
if (typeof module !== 'undefined' && (module as { exports?: unknown }).exports) {
  (module as { exports: unknown }).exports = DialogService;
}
