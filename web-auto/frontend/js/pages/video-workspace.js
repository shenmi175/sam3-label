export const VideoWorkspace = {
  container: null,
  projectId: null,
  
  async render(container, params) {
    this.container = container;
    this.projectId = params.id;
    container.innerHTML = `
      <div style="display: flex; height: 100vh; flex-direction: column;">
        <div class="neu-box" style="height: 60px; display: flex; align-items: center; padding: 0 20px; z-index: 10; border-radius: 0;">
          <h2 style="margin:0; font-size: 18px; margin-right: 20px;">Video Workspace <span style="font-weight: normal; font-size: 14px; color: var(--neu-text-light);">(${this.projectId.substring(0,8)})</span></h2>
          <button class="neu-button" onclick="window.location.hash='/'">← Back to List</button>
        </div>
        <div style="flex: 1; display: flex; align-items: center; justify-content: center; background: #c8ced6;">
           <div style="text-align: center; color: var(--neu-text-light);">
             <h2>Video Workspace (Under Construction)</h2>
             <p>Video processing and playback features will be implemented later.</p>
           </div>
        </div>
      </div>
    `;
  },
  unmount() {
    this.container = null;
  }
};
