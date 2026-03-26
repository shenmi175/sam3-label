import { api } from '../api.js';
import { CanvasViewer } from '../components/canvas-viewer.js';
import { FilterUI } from '../components/filter.js';
import { i18n } from '../i18n.js';
import { store } from '../store.js';

export const ImageWorkspace = {
  container: null,
  projectId: null,
  projectMeta: null,
  images: [],
  annotations: [],
  offset: 0,
  limit: 50,
  totalImages: 0,
  selectedImageId: null,
  selectedImagePath: null,
  viewer: null,
  isUnmounted: false,
  promptMode: 'pointer',
  currentPrompts: [],
  previewSectionCollapsed: false,
  focusedAnnotationId: null,
  unlabeledNavigationEnabled: false,
  uiStateSaveTimer: null,
  batchResultShownForJobId: '',
  
  async render(container, params) {
    this.container = container;
    this.projectId = params.id;
    this.isUnmounted = false;
    this.projectMeta = null;
    this.images = [];
    this.annotations = [];
    this.selectedImageId = null;
    this.selectedImagePath = null;
    this.offset = 0;
    this.currentPrompts = [];
    this.previews = []; // Storage for Pure Vision results
    this.promptMode = 'pointer';
    this.filterJobTimer = null;
    this.leftPanelHidden = false;
    this.rightPanelHidden = false;
    this.classesSectionCollapsed = false;
    this.annotationsSectionCollapsed = false;
    this.previewSectionCollapsed = false;
    this.focusedAnnotationId = null;
    this.unlabeledNavigationEnabled = false;
    this.batchResultShownForJobId = '';
    window.currentWorkspace = this;
    
    container.innerHTML = `
      <div class="workspace-layout" style="display: flex; height: 100%; flex-direction: column; background: var(--neu-bg); overflow: hidden; min-height: 0; min-width: 0; box-sizing: border-box;">
        <!-- 1. Top Navigation Bar -->
        <div class="neu-box" style="height: 56px; flex-shrink: 0; display: flex; align-items: center; padding: 0 24px; z-index: 100; border-radius: 0; gap: 20px; border-bottom: 1px solid rgba(0,0,0,0.05); box-sizing: border-box;">
          <div style="display: flex; align-items: center; gap: 12px; cursor: pointer;" onclick="window.location.hash='/'">
            <span style="font-size: 18px;">⬅️</span>
            <div style="display: flex; flex-direction: column; max-width: 280px;">
              <span id="ws-pj-name" style="font-weight: 700; font-size: 14px; color: var(--neu-text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 280px;">${i18n.t('backend_checking')}</span>
              <div style="display: flex; align-items: center; gap: 6px; font-size: 10px; color: var(--neu-text-light);">
                <span id="health-status-header-ws">${i18n.t('backend_checking')}</span>
                <span>•</span>
                <span id="ws-pj-type">${i18n.t('image_project')}</span>
              </div>
            </div>
          </div>
          
          <div style="flex: 1;"></div>

          <div style="display: flex; gap: 12px; align-items: center;">
             <div id="backend-health" class="health-indicator" style="display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--neu-text-light);">
                <span class="dot" style="width: 8px; height: 8px; border-radius: 50%; background: #fbbf24;"></span> ${i18n.t('backend_checking')}
             </div>
             <button id="btn-toggle-theme" class="neu-button" title="${i18n.t('toggle_theme')}" style="padding: 6px 10px; font-size: 14px;">
                <span id="theme-icon">🌓</span>
             </button>
             <button class="neu-button" onclick="window.location.hash='/'" style="padding: 6px 14px; font-size: 12px; font-weight: 600;">${i18n.t('dashboard')}</button>
          </div>
        </div>

        <!-- 2. Top Operation Bar -->
        <div class="neu-box" style="height: 64px; flex-shrink: 0; display: flex; align-items: center; padding: 0 24px; z-index: 90; border-radius: 0; gap: 15px; background: var(--neu-bg); border-bottom: 1px solid rgba(0,0,0,0.03); box-sizing: border-box;">
          <div style="display: flex; align-items: center; gap: 8px;">
            <label style="font-size: 11px; font-weight: 700; color: var(--neu-text-light);">${i18n.t('sam3_api')}</label>
            <input type="text" id="inp-sam3-url" class="neu-input" style="width: 180px; height: 32px; font-size: 11px;" value="${store.state.config.sam3ApiUrl}" />
            <button id="btn-test-api" class="neu-button" style="height: 32px; padding: 0 10px; font-size: 11px;">${i18n.t('test_api')}</button>
          </div>

          <div style="width: 1px; height: 24px; background: rgba(0,0,0,0.05);"></div>

          <div style="display: flex; align-items: center; gap: 8px; flex-wrap: nowrap;">
            <label style="font-size: 11px; font-weight: 700; color: var(--neu-text-light); white-space: nowrap;">${i18n.t('threshold')}</label>
            <input type="number" id="inp-threshold" class="neu-input" style="width: 64px; height: 32px; font-size: 11px;" step="0.05" min="0" max="1" value="${store.state.config.threshold}" />
            
            <label style="font-size: 11px; font-weight: 700; color: var(--neu-text-light); margin-left: 5px; white-space: nowrap;">${i18n.t('batch_size')}</label>
            <input type="number" id="inp-batch-size" class="neu-input" style="width: 64px; height: 32px; font-size: 11px;" min="1" max="200" value="${store.state.config.batchSize}" />
          </div>

          <div style="width: 1px; height: 24px; background: rgba(0,0,0,0.05);"></div>

          <div style="display: flex; gap: 8px;">
            <button id="btn-infer-current" class="neu-button" style="height: 32px; padding: 0 12px; font-size: 11px; font-weight: 700; color: var(--neu-text-active);">${i18n.t('infer_current')}</button>
            <button id="btn-batch-infer" class="neu-button" style="height: 32px; padding: 0 12px; font-size: 11px; font-weight: 600;">${i18n.t('batch_infer')}</button>
            <button id="btn-example-segment" class="neu-button" style="height: 32px; padding: 0 12px; font-size: 11px; font-weight: 600;">${i18n.t('example_segment')}</button>
            <button id="btn-example-prop" class="neu-button" style="height: 32px; padding: 0 12px; font-size: 11px; font-weight: 600;">${i18n.t('example_propagate')}</button>
          </div>

          <div style="flex: 1;"></div>

          <div style="display: flex; gap: 8px;">
            <button id="btn-open-filter" class="neu-button" style="height: 32px; padding: 0 12px; font-size: 11px; font-weight: 600;">${i18n.t('smart_filter')}</button>
            <button id="btn-open-export" class="neu-button" style="height: 32px; padding: 0 12px; font-size: 11px; font-weight: 600;">${i18n.t('export')}</button>
          </div>
        </div>

        <!-- 3. Task Progress Bar (Shadow Row) -->
        <div id="ws-task-bar" class="neu-box" style="display: none; height: 50px; align-items: center; padding: 0 24px; z-index: 80; border-radius: 0; background: var(--neu-bg-light); border-bottom: 1px solid rgba(0,0,0,0.03); gap: 20px;">
          <div style="display: flex; align-items: center; gap: 10px; min-width: 200px;">
            <span style="font-size: 11px; font-weight: 700; color: var(--neu-text-light);">${i18n.t('task_header')}:</span>
            <span id="task-name" style="font-size: 11px; font-weight: 800;">--</span>
          </div>
          <div style="flex: 1; display: flex; align-items: center; gap: 15px;">
            <div style="flex: 1; height: 4px; background: rgba(0,0,0,0.05); border-radius: 2px; overflow: hidden;">
              <div id="task-progress-fill" style="width: 0%; height: 100%; background: var(--neu-text-active); transition: width 0.3s ease;"></div>
            </div>
            <span id="task-status-text" style="font-size: 10px; font-weight: 600; min-width: 100px; text-align: right; color: var(--neu-text-light);">--</span>
          </div>
          <div style="display: flex; gap: 8px;">
            <button id="btn-task-stop" class="neu-button" style="height: 28px; padding: 0 12px; font-size: 10px; font-weight: 700; color: #ef4444;">${i18n.t('stop')}</button>
            <button id="btn-task-resume" class="neu-button" style="height: 28px; padding: 0 12px; font-size: 10px; font-weight: 700; color: #10b981; display: none;">${i18n.t('resume')}</button>
          </div>
        </div>
        
        <!-- 4. Main Workspace Area -->
        <div id="ws-main-row" style="display: flex; flex: 1; overflow: hidden; min-height: 0;">
          
          <!-- Left Column: Project Meta & Image List -->
          <div class="neu-box" id="left-panel" style="width: 320px; min-width: 320px; border-radius: 0; box-shadow: 4px 0 12px var(--neu-shadow-dark); display: flex; flex-direction: column; z-index: 50; padding: 0; min-height: 0;">
            <!-- Project Meta Card -->
            <div style="padding: 20px; border-bottom: 2px solid var(--neu-bg); background: var(--neu-bg);">
               <div class="neu-card" style="padding: 15px; margin-bottom: 10px;">
                 <h3 id="ws-pj-card-name" style="margin: 0 0 5px 0; font-size: 15px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 260px;">--</h3>
                 <div style="font-size: 10px; color: var(--neu-text-light); word-break: break-all; font-family: monospace;" id="ws-pj-card-id">--</div>
                 <div style="margin-top: 10px; display: flex; justify-content: space-between; font-size: 11px;">
                   <span>${i18n.t('total')}: <b id="ws-meta-total">0</b></span>
                   <span>${i18n.t('labeled')}: <b id="ws-meta-labeled" style="color: #10b981;">0</b></span>
                 </div>
                 <div style="margin-top: 12px; display: flex; align-items: center; gap: 10px;">
                   <div style="flex: 1; height: 6px; background: rgba(0,0,0,0.05); border-radius: 999px; overflow: hidden;">
                     <div id="ws-progress-bar" style="width: 0%; height: 100%; background: var(--neu-text-active); transition: width 0.3s ease;"></div>
                   </div>
                   <span id="ws-progress-text" style="font-size: 11px; font-weight: 700; color: var(--neu-text-light);">0 / 0</span>
                 </div>
               </div>
            </div>
            
            <div style="flex: 1; display: flex; flex-direction: column; overflow: hidden;">
               <div style="padding: 15px 20px; display: flex; justify-content: space-between; align-items: center; gap: 12px;">
                  <h3 style="margin: 0; font-size: 14px; text-transform: uppercase; letter-spacing: 1px; color: var(--neu-text-light);">${i18n.t('image_list')}</h3>
                  <div style="display: flex; align-items: center; gap: 8px;">
                    <button id="btn-find-unlabeled" class="neu-button" style="height: 28px; padding: 0 10px; font-size: 11px; font-weight: 700;" title="开启后，方向键只切换未标注图片">未标注</button>
                    <span id="ws-img-count-badge" class="neu-box" style="padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 700; box-shadow: var(--neu-inset);">0</span>
                  </div>
               </div>
               <div id="image-list-container" style="flex: 1; overflow-y: auto; padding: 10px 15px;">
                  <div style="text-align:center; padding: 40px; color: var(--neu-text-light);">${i18n.t('loading_images')}</div>
               </div>
               <div style="padding: 15px; display: flex; justify-content: space-between; align-items: center; border-top: 1px solid rgba(0,0,0,0.05);">
                  <button class="neu-button" style="width: 40px; height: 40px; border-radius: 50%; display: flex; align-items: center; justify-content: center;" id="btn-img-prev">‹</button>
                  <span id="ws-page-info" style="font-size: 12px; font-weight: 600;">1 / 1</span>
                  <button class="neu-button" style="width: 40px; height: 40px; border-radius: 50%; display: flex; align-items: center; justify-content: center;" id="btn-img-next">›</button>
               </div>
            </div>
          </div>
          
          <!-- Middle Column: Canvas & Hover Tools -->
          <div id="center-panel" style="flex: 1; position: relative; display: flex; flex-direction: column; overflow: hidden; background: var(--canvas-bg); min-width: 0; min-height: 0;">
             <!-- Canvas Area -->
             <div id="canvas-container" style="flex: 1; position: relative;">
                <div id="canvas-placeholder" style="position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); text-align: center; pointer-events: none;">
                   <div style="font-size: 64px; opacity: 0.1; margin-bottom: 20px;">🖼️</div>
                   <div style="font-size: 18px; font-weight: 600; color: var(--neu-text-light);">${i18n.t('select_image_prompt')}</div>
                </div>

                <!-- Hovering Toolbar -->
                 <div class="neu-box" style="position: absolute; top: 20px; left: 50%; transform: translateX(-50%); height: 50px; border-radius: 25px; display: flex; align-items: center; padding: 0 10px; z-index: 100; gap: 5px; box-shadow: 0 10px 30px rgba(0,0,0,0.1); background: var(--canvas-toolbar-bg);">
                    <button class="neu-button" id="btn-tool-pan" title="Pan / Drag Image" style="width: 40px; height: 40px; border-radius: 50%;">✋</button>
                    <button class="neu-button" id="btn-tool-point" title="Point Prompt" style="width: 40px; height: 40px; border-radius: 50%;">📍</button>
                    <button class="neu-button" id="btn-tool-box" title="Box Prompt" style="width: 40px; height: 40px; border-radius: 50%;">🏁</button>
                    <div style="width: 1px; height: 24px; background: rgba(0,0,0,0.1); margin: 0 5px;"></div>
                    <button class="neu-button" id="btn-tool-clear" title="${i18n.t('clear_prompts')}" style="width: 40px; height: 40px; border-radius: 50%;">🧹</button>
                    <div style="width: 1px; height: 24px; background: rgba(0,0,0,0.1); margin: 0 5px;"></div>
                    <button class="neu-button" id="btn-vtool-filter" title="${i18n.t('filter_settings')}" style="width: 40px; height: 40px; border-radius: 50%;">🔍</button>
                 </div>
             </div>

             <!-- Display Toggles & Information -->
             <div class="neu-box" style="height: 40px; border-radius: 0; display: flex; align-items: center; padding: 0 20px; gap: 20px; background: var(--neu-bg); z-index: 40; font-size: 11px; border-top: 1px solid rgba(0,0,0,0.03);">
                <label style="display: flex; align-items: center; gap: 6px; cursor: pointer;">
                   <input type="checkbox" id="chk-show-masks" checked /> 显示遮罩
                </label>
                <label style="display: flex; align-items: center; gap: 6px; cursor: pointer;">
                   <input type="checkbox" id="chk-auto-infer" /> 提示后自动分割
                </label>
                <div style="flex: 1;"></div>
                <div id="ws-image-status" style="font-weight: 700; color: var(--neu-text-light);">--</div>
             </div>

             <!-- Bottom Action Bar (Context Sensitive) -->
             <div id="ws-action-bar" style="position: absolute; bottom: 60px; left: 50%; transform: translateX(-50%); z-index: 100; display: none;">
                <button class="neu-button" id="btn-submit-preview" style="padding: 12px 32px; border-radius: 30px; font-weight: 800; font-size: 16px; color: var(--neu-text-active); background: var(--neu-bg); box-shadow: var(--neu-outset);">
                   ${i18n.t('submit_all')}
                </button>
             </div>
          </div>
          
          <!-- Right Column: Classes & Annotations -->
             <div class="neu-box" id="right-panel" style="width: 320px; min-width: 320px; border-radius: 0; box-shadow: -4px 0 12px var(--neu-shadow-dark); z-index: 50; display: flex; flex-direction: column; background: var(--neu-bg); min-height: 0;">
             <!-- Classes Management -->
              <div style="padding: 20px; border-bottom: 2px solid var(--neu-bg); background: var(--neu-bg); display: flex; flex-direction: column; min-height: 0; max-height: 40%;">
                 <h3 style="margin: 0 0 15px 0; font-size: 14px; text-transform: uppercase; letter-spacing: 1px; color: var(--neu-text-light);">${i18n.t('annotations_summary')}</h3>
                 <div id="classes-list" style="display: flex; flex-direction: column; gap: 8px; overflow-y: auto; padding-right: 5px; flex: 1; min-height: 0;">
                    <!-- Class items -->
                 </div>
                 <button class="neu-button" id="btn-add-class-ws" style="width: 100%; margin-top: 15px; font-size: 12px; font-weight: 600; color: var(--neu-text-active); padding: 10px; flex-shrink: 0;">${i18n.t('create_class')}</button>
              </div>

             <!-- Annotations List -->
             <div style="flex: 1; display: flex; flex-direction: column; overflow: hidden;">
                <div style="padding: 12px 20px; border-bottom: 1px solid rgba(0,0,0,0.03); display: flex; justify-content: space-between; align-items: center;">
                   <h3 style="margin: 0; font-size: 14px; text-transform: uppercase; letter-spacing: 1px; color: var(--neu-text-light);">${i18n.t('标注列表') || '标注列表'}</h3>
                   <button id="btn-collapse-anns" class="neu-button" style="width: 28px; height: 28px; padding: 0; border-radius: 50%; font-size: 12px;" title="折叠/展开">−</button>
                </div>
                <div id="annotation-list-wrapper" style="flex: 1; display: flex; flex-direction: column; overflow: hidden;">
                  <div id="annotation-list-container" style="flex: 1; overflow-y: auto; padding: 15px; display: flex; flex-direction: column; gap: 10px;">
                     <!-- Annotation items -->
                     <div style="text-align: center; padding: 40px; color: var(--neu-text-light); font-size: 12px;">无标注数据</div>
                  </div>
                </div>
                <div style="padding: 20px; border-top: 1px solid rgba(0,0,0,0.05); display: flex; flex-direction: column; gap: 10px;">
                   <div class="neu-box" style="padding: 12px; border-radius: 12px; background: var(--neu-bg-light);">
                     <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; gap: 12px;">
                       <span style="font-size: 12px; font-weight: 800; color: var(--neu-text-light);">${i18n.t('preview_results')}</span>
                       <span style="font-size: 10px; color: var(--neu-text-light); text-align: right;">${i18n.t('preview_results_desc')}</span>
                     </div>
                     <div id="preview-list" style="display: flex; flex-direction: column; gap: 10px; max-height: 220px; overflow-y: auto;"></div>
                   </div>
                   <button id="btn-save-anns" class="neu-button" style="width: 100%; height: 44px; font-weight: 700; color: var(--neu-text-active);">${i18n.t('save_anns')}</button>
                   <button id="btn-clear-anns" class="neu-button" style="width: 100%; height: 44px; font-weight: 600; color: #ef4444;">${i18n.t('clear_anns')}</button>
                </div>
             </div>

             <!-- Hidden Previews Section (becomes a modal or overlay later) -->
             <div id="preview-floating-panel" style="display: none;"></div>
          </div>
        </div>
      </div>

      <!-- Modals -->
      <div id="modal-filter-full" class="modal-overlay" style="display: none;"></div>
      <div id="modal-export-full" class="modal-overlay" style="display: none;"></div>
      <div id="modal-batch-full" class="modal-overlay" style="display: none;"></div>
      <div id="modal-batch-result" class="modal-overlay" style="display: none;"></div>
    `;

    this.initializeLayoutControls();
    
    this.viewer = new CanvasViewer('canvas-container');
    this.viewer.onPromptAdded = (type, data) => this.addPrompt(type, data);
    this.setPromptMode('pointer');
    
    this.bindEvents();
    this.refreshUnlabeledButton();
    window.currentWorkspace = this;
    
    await this.loadProjectInfo();
    await this.restoreProjectUIState();
    this.applyLayoutState();
    await this.loadImages();
    await this.restoreSelectedImage();
    this.startHealthCheck();
  },

  initializeLayoutControls() {
    const canvasContainer = document.getElementById('canvas-container');
    const centerPanel = document.getElementById('center-panel');
    const pointBtn = document.getElementById('btn-tool-point');
    const fitBtn = document.getElementById('btn-vtool-filter');
    const leftPanel = document.getElementById('left-panel');
    const rightPanel = document.getElementById('right-panel');

    if (canvasContainer && pointBtn && !document.getElementById('btn-tool-pointer')) {
      const pointerBtn = document.createElement('button');
      pointerBtn.className = 'neu-button active';
      pointerBtn.id = 'btn-tool-pointer';
      pointerBtn.title = 'Pointer / Pan';
      pointerBtn.style.cssText = 'width: 40px; height: 40px; border-radius: 50%;';
      pointerBtn.textContent = '↖';
      pointBtn.parentNode.insertBefore(pointerBtn, pointBtn);
    }

    if (fitBtn) {
      fitBtn.title = 'Fit to Screen';
      fitBtn.textContent = '⤢';
    }

    const ensureSideToggle = (id, text, styleText) => {
      if (!canvasContainer || document.getElementById(id)) return;
      const btn = document.createElement('button');
      btn.id = id;
      btn.className = 'neu-button';
      btn.style.cssText = styleText;
      btn.textContent = text;
      canvasContainer.appendChild(btn);
    };
    ensureSideToggle(
      'btn-toggle-left-panel',
      '⟨',
      'position: absolute; top: 50%; left: 14px; transform: translateY(-50%); width: 34px; height: 64px; z-index: 95; border-radius: 17px; font-size: 16px; border: 1px solid rgba(0,0,0,0.05);'
    );
    ensureSideToggle(
      'btn-toggle-right-panel',
      '⟩',
      'position: absolute; top: 50%; right: 14px; transform: translateY(-50%); width: 34px; height: 64px; z-index: 95; border-radius: 17px; font-size: 16px; border: 1px solid rgba(0,0,0,0.05);'
    );

    if (leftPanel) {
      leftPanel.style.minWidth = '320px';
    }
    if (rightPanel) {
      rightPanel.style.minWidth = '320px';
    }

    const pointerBtn = document.getElementById('btn-tool-pointer');
    if (pointerBtn) pointerBtn.textContent = 'P';
    if (fitBtn) fitBtn.textContent = 'F';

    const leftToggle = document.getElementById('btn-toggle-left-panel');
    const rightToggle = document.getElementById('btn-toggle-right-panel');
    if (centerPanel && leftToggle && leftToggle.parentElement !== centerPanel) centerPanel.appendChild(leftToggle);
    if (centerPanel && rightToggle && rightToggle.parentElement !== centerPanel) centerPanel.appendChild(rightToggle);
    if (leftToggle) leftToggle.textContent = '<';
    if (rightToggle) rightToggle.textContent = '>';

    const classesSection = rightPanel?.children?.[0] || null;
    if (classesSection && !document.getElementById('classes-section-body')) {
      classesSection.id = 'classes-section';
      const title = classesSection.querySelector('h3');
      const classesList = document.getElementById('classes-list');
      const addClassBtn = document.getElementById('btn-add-class-ws');
      if (title && classesList && addClassBtn) {
        const header = document.createElement('div');
        header.style.cssText = 'display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 15px;';
        title.parentNode.insertBefore(header, title);
        header.appendChild(title);

        const toggleBtn = document.createElement('button');
        toggleBtn.id = 'btn-toggle-classes-section';
        toggleBtn.className = 'neu-button';
        toggleBtn.style.cssText = 'width: 30px; height: 30px; padding: 0; font-size: 14px;';
        toggleBtn.textContent = '−';
        header.appendChild(toggleBtn);

        const body = document.createElement('div');
        body.id = 'classes-section-body';
        body.style.cssText = 'display: flex; flex-direction: column; gap: 8px; min-height: 0;';
        classesSection.appendChild(body);
        body.appendChild(classesList);
        body.appendChild(addClassBtn);
      }
    }

    const classesToggleBtn = document.getElementById('btn-toggle-classes-section');
    if (classesToggleBtn) classesToggleBtn.textContent = '-';

    const previewList = document.getElementById('preview-list');
    const previewCard = previewList?.closest('.neu-box') || null;
    if (previewCard && !document.getElementById('btn-collapse-preview')) {
      previewCard.style.flexShrink = '0';
      const headerRow = previewCard.firstElementChild;
      if (headerRow) {
        const toggleBtn = document.createElement('button');
        toggleBtn.id = 'btn-collapse-preview';
        toggleBtn.className = 'neu-button';
        toggleBtn.style.cssText = 'width: 28px; height: 28px; padding: 0; border-radius: 50%; font-size: 12px; flex-shrink: 0;';
        toggleBtn.textContent = '-';
        headerRow.appendChild(toggleBtn);
      }
      const previewBody = document.createElement('div');
      previewBody.id = 'preview-section-body';
      previewBody.style.cssText = 'display: flex; flex-direction: column; min-height: 0;';
      previewCard.appendChild(previewBody);
      previewBody.appendChild(previewList);
    }

    // Note: annotations section collapse is handled by btn-collapse-anns already in the HTML template
    // and bound in bindEvents(). No dynamic injection needed here.
  },

  applyLayoutState() {
    const leftPanel = document.getElementById('left-panel');
    const rightPanel = document.getElementById('right-panel');
    const leftBtn = document.getElementById('btn-toggle-left-panel');
    const rightBtn = document.getElementById('btn-toggle-right-panel');
    if (leftPanel) leftPanel.style.display = this.leftPanelHidden ? 'none' : 'flex';
    if (rightPanel) rightPanel.style.display = this.rightPanelHidden ? 'none' : 'flex';
    if (leftBtn) leftBtn.textContent = this.leftPanelHidden ? '>' : '<';
    if (rightBtn) rightBtn.textContent = this.rightPanelHidden ? '<' : '>';

    const classesBody = document.getElementById('classes-section-body');
    const classesBtn = document.getElementById('btn-toggle-classes-section');
    if (classesBody) classesBody.style.display = this.classesSectionCollapsed ? 'none' : 'flex';
    if (classesBtn) classesBtn.textContent = this.classesSectionCollapsed ? '+' : '-';

    const annWrapper = document.getElementById('annotation-list-wrapper');
    const annBtn = document.getElementById('btn-collapse-anns');
    if (annWrapper) annWrapper.style.display = this.annotationsSectionCollapsed ? 'none' : 'flex';
    if (annBtn) annBtn.textContent = this.annotationsSectionCollapsed ? '+' : '-';

    const previewWrapper = document.getElementById('preview-section-body');
    const previewBtn = document.getElementById('btn-collapse-preview');
    if (previewWrapper) previewWrapper.style.display = this.previewSectionCollapsed ? 'none' : 'flex';
    if (previewBtn) previewBtn.textContent = this.previewSectionCollapsed ? '+' : '-';

    requestAnimationFrame(() => {
      if (this.viewer) this.viewer.onResize();
    });
  },

  unmount() {
    this.isUnmounted = true;
    this.flushProjectUIState();
    if (this.viewer) {
      this.viewer.destroy();
      this.viewer = null;
    }
    if (this.healthInterval) clearInterval(this.healthInterval);
    if (this.filterJobTimer) clearTimeout(this.filterJobTimer);
    if (this.uiStateSaveTimer) {
      clearTimeout(this.uiStateSaveTimer);
      this.uiStateSaveTimer = null;
    }
    if (this._keyHandler) {
      document.removeEventListener('keydown', this._keyHandler);
      this._keyHandler = null;
    }
    this.container = null;
    window.currentWorkspace = null;
  },

  sanitizeOffset(offsetValue = this.offset, totalValue = this.totalImages) {
    const total = Math.max(0, Number(totalValue || 0));
    const limit = Math.max(1, Number(this.limit || 50));
    let nextOffset = Math.max(0, Number(offsetValue || 0));
    if (total > 0 && nextOffset >= total) {
      nextOffset = Math.max(0, Math.floor((total - 1) / limit) * limit);
    }
    return nextOffset;
  },

  async restoreProjectUIState() {
    try {
      const res = await api.getUIState(this.projectId);
      const state = res?.state || {};
      this.offset = this.sanitizeOffset(state.offset ?? 0, this.totalImages);
      this.limit = Math.max(1, Number(state.limit || this.limit || 50));
      this.selectedImageId = state.selectedImageId || null;
      this.selectedImagePath = state.selectedImagePath || null;
      this.focusedAnnotationId = state.focusedAnnotationId || null;
      this.unlabeledNavigationEnabled = Boolean(state.unlabeledNavigationEnabled);
      this.leftPanelHidden = Boolean(state.leftPanelHidden);
      this.rightPanelHidden = Boolean(state.rightPanelHidden);
      this.classesSectionCollapsed = Boolean(state.classesSectionCollapsed);
      this.annotationsSectionCollapsed = Boolean(state.annotationsSectionCollapsed);
      this.previewSectionCollapsed = Boolean(state.previewSectionCollapsed);
      this.refreshUnlabeledButton();
    } catch (err) {
      console.warn('restore project ui state failed', err);
      this.offset = 0;
    }
  },

  scheduleProjectUIStateSave() {
    if (this.isUnmounted || !this.projectId) return;
    if (this.uiStateSaveTimer) clearTimeout(this.uiStateSaveTimer);
    this.uiStateSaveTimer = setTimeout(() => this.flushProjectUIState(), 150);
  },

  async flushProjectUIState() {
    if (this.isUnmounted || !this.projectId) return;
    try {
      await api.setUIState(this.projectId, {
        offset: this.sanitizeOffset(this.offset, this.totalImages),
        limit: this.limit,
        selectedImageId: this.selectedImageId || '',
        selectedImagePath: this.selectedImagePath || '',
        focusedAnnotationId: this.focusedAnnotationId || '',
        unlabeledNavigationEnabled: Boolean(this.unlabeledNavigationEnabled),
        leftPanelHidden: Boolean(this.leftPanelHidden),
        rightPanelHidden: Boolean(this.rightPanelHidden),
        classesSectionCollapsed: Boolean(this.classesSectionCollapsed),
        annotationsSectionCollapsed: Boolean(this.annotationsSectionCollapsed),
        previewSectionCollapsed: Boolean(this.previewSectionCollapsed),
      });
    } catch (err) {
      console.warn('save project ui state failed', err);
    }
  },

  async restoreSelectedImage() {
    let targetId = this.selectedImageId;
    let targetPath = this.selectedImagePath;
    if (!targetId && this.images.length > 0) {
      targetId = this.images[0].id;
      targetPath = this.images[0].rel_path;
    }
    if (targetId) {
      await this.selectImage(targetId, targetPath, { preserveFit: false });
    }
  },

  startHealthCheck() {
    const check = async () => {
      const el = document.getElementById('backend-health');
      const headerStatus = document.getElementById('health-status-header-ws');
      if (!el) return;
      try {
        const res = await api.getHealth();
        const dot = el.querySelector('.dot');
        if (res.status === 'ok') {
          dot.style.background = '#10b981';
          const txt = i18n.t('backend_online');
          el.innerHTML = `<span class="dot" style="width: 8px; height: 8px; border-radius: 50%; background: #10b981; margin-right: 6px;"></span> ${txt}`;
          if (headerStatus) headerStatus.innerText = txt;
        } else {
          dot.style.background = '#ef4444';
          const txt = i18n.t('backend_error');
          el.innerHTML = `<span class="dot" style="width: 8px; height: 8px; border-radius: 50%; background: #ef4444; margin-right: 6px;"></span> ${txt}`;
          if (headerStatus) headerStatus.innerText = txt;
        }
      } catch (e) {
        const txt = i18n.t('backend_offline');
        el.innerHTML = `<span class="dot" style="width: 8px; height: 8px; border-radius: 50%; background: #ef4444; margin-right: 6px;"></span> ${txt}`;
        if (headerStatus) headerStatus.innerText = txt;
      }
    };
    check();
    this.healthInterval = setInterval(check, 10000);
  },
  bindEvents() {
    // Top Operation Bar
    const sam3UrlInp = document.getElementById('inp-sam3-url');
    if (sam3UrlInp) sam3UrlInp.onchange = (e) => store.setConfig('sam3ApiUrl', e.target.value);
    
    const thresholdInp = document.getElementById('inp-threshold');
    if (thresholdInp) thresholdInp.onchange = (e) => store.setConfig('threshold', parseFloat(e.target.value));
    
    const batchSizeInp = document.getElementById('inp-batch-size');
    if (batchSizeInp) batchSizeInp.onchange = (e) => store.setConfig('batchSize', parseInt(e.target.value));

    const btnTest = document.getElementById('btn-test-api');
    if (btnTest) btnTest.onclick = async () => {
      try {
        btnTest.disabled = true;
        btnTest.innerText = 'Testing...';
        await api.testSam3(store.state.config.sam3ApiUrl);
        showToast("SAM3 API is Online", "success");
      } catch(e) {
        showToast("SAM3 API Connection Failed: " + e.message, "error");
      } finally {
        btnTest.disabled = false;
        btnTest.innerText = i18n.t('test_api');
      }
    };

    const btnInfer = document.getElementById('btn-infer-current');
    if (btnInfer) btnInfer.onclick = () => this.runSingleInfer();
    
    const btnBatch = document.getElementById('btn-batch-infer');
    if (btnBatch) btnBatch.onclick = () => this.startBatchTask('text');
    
    const btnExSeg = document.getElementById('btn-example-segment');
    if (btnExSeg) btnExSeg.onclick = () => this.runExamplePreview();
    
    const btnExProp = document.getElementById('btn-example-prop');
    if (btnExProp) btnExProp.onclick = () => this.startBatchTask('example');
    
    const btnFilter = document.getElementById('btn-open-filter');
    if (btnFilter) btnFilter.onclick = () => this.openSmartFilter();
    
    const btnExport = document.getElementById('btn-open-export');
    if (btnExport) btnExport.onclick = () => this.openExport();

    // Task Bar
    const btnStop = document.getElementById('btn-task-stop');
    if (btnStop) btnStop.onclick = () => this.stopActiveTask();
    
    const btnResume = document.getElementById('btn-task-resume');
    if (btnResume) btnResume.onclick = () => this.resumeActiveTask();

    // Image List (Event Delegation)
    const listCont = document.getElementById('image-list-container');
    if (listCont) {
      listCont.onclick = (e) => {
        const item = e.target.closest('.image-item');
        if (item) {
          this.selectImage(item.dataset.id, item.dataset.rel);
        }
      };
    }

    const btnPrev = document.getElementById('btn-img-prev');
    if (btnPrev) btnPrev.onclick = () => {
      if (this.offset >= this.limit) {
        this.offset -= this.limit;
        this.loadImages();
      }
    };
    
    const btnNext = document.getElementById('btn-img-next');
    if (btnNext) btnNext.onclick = () => {
      if (this.offset + this.limit < this.totalImages) {
        this.offset += this.limit;
        this.loadImages();
      }
    };

    const btnFindUnlabeled = document.getElementById('btn-find-unlabeled');
    if (btnFindUnlabeled) btnFindUnlabeled.onclick = () => this.toggleUnlabeledNavigation();
    
    const btnAddCls = document.getElementById('btn-add-class-ws');
    if (btnAddCls) btnAddCls.onclick = () => this.showAddClassModal();

    // Canvas Tools (Pan / Pointer / Point / Box / Clear / Fit)
    const btnToolPan = document.getElementById('btn-tool-pan');
    const btnToolPointer = document.getElementById('btn-tool-pointer');
    const btnToolPoint = document.getElementById('btn-tool-point');
    const btnToolBox = document.getElementById('btn-tool-box');
    const btnToolClear = document.getElementById('btn-tool-clear') || document.getElementById('btn-vtool-clear');
    const btnToolFit = document.getElementById('btn-vtool-filter');

    if (btnToolPan) btnToolPan.onclick = () => this.setPromptMode('pan');
    if (btnToolPointer) btnToolPointer.onclick = () => this.setPromptMode('pointer');
    if (btnToolPoint) btnToolPoint.onclick = () => this.setPromptMode('point');
    if (btnToolBox) btnToolBox.onclick = () => this.setPromptMode('box');
    if (btnToolClear) btnToolClear.onclick = () => {
      this.currentPrompts = [];
      this.previews = [];
      if (this.viewer) {
        this.viewer.setPrompts([]);
        this.viewer.setPreviews([]);
      }
      this.renderPreviews();
      this.updateActionBar();
      showToast(i18n.t('prompts_cleared'));
    };
    if (btnToolFit) btnToolFit.onclick = () => {
      if (this.viewer) this.viewer.fitToScreen();
    };

    // Annotation section collapse toggle
    const btnCollapseAnns = document.getElementById('btn-collapse-anns');
    if (btnCollapseAnns) {
      btnCollapseAnns.onclick = () => {
        const wrapper = document.getElementById('annotation-list-wrapper');
        if (!wrapper) return;
        const collapsed = wrapper.style.display === 'none';
        wrapper.style.display = collapsed ? 'flex' : 'none';
        btnCollapseAnns.innerText = collapsed ? '\u2212' : '+';
      };
    }

    const chkShowMasks = document.getElementById('chk-show-masks');
    if (chkShowMasks) chkShowMasks.onchange = (e) => {
      if (this.viewer) this.viewer.setOptions({ showMasks: e.target.checked });
    };

    const btnToggleLeftPanel = document.getElementById('btn-toggle-left-panel');
    if (btnToggleLeftPanel) btnToggleLeftPanel.onclick = () => this.toggleSidePanel('left');
    const btnToggleRightPanel = document.getElementById('btn-toggle-right-panel');
    if (btnToggleRightPanel) btnToggleRightPanel.onclick = () => this.toggleSidePanel('right');
    const btnToggleClasses = document.getElementById('btn-toggle-classes-section');
    if (btnToggleClasses) btnToggleClasses.onclick = () => this.toggleSection('classes');
    const btnToggleAnnotations = document.getElementById('btn-collapse-anns') || document.getElementById('btn-toggle-annotations-section');
    if (btnToggleAnnotations) btnToggleAnnotations.onclick = () => this.toggleSection('annotations');
    const btnTogglePreview = document.getElementById('btn-collapse-preview');
    if (btnTogglePreview) btnTogglePreview.onclick = () => this.toggleSection('preview');

    // Right Column
    const btnSaveAnns = document.getElementById('btn-save-anns');
    if (btnSaveAnns) btnSaveAnns.onclick = () => this.saveCurrentAnns();
    const btnClearAnns = document.getElementById('btn-clear-anns');
    if (btnClearAnns) btnClearAnns.onclick = () => this.clearCurrentAnns();
    const btnSubmitPreview = document.getElementById('btn-submit-preview');
    if (btnSubmitPreview) btnSubmitPreview.onclick = () => this.keepAllPreviews();

    // Theme Toggle
    const btnTheme = document.getElementById('btn-toggle-theme');
    if (btnTheme) btnTheme.onclick = () => {
      const next = store.state.config.theme === 'dark' ? 'light' : 'dark';
      store.setConfig('theme', next);
      const icon = document.getElementById('theme-icon');
      if (icon) icon.innerText = next === 'dark' ? '☀️' : '🌓';
    };

    // Keyboard navigation: ArrowUp/Left = prev image, ArrowDown/Right = next image
    // Debounce to avoid skipping images on fast key repeat
    let navTimer = null;
    this._keyHandler = (e) => {
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
        e.preventDefault();
        clearTimeout(navTimer);
        navTimer = setTimeout(() => this.navigateImage(-1), 120);
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
        e.preventDefault();
        clearTimeout(navTimer);
        navTimer = setTimeout(() => this.navigateImage(1), 120);
      }
    };
    document.addEventListener('keydown', this._keyHandler);
  },

  navigateImage(delta) {
    if (this.unlabeledNavigationEnabled) {
      this.navigateUnlabeledImage(delta);
      return;
    }
    if (!this.images || this.images.length === 0) return;
    const currentIndex = this.images.findIndex(img => img.id === this.selectedImageId);
    const nextIndex = currentIndex + delta;
    if (nextIndex >= 0 && nextIndex < this.images.length) {
      const img = this.images[nextIndex];
      this.selectImage(img.id, img.rel_path);
      setTimeout(() => {
        const el = document.querySelector(`.image-item[data-id="${img.id}"]`);
        if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }, 50);
    } else if (nextIndex < 0 && this.offset >= this.limit) {
      this.offset -= this.limit;
      this.loadImages().then(() => {
        const img = this.images[this.images.length - 1];
        if (img) this.selectImage(img.id, img.rel_path);
      });
    } else if (nextIndex >= this.images.length && this.offset + this.limit < this.totalImages) {
      this.offset += this.limit;
      this.loadImages().then(() => {
        const img = this.images[0];
        if (img) this.selectImage(img.id, img.rel_path);
      });
    }
  },

  toggleUnlabeledNavigation() {
    this.unlabeledNavigationEnabled = !this.unlabeledNavigationEnabled;
    this.refreshUnlabeledButton();
    this.scheduleProjectUIStateSave();
    showToast(
      this.unlabeledNavigationEnabled
        ? '未标注导航已开启，方向键将只切换未标注图片'
        : '未标注导航已关闭，方向键恢复普通切图',
      'info'
    );
  },

  refreshUnlabeledButton() {
    const btn = document.getElementById('btn-find-unlabeled');
    if (!btn) return;
    btn.style.boxShadow = this.unlabeledNavigationEnabled ? 'var(--neu-inset)' : 'var(--neu-outset-sm)';
    btn.style.color = this.unlabeledNavigationEnabled ? 'var(--neu-text-active)' : 'var(--neu-text)';
    btn.textContent = this.unlabeledNavigationEnabled ? '未标注: 开' : '未标注';
  },

  async navigateUnlabeledImage(delta) {
    try {
      const direction = delta < 0 ? 'prev' : 'next';
      const res = await api.getUnlabeledImage(this.projectId, this.selectedImageId || '', direction);
      const image = res?.image || null;
      const imageIndex = Number(res?.image_index ?? -1);
      if (!image || !image.id) {
        showToast('No unlabeled images found', 'info');
        return;
      }
      if (imageIndex >= 0) {
        this.offset = Math.floor(imageIndex / this.limit) * this.limit;
      }
      await this.loadImages();
      await this.selectImage(image.id, image.rel_path);
      setTimeout(() => {
        const el = document.querySelector(`.image-item[data-id="${image.id}"]`);
        if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }, 50);
    } catch (e) {
      showToast(e.message, 'error');
    }
  },

  toggleSidePanel(side) {
    const panelId = side === 'left' ? 'left-panel' : 'right-panel';
    const btnId = side === 'left' ? 'btn-toggle-left-panel' : 'btn-toggle-right-panel';
    const panel = document.getElementById(panelId);
    const btn = document.getElementById(btnId);
    if (!panel) return;
    const hidden = panel.style.display === 'none';
    panel.style.display = hidden ? 'flex' : 'none';
    if (side === 'left') this.leftPanelHidden = !hidden;
    else this.rightPanelHidden = !hidden;
    if (btn) btn.textContent = side === 'left'
      ? (hidden ? '<' : '>')
      : (hidden ? '>' : '<');
    this.scheduleProjectUIStateSave();
    requestAnimationFrame(() => {
      if (this.viewer) this.viewer.onResize();
    });
  },

  toggleSection(section) {
    if (section === 'classes') {
      const body = document.getElementById('classes-section-body');
      const btn = document.getElementById('btn-toggle-classes-section');
      if (!body) return;
      this.classesSectionCollapsed = !this.classesSectionCollapsed;
      body.style.display = this.classesSectionCollapsed ? 'none' : 'flex';
      const classesSection = document.getElementById('classes-section');
      if (classesSection) classesSection.style.maxHeight = this.classesSectionCollapsed ? 'auto' : '40%';
      if (btn) btn.textContent = this.classesSectionCollapsed ? '+' : '-';
      this.scheduleProjectUIStateSave();
    } else if (section === 'annotations') {
      const wrapper = document.getElementById('annotation-list-wrapper');
      const btn = document.getElementById('btn-collapse-anns') || document.getElementById('btn-toggle-annotations-section');
      if (!wrapper) return;
      this.annotationsSectionCollapsed = !this.annotationsSectionCollapsed;
      wrapper.style.display = this.annotationsSectionCollapsed ? 'none' : 'flex';
      if (btn) btn.textContent = this.annotationsSectionCollapsed ? '+' : '-';
      this.scheduleProjectUIStateSave();
    } else if (section === 'preview') {
      const wrapper = document.getElementById('preview-section-body');
      const btn = document.getElementById('btn-collapse-preview');
      if (!wrapper) return;
      this.previewSectionCollapsed = !this.previewSectionCollapsed;
      wrapper.style.display = this.previewSectionCollapsed ? 'none' : 'flex';
      if (btn) btn.textContent = this.previewSectionCollapsed ? '+' : '-';
      this.scheduleProjectUIStateSave();
    }
  },

  selectAllPreviews() {
    // In current implementation, "Submit" already keeps all. 
    // This button could be used to toggle visual selection if we had selective submission.
    // For now, let's make it a quick way to trigger keepAllPreviews.
    this.keepAllPreviews();
  },

  updateActionBar() {
    const bar = document.getElementById('ws-action-bar');
    const btn = document.getElementById('btn-submit-preview');
    const btnAll = document.getElementById('btn-select-all-previews');
    if (!bar || !btn) return;
    
    if (this.previews.length > 0) {
      bar.style.display = 'block';
      if (btnAll) btnAll.style.display = 'block';
      const className = this.selectedClass || (this.projectMeta.classes?.[0] || 'Object');
      btn.textContent = `Submit ${this.previews.length} Previews to [${className}]`;
    } else {
      bar.style.display = 'none';
      if (btnAll) btnAll.style.display = 'none';
    }
  },

  async keepAllPreviews() {
    if (this.previews.length === 0) return;
    const className = this.selectedClass || (this.projectMeta.classes?.[0] || 'Object');
    
    try {
      const existing = await api.getAnnotations(this.projectId, this.selectedImageId);
      const newAnns = [...(existing.annotations || []), ...this.previews.map(p => ({
        ...p,
        id: 'ann_' + Math.random().toString(36).substr(2, 9),
        class_name: className
      }))];
      
      await api.saveAnnotations(this.projectId, this.selectedImageId, newAnns);
      
      // Clear previews and refresh
      this.previews = [];
      this.currentPrompts = [];
      this.viewer.setPrompts([]);
      this.viewer.setPreviews([]);
      this.renderPreviews();
      this.updateActionBar();
      
      await this.loadProjectInfo(); // Refresh counts
      await this.selectImage(this.selectedImageId, this.selectedImagePath); // Refresh annotations list
      
    } catch(e) {
      alert("Failed to save: " + e.message);
    }
  },

  renderClasses() {
    const list = document.getElementById('classes-list');
    const classes = this.projectMeta?.classes || [];
    
    if (classes.length === 0) {
      list.innerHTML = `<div style="color:var(--neu-text-light); font-size:12px; text-align:center;">${i18n.t('no_classes')}</div>`;
      return;
    }
    
    if (!this.selectedClass) this.selectedClass = classes[0];

    // Calculate current image class counts
    const annCounts = {};
    (this.annotations || []).forEach(ann => {
      annCounts[ann.class_name] = (annCounts[ann.class_name] || 0) + 1;
    });

    list.innerHTML = classes.map(cls => {
      const escapedCls = cls.replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      return `
        <div class="neu-button class-item ${this.selectedClass === cls ? 'active' : ''}" 
             data-cls="${escapedCls}"
             style="justify-content: space-between; padding: 10px 15px; font-size: 13px; border-radius: 12px; ${this.selectedClass === cls ? 'box-shadow: var(--neu-inset);' : ''}">
          <div class="cls-select" style="display: flex; align-items: center; gap: 10px; flex: 1; cursor: pointer; pointer-events: auto;">
             <span style="display:inline-block; width:12px; height:12px; border-radius:50%; background:${this.getClassColor(cls)}; box-shadow: 0 2px 5px rgba(0,0,0,0.1); pointer-events: none;"></span>
             <span style="font-weight: 600; pointer-events: none;">${escapedCls}</span>
          </div>
          <div style="display: flex; align-items: center; gap: 6px;">
             <span style="font-size: 11px; opacity: 0.6; font-family: monospace;">(${annCounts[cls] || 0})</span>
             <input type="checkbox" class="cls-chk-infer" data-cls="${escapedCls}" title="Include in text inference" checked style="width: 14px; height: 14px; cursor: pointer;" />
             <button class="cls-delete-btn neu-button" data-delete-cls="${escapedCls}" style="width: 22px; height: 22px; padding: 0; border-radius: 50%; font-size: 11px; color: #ef4444; flex-shrink: 0;" title="删除类别">×</button>
          </div>
        </div>
      `;
    }).join('');

    // Attach events via delegation on the list element
    list.onclick = (e) => {
      const deleteBtn = e.target.closest('.cls-delete-btn');
      if (deleteBtn) {
        e.stopPropagation();
        this.deleteClass(deleteBtn.dataset.deleteCls);
        return;
      }
      const selectArea = e.target.closest('.cls-select');
      if (selectArea) {
        const item = e.target.closest('.class-item');
        if (item) this.selectClass(item.dataset.cls);
      }
    };
    
    this.updateActionBar();
  },

  selectClass(cls) {
    this.selectedClass = cls;
    this.renderClasses();
  },

  async deleteClass(className) {
    if (!confirm(`确认删除类别 "${className}" ？`)) return;
    try {
      await api.deleteClass(this.projectId, className);
      if (this.selectedClass === className) this.selectedClass = null;
      await this.loadProjectInfo();
      showToast(`类别 "${className}" 已删除`, 'success');
    } catch(e) { showToast(e.message, 'error'); }
  },

  showAddClassModal() {
    const existing = document.getElementById('modal-add-class');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'modal-add-class';
    modal.className = 'modal-overlay';
    modal.style.cssText = 'position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; z-index: 9999; background: rgba(0,0,0,0.3); backdrop-filter: blur(4px);';
    modal.innerHTML = `
      <div class="neu-card" style="width: 380px; padding: 28px; border-radius: 20px; position: relative;">
        <button class="neu-button" style="position: absolute; top: 15px; right: 15px; width: 30px; height: 30px; padding: 0; border-radius: 50%; font-size: 16px; color: #ef4444;" onclick="document.getElementById('modal-add-class').remove()">&times;</button>
        <h3 style="margin: 0 0 20px 0; font-size: 16px;">\u65B0\u589E\u7C7B\u522B</h3>
        <textarea id="inp-new-class-names" class="neu-input" rows="4" placeholder="\u6BCF\u884C\u4E00\u4E2A\u7C7B\u522B\uFF0C\u4E5F\u652F\u6301\u9017\u53F7\u6216\u5206\u53F7\u6279\u91CF\u8F93\u5165" style="width: 100%; resize: vertical; font-size: 13px; padding: 10px;"></textarea>
        <div style="display: flex; justify-content: flex-end; gap: 10px; margin-top: 16px;">
          <button class="neu-button" style="padding: 10px 20px;" id="btn-cancel-add-class">\u53D6\u6D88</button>
          <button class="neu-button" style="padding: 10px 20px; color: var(--neu-text-active); font-weight: 700;" id="btn-confirm-add-class">\u786E\u8BA4</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    const inp = document.getElementById('inp-new-class-names');
    inp.focus();

    document.getElementById('btn-cancel-add-class').onclick = () => modal.remove();
    document.getElementById('btn-confirm-add-class').onclick = async () => {
      const names = inp.value.replace(/\r\n?/g, '\n').trim();
      if (!names) return showToast('\u8BF7\u8F93\u5165\u7C7B\u522B\u540D\u79F0', 'error');
      try {
        await api.addClass(this.projectId, names);
        modal.remove();
        await this.loadProjectInfo();
        showToast('\u7C7B\u522B\u5DF2\u6DFB\u52A0', 'success');
      } catch (e) {
        showToast(e.message, 'error');
      }
    };
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') modal.remove();
    });
  },

  getClassColor(className) {
    let hash = 0;
    const str = String(className || 'unknown');
    for (let i = 0; i < str.length; i++) {
       hash = str.charCodeAt(i) + ((hash << 5) - hash);
    }
    const hue = Math.abs(hash) % 360;
    return `hsl(${hue}, 70%, 50%)`;
  },

  setPromptMode(mode) {
    this.promptMode = mode;
    document.querySelectorAll('[id^="btn-tool-"]').forEach(btn => btn.classList.remove('active'));
    const btn = document.getElementById(`btn-tool-${mode}`);
    if (btn) btn.classList.add('active');
    
    const canvasEl = document.getElementById('canvas-container');
    if (canvasEl) {
      canvasEl.style.cursor = mode === 'pan'
        ? 'grab'
        : (mode === 'box' ? 'crosshair' : (mode === 'point' ? 'copy' : 'default'));
    }
    
    if (this.viewer) {
      this.viewer.setPromptMode(mode);
    }
    const imageStatus = document.getElementById('ws-image-status');
    if (imageStatus) {
      const modeText = mode === 'pointer' ? 'Pointer' : mode === 'point' ? 'Point Prompt' : 'Box Prompt';
      imageStatus.innerText = this.selectedImagePath ? `${this.selectedImagePath} | ${modeText}` : modeText;
    }
  },

  addPrompt(type, data) {
    this.currentPrompts.push({type, data, timestamp: new Date().getTime()});
    if (this.viewer) this.viewer.setPrompts(this.currentPrompts);
    const autoInfer = document.getElementById('chk-auto-infer');
    if (autoInfer?.checked) {
      this.runPromptPreview();
    }
  },

  async runPromptPreview() {
    if (!this.selectedImageId) return;
    const points = this.currentPrompts.filter((p) => p.type === 'point').map((p) => p.data);
    const boxes = this.currentPrompts.filter((p) => p.type === 'box').map((p) => p.data);
    let mode = '';
    if (boxes.length > 0) {
      mode = 'boxes';
    } else if (points.length > 0) {
      mode = 'points';
    }
    if (!mode) return;

    try {
      const res = await api.inferPreview({
        project_id: this.projectId,
        image_id: this.selectedImageId,
        mode,
        active_class: this.selectedClass || '',
        points,
        boxes,
        threshold: store.state.config.threshold,
        api_base_url: store.state.config.sam3ApiUrl,
      });
      const detections = Array.isArray(res?.detections) ? res.detections : [];
      this.previews = detections.map((d) => ({
        ...d,
        id: d.id || `preview_${Math.random().toString(36).slice(2, 10)}`,
        class_name: d.class_name || this.selectedClass || 'unknown',
      }));
      if (this.viewer) this.viewer.setPreviews(this.previews);
      this.renderPreviews();
      this.updateActionBar();
    } catch (e) {
      showToast(e.message, 'error');
    }
  },

  renderPreviews() {
    const list = document.getElementById('preview-list');
    if (!list) return;
    if (this.previews.length === 0) {
      list.innerHTML = `
        <div style="text-align: center; padding: 60px 20px; color: var(--neu-text-light);">
           <div style="font-size: 32px; margin-bottom: 15px; opacity: 0.3;">✨</div>
           <div style="font-size: 13px;">${i18n.t('preview_results_desc')}</div>
        </div>
      `;
      return;
    }

    list.innerHTML = this.previews.map((p, idx) => `
      <div class="neu-box" style="padding: 12px; border-radius: 12px; display: flex; flex-direction: column; gap: 10px; background: var(--neu-bg); box-shadow: var(--neu-outset-sm);">
         <div style="display: flex; justify-content: space-between; align-items: center;">
            <span style="font-size: 11px; font-weight: 700; color: var(--neu-text-active); text-transform: uppercase;">Preview Result #${idx+1}</span>
            <button class="neu-button" style="width: 24px; height: 24px; border-radius: 50%; padding: 0; font-size: 10px; color: #ef4444;" onclick="window.currentWorkspace.removePreview('${p.id}')">×</button>
         </div>
         <div style="font-size: 12px; color: var(--neu-text-light);">
            Confidence: <span style="font-weight: 600; color: var(--neu-text);">${(p.score || 0.98).toFixed(3)}</span>
         </div>
         <div style="display: flex; gap: 8px;">
            <button class="neu-button" style="flex: 1; font-size: 11px; padding: 6px;" onclick="window.currentWorkspace.keepSinglePreview('${p.id}')">Apply to Image</button>
         </div>
      </div>
    `).join('');
  },

  removePreview(id) {
    this.previews = this.previews.filter(p => p.id !== id);
    this.viewer.setPreviews(this.previews);
    this.renderPreviews();
    this.updateActionBar();
  },

  async keepSinglePreview(id) {
    const pre = this.previews.find(p => p.id === id);
    if (!pre) return;
    
    const className = this.selectedClass || (this.projectMeta.classes?.[0] || 'Object');
    try {
      const existing = await api.getAnnotations(this.projectId, this.selectedImageId);
      const newAnns = [...(existing.annotations || []), {
        ...pre,
        id: 'ann_' + Math.random().toString(36).substr(2, 9),
        class_name: className
      }];
      
      await api.saveAnnotations(this.projectId, this.selectedImageId, newAnns);
      this.removePreview(id);
      await this.loadProjectInfo();
      await this.selectImage(this.selectedImageId, this.selectedImagePath);
    } catch(e) { alert(e.message); }
  },

  async loadProjectInfo() {
    try {
      const res = await api.getProject(this.projectId, false);
      this.projectMeta = res.project;
      if (this.isUnmounted) return;
      
      const projectNameEl = document.getElementById('ws-pj-name');
      const projectNameCardEl = document.getElementById('ws-pj-card-name');
      const projectIdEl = document.getElementById('ws-pj-id');
      const projectIdCardEl = document.getElementById('ws-pj-card-id');
      
      const name = this.projectMeta.name || this.projectId;
      if (projectNameEl) projectNameEl.innerText = name;
      if (projectNameCardEl) projectNameCardEl.innerText = name;
      if (projectIdEl) projectIdEl.innerText = this.projectId;
      if (projectIdCardEl) projectIdCardEl.innerText = this.projectId;
      
      const total = this.projectMeta.num_images || 0;
      const labeled = this.projectMeta.labeled_images || 0;
      const progress = total > 0 ? (labeled / total) * 100 : 0;
      
      const progressBar = document.getElementById('ws-progress-bar');
      const progressText = document.getElementById('ws-progress-text');
      const imageCountBadge = document.getElementById('ws-img-count-badge');
      if (progressBar) progressBar.style.width = `${progress}%`;
      if (progressText) progressText.innerText = `${labeled} / ${total}`;
      if (imageCountBadge) imageCountBadge.innerText = total;
      
      const metaTotal = document.getElementById('ws-meta-total');
      const metaLabeled = document.getElementById('ws-meta-labeled');
      if (metaTotal) metaTotal.innerText = total;
      if (metaLabeled) metaLabeled.innerText = labeled;
      
      this.totalImages = total;
      this.offset = this.sanitizeOffset(this.offset, total);
      this.renderClasses();
      
      // Check for active job
      const activeJobRes = await api.getInferActiveJob(this.projectId);
      const activeJob = activeJobRes?.job || null;
      if (activeJob && activeJob.job_id) {
        this.activeJobId = activeJob.job_id;
        this.pollTaskStatus();
      }
    } catch(err) { console.error(err); }
  },
  
  async loadImages() {
    const listCont = document.getElementById('image-list-container');
    try {
      this.offset = this.sanitizeOffset(this.offset, this.totalImages);
      const data = await api.getImages(this.projectId, this.offset, this.limit);
      if (this.isUnmounted) return;
      
      this.images = data.items || [];
      this.totalImages = data.total || 0;
      this.offset = this.sanitizeOffset(this.offset, this.totalImages);
      
      const totalPages = Math.ceil(this.totalImages / this.limit) || 1;
      const currPage = Math.floor(this.offset / this.limit) + 1;
      document.getElementById('ws-page-info').innerText = `${currPage} / ${totalPages}`;
      
      if (this.images.length === 0) {
         listCont.innerHTML = `<div style="text-align:center; padding: 20px; color: var(--neu-text-light);">${i18n.t('no_images')}</div>`;
         return;
      }
      
      let html = '<div style="display: flex; flex-direction: column; gap: 8px;">';
      for(const img of this.images) {
        const isSel = this.selectedImageId === img.id;
        const bgState = isSel ? 'var(--neu-bg)' : 'transparent';
        const shadowState = isSel ? 'var(--neu-inset)' : 'none';
        const weight = isSel ? '700' : '500';
        
        const isLabeled = (img.status === 'labeled' || img.labeled);
        const dotColor = isLabeled ? '#10b981' : '#e2e8f0';
        
        html += `
          <div class="neu-button image-item" 
               data-id="${img.id}" data-rel="${img.rel_path}"
               style="justify-content: flex-start; text-align: left; padding: 12px; background: ${bgState}; box-shadow: ${shadowState}; font-weight: ${weight}; border-radius: 12px; font-size: 13px; overflow: hidden; cursor: pointer;">
             <span style="width: 8px; height: 8px; border-radius: 50%; background: ${dotColor}; margin-right: 12px; flex-shrink: 0; pointer-events: none;"></span>
             <span style="white-space: nowrap; text-overflow: ellipsis; overflow: hidden; pointer-events: none;">${img.rel_path}</span>
          </div>
        `;
      }
      html += '</div>';
      listCont.innerHTML = html;
      this.scheduleProjectUIStateSave();
      
    } catch(e) {
      listCont.innerHTML = `<div style="color: #ef4444; padding: 10px; font-size: 12px;">${e.message}</div>`;
    }
  },
  async selectImage(id, relPath, options = {}) {
    this.selectedImageId = id;
    this.selectedImagePath = relPath;
    this.currentPrompts = [];
    this.previews = [];
    this.focusedAnnotationId = null;
    
    if (this.viewer) {
      this.viewer.setPrompts([]);
      this.viewer.setPreviews([]);
      this.viewer.setFocusedAnnotation(null);
    }
    
    this.renderPreviews();
    this.updateActionBar();
    await this.loadImages();
    this.renderAnnotations();
    
    const placeholder = document.getElementById('canvas-placeholder');
    if (placeholder) placeholder.style.display = 'none';
    const imageStatus = document.getElementById('ws-image-status');
    if (imageStatus) {
      const modeText = this.promptMode === 'pointer' ? 'Pointer' : this.promptMode === 'point' ? 'Point Prompt' : 'Box Prompt';
      imageStatus.innerText = `${relPath || id} | ${modeText}`;
    }
    
    try {
      const imgUrl = `/api/projects/${this.projectId}/images/${id}/file`;
      await this.viewer.loadImage(imgUrl);
      
      const annsRes = await api.getAnnotations(this.projectId, id);
      this.annotations = annsRes.annotations || [];
      this.viewer.setAnnotations(this.annotations);
      this.viewer.setFocusedAnnotation(null);
      requestAnimationFrame(() => {
        if (this.viewer) this.viewer.fitToScreen();
      });
      this.renderClasses();
      this.renderAnnotations();
      this.scheduleProjectUIStateSave();
      
    } catch(e) {
      console.error("Failed to load image/annotations:", e);
    }
  },

  async runSingleInfer() {
    if (!this.selectedImageId) return showToast("Select an image first", "error");
    
    const btn = document.getElementById('btn-infer-current');
    try {
      btn.disabled = true;
      btn.innerText = i18n.t('inferring');
      
      const payload = {
        project_id: this.projectId,
        image_id: this.selectedImageId,
        mode: 'text',
        classes: this.getSelectedClassesForInference(),
        threshold: store.state.config.threshold,
        api_base_url: store.state.config.sam3ApiUrl
      };
      
      const res = await api.infer(payload);
      showToast(i18n.t('save_success'), "success");
      await this.selectImage(this.selectedImageId, this.selectedImagePath);
      await this.loadProjectInfo();
    } catch(e) {
      showToast(e.message, "error");
    } finally {
      btn.disabled = false;
      btn.innerText = i18n.t('infer_current');
    }
  },

  async runExamplePreview() {
    if (!this.selectedImageId) return showToast("Select an image first", "error");
    if (!this.selectedClass) return showToast("Select a class first", "error");
    
    const boxes = this.currentPrompts
      .filter(p => p.type === 'box')
      .map(p => p.data);
      
    if (boxes.length === 0) return showToast("Draw at least one box as an example", "error");

    const btn = document.getElementById('btn-example-segment');
    try {
      btn.disabled = true;
      btn.innerText = 'Segmenting...';
      
      const payload = {
        project_id: this.projectId,
        image_id: this.selectedImageId,
        active_class: this.selectedClass,
        boxes: boxes,
        pure_visual: false,
        threshold: store.state.config.threshold,
        api_base_url: store.state.config.sam3ApiUrl
      };
      
      const res = await api.inferExample(payload);
      const detections = res.detections || [];
      this.previews = detections.map(d => ({
        ...d,
        id: 'preview_' + Math.random().toString(36).substr(2, 9),
        class_name: this.selectedClass
      }));
      
      this.viewer.setPreviews(this.previews);
      this.renderPreviews(); // Although this panel is hidden, we use it for keeping
      this.updateActionBar();
      showToast(`Found ${this.previews.length} matches`, "info");
    } catch(e) {
      showToast(e.message, "error");
    } finally {
      btn.disabled = false;
      btn.innerText = i18n.t('example_segment');
    }
  },

  async startBatchTask(type) {
    const classes = this.getSelectedClassesForInference();
    if (type === 'text' && classes.length === 0) return showToast("Select at least one class for text inference", "error");

    let payload = {
      project_id: this.projectId,
      threshold: store.state.config.threshold,
      batch_size: store.state.config.batchSize,
      api_base_url: store.state.config.sam3ApiUrl
    };

    if (type === 'text') {
      const batchConfig = await this.openBatchConfigModal(classes);
      if (!batchConfig) return;
      payload.classes = classes;
      payload.scope_mode = batchConfig.scope_mode;
      payload.related_classes = batchConfig.related_classes || [];
      payload.image_ids = batchConfig.image_ids || [];
      payload.retry_image_ids = batchConfig.retry_image_ids || [];
      payload.all_images = batchConfig.scope_mode === 'all' && payload.image_ids.length === 0 && payload.retry_image_ids.length === 0;
    } else {
      if (!this.selectedImageId) return showToast("Select a source image first", "error");
      const boxes = this.currentPrompts.filter(p => p.type === 'box').map(p => p.data);
      if (boxes.length === 0) return showToast("Draw an example box first", "error");
      if (!this.selectedClass) return showToast("Select a target class", "error");
      payload.source_image_id = this.selectedImageId;
      payload.active_class = this.selectedClass;
      payload.boxes = boxes;
      payload.pure_visual = false;
    }

    try {
      const res = type === 'text' 
        ? await api.startBatchInfer(payload)
        : await api.startBatchExample(payload);
        
      this.activeJobId = res?.job?.job_id || '';
      if (!this.activeJobId) throw new Error('batch task did not return job_id');
      this.batchResultShownForJobId = '';
      this.pollTaskStatus();
      showToast("Batch task started", "success");
    } catch(e) {
       showToast(e.message, "error");
    }
  },

  async pollTaskStatus() {
    if (this.isPolling) return;
    this.isPolling = true;
    
    const bar = document.getElementById('ws-task-bar');
    const nameEl = document.getElementById('task-name');
    const fillEl = document.getElementById('task-progress-fill');
    const statusEl = document.getElementById('task-status-text');
    const stopBtn = document.getElementById('btn-task-stop');
    const resumeBtn = document.getElementById('btn-task-resume');
    
    bar.style.display = 'flex';
    
    const poll = async () => {
      if (this.isUnmounted || !this.activeJobId) {
        this.isPolling = false;
        return;
      }
      
      try {
        const res = await api.getInferJob(this.activeJobId);
        const job = res?.job || null;
        if (!job) {
          this.activeJobId = null;
          this.isPolling = false;
          bar.style.display = 'none';
          return;
        }
        const pct = Number(job.progress_pct || 0);
        nameEl.innerText = i18n.t(job.job_type === 'example_batch' ? 'example_propagate' : 'batch_infer');
        fillEl.style.width = `${pct}%`;
        statusEl.innerText = `${job.message || `${Math.round(pct)}%`}`;
        
        if (job.status === 'done' || job.status === 'error') {
          setTimeout(() => bar.style.display = 'none', 3000);
          if (job.job_type === 'text_batch' && job.status === 'done') {
            this.showBatchResultModal(job);
          }
          this.activeJobId = null;
          this.isPolling = false;
          if (resumeBtn) resumeBtn.style.display = 'none';
          if (stopBtn) {
            stopBtn.style.display = 'block';
            stopBtn.disabled = false;
            stopBtn.innerText = 'Stop';
          }
          await this.loadProjectInfo();
          if (this.selectedImageId && this.selectedImagePath) {
            await this.selectImage(this.selectedImageId, this.selectedImagePath);
          }
          return;
        } else if (job.status === 'pausing') {
          if (resumeBtn) resumeBtn.style.display = 'none';
          if (stopBtn) {
            stopBtn.style.display = 'block';
            stopBtn.disabled = true;
            stopBtn.innerText = 'Stopping...';
          }
        } else if (job.status === 'paused') {
          if (resumeBtn) resumeBtn.style.display = 'block';
          if (stopBtn) {
            stopBtn.style.display = 'none';
            stopBtn.disabled = false;
            stopBtn.innerText = 'Stop';
          }
        } else {
          if (resumeBtn) resumeBtn.style.display = 'none';
          if (stopBtn) {
            stopBtn.style.display = 'block';
            stopBtn.disabled = false;
            stopBtn.innerText = 'Stop';
          }
        }
        
        setTimeout(poll, 1000);
      } catch(e) {
        console.error("Poll error", e);
        this.isPolling = false;
      }
    };
    
    poll();
  },

  async stopActiveTask() {
    try {
      const res = await api.stopInferJob(this.projectId);
      const job = res?.job || null;
      const stopBtn = document.getElementById('btn-task-stop');
      const statusEl = document.getElementById('task-status-text');
      if (job?.job_id) this.activeJobId = job.job_id;
      if (stopBtn) {
        stopBtn.disabled = true;
        stopBtn.innerText = 'Stopping...';
      }
      if (statusEl) statusEl.innerText = 'Stopping task...';
      showToast("Stopping task...");
    } catch(e) { showToast(e.message, "error"); }
  },

  async resumeActiveTask() {
    try {
      const payload = {
        project_id: this.projectId,
        threshold: store.state.config.threshold,
        batch_size: store.state.config.batchSize,
        api_base_url: store.state.config.sam3ApiUrl
      };
      const res = await api.resumeInferJob(payload);
      const job = res?.job || null;
      if (job?.job_id) this.activeJobId = job.job_id;
      const stopBtn = document.getElementById('btn-task-stop');
      const resumeBtn = document.getElementById('btn-task-resume');
      const statusEl = document.getElementById('task-status-text');
      if (resumeBtn) resumeBtn.style.display = 'none';
      if (stopBtn) {
        stopBtn.style.display = 'block';
        stopBtn.disabled = false;
        stopBtn.innerText = 'Stop';
      }
      if (statusEl) statusEl.innerText = 'Resuming task...';
      if (!this.isPolling && this.activeJobId) this.pollTaskStatus();
      showToast("Resuming task...");
    } catch(e) { showToast(e.message, "error"); }
  },

  renderAnnotations() {
    const list = document.getElementById('annotation-list-container');
    const anns = this.annotations || [];
    if (anns.length === 0) {
      list.innerHTML = `<div style="text-align: center; padding: 40px; color: var(--neu-text-light); font-size: 12px;">无标注数据</div>`;
      return;
    }

    const focusBanner = ''; /*
      <div class="neu-box" style="padding: 10px 12px; border-radius: 12px; display: flex; align-items: center; justify-content: space-between; gap: 10px; background: var(--neu-bg-light); box-shadow: var(--neu-inset-sm);">
        <span style="font-size: 12px; font-weight: 700; color: var(--neu-text-light);">只显示当前实例</span>
        <button class="neu-button" style="padding: 6px 10px; font-size: 11px; font-weight: 700;" onclick="window.currentWorkspace.clearAnnotationFocus()">显示全部</button>
      </div>
    */

    list.innerHTML = `${anns.map(ann => `
      <div class="neu-box ann-item-focus" data-ann-id="${ann.id}" style="padding: 12px; border-radius: 12px; display: flex; flex-direction: column; gap: 8px; background: ${this.focusedAnnotationId === ann.id ? 'var(--neu-bg-light)' : 'var(--neu-bg)'}; box-shadow: ${this.focusedAnnotationId === ann.id ? 'var(--neu-inset)' : 'var(--neu-inset-sm)'}; cursor: pointer;">
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <div style="display: flex; align-items: center; gap: 8px;">
            <span style="width: 10px; height: 10px; border-radius: 50%; background: ${this.getClassColor(ann.class_name)};"></span>
            <span style="font-size: 13px; font-weight: 700;">${ann.class_name}</span>
          </div>
          <div style="display: flex; gap: 5px;">
            <button class="neu-button" style="width: 24px; height: 24px; padding: 0; font-size: 10px;" onclick="window.currentWorkspace.locateAnnotation('${ann.id}')">🎯</button>
            <button class="neu-button" style="width: 24px; height: 24px; padding: 0; font-size: 12px; color: #ef4444;" onclick="window.currentWorkspace.deleteAnnotation('${ann.id}')">×</button>
          </div>
        </div>
        <div style="font-size: 11px; color: var(--neu-text-light); display: flex; justify-content: space-between;">
          <span>Conf: <b>${(ann.score || 0.98).toFixed(3)}</b></span>
          <span>${ann.polygon ? 'Polygon' : 'BBox'}</span>
        </div>
      </div>
    `).join('')}`;
    list.querySelectorAll('.ann-item-focus').forEach((item) => {
      item.onclick = (e) => {
        if (e.target.closest('button')) return;
        this.toggleAnnotationFocus(item.dataset.annId || '');
      };
    });
  },

  locateAnnotation(annId) {
    const ann = this.annotations.find(a => a.id === annId);
    if (ann && this.viewer) {
      this.focusedAnnotationId = annId;
      this.viewer.setFocusedAnnotation(annId);
      this.viewer.centerOn(ann.bbox);
      this.renderAnnotations();
    }
  },

  openBatchConfigModal(defaultClasses = []) {
    return new Promise((resolve) => {
      const modal = document.getElementById('modal-batch-full');
      if (!modal) {
        resolve(null);
        return;
      }
      const classes = this.projectMeta?.classes || [];
      const defaultSet = new Set((defaultClasses || []).map(x => String(x)));
      modal.innerHTML = `
        <div class="neu-card" style="width: 520px; max-width: calc(100vw - 40px); padding: 28px; position: relative;">
          <button class="neu-button" id="btn-close-batch-modal" style="position: absolute; top: 14px; right: 14px; width: 32px; height: 32px; padding: 0; border-radius: 50%; color: #ef4444;">×</button>
          <h2 style="margin: 0 0 18px 0; font-size: 18px;">全图文本推理</h2>
          <div style="display: flex; flex-direction: column; gap: 18px;">
            <div class="neu-box" style="padding: 14px; border-radius: 12px; background: var(--neu-bg-light);">
              <div style="font-size: 12px; font-weight: 700; margin-bottom: 10px;">本次将推理这些类别</div>
              <div style="display: flex; flex-wrap: wrap; gap: 8px;">
                ${(defaultClasses || []).map(cls => `<span class="neu-box" style="padding: 4px 10px; border-radius: 999px; font-size: 12px; box-shadow: var(--neu-inset);">${cls}</span>`).join('') || '<span style="font-size: 12px; color: var(--neu-text-light);">未选择类别</span>'}
              </div>
            </div>
            <div>
              <div style="font-size: 12px; font-weight: 700; margin-bottom: 8px;">处理范围</div>
              <select id="batch-scope-mode" class="neu-input" style="width: 100%;">
                <option value="all">重新标注全部图片</option>
                <option value="unlabeled">只标注未标注图片</option>
                <option value="class_related">重新标注指定类别相关图片</option>
                <option value="class_related_unlabeled">只标注当前缺少这些类别的图片</option>
              </select>
            </div>
            <div id="batch-related-classes-panel" style="display: none;">
              <div style="font-size: 12px; font-weight: 700; margin-bottom: 8px;">相关类别范围</div>
              <div class="neu-box" style="padding: 12px; border-radius: 12px; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; max-height: 180px; overflow-y: auto;">
                ${classes.map(cls => `
                  <label style="display: flex; align-items: center; gap: 8px; font-size: 12px; cursor: pointer;">
                    <input type="checkbox" class="batch-related-cls" value="${cls.replace(/"/g, '&quot;')}" ${defaultSet.has(cls) ? 'checked' : ''} />
                    <span>${cls}</span>
                  </label>
                `).join('')}
              </div>
              <div style="margin-top: 8px; font-size: 11px; color: var(--neu-text-light);">按现有标注判断“相关图片”；“缺少这些类别”表示当前图片里还没有这些类别的标注。</div>
            </div>
            <div class="neu-box" style="padding: 14px; border-radius: 12px; background: var(--neu-bg-light);">
              <div style="font-size: 12px; color: var(--neu-text-light); line-height: 1.6;">
                阈值：${store.state.config.threshold}，批大小：${store.state.config.batchSize}<br />
                任务完成后会显示结果汇总，并支持一键重试失败图片。
              </div>
            </div>
            <div style="display: flex; justify-content: flex-end; gap: 10px;">
              <button id="btn-cancel-batch-modal" class="neu-button">取消</button>
              <button id="btn-confirm-batch-modal" class="neu-button" style="color: var(--neu-text-active); font-weight: 700;">开始任务</button>
            </div>
          </div>
        </div>
      `;
      modal.style.display = 'flex';

      const cleanup = (result) => {
        modal.style.display = 'none';
        modal.innerHTML = '';
        resolve(result);
      };
      const scopeSel = document.getElementById('batch-scope-mode');
      const relatedPanel = document.getElementById('batch-related-classes-panel');
      const syncScope = () => {
        const needRelated = scopeSel.value === 'class_related' || scopeSel.value === 'class_related_unlabeled';
        relatedPanel.style.display = needRelated ? 'block' : 'none';
      };
      syncScope();
      scopeSel.onchange = syncScope;
      document.getElementById('btn-close-batch-modal').onclick = () => cleanup(null);
      document.getElementById('btn-cancel-batch-modal').onclick = () => cleanup(null);
      document.getElementById('btn-confirm-batch-modal').onclick = () => {
        const related = Array.from(document.querySelectorAll('.batch-related-cls:checked')).map(el => el.value);
        if ((scopeSel.value === 'class_related' || scopeSel.value === 'class_related_unlabeled') && related.length === 0) {
          showToast('请至少选择一个相关类别', 'error');
          return;
        }
        cleanup({
          scope_mode: scopeSel.value,
          related_classes: related,
          image_ids: [],
          retry_image_ids: []
        });
      };
    });
  },

  showBatchResultModal(job) {
    if (!job || this.batchResultShownForJobId === job.job_id) return;
    this.batchResultShownForJobId = job.job_id;
    const modal = document.getElementById('modal-batch-result');
    if (!modal) return;
    const result = job.result || {};
    const classAdditions = result.class_additions || {};
    const retryImageIds = result.retry_image_ids || [];
    const classRows = Object.entries(classAdditions);
    modal.innerHTML = `
      <div class="neu-card" style="width: 560px; max-width: calc(100vw - 40px); padding: 28px; position: relative;">
        <button class="neu-button" id="btn-close-batch-result" style="position: absolute; top: 14px; right: 14px; width: 32px; height: 32px; padding: 0; border-radius: 50%; color: #ef4444;">×</button>
        <h2 style="margin: 0 0 18px 0; font-size: 18px;">批量推理结果</h2>
        <div style="display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px;">
          <div class="neu-box" style="padding: 14px; border-radius: 12px;"><b>请求图片</b><div style="margin-top: 6px;">${result.requested || job.requested || 0}</div></div>
          <div class="neu-box" style="padding: 14px; border-radius: 12px;"><b>已处理</b><div style="margin-top: 6px;">${result.processed_images || job.progress_done || 0}</div></div>
          <div class="neu-box" style="padding: 14px; border-radius: 12px;"><b>成功</b><div style="margin-top: 6px; color: #10b981;">${result.saved_images || result.succeeded || job.succeeded || 0}</div></div>
          <div class="neu-box" style="padding: 14px; border-radius: 12px;"><b>失败</b><div style="margin-top: 6px; color: #ef4444;">${result.failed_images || result.failed || job.failed || 0}</div></div>
          <div class="neu-box" style="padding: 14px; border-radius: 12px;"><b>跳过</b><div style="margin-top: 6px;">${result.skipped_images || result.skipped || job.skipped || 0}</div></div>
          <div class="neu-box" style="padding: 14px; border-radius: 12px;"><b>新增标注</b><div style="margin-top: 6px;">${result.new_annotations || job.new_annotations || 0}</div></div>
        </div>
        <div class="neu-box" style="padding: 14px; border-radius: 12px; margin-top: 16px; background: var(--neu-bg-light);">
          <div style="font-size: 12px; font-weight: 700; margin-bottom: 8px;">类别新增统计</div>
          ${classRows.length > 0 ? classRows.map(([cls, count]) => `<div style="display: flex; justify-content: space-between; font-size: 12px; padding: 4px 0;"><span>${cls}</span><b>${count}</b></div>`).join('') : '<div style="font-size: 12px; color: var(--neu-text-light);">无新增类别统计</div>'}
        </div>
        <div style="margin-top: 16px; font-size: 12px; color: var(--neu-text-light); line-height: 1.7;">${job.message || result.message || '任务结束'}</div>
        <div style="display: flex; justify-content: flex-end; gap: 10px; margin-top: 18px;">
          ${retryImageIds.length > 0 ? '<button id="btn-retry-batch-result" class="neu-button" style="color: var(--neu-text-active); font-weight: 700;">重试未完成</button>' : ''}
          <button id="btn-confirm-batch-result" class="neu-button">关闭</button>
        </div>
      </div>
    `;
    modal.style.display = 'flex';
    const close = () => {
      modal.style.display = 'none';
      modal.innerHTML = '';
    };
    document.getElementById('btn-close-batch-result').onclick = close;
    document.getElementById('btn-confirm-batch-result').onclick = close;
    const retryBtn = document.getElementById('btn-retry-batch-result');
    if (retryBtn) {
      retryBtn.onclick = async () => {
        close();
        try {
          const res = await api.startBatchInfer({
            project_id: this.projectId,
            classes: this.getSelectedClassesForInference(),
            retry_image_ids: retryImageIds,
            threshold: store.state.config.threshold,
            batch_size: store.state.config.batchSize,
            api_base_url: store.state.config.sam3ApiUrl
          });
          this.activeJobId = res?.job?.job_id || '';
          if (!this.activeJobId) throw new Error('batch task did not return job_id');
          this.batchResultShownForJobId = '';
          this.pollTaskStatus();
          showToast('已启动未完成图片重试', 'success');
        } catch (e) {
          showToast(e.message, 'error');
        }
      };
    }
  },

  toggleAnnotationFocus(annId) {
    const nextId = String(this.focusedAnnotationId || '') === String(annId || '') ? null : annId;
    this.focusedAnnotationId = nextId;
    if (this.viewer) this.viewer.setFocusedAnnotation(nextId);
    if (nextId) {
      const ann = (this.annotations || []).find((item) => String(item?.id || '') === String(nextId));
      if (ann?.bbox && this.viewer) this.viewer.centerOn(ann.bbox);
    }
    this.renderAnnotations();
  },

  clearAnnotationFocus() {
    this.focusedAnnotationId = null;
    if (this.viewer) this.viewer.setFocusedAnnotation(null);
    this.renderAnnotations();
  },

  getSelectedClassesForInference() {
    const checked = [];
    document.querySelectorAll('.cls-chk-infer[type="checkbox"]:checked').forEach(chk => {
       checked.push(chk.dataset.cls);
    });
    return checked;
  },

  async saveCurrentAnns() {
    if (!this.selectedImageId) return;
    try {
      await api.saveAnnotations(this.projectId, this.selectedImageId, this.annotations);
      showToast(i18n.t('save_success'), "success");
      await this.loadProjectInfo();
    } catch(e) { showToast(e.message, "error"); }
  },

  async clearCurrentAnns() {
    if (!this.selectedImageId) return;
    if (!confirm("Clear all annotations on this image?")) return;
    try {
      await api.saveAnnotations(this.projectId, this.selectedImageId, []);
      await this.selectImage(this.selectedImageId, this.selectedImagePath);
      await this.loadProjectInfo();
    } catch(e) { showToast(e.message, "error"); }
  },
  
  async deleteAnnotation(annId) {
    if (!this.selectedImageId) return;
    try {
      const newAnns = this.annotations.filter(a => a.id !== annId);
      await api.saveAnnotations(this.projectId, this.selectedImageId, newAnns);
      await this.selectImage(this.selectedImageId, this.selectedImagePath);
      await this.loadProjectInfo();
    } catch(e) { showToast(e.message, "error"); }
  },

  openSmartFilter() {
    const modal = document.getElementById('modal-filter-full');
    const classes = this.projectMeta?.classes || [];

    modal.innerHTML = `
      <div class="neu-card" style="width: 760px; max-width: calc(100vw - 40px); padding: 28px; position: relative; max-height: 90vh; overflow-y: auto;">
        <button class="neu-button" style="position: absolute; top: 16px; right: 16px; width: 34px; height: 34px; padding: 0; border-radius: 50%; font-size: 18px; color: #ef4444;" onclick="document.getElementById('modal-filter-full').style.display='none'">&times;</button>
        <h2 style="margin-top: 0; margin-bottom: 18px;">\u667A\u80FD\u8FC7\u6EE4</h2>
        <div style="display: flex; flex-direction: column; gap: 18px;">
          <div class="neu-box" style="padding: 8px; border-radius: 14px; display: flex; gap: 8px;">
            <button id="btn-filter-op-merge" class="neu-button" style="flex: 1; font-weight: 700;">\u5408\u5E76\u8FC7\u6EE4</button>
            <button id="btn-filter-op-rule" class="neu-button" style="flex: 1; font-weight: 700;">\u89C4\u5219\u8FC7\u6EE4</button>
          </div>

          <div id="filter-op-hint" class="neu-box" style="padding: 14px; border-radius: 12px; background: var(--neu-bg-light); font-size: 12px; line-height: 1.8;"></div>

          <div id="filter-merge-panel" style="display: flex; flex-direction: column; gap: 18px;">
            <div style="display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px;">
              <div>
                <label class="neu-label">\u5408\u5E76\u6A21\u5F0F</label>
                <select id="filter-mode-sel" class="neu-input" style="width: 100%;">
                  <option value="same_class">\u540C\u7C7B\u53BB\u91CD</option>
                  <option value="canonical_class">\u6765\u6E90\u7C7B\u5E76\u5165\u76EE\u6807\u7C7B</option>
                </select>
              </div>
              <div>
                <label class="neu-label">\u9762\u79EF\u6307\u6807</label>
                <select id="filter-area-sel" class="neu-input" style="width: 100%;">
                  <option value="instance">\u5B9E\u4F8B\u9762\u79EF</option>
                  <option value="bbox">\u8FB9\u6846\u9762\u79EF</option>
                </select>
              </div>
            </div>

            <div id="filter-ms-panel" style="display: none; flex-direction: column; gap: 14px; padding: 16px; border-radius: 14px; background: var(--neu-bg-light);">
              <div>
                <label class="neu-label">\u76EE\u6807\u7C7B\u522B</label>
                <select id="filter-target-cls" class="neu-input" style="width: 100%;">
                  ${classes.map(c => `<option value="${c}">${c}</option>`).join('')}
                </select>
              </div>
              <div>
                <label class="neu-label">\u6765\u6E90\u7C7B\u522B</label>
                <div style="display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; max-height: 140px; overflow-y: auto; padding: 10px; border-radius: 10px; background: var(--neu-bg); box-shadow: var(--neu-inset);">
                  ${classes.map(c => `<label style="display:flex; align-items:center; gap:8px; font-size:12px;"><input type="checkbox" class="source-cls-chk" value="${c}" /> <span>${c}</span></label>`).join('')}
                </div>
              </div>
            </div>

            <div>
              <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 6px;">
                <label class="neu-label">\u91CD\u53E0\u9608\u503C</label>
                <span id="filter-cov-val" style="font-size:12px; font-weight:700; color: var(--neu-text-active);">0.98</span>
              </div>
              <input type="range" id="filter-cov" min="0.5" max="1" step="0.01" value="0.98" style="width:100%;" />
            </div>
          </div>

          <div id="filter-rule-panel" style="display: none; flex-direction: column; gap: 18px;">
            <div class="neu-box" style="padding: 14px; border-radius: 12px; background: rgba(239, 68, 68, 0.08); font-size: 12px; line-height: 1.8; color: var(--neu-text);">
              \u89C4\u5219\u8FC7\u6EE4\u53EA\u4F1A\u5220\u9664\u547D\u4E2D\u7684\u6807\u6CE8\uFF0C\u4E0D\u4F1A\u6539\u7C7B\u6216\u5408\u5E76\u3002\u8BF7\u5148\u9884\u89C8\uFF0C\u786E\u8BA4\u547D\u4E2D\u8303\u56F4\u540E\u518D\u6267\u884C\u5220\u9664\u3002
            </div>

            <div class="neu-box" style="padding: 16px; border-radius: 14px; display: flex; flex-direction: column; gap: 14px;">
              <div style="font-size: 12px; font-weight: 800; color: var(--neu-text-light);">\u7B5B\u9009\u6761\u4EF6</div>
              <div>
                <div style="font-size: 12px; font-weight: 700; margin-bottom: 8px;">\u7C7B\u522B\u8303\u56F4</div>
                <div style="display:grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; max-height: 140px; overflow-y:auto;">
                  ${classes.map(c => `<label style="display:flex; align-items:center; gap:8px; font-size:12px;"><input type="checkbox" class="rule-cls-chk" value="${c}" checked /> <span>${c}</span></label>`).join('')}
                </div>
              </div>
              <div style="display:grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px;">
                <div class="neu-box" style="padding: 12px; border-radius: 12px; box-shadow: var(--neu-inset);">
                  <label style="display:flex; align-items:center; gap:8px; font-size:12px; font-weight:700; margin-bottom:8px;"><input type="checkbox" id="filter-small-enabled" /> \u5C0F\u76EE\u6807\u8FC7\u6EE4</label>
                  <div style="font-size:11px; color: var(--neu-text-light); margin-bottom: 8px;">\u4EC5\u5220\u9664\u9762\u79EF\u5360\u6BD4\u4E0D\u8D85\u8FC7\u8BE5\u503C\u7684\u76EE\u6807\u3002</div>
                  <input type="number" id="filter-small-ratio" class="neu-input" min="0" max="1" step="0.001" value="0.02" />
                </div>
                <div class="neu-box" style="padding: 12px; border-radius: 12px; box-shadow: var(--neu-inset);">
                  <label style="display:flex; align-items:center; gap:8px; font-size:12px; font-weight:700; margin-bottom:8px;"><input type="checkbox" id="filter-count-enabled" /> \u5B9E\u4F8B\u6570\u91CF\u8FC7\u6EE4</label>
                  <div style="font-size:11px; color: var(--neu-text-light); margin-bottom: 8px;">\u4EC5\u5220\u9664\u5B9E\u4F8B\u603B\u6570\u843D\u5728\u8BE5\u8303\u56F4\u5185\u7684\u56FE\u7247\u6807\u6CE8\u3002\u5DE6\u8FB9\u662F\u6700\u5C11\u6570\u91CF\uFF0C\u53F3\u8FB9\u662F\u6700\u591A\u6570\u91CF\uFF0C0 \u8868\u793A\u4E0D\u9650\u5236\u4E0A\u9650\u3002</div>
                  <div style="display:flex; gap: 8px;">
                    <input type="number" id="filter-min-count" class="neu-input" min="0" value="1" placeholder="\u6700\u5C0F\u503C" />
                    <input type="number" id="filter-max-count" class="neu-input" min="0" value="0" placeholder="\u6700\u5927\u503C(0=\u4E0D\u9650)" />
                  </div>
                </div>
                <div class="neu-box" style="padding: 12px; border-radius: 12px; box-shadow: var(--neu-inset);">
                  <label style="display:flex; align-items:center; gap:8px; font-size:12px; font-weight:700; margin-bottom:8px;"><input type="checkbox" id="filter-pos-enabled" /> \u4F4D\u7F6E\u8FC7\u6EE4</label>
                  <div style="font-size:11px; color: var(--neu-text-light); margin-bottom: 8px;">\u4E2D\u5FC3\u77E9\u5F62\u5185\u547D\u4E2D\u7684\u6807\u6CE8\u4F1A\u88AB\u5220\u9664\u3002</div>
                  <div style="display:flex; gap: 8px;">
                    <input type="number" id="filter-center-x" class="neu-input" min="0" max="0.5" step="0.01" value="0.25" placeholder="\u534A\u5BBD" />
                    <input type="number" id="filter-center-y" class="neu-input" min="0" max="0.5" step="0.01" value="0.05" placeholder="\u534A\u9AD8" />
                  </div>
                </div>
                <div class="neu-box" style="padding: 12px; border-radius: 12px; box-shadow: var(--neu-inset);">
                  <label style="display:flex; align-items:center; gap:8px; font-size:12px; font-weight:700; margin-bottom:8px;"><input type="checkbox" id="filter-conf-enabled" /> \u7F6E\u4FE1\u5EA6\u8FC7\u6EE4</label>
                  <div style="font-size:11px; color: var(--neu-text-light); margin-bottom: 8px;">\u4EC5\u5220\u9664\u7F6E\u4FE1\u5EA6\u843D\u5728\u8BE5\u533A\u95F4\u5185\u7684\u6807\u6CE8\u3002\u5DE6\u8FB9\u662F\u6700\u5C0F\u5206\u6570\uFF0C\u53F3\u8FB9\u662F\u6700\u5927\u5206\u6570\u3002</div>
                  <div style="display:flex; gap: 8px;">
                    <input type="number" id="filter-conf-min" class="neu-input" min="0" max="1" step="0.01" value="0.00" placeholder="\u6700\u5C0F\u5206\u6570" />
                    <input type="number" id="filter-conf-max" class="neu-input" min="0" max="1" step="0.01" value="1.00" placeholder="\u6700\u5927\u5206\u6570" />
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div class="neu-box" style="padding: 14px; border-radius: 12px; background: var(--neu-bg-light);">
            <div style="font-size: 11px; font-weight: 700; color: var(--neu-text-light); margin-bottom: 6px;">\u6267\u884C\u6458\u8981</div>
            <div id="filter-rule-text" style="font-size: 12px; line-height: 1.7;">--</div>
          </div>

          <div class="neu-box" style="padding: 16px; border-radius: 12px; display: flex; flex-direction: column; gap: 12px;">
            <div style="display: flex; justify-content: space-between; align-items: center;">
              <span style="font-size: 12px; font-weight: 800; color: var(--neu-text-light);">\u4EFB\u52A1\u8FDB\u5EA6</span>
              <span id="filter-job-progress-text" style="font-size: 11px; color: var(--neu-text-light);">\u7A7A\u95F2</span>
            </div>
            <div style="height: 8px; background: rgba(0,0,0,0.05); border-radius: 999px; overflow: hidden;">
              <div id="filter-job-progress-fill" style="width: 0%; height: 100%; background: var(--neu-text-active); transition: width 0.25s ease;"></div>
            </div>
            <div id="filter-job-status" style="font-size: 12px; color: var(--neu-text); min-height: 18px;">\u5148\u6267\u884C\u9884\u89C8\u4EE5\u67E5\u770B\u547D\u4E2D\u7ED3\u679C\u3002</div>
            <div id="filter-preview-summary" style="display: flex; flex-direction: column; gap: 8px; max-height: 220px; overflow-y: auto;"></div>
          </div>

          <div style="display: flex; justify-content: flex-end; gap: 12px;">
            <button class="neu-button" style="padding: 10px 24px;" onclick="document.getElementById('modal-filter-full').style.display='none'">\u53D6\u6D88</button>
            <button id="btn-start-filter-preview" class="neu-button" style="padding: 10px 24px; color: var(--neu-text-active); font-weight: 700;">\u5F00\u59CB\u9884\u89C8</button>
            <button id="btn-apply-filter" class="neu-button" style="padding: 10px 24px; color: #10b981; font-weight: 700; display: none;">\u786E\u8BA4\u5408\u5E76</button>
          </div>
        </div>
      </div>
    `;
    modal.style.display = 'flex';

    let operationMode = 'merge';
    const mergeBtn = document.getElementById('btn-filter-op-merge');
    const ruleBtn = document.getElementById('btn-filter-op-rule');
    const opHint = document.getElementById('filter-op-hint');
    const mergePanel = document.getElementById('filter-merge-panel');
    const rulePanel = document.getElementById('filter-rule-panel');
    const modeSel = document.getElementById('filter-mode-sel');
    const msPanel = document.getElementById('filter-ms-panel');
    const statusEl = document.getElementById('filter-job-status');
    const progressFillEl = document.getElementById('filter-job-progress-fill');
    const progressTextEl = document.getElementById('filter-job-progress-text');
    const summaryEl = document.getElementById('filter-preview-summary');
    const previewBtn = document.getElementById('btn-start-filter-preview');
    const applyBtn = document.getElementById('btn-apply-filter');
    const cov = document.getElementById('filter-cov');
    const filterInputs = [
      'filter-mode-sel', 'filter-area-sel', 'filter-target-cls', 'filter-small-enabled', 'filter-small-ratio',
      'filter-count-enabled', 'filter-min-count', 'filter-max-count', 'filter-pos-enabled', 'filter-center-x',
      'filter-center-y', 'filter-conf-enabled', 'filter-conf-min', 'filter-conf-max'
    ].map(id => document.getElementById(id)).filter(Boolean);

    const syncOperationUI = () => {
      const mergeActive = operationMode === 'merge';
      mergePanel.style.display = mergeActive ? 'flex' : 'none';
      rulePanel.style.display = mergeActive ? 'none' : 'flex';
      msPanel.style.display = mergeActive && modeSel.value === 'canonical_class' ? 'flex' : 'none';
      mergeBtn.style.boxShadow = mergeActive ? 'var(--neu-inset)' : 'var(--neu-outset-sm)';
      ruleBtn.style.boxShadow = mergeActive ? 'var(--neu-outset-sm)' : 'var(--neu-inset)';
      mergeBtn.style.color = mergeActive ? 'var(--neu-text-active)' : 'var(--neu-text)';
      ruleBtn.style.color = mergeActive ? 'var(--neu-text)' : '#ef4444';
      opHint.innerText = mergeActive
        ? '\u5408\u5E76\u8FC7\u6EE4\uFF1A\u7528\u4E8E\u5904\u7406\u91CD\u590D\u6807\u6CE8\u6216\u628A\u6765\u6E90\u7C7B\u522B\u5E76\u5165\u76EE\u6807\u7C7B\u522B\u3002\u8BE5\u6A21\u5F0F\u4E0D\u4F1A\u4F7F\u7528\u89C4\u5219\u8FC7\u6EE4\u6761\u4EF6\u3002'
        : '\u89C4\u5219\u8FC7\u6EE4\uFF1A\u53EA\u6839\u636E\u5DF2\u52FE\u9009\u7684\u89C4\u5219\u7B5B\u51FA\u547D\u4E2D\u6807\u6CE8\uFF0C\u5E76\u5728\u786E\u8BA4\u540E\u5220\u9664\u8FD9\u4E9B\u547D\u4E2D\u6807\u6CE8\u3002\u8BE5\u6A21\u5F0F\u4E0D\u4F1A\u505A\u6539\u7C7B\u6216\u5408\u5E76\u3002';
      applyBtn.innerText = mergeActive ? '\u786E\u8BA4\u5408\u5E76' : '\u5220\u9664\u547D\u4E2D\u6807\u6CE8';
      this.updateFilterRuleText(operationMode);
    };

    const updateUI = () => {
      syncOperationUI();
      this.updateFilterRuleText(operationMode);
    };

    mergeBtn.onclick = () => {
      operationMode = 'merge';
      applyBtn.style.display = 'none';
      summaryEl.innerHTML = '';
      this.currentFilterToken = '';
      updateUI();
    };
    ruleBtn.onclick = () => {
      operationMode = 'rule';
      applyBtn.style.display = 'none';
      summaryEl.innerHTML = '';
      this.currentFilterToken = '';
      updateUI();
    };

    cov.oninput = () => {
      document.getElementById('filter-cov-val').innerText = Number(cov.value).toFixed(2);
      this.updateFilterRuleText(operationMode);
    };
    modeSel.onchange = updateUI;
    Array.from(document.querySelectorAll('.source-cls-chk, .rule-cls-chk')).forEach(el => {
      el.onchange = () => this.updateFilterRuleText(operationMode);
    });
    filterInputs.forEach(el => {
      el.onchange = () => this.updateFilterRuleText(operationMode);
      el.oninput = () => this.updateFilterRuleText(operationMode);
    });
    updateUI();

    const collectPayload = () => {
      const mode = modeSel.value;
      const target = document.getElementById('filter-target-cls').value;
      const sources = Array.from(document.querySelectorAll('.source-cls-chk:checked')).map(el => el.value);
      const ruleClasses = Array.from(document.querySelectorAll('.rule-cls-chk:checked')).map(el => el.value);
      const smallEnabled = document.getElementById('filter-small-enabled').checked;
      const countEnabled = document.getElementById('filter-count-enabled').checked;
      const posEnabled = document.getElementById('filter-pos-enabled').checked;
      const confEnabled = document.getElementById('filter-conf-enabled').checked;

      if (operationMode === 'merge' && mode === 'canonical_class' && sources.length === 0) {
        throw new Error('\u8BF7\u81F3\u5C11\u9009\u62E9\u4E00\u4E2A\u6765\u6E90\u7C7B\u522B');
      }
      if (operationMode === 'rule' && ruleClasses.length === 0) {
        throw new Error('\u8BF7\u81F3\u5C11\u9009\u62E9\u4E00\u4E2A\u7C7B\u522B\u8303\u56F4');
      }
      if (operationMode === 'rule' && !(smallEnabled || countEnabled || posEnabled || confEnabled)) {
        throw new Error('\u89C4\u5219\u8FC7\u6EE4\u81F3\u5C11\u8981\u542F\u7528\u4E00\u6761\u89C4\u5219\u6761\u4EF6');
      }

      return {
        project_id: this.projectId,
        operation_mode: operationMode,
        merge_mode: operationMode === 'merge' ? mode : 'same_class',
        coverage_threshold: parseFloat(cov.value),
        canonical_class: operationMode === 'merge' && mode === 'canonical_class' ? target : '',
        source_classes: operationMode === 'merge' && mode === 'canonical_class' ? sources : [],
        area_mode: document.getElementById('filter-area-sel').value,
        rule_classes: operationMode === 'rule' ? ruleClasses : [],
        small_target_enabled: operationMode === 'rule' ? smallEnabled : false,
        max_area_ratio: parseFloat(document.getElementById('filter-small-ratio').value || '0.02'),
        instance_count_enabled: operationMode === 'rule' ? countEnabled : false,
        min_instances: parseInt(document.getElementById('filter-min-count').value || '1', 10),
        max_instances: parseInt(document.getElementById('filter-max-count').value || '0', 10),
        position_enabled: operationMode === 'rule' ? posEnabled : false,
        center_x_half_width: parseFloat(document.getElementById('filter-center-x').value || '0.25'),
        center_y_half_height: parseFloat(document.getElementById('filter-center-y').value || '0.05'),
        confidence_enabled: operationMode === 'rule' ? confEnabled : false,
        min_confidence: parseFloat(document.getElementById('filter-conf-min').value || '0'),
        max_confidence: parseFloat(document.getElementById('filter-conf-max').value || '1')
      };
    };

    const renderFilterSummary = (result, kind) => {
      const items = Array.isArray(result?.items) ? result.items : [];
      const op = String(result?.operation_mode || operationMode || 'merge');
      if (items.length === 0) {
        summaryEl.innerHTML = `<div style="font-size: 12px; color: var(--neu-text-light);">${op === 'merge' ? '\u5F53\u524D\u5408\u5E76\u89C4\u5219\u4E0B\u6CA1\u6709\u5019\u9009\u56FE\u7247\u3002' : '\u5F53\u524D\u89C4\u5219\u4E0B\u6CA1\u6709\u547D\u4E2D\u6807\u6CE8\u3002'}</div>`;
        return;
      }
      summaryEl.innerHTML = items.slice(0, 30).map((item) => {
        const primaryCount = kind === 'preview'
          ? (op === 'merge' ? `\u9884\u89C8\u5220\u9664 ${item.candidate_count || 0}` : `\u547D\u4E2D\u5F85\u5220 ${item.candidate_count || 0}`)
          : (op === 'merge' ? `\u5DF2\u5220\u9664 ${item.removed_count || 0}` : `\u5DF2\u5220\u9664 ${item.removed_count || 0}`);
        const relabelText = op === 'merge' ? `<span>\u6539\u7C7B ${item.relabel_count || 0}</span>` : '';
        const scopedText = op === 'merge' && item.scoped_annotation_count != null
          ? `<span>\u547D\u4E2D\u8303\u56F4 ${item.scoped_annotation_count}</span>`
          : '';
        return `
          <div class="neu-box" style="padding: 10px 12px; border-radius: 10px; background: var(--neu-bg-light);">
            <div style="font-size: 12px; font-weight: 700; color: var(--neu-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${item.rel_path || item.image_id || '--'}</div>
            <div style="margin-top: 6px; display: flex; gap: 12px; font-size: 11px; color: var(--neu-text-light); flex-wrap: wrap;">
              <span>${primaryCount}</span>
              ${relabelText}
              ${scopedText}
            </div>
          </div>
        `;
      }).join('');
    };

    const pollFilterJob = async (jobId, kind) => {
      if (!jobId) return;
      if (this.filterJobTimer) clearTimeout(this.filterJobTimer);
      try {
        const res = await api.getFilterJob(jobId);
        const job = res?.job || null;
        if (!job) {
          statusEl.innerText = '\u672A\u627E\u5230\u667A\u80FD\u8FC7\u6EE4\u4EFB\u52A1\u72B6\u6001';
          return;
        }
        const pct = Number(job.progress_pct || 0);
        progressFillEl.style.width = `${pct}%`;
        progressTextEl.innerText = `${Math.round(pct)}%`;
        statusEl.innerText = job.message || '\u5904\u7406\u4E2D...';

        if (job.status === 'done') {
          const result = job.result || {};
          if (kind === 'preview') {
            this.currentFilterToken = result.preview_token || '';
            renderFilterSummary(result, 'preview');
            applyBtn.style.display = this.currentFilterToken ? 'inline-flex' : 'none';
          } else {
            renderFilterSummary(result, 'apply');
            applyBtn.style.display = 'none';
            await this.loadProjectInfo();
            if (this.selectedImageId && this.selectedImagePath) {
              await this.selectImage(this.selectedImageId, this.selectedImagePath);
            }
          }
          return;
        }

        if (job.status === 'error') {
          progressFillEl.style.background = '#ef4444';
          statusEl.innerText = job.error || job.message || '\u667A\u80FD\u8FC7\u6EE4\u4EFB\u52A1\u5931\u8D25';
          return;
        }

        progressFillEl.style.background = 'var(--neu-text-active)';
        this.filterJobTimer = setTimeout(() => pollFilterJob(jobId, kind), 1200);
      } catch (e) {
        statusEl.innerText = `\u8F6E\u8BE2\u5931\u8D25: ${e.message}`;
      }
    };

    previewBtn.onclick = async () => {
      try {
        const payload = collectPayload();
        previewBtn.disabled = true;
        applyBtn.style.display = 'none';
        this.currentFilterToken = '';
        summaryEl.innerHTML = '';
        progressFillEl.style.width = '0%';
        progressFillEl.style.background = 'var(--neu-text-active)';
        progressTextEl.innerText = '0%';
        statusEl.innerText = '\u63D0\u4EA4\u9884\u89C8\u4EFB\u52A1...';
        const res = await api.smartFilterPreview(payload);
        const job = res?.job || null;
        if (!job?.job_id) throw new Error('\u9884\u89C8\u4EFB\u52A1\u672A\u8FD4\u56DE job_id');
        statusEl.innerText = '\u9884\u89C8\u4EFB\u52A1\u5DF2\u542F\u52A8...';
        await pollFilterJob(job.job_id, 'preview');
      } catch (e) {
        statusEl.innerText = e.message;
        showToast(e.message, 'error');
      } finally {
        previewBtn.disabled = false;
      }
    };

    applyBtn.onclick = async () => {
      if (!this.currentFilterToken) return showToast(i18n.t('filter_preview_expired'), 'error');
      const confirmText = operationMode === 'merge'
        ? '\u786E\u8BA4\u6309\u9884\u89C8\u7ED3\u679C\u6267\u884C\u5408\u5E76\u8FC7\u6EE4\u5417\uFF1F'
        : '\u786E\u8BA4\u5220\u9664\u6240\u6709\u547D\u4E2D\u89C4\u5219\u7684\u6807\u6CE8\u5417\uFF1F\u8BE5\u64CD\u4F5C\u4F1A\u76F4\u63A5\u4FEE\u6539\u6807\u6CE8\u3002';
      if (!confirm(confirmText)) return;
      try {
        applyBtn.disabled = true;
        summaryEl.innerHTML = '';
        progressFillEl.style.width = '0%';
        progressFillEl.style.background = 'var(--neu-text-active)';
        progressTextEl.innerText = '0%';
        statusEl.innerText = '\u63D0\u4EA4\u786E\u8BA4\u4EFB\u52A1...';
        const res = await api.smartFilterApply({
          ...collectPayload(),
          preview_token: this.currentFilterToken
        });
        const job = res?.job || null;
        if (!job?.job_id) throw new Error('\u786E\u8BA4\u4EFB\u52A1\u672A\u8FD4\u56DE job_id');
        statusEl.innerText = operationMode === 'merge' ? '\u6B63\u5728\u5E94\u7528\u5408\u5E76\u7ED3\u679C...' : '\u6B63\u5728\u5220\u9664\u547D\u4E2D\u6807\u6CE8...';
        await pollFilterJob(job.job_id, 'apply');
        showToast(operationMode === 'merge' ? '\u5408\u5E76\u8FC7\u6EE4\u5DF2\u5E94\u7528' : '\u89C4\u5219\u8FC7\u6EE4\u5220\u9664\u5DF2\u5E94\u7528', 'success');
      } catch (e) {
        showToast(e.message, 'error');
      } finally {
        applyBtn.disabled = false;
      }
    };
  },

  updateFilterRuleText(operationMode = 'merge') {
    const mode = document.getElementById('filter-mode-sel')?.value;
    const cov = parseFloat(document.getElementById('filter-cov')?.value || '0.98');
    const target = document.getElementById('filter-target-cls')?.value;
    const sources = Array.from(document.querySelectorAll('.source-cls-chk:checked')).map(el => el.value);
    const ruleClasses = Array.from(document.querySelectorAll('.rule-cls-chk:checked')).map(el => el.value);
    const chunks = [];

    if (operationMode === 'merge') {
      if (mode === 'same_class') {
        chunks.push(`\u5408\u5E76\u8FC7\u6EE4\uFF1A\u5F53\u540C\u7C7B\u6807\u6CE8\u7684\u91CD\u53E0\u7387\u8D85\u8FC7 ${(cov * 100).toFixed(0)}% \u65F6\uFF0C\u5220\u9664\u8F83\u5C0F\u5B9E\u4F8B\u3002`);
      } else {
        chunks.push(`\u5408\u5E76\u8FC7\u6EE4\uFF1A\u5F53\u91CD\u53E0\u7387\u8D85\u8FC7 ${(cov * 100).toFixed(0)}% \u65F6\uFF0C\u5C06 [${sources.join(', ') || '\u672A\u9009\u62E9'}] \u5E76\u5165 [${target || '--'}]\u3002`);
      }
      chunks.push('\u8BE5\u6A21\u5F0F\u53EA\u4F1A\u6267\u884C\u5408\u5E76 / \u6539\u7C7B\u903B\u8F91\uFF0C\u4E0D\u4F1A\u5E94\u7528\u89C4\u5219\u5220\u9664\u6761\u4EF6\u3002');
    } else {
      chunks.push(`\u89C4\u5219\u8FC7\u6EE4\uFF1A\u5728 [${ruleClasses.length > 0 ? ruleClasses.join(', ') : '\u672A\u9009\u62E9'}] \u8303\u56F4\u5185\u67E5\u627E\u547D\u4E2D\u89C4\u5219\u7684\u6807\u6CE8\uFF0C\u9884\u89C8\u540E\u5220\u9664\u547D\u4E2D\u9879\u3002`);
      if (document.getElementById('filter-small-enabled')?.checked) {
        chunks.push(`\u5C0F\u76EE\u6807\uFF1A\u9762\u79EF\u5360\u6BD4 <= ${document.getElementById('filter-small-ratio').value}\u3002`);
      }
      if (document.getElementById('filter-count-enabled')?.checked) {
        const maxValue = document.getElementById('filter-max-count').value || '\u4E0D\u9650';
        chunks.push(`\u5B9E\u4F8B\u6570\u91CF\uFF1A${document.getElementById('filter-min-count').value} \u5230 ${maxValue}\u3002`);
      }
      if (document.getElementById('filter-pos-enabled')?.checked) {
        chunks.push(`\u4F4D\u7F6E\uFF1A\u4E2D\u5FC3\u534A\u5BBD ${document.getElementById('filter-center-x').value}\uFF0C\u4E2D\u5FC3\u534A\u9AD8 ${document.getElementById('filter-center-y').value}\u3002`);
      }
      if (document.getElementById('filter-conf-enabled')?.checked) {
        chunks.push(`\u7F6E\u4FE1\u5EA6\uFF1A${document.getElementById('filter-conf-min').value} - ${document.getElementById('filter-conf-max').value}\u3002`);
      }
      if (chunks.length === 1) {
        chunks.push('\u8BF7\u81F3\u5C11\u542F\u7528\u4E00\u6761\u89C4\u5219\u6761\u4EF6\uFF0C\u5426\u5219\u4E0D\u4F1A\u5141\u8BB8\u6267\u884C\u5220\u9664\u3002');
      }
    }

    const el = document.getElementById('filter-rule-text');
    if (el) el.innerText = chunks.join(' ');
  },

  openExport() {
    const modal = document.getElementById('modal-export-full');
    modal.innerHTML = `
      <div class="neu-card" style="width: 400px; padding: 30px; position: relative;">
        <button class="neu-button" style="position: absolute; top: 15px; right: 15px; width: 34px; height: 34px; padding: 0; border-radius: 50%; font-size: 18px; color: #ef4444;" onclick="document.getElementById('modal-export-full').style.display='none'">×</button>
        <h2 style="margin-top: 0;">${i18n.t('export')}</h2>
        <div style="display: flex; flex-direction: column; gap: 20px;">
          <div>
            <label style="display: block; font-size: 11px; font-weight: 700; margin-bottom: 8px;">导出格式</label>
            <select id="exp-format" class="neu-input" style="width: 100%;">
              <option value="coco">COCO</option>
              <option value="yolo">YOLO</option>
              <option value="json">JSON</option>
            </select>
          </div>
          <div>
             <label style="display: block; font-size: 11px; font-weight: 700; margin-bottom: 8px;">保存内容</label>
             <div style="display: flex; gap: 20px; font-size: 12px;">
                <label><input type="checkbox" id="exp-bbox" checked /> BBox</label>
                <label><input type="checkbox" id="exp-mask" /> Mask</label>
             </div>
          </div>
          <div>
            <label style="display: block; font-size: 11px; font-weight: 700; margin-bottom: 8px;">导出目录</label>
            <input type="text" id="exp-dir" class="neu-input" style="width: 100%;" placeholder="留空则导出到项目默认目录" />
            <div style="margin-top: 6px; font-size: 11px; color: var(--neu-text-light);">YOLO 只能导出框或掩码其中一种；JSON/COCO 可以同时导出。</div>
          </div>
          <div class="neu-box" style="padding: 12px; border-radius: 12px; background: var(--neu-bg-light);">
            <div id="export-status" style="font-size: 12px; color: var(--neu-text-light);">请先选择格式和内容，再点击确认导出。</div>
          </div>
          <div style="display: flex; justify-content: flex-end; gap: 10px; margin-top: 10px;">
            <button class="neu-button" onclick="document.getElementById('modal-export-full').style.display='none'">${i18n.t('cancel')}</button>
            <button id="btn-do-export" class="neu-button" style="color: var(--neu-text-active); font-weight: 700;">确认导出</button>
          </div>
        </div>
      </div>
    `;
    modal.style.display = 'flex';
    
    const formatEl = document.getElementById('exp-format');
    const bboxEl = document.getElementById('exp-bbox');
    const maskEl = document.getElementById('exp-mask');
    const statusEl = document.getElementById('export-status');
    const exportBtn = document.getElementById('btn-do-export');
    const updateExportOptions = () => {
      if (formatEl.value === 'yolo' && bboxEl.checked && maskEl.checked) {
        maskEl.checked = false;
      }
      statusEl.innerText = formatEl.value === 'yolo'
        ? 'YOLO 仅支持框检测或掩码分割其中一种导出形式。'
        : '将使用后端导出接口生成数据集文件。';
    };
    formatEl.onchange = updateExportOptions;
    bboxEl.onchange = updateExportOptions;
    maskEl.onchange = updateExportOptions;
    updateExportOptions();

    exportBtn.onclick = async () => {
      const dir = document.getElementById('exp-dir').value.trim();
      try {
        exportBtn.disabled = true;
        statusEl.innerText = '正在导出，请稍候...';
        const res = await api.exportProject({
          project_id: this.projectId,
          format: formatEl.value,
          include_bbox: bboxEl.checked,
          include_mask: maskEl.checked,
          output_dir: dir || null
        });
        const output = res?.output || '';
        statusEl.innerText = output ? `导出完成: ${output}` : '导出完成';
        showToast("Export successful", "success");
      } catch(e) {
        statusEl.innerText = e.message;
        showToast(e.message, "error");
      } finally {
        exportBtn.disabled = false;
      }
    };
  }
};
