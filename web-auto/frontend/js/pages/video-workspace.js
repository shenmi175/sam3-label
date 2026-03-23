export const VideoWorkspace = {
  container: null,
  projectId: null,
  
  async render(container, params) {
    this.container = container;
    this.projectId = params.id;
    container.innerHTML = `
      <div class="app-container" style="display: flex; height: 100vh; flex-direction: column;">
        <div class="neu-box" style="height: 60px; display: flex; align-items: center; padding: 0 20px; z-index: 10; border-radius: 0;">
          <h2 style="margin:0; font-size: 18px; margin-right: 20px; display: flex; align-items: center; gap: 10px;">
            <span>🎬</span> 
            <span>Video Workspace</span>
            <span style="font-weight: normal; font-size: 14px; color: var(--neu-text-light);">(${this.projectId.substring(0,8)})</span>
          </h2>
          <div style="flex: 1;"></div>
          <button class="neu-button" onclick="window.location.hash='/'">← Dashboard</button>
        </div>
        <div style="flex: 1; display: flex; align-items: center; justify-content: center;">
           <div class="neu-card" style="text-align: center; padding: 40px;">
             <h2 style="margin-top:0;">Video Features: Coming Soon</h2>
             <p style="color: var(--neu-text-light);">SAM-based video propagation and tracker integration are being finalized.</p>
             <button class="neu-button" onclick="window.location.hash='/'">Return to Dashboard</button>
           </div>
        </div>
      </div>
    `;
  },
  unmount() {
    this.container = null;
  }
};
