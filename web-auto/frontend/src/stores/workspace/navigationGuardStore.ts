import { create } from 'zustand';

export type NavigationDecision = 'save' | 'discard' | 'cancel';

interface NavigationGuardState {
  open: boolean;
  decide: (decision: NavigationDecision) => void;
}

let pendingResolver: ((decision: NavigationDecision) => void) | null = null;

export const useNavigationGuardStore = create<NavigationGuardState>((set) => ({
  open: false,
  decide: (decision) => {
    const resolve = pendingResolver;
    pendingResolver = null;
    set({ open: false });
    resolve?.(decision);
  },
}));

export function requestNavigationDecision(): Promise<NavigationDecision> {
  if (pendingResolver) return Promise.resolve('cancel');
  useNavigationGuardStore.setState({ open: true });
  return new Promise((resolve) => {
    pendingResolver = resolve;
  });
}
