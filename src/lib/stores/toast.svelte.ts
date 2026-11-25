import { uid } from '../utils/ids';

export type ToastKind = 'info' | 'success' | 'error';

export interface Toast {
  id: string;
  kind: ToastKind;
  text: string;
}

class ToastStore {
  items = $state<Toast[]>([]);

  push(text: string, kind: ToastKind = 'info', ttl = 4200): void {
    const id = uid('toast');
    this.items = [...this.items, { id, kind, text }];
    window.setTimeout(() => this.dismiss(id), ttl);
  }

  info(text: string): void {
    this.push(text, 'info');
  }

  success(text: string): void {
    this.push(text, 'success');
  }

  error(text: string): void {
    this.push(text, 'error', 7000);
  }

  dismiss(id: string): void {
    this.items = this.items.filter((t) => t.id !== id);
  }
}

export const toasts = new ToastStore();
