import { api } from '../api.js';

export const TaskManager = {
  container: null,
  activeJobs: new Map(), // jobId -> data
  pollTimer: null,
  
  init() {
    this.createUI();
    this.startPolling();
  },
  
  createUI() {
    this.container = document.createElement('div');
    // Global floating task container
    this.container.style.cssText = `
      position: fixed;
      bottom: 20px;
      right: 20px;
      width: 350px;
      z-index: 9999;
      display: flex;
      flex-direction: column;
      gap: 12px;
      pointer-events: none; /* Let clicks pass through empty space */
    `;
    document.body.appendChild(this.container);
  },
  
  startPolling() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = setInterval(() => this.pollActiveJobs(), 2000);
    this.pollActiveJobs(); // Poll once immediately assuming we might have jobs on refresh
  },
  
  async pollActiveJobs() {
    // If we rely on project_id context, we can fetch active jobs globally from API?
    // The given backend APIs require project_id to fetch active jobs: GET /api/infer/jobs/active?project_id=...
    // Since we are a SPA, we might need a global endpoint or we just poll the active project.
    
    const projectId = window.currentWorkspace ? window.currentWorkspace.projectId : null;
    if (!projectId) return;

    try {
      const workspace = window.currentWorkspace || {};
      const projectType = workspace.projectMeta?.project_type || workspace.project?.project_type || '';
      const isVideo = projectType === 'video';
      
      // Parallel poll
      const promises = [
        api.getInferActiveJob(projectId),
        api.getFilterActiveJob(projectId)
      ];
      if (isVideo) promises.push(api.getVideoJob(projectId));
      
      const results = await Promise.allSettled(promises);
      
      const newActive = new Map();
      results.forEach(res => {
         const job = res.status === 'fulfilled' ? res.value?.job : null;
         if (job && job.status && job.status !== 'done' && job.status !== 'error') {
            newActive.set(job.job_id || job.project_id || 'video', job);
         }
      });
      
      this.activeJobs = newActive;
      this.render();
      
    } catch(e) {
      console.error("Polling error", e);
    }
  },
  
  render() {
    if (this.activeJobs.size === 0) {
      this.container.innerHTML = '';
      return;
    }
    
    let html = '';
    this.activeJobs.forEach((job, jobId) => {
      const pct = job.progress_pct != null ? job.progress_pct : 0;
      const running = ['queued', 'running', 'pausing'].includes(job.status);
      const failed = job.status === 'error';
      // Make elements clickable inside the non-clickable container
      html += `
        <div class="neu-card" style="pointer-events: auto; padding: 16px; position: relative;">
           <div style="display: flex; justify-content: space-between; margin-bottom: 8px;">
              <span style="font-weight: 600; font-size: 14px;">${job.job_type || 'Task'}</span>
              <span style="font-size: 12px; color: var(--neu-text-light);">${job.status.toUpperCase()}</span>
           </div>
           
           <div style="font-size: 12px; margin-bottom: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
             ${job.message || 'Processing...'}
           </div>
           
           <div style="width: 100%; height: 8px; background: var(--neu-inset); border-radius: 4px; overflow: hidden; margin-bottom: 12px;">
             <div style="height: 100%; width: ${pct}%; background: ${failed ? '#e53e3e' : running ? 'var(--neu-text-active)' : '#a0aec0'}; transition: width 0.3s;"></div>
           </div>
           
           <div style="display: flex; gap: 8px; justify-content: flex-end;">
             ${running ? `<button class="neu-button" style="padding: 4px 8px; font-size: 11px;" onclick="window.taskManager.stopJob('${jobId}', '${job.job_type}', '${job.project_id}')">Stop</button>` : ''}
             ${job.status === 'paused' ? `<button class="neu-button" style="padding: 4px 8px; font-size: 11px; color: var(--neu-text-active);" onclick="window.taskManager.resumeJob('${jobId}', '${job.job_type}', '${job.project_id}')">Resume</button>` : ''}
           </div>
        </div>
      `;
    });
    
    this.container.innerHTML = html;
  },
  
  async stopJob(jobId, type, projectId) {
    try {
      if (type.includes('filter')) {
         // Filter doesn't have an explicit stop in doc, but infer does
         console.warn('Filter job cannot be stopped manually per API docs currently.');
      } else if (type === 'video') {
         await api.stopVideoJob(projectId);
      } else {
         await api.stopInferJob(projectId);
      }
      this.pollActiveJobs();
    } catch(e) { alert(e.message); }
  },
  
  async resumeJob(jobId, type, projectId) {
    try {
      if (type === 'video') {
         await api.resumeVideoJob({project_id: projectId});
      } else {
         await api.resumeInferJob({project_id: projectId});
      }
      this.pollActiveJobs();
    } catch(e) { alert(e.message); }
  }
};

window.taskManager = TaskManager;
