import { ImageWorkspace } from './image-workspace.js';

export const ImageWorkspaceShell = {
  async render(container, params = {}) {
    await ImageWorkspace.render(container, params);
  },

  unmount() {
    ImageWorkspace.unmount();
  },
};

export function createImageWorkspaceRoute(workspaceMode = 'auto') {
  return {
    async render(container, params = {}) {
      await ImageWorkspaceShell.render(container, {
        ...params,
        workspaceMode,
      });
    },

    unmount() {
      ImageWorkspaceShell.unmount();
    },
  };
}
