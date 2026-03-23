import { api } from '../api.js';

export const FilterUI = {
  container: null,
  projectId: null,
  
  render(containerId, projectId) {
    this.container = document.getElementById(containerId);
    this.projectId = projectId;
    
    this.container.innerHTML = `
      <div style="padding: 16px; border-top: 2px solid var(--neu-bg);">
         <h3 style="margin-top:0; font-size: 16px;">Intelligent Filter</h3>
         
         <div style="margin-bottom: 12px;">
           <label style="display:block; margin-bottom: 4px; font-weight: 500; font-size: 12px;">Merge Mode</label>
           <select id="flt-merge-mode" class="neu-input" style="padding: 8px;">
             <option value="same_class">Same Class</option>
             <option value="canonical_class">Canonical Class</option>
           </select>
         </div>
         
         <div style="margin-bottom: 12px;">
           <label style="display:block; margin-bottom: 4px; font-weight: 500; font-size: 12px;">Coverage Threshold</label>
           <input type="number" step="0.01" value="0.98" id="flt-cov" class="neu-input" style="padding: 8px;" />
         </div>
         
         <div style="margin-bottom: 12px; display: none;" id="flt-canonical-wrapper">
           <label style="display:block; margin-bottom: 4px; font-weight: 500; font-size: 12px;">Target Canonical Class</label>
           <input type="text" id="flt-canonical" class="neu-input" style="padding: 8px;" placeholder="e.g. human face" />
           <label style="display:block; margin-top: 8px; margin-bottom: 4px; font-weight: 500; font-size: 12px;">Source Classes (comma sep)</label>
           <input type="text" id="flt-sources" class="neu-input" style="padding: 8px;" placeholder="face, head" />
         </div>
         
         <div style="display: flex; gap: 8px;">
           <button class="neu-button" id="btn-flt-preview" style="flex: 1; color: var(--neu-text-active);">Preview</button>
           <button class="neu-button" id="btn-flt-apply" style="flex: 1; display: none; color: #48bb78;">Apply Filter</button>
         </div>
         <div id="flt-status" style="margin-top: 8px; font-size: 11px; color: var(--neu-text-light);"></div>
      </div>
    `;
    
    this.bindEvents();
  },
  
  bindEvents() {
    const modeSel = document.getElementById('flt-merge-mode');
    const canWrapper = document.getElementById('flt-canonical-wrapper');
    const btnPrev = document.getElementById('btn-flt-preview');
    const btnApp = document.getElementById('btn-flt-apply');
    const status = document.getElementById('flt-status');
    let currentPreviewToken = '';
    
    modeSel.onchange = (e) => {
      if (e.target.value === 'canonical_class') canWrapper.style.display = 'block';
      else canWrapper.style.display = 'none';
      btnApp.style.display = 'none'; // reset apply button if config changes
      status.innerText = '';
    };
    
    btnPrev.onclick = async () => {
       const payload = {
         project_id: this.projectId,
         merge_mode: modeSel.value,
         coverage_threshold: parseFloat(document.getElementById('flt-cov').value)
       };
       if (modeSel.value === 'canonical_class') {
         payload.canonical_class = document.getElementById('flt-canonical').value;
         payload.source_classes = document.getElementById('flt-sources').value.split(',').map(s=>s.trim()).filter(s=>s);
       }
       
       try {
         btnPrev.disabled = true;
         status.innerText = 'Starting preview task...';
         await api.smartFilterPreview(payload);
         // Rely on global TaskManager to poll the running task.
         // We can't immediately show the apply button because the job runs async.
         // We have to prompt the user to wait until task manager shows finished.
         // (A better UX would poll specifically here too, but we can instruct the user for now)
         status.innerText = 'Task queued. Wait for it to finish, then we can apply (You will need the token).';
         // Wait, the API requires a preview_token. The backend returns it in job result,
         // but we don't fetch it explicitly here without polling.
         // Actually `start_preview` returns a job, we can poll it until finished, then extract token.
         this.pollLocalPreview(payload);
       } catch(e) {
         status.innerText = 'Preview Error: ' + e.message;
       } finally {
         btnPrev.disabled = false;
       }
    };
    
    btnApp.onclick = async () => {
       if(!currentPreviewToken) return;
       const payload = {
         project_id: this.projectId,
         merge_mode: modeSel.value,
         coverage_threshold: parseFloat(document.getElementById('flt-cov').value),
         preview_token: currentPreviewToken
       };
       if (modeSel.value === 'canonical_class') {
         payload.canonical_class = document.getElementById('flt-canonical').value;
         payload.source_classes = document.getElementById('flt-sources').value.split(',').map(s=>s.trim()).filter(s=>s);
       }
       
       try {
         btnApp.disabled = true;
         status.innerText = 'Starting apply task...';
         await api.smartFilterApply(payload);
         status.innerText = 'Apply started. See global Tasks.';
         btnApp.style.display = 'none';
       } catch(e) {
         status.innerText = 'Apply Error: ' + e.message;
       } finally {
         btnApp.disabled = false;
       }
    };
    
    this.pollLocalPreview = async (payload) => {
       status.innerText = 'Waiting for preview calculation...';
       let interval = setInterval(async () => {
         try {
           const job = await api.getFilterActiveJob(this.projectId);
           if (!job) {
             // Maybe it finished and cleared, actually we should get job by ID if we had it.
             // We'll trust task manager context for now.
             clearInterval(interval);
           } else {
             if (job.status === 'finished') {
                clearInterval(interval);
                currentPreviewToken = job.result && job.result.preview_token;
                if (currentPreviewToken) {
                  status.innerText = `Preview ready! Token: ${currentPreviewToken.substring(0,6)}...`;
                  btnApp.style.display = 'block';
                } else {
                  status.innerText = 'No preview token in result.';
                }
             } else if (job.status === 'failed') {
                clearInterval(interval);
                status.innerText = 'Preview failed: ' + job.error;
             }
           }
         } catch(e) {}
       }, 2000);
    }
  }
};
