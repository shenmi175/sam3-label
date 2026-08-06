/**
 * Imperative toast bridge so non-component code (Zustand stores, hooks) can
 * raise toasts without a React context. ToastProvider registers its
 * showToast implementation at mount time.
 */

export type ToastType = 'info' | 'success' | 'error' | 'warning';
export type ToastFn = (message: string, type?: ToastType) => void;

let current: ToastFn = () => {};

export function registerToast(fn: ToastFn) {
  current = fn;
}

export function toast(message: string, type: ToastType = 'info') {
  current(message, type);
}
