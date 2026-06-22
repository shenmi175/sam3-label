import { api } from '../api.js';
import {
  bindAnnotationListEvents,
  renderAnnotationList,
  updateAnnotationListFocus,
} from '../components/annotation-list.js';
import { bindClassPanelEvents, renderClassPanel } from '../components/class-panel.js';
import { bindImageListEvents, setImageListItemLabeledState } from '../components/image-list.js';
import { ImageViewerV2 } from '../components/image-viewer-v2.js';
import { renderWorkspaceToolbar } from '../components/workspace-toolbar.js';
import { i18n } from '../i18n.js';
import { AnnotationController } from '../modules/image-workspace/annotation-controller.js';
import { DataDashboardController } from '../modules/image-workspace/data-dashboard-controller.js';
import { ExportController } from '../modules/image-workspace/export-controller.js';
import { ImageNavigationController } from '../modules/image-workspace/image-navigation-controller.js';
import { SmartFilterController } from '../modules/image-workspace/smart-filter-controller.js';
import {
  clearBundleState,
  getBundleFromCache,
  invalidateBundleState,
  makeImageBundle,
  makeImageBundleKey,
  storeBundleInCache,
  touchBundleCache,
} from '../modules/image-workspace/workspace-state.js';
import { store } from '../store.js';
import { escapeAttr, escapeHtml } from '../utils/html.js';

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
  annotationController: null,
  dataDashboardController: null,
  exportController: null,
  imageNavigationController: null,
  smartFilterController: null,
  isUnmounted: false,
  promptMode: 'pointer',
  currentPrompts: [],
  previewSectionCollapsed: false,
  focusedAnnotationId: null,
  unlabeledNavigationEnabled: false,
  imageFilterClass: '',
  imageFilterStatus: 'all',
  imageLoadSeq: 0,
  imageListLoadSeq: 0,
  imageLoadAbortController: null,
  isImageLoading: false,
  imageBundleCache: null,
  imageBundlePromises: null,
  imageBundleCacheLimit: 8,
  imagePrefetchRadius: 3,
  gpuStatusInterval: null,
  gpuStatusFailures: 0,
  uiStateSaveTimer: null,
  batchResultShownForJobId: '',
  annotationAutosaveEnabled: true,
  annotationSaveTimer: null,
  annotationDirty: false,
  annotationSaving: false,
  annotationRev: 0,
  annotationSaveImageId: '',
  annotationHistory: null,
  annotationRedoStack: null,
  workspaceMode: 'auto',
  reviewContinuousMode: true,
  
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
    this.leftPanelHidden = false;
    this.rightPanelHidden = false;
    this.classesSectionCollapsed = false;
    this.annotationsSectionCollapsed = false;
    this.previewSectionCollapsed = false;
    this.focusedAnnotationId = null;
    this.unlabeledNavigationEnabled = false;
    this.imageFilterClass = '';
    this.imageFilterStatus = 'all';
    this.imageLoadSeq = 0;
    this.imageListLoadSeq = 0;
    this.imageLoadAbortController = null;
    this.isImageLoading = false;
    this.imageBundleCache = new Map();
    this.imageBundlePromises = new Map();
    this.gpuStatusInterval = null;
    this.gpuStatusFailures = 0;
    this.batchResultShownForJobId = '';
    this.annotationAutosaveEnabled = true;
    this.annotationSaveTimer = null;
    this.annotationDirty = false;
    this.annotationSaving = false;
    this.annotationRev = 0;
    this.annotationSaveImageId = '';
    this.annotationHistory = [];
    this.annotationRedoStack = [];
    this.workspaceMode = 'auto';
    this.reviewContinuousMode = true;
    this.annotationController = new AnnotationController(this);
    this.dataDashboardController = new DataDashboardController(this);
    this.exportController = new ExportController(this);
    this.imageNavigationController = new ImageNavigationController(this);
    this.smartFilterController = new SmartFilterController(this);
    window.currentWorkspace = this;
    
    container.innerHTML = `
      <div class="workspace-layout" style="display: flex; height: 100%; flex-direction: column; background: var(--neu-bg); overflow: hidden; min-height: 0; min-width: 0; box-sizing: border-box;">
        <!-- 1. Top Navigation Bar -->
        <div class="neu-box" style="height: 56px; flex-shrink: 0; display: flex; align-items: center; padding: 0 24px; z-index: 100; border-radius: 0; gap: 20px; border-bottom: 1px solid rgba(0,0,0,0.05); box-sizing: border-box; position: relative;">
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

          <div id="gpu-status-widget" class="neu-box" title="GPU status" style="position: absolute; left: 50%; top: 10px; transform: translateX(-50%); width: 360px; height: 36px; border-radius: 10px; padding: 6px 12px; box-sizing: border-box; display: flex; align-items: center; gap: 12px; box-shadow: var(--neu-inset-sm); background: var(--neu-bg);">
            <span id="gpu-status-dot" style="width: 8px; height: 8px; border-radius: 50%; background: #94a3b8; flex-shrink: 0;"></span>
            <div style="display: flex; align-items: center; gap: 6px; flex: 1; min-width: 0;">
              <span style="font-size: 10px; font-weight: 800; color: var(--neu-text-light); width: 28px;">GPU</span>
              <div style="height: 6px; flex: 1; min-width: 48px; background: rgba(0,0,0,0.08); border-radius: 999px; overflow: hidden;">
                <div id="gpu-util-fill" style="width: 0%; height: 100%; background: #10b981;"></div>
              </div>
              <span id="gpu-util-text" style="width: 34px; text-align: right; font-size: 10px; font-weight: 800; color: var(--neu-text); font-variant-numeric: tabular-nums;">--</span>
            </div>
            <div style="display: flex; align-items: center; gap: 6px; flex: 1.2; min-width: 0;">
              <span style="font-size: 10px; font-weight: 800; color: var(--neu-text-light); width: 32px;">显存</span>
              <div style="height: 6px; flex: 1; min-width: 48px; background: rgba(0,0,0,0.08); border-radius: 999px; overflow: hidden;">
                <div id="gpu-mem-fill" style="width: 0%; height: 100%; background: #3b82f6;"></div>
              </div>
              <span id="gpu-mem-text" style="width: 78px; text-align: right; font-size: 10px; font-weight: 800; color: var(--neu-text); font-variant-numeric: tabular-nums;">--</span>
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
        ${renderWorkspaceToolbar()}

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
                 <div style="padding: 0 20px 10px 20px; display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
                   <select id="sel-image-filter-class" class="neu-input" style="height: 32px; font-size: 11px;">
                     <option value="">${i18n.t('filter_all_classes')}</option>
                   </select>
                   <select id="sel-image-filter-status" class="neu-input" style="height: 32px; font-size: 11px;">
                     <option value="all">${i18n.t('filter_all_status')}</option>
                     <option value="labeled">${i18n.t('labeled')}</option>
                     <option value="unlabeled">${i18n.t('unlabeled')}</option>
                   </select>
                 </div>
               <div id="image-list-container" style="flex: 1; overflow-y: auto; padding: 10px 15px;">
                  <div style="text-align:center; padding: 40px; color: var(--neu-text-light);">${i18n.t('loading_images')}</div>
               </div>
               <div style="padding: 15px; display: flex; justify-content: space-between; align-items: center; border-top: 1px solid rgba(0,0,0,0.05);">
                  <button class="neu-button" style="width: 40px; height: 40px; border-radius: 50%; display: flex; align-items: center; justify-content: center;" id="btn-img-prev">‹</button>
                  <div style="display: flex; align-items: center; justify-content: center; gap: 6px; font-size: 12px; font-weight: 700;">
                    <input id="inp-page-jump" class="neu-input" type="text" inputmode="numeric" pattern="[0-9]*" value="1" aria-label="跳转页码" style="width: 54px; height: 30px; text-align: center; font-size: 12px; font-weight: 800; padding: 0 6px;" />
                    <span style="color: var(--neu-text-light);">/</span>
                    <span id="ws-page-total" style="min-width: 22px; text-align: left;">1</span>
                  </div>
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
                   <div id="canvas-placeholder-text" style="font-size: 18px; font-weight: 600; color: var(--neu-text-light);">${i18n.t('select_image_prompt')}</div>
                </div>

                <!-- Hovering Toolbar -->
                 <div class="neu-box" style="position: absolute; top: 20px; left: 50%; transform: translateX(-50%); height: 50px; border-radius: 25px; display: flex; align-items: center; padding: 0 10px; z-index: 100; gap: 5px; box-shadow: 0 10px 30px rgba(0,0,0,0.1); background: var(--canvas-toolbar-bg);">
                    <span style="font-size: 10px; font-weight: 800; color: var(--neu-text-light); padding: 0 4px;">标注</span>
                    <button class="neu-button" id="btn-tool-pointer" title="V：选择/移动/修正已有标注，空白处拖动平移" style="width: 44px; height: 40px; border-radius: 20px; font-size: 11px; font-weight: 800;">编辑</button>
                    <button class="neu-button" id="btn-tool-manual-box" title="B：手动画检测框" style="width: 40px; height: 40px; border-radius: 50%;">□</button>
                    <button class="neu-button" id="btn-tool-manual-polygon" title="P：手动画分割多边形，Enter 闭合，Esc 取消" style="width: 48px; height: 40px; border-radius: 20px; font-size: 11px; font-weight: 800;">Poly</button>
                    <div style="width: 1px; height: 24px; background: rgba(0,0,0,0.1); margin: 0 5px;"></div>
                    <button class="neu-button" id="btn-tool-undo" title="撤销手动修改" style="width: 40px; height: 40px; border-radius: 50%;">↶</button>
                    <button class="neu-button" id="btn-tool-redo" title="重做手动修改" style="width: 40px; height: 40px; border-radius: 50%;">↷</button>
                    <button class="neu-button" id="btn-tool-delete-ann" title="删除当前选中标注" style="width: 40px; height: 40px; border-radius: 50%; color: #ef4444;">×</button>
                    <div id="ws-sam-tools" class="ws-auto-only" data-default-display="flex" style="display: flex; align-items: center; gap: 5px;">
                      <div style="width: 1px; height: 24px; background: rgba(0,0,0,0.1); margin: 0 5px;"></div>
                      <span style="font-size: 10px; font-weight: 800; color: var(--neu-text-light); padding: 0 4px;">SAM</span>
                      <button class="neu-button" id="btn-tool-box" title="S：${i18n.t('box_exemplar_tool')}" style="width: 40px; height: 40px; border-radius: 50%;">🏁</button>
                      <button class="neu-button" id="btn-tool-clear" title="${i18n.t('clear_prompts')}" style="width: 40px; height: 40px; border-radius: 50%;">🧹</button>
                    </div>
                    <div style="width: 1px; height: 24px; background: rgba(0,0,0,0.1); margin: 0 5px;"></div>
                    <button class="neu-button" id="btn-tool-fit" title="F：适配屏幕" style="width: 40px; height: 40px; border-radius: 50%;">F</button>
                 </div>
             </div>

             <!-- Display Toggles & Information -->
             <div class="neu-box" style="height: 40px; border-radius: 0; display: flex; align-items: center; padding: 0 20px; gap: 20px; background: var(--neu-bg); z-index: 40; font-size: 11px; border-top: 1px solid rgba(0,0,0,0.03);">
                <label style="display: flex; align-items: center; gap: 6px; cursor: pointer;">
                   <input type="checkbox" id="chk-show-masks" checked /> 显示遮罩
                </label>
                <label style="display: flex; align-items: center; gap: 6px; cursor: pointer;">
                   <input type="checkbox" id="chk-annotation-autosave" checked /> 自动保存
                </label>
                <div id="annotation-save-status" style="font-weight: 700; color: var(--neu-text-light); min-width: 72px;">已保存</div>
                <div style="flex: 1;"></div>
                <div id="ws-image-status" style="font-weight: 700; color: var(--neu-text-light);">--</div>
             </div>

             <!-- Bottom Action Bar (Context Sensitive) -->
             <div id="ws-action-bar" class="ws-auto-only" data-default-display="block" style="position: absolute; bottom: 60px; left: 50%; transform: translateX(-50%); z-index: 100; display: none;">
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
                   <div id="preview-results-card" class="neu-box ws-auto-only" data-default-display="block" style="padding: 12px; border-radius: 12px; background: var(--neu-bg-light);">
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
      <div id="modal-dashboard-full" class="modal-overlay" style="display: none;"></div>
      <div id="modal-export-full" class="modal-overlay" style="display: none;"></div>
      <div id="modal-batch-full" class="modal-overlay" style="display: none;"></div>
      <div id="modal-batch-result" class="modal-overlay" style="display: none;"></div>
    `;

    this.initializeLayoutControls();
    
    this.viewer = new ImageViewerV2('canvas-container');
    this.viewer.onPromptAdded = (type, data) => this.addPrompt(type, data);
    this.viewer.onAnnotationSelected = (annId) => this.selectAnnotationFromCanvas(annId);
    this.viewer.onAnnotationEditStart = () => this.pushAnnotationHistory();
    this.viewer.onAnnotationUpdated = (ann) => this.handleManualAnnotationUpdated(ann);
    this.viewer.onAnnotationCreated = (shape) => this.createManualAnnotation(shape);
    this.setPromptMode('pointer');
    
    this.bindEvents();
    this.refreshUnlabeledButton();
    window.currentWorkspace = this;
    
    await this.loadProjectInfo();
    await this.restoreProjectUIState();
    this.syncWorkspaceModeUI();
    this.renderImageFilterControls();
    this.applyLayoutState();
    await this.loadImages();
    await this.restoreSelectedImage();
    this.startHealthCheck();
    this.startGpuStatusPolling();
  },

  initializeLayoutControls() {
    const canvasContainer = document.getElementById('canvas-container');
    const centerPanel = document.getElementById('center-panel');
    const fitBtn = document.getElementById('btn-tool-fit');
    const leftPanel = document.getElementById('left-panel');
    const rightPanel = document.getElementById('right-panel');

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
    if (this.imageLoadAbortController) {
      this.imageLoadAbortController.abort();
      this.imageLoadAbortController = null;
    }
    this.clearImageBundleCache();
    this.flushProjectUIState();
    if (this.viewer) {
      this.viewer.destroy();
      this.viewer = null;
    }
    if (this.healthInterval) clearInterval(this.healthInterval);
    if (this.gpuStatusInterval) clearInterval(this.gpuStatusInterval);
    if (this.smartFilterController) this.smartFilterController.clearTimer();
    if (this.uiStateSaveTimer) {
      clearTimeout(this.uiStateSaveTimer);
      this.uiStateSaveTimer = null;
    }
    if (this.annotationController) this.annotationController.clearSaveTimer();
    if (this._keyHandler) {
      document.removeEventListener('keydown', this._keyHandler);
      this._keyHandler = null;
    }
    this.container = null;
    window.currentWorkspace = null;
  },

  sanitizeOffset(offsetValue = this.offset, totalValue = this.totalImages) {
    return this.imageNavigationController.sanitizeOffset(offsetValue, totalValue);
  },

  getTotalImagePages() {
    return this.imageNavigationController.getTotalPages();
  },

  getCurrentImagePage() {
    return this.imageNavigationController.getCurrentPage();
  },

  syncImagePaginationControls() {
    this.imageNavigationController.syncPaginationControls();
  },

  async goToImagePage(pageValue) {
    await this.imageNavigationController.goToPage(pageValue);
  },

  hasImageFilter() {
    return this.imageNavigationController.hasFilter();
  },

  setWorkspaceMode(mode) {
    const nextMode = mode === 'review' ? 'review' : 'auto';
    this.workspaceMode = nextMode;
    if (nextMode === 'review' && this.promptMode === 'box') {
      this.setPromptMode('pointer');
    }
    this.syncWorkspaceModeUI();
    this.scheduleProjectUIStateSave();
  },

  setModeElementVisibility(selector, visible) {
    document.querySelectorAll(selector).forEach((el) => {
      const defaultDisplay = el.dataset.defaultDisplay || 'flex';
      el.style.display = visible ? defaultDisplay : 'none';
    });
  },

  syncWorkspaceModeUI() {
    const isReview = this.workspaceMode === 'review';
    this.setModeElementVisibility('.ws-auto-only', !isReview);
    this.setModeElementVisibility('.ws-review-only', isReview);

    const autoBtn = document.getElementById('btn-workspace-mode-auto');
    const reviewBtn = document.getElementById('btn-workspace-mode-review');
    const syncModeButton = (btn, active) => {
      if (!btn) return;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
      btn.style.boxShadow = active ? 'var(--neu-inset)' : 'var(--neu-outset-sm)';
      btn.style.color = active ? 'var(--neu-text-active)' : 'var(--neu-text)';
    };
    syncModeButton(autoBtn, !isReview);
    syncModeButton(reviewBtn, isReview);

    const btnReviewContinuous = document.getElementById('btn-review-continuous');
    if (btnReviewContinuous) {
      btnReviewContinuous.textContent = this.reviewContinuousMode ? '连续: 开' : '连续: 关';
      btnReviewContinuous.style.boxShadow = this.reviewContinuousMode ? 'var(--neu-inset)' : 'var(--neu-outset-sm)';
      btnReviewContinuous.style.color = this.reviewContinuousMode ? 'var(--neu-text-active)' : 'var(--neu-text)';
    }
    this.syncReviewModeSummary();
    this.updateAnnotationSelectionControls();
    this.updateActionBar();
  },

  syncReviewModeSummary() {
    const currentClassEl = document.getElementById('review-current-class');
    if (currentClassEl) {
      const selected = this.selectedClass || this.projectMeta?.classes?.[0] || '';
      currentClassEl.textContent = selected || '未选择';
      currentClassEl.title = selected || '未选择类别';
    }
  },

  toggleReviewContinuousMode() {
    this.reviewContinuousMode = !this.reviewContinuousMode;
    this.syncWorkspaceModeUI();
    this.scheduleProjectUIStateSave();
  },

  async saveAndNavigate(delta = 1) {
    if (!this.selectedImageId) return showToast('请先选择图片', 'error');
    try {
      if (this.annotationDirty) {
        await this.flushAnnotationAutosave('review-save-next');
      } else {
        const saved = await this.annotationController.saveCurrent();
        if (saved) showToast(i18n.t('save_success'), 'success');
      }
      if (this.annotationDirty) return showToast('当前图片标注尚未保存，保存成功后再切换图片', 'error');
      this.navigateImage(delta);
    } catch (e) {
      showToast(e.message, 'error');
    }
  },

  selectClassByIndex(index) {
    const classes = this.projectMeta?.classes || [];
    const cls = classes[index];
    if (!cls) return;
    this.selectClass(cls);
    showToast(`当前类别: ${cls}`, 'info');
  },

  async applySelectedClassToFocusedAnnotation() {
    if (!this.focusedAnnotationId) return showToast('请先选中一个标注', 'info');
    const nextClass = this.selectedClass || this.projectMeta?.classes?.[0] || '';
    if (!nextClass) return showToast('请先选择类别', 'error');
    await this.updateAnnotationClass(this.focusedAnnotationId, nextClass);
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
      this.imageFilterClass = state.imageFilterClass || '';
      this.imageFilterStatus = state.imageFilterStatus || 'all';
      this.leftPanelHidden = Boolean(state.leftPanelHidden);
      this.rightPanelHidden = Boolean(state.rightPanelHidden);
      this.classesSectionCollapsed = Boolean(state.classesSectionCollapsed);
      this.annotationsSectionCollapsed = Boolean(state.annotationsSectionCollapsed);
      this.previewSectionCollapsed = Boolean(state.previewSectionCollapsed);
      this.annotationAutosaveEnabled = state.annotationAutosaveEnabled !== false;
      this.workspaceMode = state.workspaceMode === 'review' ? 'review' : 'auto';
      this.reviewContinuousMode = state.reviewContinuousMode !== false;
      const autosave = document.getElementById('chk-annotation-autosave');
      if (autosave) autosave.checked = this.annotationAutosaveEnabled;
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
        imageFilterClass: this.imageFilterClass || '',
        imageFilterStatus: this.imageFilterStatus || 'all',
        leftPanelHidden: Boolean(this.leftPanelHidden),
        rightPanelHidden: Boolean(this.rightPanelHidden),
        classesSectionCollapsed: Boolean(this.classesSectionCollapsed),
        annotationsSectionCollapsed: Boolean(this.annotationsSectionCollapsed),
        previewSectionCollapsed: Boolean(this.previewSectionCollapsed),
        annotationAutosaveEnabled: Boolean(this.annotationAutosaveEnabled),
        workspaceMode: this.workspaceMode === 'review' ? 'review' : 'auto',
        reviewContinuousMode: Boolean(this.reviewContinuousMode),
      });
    } catch (err) {
      console.warn('save project ui state failed', err);
    }
  },

  async restoreSelectedImage() {
    let targetId = this.selectedImageId;
    let targetPath = this.selectedImagePath;
    if (this.hasImageFilter() && this.images.length > 0 && !this.images.some((img) => img.id === targetId)) {
      targetId = this.images[0].id;
      targetPath = this.images[0].rel_path;
    }
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

  formatGpuMemory(mb) {
    const value = Number(mb || 0);
    if (!Number.isFinite(value) || value <= 0) return '--';
    if (value >= 1024) return `${(value / 1024).toFixed(value >= 10240 ? 0 : 1)}G`;
    return `${Math.round(value)}M`;
  },

  setGpuWidgetUnavailable(message = 'GPU unavailable') {
    const dot = document.getElementById('gpu-status-dot');
    const utilFill = document.getElementById('gpu-util-fill');
    const memFill = document.getElementById('gpu-mem-fill');
    const utilText = document.getElementById('gpu-util-text');
    const memText = document.getElementById('gpu-mem-text');
    const widget = document.getElementById('gpu-status-widget');
    if (dot) dot.style.background = '#94a3b8';
    if (utilFill) utilFill.style.width = '0%';
    if (memFill) memFill.style.width = '0%';
    if (utilText) utilText.textContent = '--';
    if (memText) memText.textContent = '--';
    if (widget) widget.title = message;
  },

  markGpuWidgetStale(message = 'GPU status refresh delayed') {
    const dot = document.getElementById('gpu-status-dot');
    const widget = document.getElementById('gpu-status-widget');
    if (dot) dot.style.background = '#f59e0b';
    if (widget) widget.title = message;
  },

  renderGpuWidget(status) {
    const gpu = status?.result?.gpu || status?.gpu || {};
    const summary = gpu.summary || {};
    const gpus = Array.isArray(gpu.gpus) ? gpu.gpus : [];
    if (!gpu.available || gpus.length === 0) {
      this.setGpuWidgetUnavailable('sam3-api GPU status unavailable');
      return;
    }

    const gpuUtilRaw = summary.gpu_utilization_percent;
    const gpuUtil = Number.isFinite(Number(gpuUtilRaw)) ? Math.max(0, Math.min(100, Number(gpuUtilRaw))) : null;
    const memUsed = Number(summary.memory_used_mb || 0);
    const memTotal = Number(summary.memory_total_mb || 0);
    const memPctRaw = Number(summary.memory_utilization_percent);
    const memPct = Number.isFinite(memPctRaw) ? Math.max(0, Math.min(100, memPctRaw)) : 0;
    const stale = Boolean(gpu.stale);
    const age = Number(gpu.age_seconds || 0);
    const dot = document.getElementById('gpu-status-dot');
    const utilFill = document.getElementById('gpu-util-fill');
    const memFill = document.getElementById('gpu-mem-fill');
    const utilText = document.getElementById('gpu-util-text');
    const memText = document.getElementById('gpu-mem-text');
    const widget = document.getElementById('gpu-status-widget');
    if (dot) dot.style.background = stale ? '#f59e0b' : (memPct >= 90 ? '#ef4444' : (memPct >= 75 ? '#f59e0b' : '#10b981'));
    if (utilFill) utilFill.style.width = gpuUtil === null ? '0%' : `${gpuUtil.toFixed(0)}%`;
    if (memFill) memFill.style.width = `${memPct.toFixed(0)}%`;
    if (utilText) utilText.textContent = gpuUtil === null ? '--' : `${gpuUtil.toFixed(0)}%`;
    if (memText) memText.textContent = `${this.formatGpuMemory(memUsed)}/${this.formatGpuMemory(memTotal)}`;
    if (widget) {
      const lines = gpus.map((item) => {
        const util = item.gpu_utilization_percent === null || item.gpu_utilization_percent === undefined
          ? '--'
          : `${Number(item.gpu_utilization_percent).toFixed(0)}%`;
        return `GPU${item.index} ${item.name}: ${util}, ${this.formatGpuMemory(item.memory_used_mb)}/${this.formatGpuMemory(item.memory_total_mb)}`;
      });
      widget.title = `${stale ? `GPU status is stale (${age.toFixed(0)}s old)\n` : ''}${lines.join('\n')}`;
    }
  },

  startGpuStatusPolling() {
    if (this.gpuStatusInterval) clearInterval(this.gpuStatusInterval);
    const poll = async () => {
      try {
        const status = await api.getSam3Status(store.state.config.sam3ApiUrl);
        if (this.isUnmounted) return;
        this.gpuStatusFailures = 0;
        this.renderGpuWidget(status);
      } catch (err) {
        if (this.isUnmounted) return;
        this.gpuStatusFailures = (this.gpuStatusFailures || 0) + 1;
        const message = String(err?.message || err || 'GPU status unavailable');
        if (this.gpuStatusFailures >= 3) {
          this.setGpuWidgetUnavailable(message);
        } else {
          this.markGpuWidgetStale(message);
        }
      }
    };
    poll();
    this.gpuStatusInterval = setInterval(poll, 1000);
  },

  bindEvents() {
    // Top Operation Bar
    const sam3UrlInp = document.getElementById('inp-sam3-url');
    if (sam3UrlInp) sam3UrlInp.onchange = (e) => store.setConfig('sam3ApiUrl', e.target.value);

    const syncTopConfigControls = () => {
      const thresholdLabel = document.getElementById('lbl-threshold-value');
      const batchLabel = document.getElementById('lbl-batch-size-value');
      if (thresholdLabel) thresholdLabel.innerText = Number(store.state.config.threshold).toFixed(2);
      if (batchLabel) batchLabel.innerText = String(store.state.config.batchSize);
    };
    const adjustThreshold = (delta) => {
      const next = Number((Number(store.state.config.threshold || 0.5) + delta).toFixed(2));
      store.setConfig('threshold', next);
      syncTopConfigControls();
    };
    const adjustBatchSize = (delta) => {
      const next = Number(store.state.config.batchSize || 1) + delta;
      store.setConfig('batchSize', next);
      syncTopConfigControls();
    };
    const btnThresholdDec = document.getElementById('btn-threshold-dec');
    const btnThresholdInc = document.getElementById('btn-threshold-inc');
    const btnBatchDec = document.getElementById('btn-batch-dec');
    const btnBatchInc = document.getElementById('btn-batch-inc');
    if (btnThresholdDec) btnThresholdDec.onclick = () => adjustThreshold(-0.05);
    if (btnThresholdInc) btnThresholdInc.onclick = () => adjustThreshold(0.05);
    if (btnBatchDec) btnBatchDec.onclick = () => adjustBatchSize(-1);
    if (btnBatchInc) btnBatchInc.onclick = () => adjustBatchSize(1);
    syncTopConfigControls();

    const btnWorkspaceAuto = document.getElementById('btn-workspace-mode-auto');
    const btnWorkspaceReview = document.getElementById('btn-workspace-mode-review');
    if (btnWorkspaceAuto) btnWorkspaceAuto.onclick = () => this.setWorkspaceMode('auto');
    if (btnWorkspaceReview) btnWorkspaceReview.onclick = () => this.setWorkspaceMode('review');

    const btnReviewContinuous = document.getElementById('btn-review-continuous');
    if (btnReviewContinuous) btnReviewContinuous.onclick = () => this.toggleReviewContinuousMode();
    const btnReviewApplyClass = document.getElementById('btn-review-apply-class');
    if (btnReviewApplyClass) btnReviewApplyClass.onclick = () => this.applySelectedClassToFocusedAnnotation();
    const btnReviewDeleteAnn = document.getElementById('btn-review-delete-ann');
    if (btnReviewDeleteAnn) btnReviewDeleteAnn.onclick = () => {
      if (!this.focusedAnnotationId) return showToast('请先选中一个标注', 'info');
      this.deleteAnnotation(this.focusedAnnotationId);
    };
    const btnReviewSaveNext = document.getElementById('btn-review-save-next');
    if (btnReviewSaveNext) btnReviewSaveNext.onclick = () => this.saveAndNavigate(1);
    const btnReviewNextUnlabeled = document.getElementById('btn-review-next-unlabeled');
    if (btnReviewNextUnlabeled) btnReviewNextUnlabeled.onclick = () => this.navigateUnlabeledImage(1);

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
    if (btnBatch) btnBatch.onclick = () => this.startBatchTask();
    
    const btnExSeg = document.getElementById('btn-example-segment');
    if (btnExSeg) btnExSeg.onclick = () => this.runExamplePreview();

    const btnDashboard = document.getElementById('btn-open-data-dashboard');
    if (btnDashboard) btnDashboard.onclick = () => this.openDataDashboard();

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
      bindImageListEvents(listCont, {
        onDelete: (imageId, relPath) => this.deleteProjectImage(imageId, relPath),
        onSelect: (imageId, relPath) => this.selectImage(imageId, relPath),
      });
    }

    const btnPrev = document.getElementById('btn-img-prev');
    if (btnPrev) btnPrev.onclick = () => this.goToImagePage(this.getCurrentImagePage() - 1);
    
    const btnNext = document.getElementById('btn-img-next');
    if (btnNext) btnNext.onclick = () => this.goToImagePage(this.getCurrentImagePage() + 1);

    const pageJump = document.getElementById('inp-page-jump');
    if (pageJump) {
      pageJump.onfocus = () => pageJump.select();
      pageJump.oninput = () => {
        pageJump.value = pageJump.value.replace(/[^\d]/g, '');
      };
      pageJump.onkeydown = async (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          await this.goToImagePage(pageJump.value);
          pageJump.blur();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          this.syncImagePaginationControls();
          pageJump.blur();
        }
      };
      pageJump.onblur = () => this.syncImagePaginationControls();
    }

    const btnFindUnlabeled = document.getElementById('btn-find-unlabeled');
    if (btnFindUnlabeled) btnFindUnlabeled.onclick = () => this.toggleUnlabeledNavigation();

    const classFilter = document.getElementById('sel-image-filter-class');
    if (classFilter) classFilter.onchange = () => {
      this.imageFilterClass = classFilter.value || '';
      this.applyImageFilters();
    };
    const statusFilter = document.getElementById('sel-image-filter-status');
    if (statusFilter) statusFilter.onchange = () => {
      this.imageFilterStatus = statusFilter.value || 'all';
      this.applyImageFilters();
    };
    
    const btnAddCls = document.getElementById('btn-add-class-ws');
    if (btnAddCls) btnAddCls.onclick = () => this.showAddClassModal();

    // Canvas Tools (Pointer / Box / Clear / Fit)
    const btnToolPointer = document.getElementById('btn-tool-pointer');
    const btnToolManualBox = document.getElementById('btn-tool-manual-box');
    const btnToolManualPolygon = document.getElementById('btn-tool-manual-polygon');
    const btnToolBox = document.getElementById('btn-tool-box');
    const btnToolUndo = document.getElementById('btn-tool-undo');
    const btnToolRedo = document.getElementById('btn-tool-redo');
    const btnToolDeleteAnn = document.getElementById('btn-tool-delete-ann');
    const btnToolClear = document.getElementById('btn-tool-clear') || document.getElementById('btn-vtool-clear');
    const btnToolFit = document.getElementById('btn-tool-fit');

    if (btnToolPointer) btnToolPointer.onclick = () => this.setPromptMode('pointer');
    if (btnToolManualBox) btnToolManualBox.onclick = () => this.setPromptMode('manual-box');
    if (btnToolManualPolygon) btnToolManualPolygon.onclick = () => this.setPromptMode('manual-polygon');
    if (btnToolBox) btnToolBox.onclick = () => this.setPromptMode('box');
    if (btnToolUndo) btnToolUndo.onclick = () => this.undoAnnotationChange();
    if (btnToolRedo) btnToolRedo.onclick = () => this.redoAnnotationChange();
    if (btnToolDeleteAnn) btnToolDeleteAnn.onclick = () => {
      if (!this.focusedAnnotationId) return showToast('请先在编辑模式下选中一个标注', 'info');
      this.deleteAnnotation(this.focusedAnnotationId);
    };
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
    const chkAutosave = document.getElementById('chk-annotation-autosave');
    if (chkAutosave) chkAutosave.onchange = (e) => {
      this.annotationAutosaveEnabled = Boolean(e.target.checked);
      if (this.annotationAutosaveEnabled && this.annotationDirty) this.scheduleAnnotationAutosave('autosave-enabled');
      else this.setAnnotationSaveStatus(this.annotationDirty ? '未保存' : '已保存');
      this.scheduleProjectUIStateSave();
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
    let lastNavAt = 0;
    this._keyHandler = (e) => {
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      const now = performance.now();
      if (now - lastNavAt < 45) return;
      const key = String(e.key || '').toLowerCase();
      if (!e.ctrlKey && !e.metaKey && !e.altKey && key === 'v') {
        e.preventDefault();
        this.setPromptMode('pointer');
      } else if (!e.ctrlKey && !e.metaKey && !e.altKey && key === 'b') {
        e.preventDefault();
        this.setPromptMode('manual-box');
      } else if (!e.ctrlKey && !e.metaKey && !e.altKey && key === 'p') {
        e.preventDefault();
        this.setPromptMode('manual-polygon');
      } else if (!e.ctrlKey && !e.metaKey && !e.altKey && key === 's') {
        e.preventDefault();
        this.setPromptMode('box');
      } else if (!e.ctrlKey && !e.metaKey && !e.altKey && key === 'f') {
        e.preventDefault();
        if (this.viewer) this.viewer.fitToScreen();
      } else if (!e.ctrlKey && !e.metaKey && !e.altKey && /^[1-9]$/.test(key)) {
        e.preventDefault();
        this.selectClassByIndex(Number(key) - 1);
      } else if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key === 'Escape') {
        if (this.promptMode !== 'pointer') {
          e.preventDefault();
          this.setPromptMode('pointer');
        } else if (this.focusedAnnotationId) {
          e.preventDefault();
          this.clearAnnotationFocus();
        }
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
        e.preventDefault();
        lastNavAt = now;
        this.navigateImage(-1);
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
        e.preventDefault();
        lastNavAt = now;
        this.navigateImage(1);
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        this.saveCurrentAnns();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        this.undoAnnotationChange();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        this.redoAnnotationChange();
      } else if (e.key === 'Delete') {
        const activeImageItem = document.activeElement?.closest?.('.image-item');
        if (this.focusedAnnotationId) {
          e.preventDefault();
          this.deleteAnnotation(this.focusedAnnotationId);
        } else if (activeImageItem?.dataset?.id) {
          e.preventDefault();
          this.deleteProjectImage(activeImageItem.dataset.id, activeImageItem.dataset.rel);
        }
      } else if (e.key === 'Backspace') {
        if (this.focusedAnnotationId) {
          e.preventDefault();
          this.deleteAnnotation(this.focusedAnnotationId);
        }
      }
    };
    document.addEventListener('keydown', this._keyHandler);
  },

  navigateImage(delta) {
    this.imageNavigationController.navigate(delta);
  },

  toggleUnlabeledNavigation() {
    this.imageNavigationController.toggleUnlabeledNavigation();
  },

  refreshUnlabeledButton() {
    this.imageNavigationController.refreshUnlabeledButton();
  },

  async navigateUnlabeledImage(delta) {
    await this.imageNavigationController.navigateUnlabeled(delta);
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
    if (this.workspaceMode === 'review') {
      bar.style.display = 'none';
      if (btnAll) btnAll.style.display = 'none';
      return;
    }
    
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
      this.invalidateImageBundle(this.selectedImageId);
      await this.selectImage(this.selectedImageId, this.selectedImagePath); // Refresh annotations list
      
    } catch(e) {
      alert("Failed to save: " + e.message);
    }
  },

  renderImageFilterControls() {
    const classFilter = document.getElementById('sel-image-filter-class');
    const statusFilter = document.getElementById('sel-image-filter-status');
    if (classFilter) {
      const classes = this.projectMeta?.classes || [];
      const current = this.imageFilterClass || '';
      classFilter.innerHTML = [
        `<option value="">${i18n.t('filter_all_classes')}</option>`,
        ...classes.map((cls) => {
          const escaped = String(cls).replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
          return `<option value="${escaped}" ${current === cls ? 'selected' : ''}>${escaped}</option>`;
        })
      ].join('');
      if (current && !classes.includes(current)) {
        this.imageFilterClass = '';
        classFilter.value = '';
      }
    }
    if (statusFilter) statusFilter.value = this.imageFilterStatus || 'all';
  },

  renderClasses() {
    const list = document.getElementById('classes-list');
    const classes = this.projectMeta?.classes || [];
    this.renderImageFilterControls();
    
    if (!this.selectedClass) this.selectedClass = classes[0];
    renderClassPanel(list, classes, {
      selectedClass: this.selectedClass,
      annotations: this.annotations,
      emptyText: i18n.t('no_classes'),
      getClassColor: (className) => this.getClassColor(className),
    });
    bindClassPanelEvents(list, {
      onSelect: (className) => this.selectClass(className),
      onDelete: (className) => this.deleteClass(className),
    });
    
    this.syncReviewModeSummary();
    this.updateActionBar();
  },

  selectClass(cls) {
    this.selectedClass = cls;
    this.renderClasses();
    this.syncReviewModeSummary();
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

  getPromptModeLabel(mode = this.promptMode) {
    if (mode === 'manual-box') return '手动框';
    if (mode === 'manual-polygon') return '手动多边形';
    if (mode === 'box') return i18n.t('box_exemplar_tool');
    return '选择/编辑';
  },

  setPromptMode(mode) {
    if (mode === 'point') mode = 'pointer';
    if (this.workspaceMode === 'review' && mode === 'box') {
      mode = 'pointer';
    }
    this.promptMode = mode;
    document.querySelectorAll('[id^="btn-tool-"]').forEach(btn => btn.classList.remove('active'));
    const btn = document.getElementById(`btn-tool-${mode}`);
    if (btn) btn.classList.add('active');
    
    const canvasEl = document.getElementById('canvas-container');
    if (canvasEl) {
      canvasEl.style.cursor = mode === 'pan'
        ? 'grab'
        : (mode === 'box' || mode === 'manual-box' || mode === 'manual-polygon' ? 'crosshair' : 'default');
    }
    
    if (this.viewer) {
      this.viewer.setPromptMode(mode);
    }
    const imageStatus = document.getElementById('ws-image-status');
    if (imageStatus) {
      const modeText = this.getPromptModeLabel(mode);
      imageStatus.innerText = this.selectedImagePath ? `${this.selectedImagePath} | ${modeText}` : modeText;
    }
  },

  addPrompt(type, data) {
    if (type === 'point') return;
    this.currentPrompts.push({type, data, timestamp: new Date().getTime()});
    if (this.viewer) this.viewer.setPrompts(this.currentPrompts);
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
      this.invalidateImageBundle(this.selectedImageId);
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
      
      if (!this.hasImageFilter()) {
        this.totalImages = total;
        this.offset = this.sanitizeOffset(this.offset, total);
      }
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
    return this.imageNavigationController.loadImages();
  },

  async applyImageFilters() {
    await this.imageNavigationController.applyFilters();
  },

  updateSelectedImageListState() {
    this.imageNavigationController.updateSelectedImageListState();
  },

  setCanvasPlaceholder(visible, text = '') {
    const placeholder = document.getElementById('canvas-placeholder');
    const placeholderText = document.getElementById('canvas-placeholder-text');
    if (placeholderText) placeholderText.textContent = text || i18n.t('select_image_prompt');
    if (placeholder) placeholder.style.display = visible ? 'block' : 'none';
  },

  imageBundleKey(id) {
    return makeImageBundleKey(this.projectId, id);
  },

  touchImageBundleCache(key, bundle) {
    this.imageBundleCache = touchBundleCache(this.imageBundleCache, key, bundle, this.imageBundleCacheLimit);
  },

  getCachedImageBundle(id) {
    const key = this.imageBundleKey(id);
    const cached = getBundleFromCache(this.imageBundleCache, key);
    if (!cached) return null;
    this.touchImageBundleCache(key, cached);
    return cached;
  },

  storeImageBundle(id, relPath, imageInfo, annotations) {
    this.imageBundleCache = storeBundleInCache(
      this.imageBundleCache,
      this.imageBundleKey(id),
      id,
      relPath,
      imageInfo,
      annotations,
      this.imageBundleCacheLimit,
    );
  },

  invalidateImageBundle(id) {
    const key = this.imageBundleKey(id);
    invalidateBundleState(this.imageBundleCache, this.imageBundlePromises, key);
  },

  clearImageBundleCache() {
    clearBundleState(this.imageBundleCache, this.imageBundlePromises);
  },

  updateCurrentImageBundleAnnotations(annotations) {
    const cached = this.getCachedImageBundle(this.selectedImageId);
    if (!cached) return;
    this.storeImageBundle(this.selectedImageId, this.selectedImagePath || cached.relPath, cached.imageInfo, annotations);
  },

  async loadImageBundle(id, relPath, options = {}) {
    const cached = this.getCachedImageBundle(id);
    if (cached) return cached;

    const key = this.imageBundleKey(id);
    if (!this.imageBundlePromises) this.imageBundlePromises = new Map();
    const existing = this.imageBundlePromises.get(key);
    if (existing) return existing;

    const requestOptions = options.signal ? { signal: options.signal } : {};
    const promise = Promise.all([
      api.getImageTilesInfo(this.projectId, id, requestOptions),
      api.getAnnotations(this.projectId, id, requestOptions),
    ]).then(([imageInfo, annsRes]) => {
      const bundle = makeImageBundle(id, relPath, imageInfo, annsRes?.annotations);
      this.touchImageBundleCache(key, bundle);
      return bundle;
    });

    if (!options.signal) {
      this.imageBundlePromises.set(key, promise);
      const cleanup = () => {
        if (this.imageBundlePromises?.get(key) === promise) {
          this.imageBundlePromises.delete(key);
        }
      };
      promise.then(cleanup, cleanup);
    }

    return promise;
  },

  commitImageBundle(bundle) {
    if (!bundle || !this.viewer) return;
    this.annotationController.resetForImage(bundle.annotations);
    this.isImageLoading = false;
    this.viewer.setPrompts([]);
    this.viewer.setPreviews([]);
    this.viewer.setImageSource(bundle.imageInfo);
    this.viewer.setAnnotations(this.annotations);
    this.viewer.setFocusedAnnotation(null);
    this.setCanvasPlaceholder(false);
    const imageStatus = document.getElementById('ws-image-status');
    if (imageStatus) {
      const modeText = this.getPromptModeLabel();
      imageStatus.innerText = `${this.selectedImagePath || bundle.relPath || bundle.id} | ${modeText}`;
    }
    this.renderClasses();
    this.renderAnnotations();
    this.scheduleProjectUIStateSave();
  },

  prefetchAdjacentImages(anchorId = this.selectedImageId) {
    if (!anchorId || !Array.isArray(this.images) || this.images.length === 0) return;
    const anchorIndex = this.images.findIndex((img) => String(img.id) === String(anchorId));
    if (anchorIndex < 0) return;

    const queue = [];
    for (let step = 1; step <= this.imagePrefetchRadius; step += 1) {
      queue.push(anchorIndex + step, anchorIndex - step);
    }

    queue.forEach((index) => {
      const img = this.images[index];
      if (!img?.id) return;
      const key = this.imageBundleKey(img.id);
      if (this.imageBundleCache?.has(key) || this.imageBundlePromises?.has(key)) return;
      this.loadImageBundle(img.id, img.rel_path).catch(() => {});
    });
  },

  async selectImage(id, relPath, options = {}) {
    this.annotationController.clearSaveTimer();
    if (this.annotationDirty) {
      await this.flushAnnotationAutosave('before-switch');
      if (this.annotationDirty) {
        showToast('当前图片标注尚未保存，保存成功后再切换图片', 'error');
        return;
      }
    }

    const requestSeq = ++this.imageLoadSeq;
    if (this.imageLoadAbortController) {
      this.imageLoadAbortController.abort();
    }
    const abortController = new AbortController();
    this.imageLoadAbortController = abortController;
    this.selectedImageId = id;
    this.selectedImagePath = relPath;
    this.currentPrompts = [];
    this.previews = [];
    this.annotationController.resetEmptySelection();
    const cachedBundle = this.getCachedImageBundle(id);
    this.isImageLoading = !cachedBundle;
    
    if (this.viewer) {
      this.viewer.setPrompts([]);
      this.viewer.setPreviews([]);
      this.viewer.setFocusedAnnotation(null);
      if (!cachedBundle) {
        this.viewer.clearImage();
        this.viewer.setAnnotations([]);
      }
    }
    
    this.renderPreviews();
    this.updateActionBar();
    this.updateSelectedImageListState();

    if (cachedBundle) {
      this.commitImageBundle(cachedBundle);
      if (this.imageLoadAbortController === abortController) {
        this.imageLoadAbortController = null;
      }
      this.prefetchAdjacentImages(id);
      return;
    }

    this.renderAnnotations();
    
    this.setCanvasPlaceholder(true, i18n.t('loading_image_annotations'));
    const imageStatus = document.getElementById('ws-image-status');
    if (imageStatus) {
      const modeText = this.getPromptModeLabel();
      imageStatus.innerText = `${relPath || id} | ${modeText} | ${i18n.t('loading_image_annotations')}`;
    }
    
    try {
      const bundle = await this.loadImageBundle(id, relPath, { signal: abortController.signal });
      if (this.isUnmounted || requestSeq !== this.imageLoadSeq || String(this.selectedImageId) !== String(id)) return;
      if (!bundle?.imageInfo) return;
      this.commitImageBundle(bundle);
      if (this.imageLoadAbortController === abortController) {
        this.imageLoadAbortController = null;
      }
      this.prefetchAdjacentImages(id);
      
    } catch(e) {
      if (e && e.name === 'AbortError') return;
      if (this.isUnmounted || requestSeq !== this.imageLoadSeq || String(this.selectedImageId) !== String(id)) return;
      this.isImageLoading = false;
      this.setCanvasPlaceholder(true, i18n.t('image_load_failed'));
      this.renderAnnotations();
      console.error("Failed to load image/annotations:", e);
    }
  },

  async runSingleInfer() {
    if (!this.selectedImageId) return showToast("Select an image first", "error");
    if (this.annotationDirty) {
      await this.flushAnnotationAutosave('before-infer');
      if (this.annotationDirty) return showToast('当前图片标注尚未保存，保存成功后再推理', 'error');
    }
    
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
      this.invalidateImageBundle(this.selectedImageId);
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
    if (!this.selectedImageId) return showToast(i18n.t('select_image_first'), "error");
    
    const boxes = this.currentPrompts
      .filter(p => p.type === 'box')
      .map(p => p.data);
    const btn = document.getElementById('btn-example-segment');
    if (boxes.length === 0) {
      this.setPromptMode('box');
      return showToast(i18n.t('box_exemplar_mode_hint'), "info");
    }
    if (!this.selectedClass) return showToast(i18n.t('select_class_first'), "error");

    try {
      btn.disabled = true;
      btn.innerText = i18n.t('finding_similar');
      
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
      showToast(i18n.t('found_matches', { count: this.previews.length }), "info");
    } catch(e) {
      showToast(e.message, "error");
    } finally {
      btn.disabled = false;
      btn.innerText = i18n.t('example_segment');
    }
  },

  async startBatchTask() {
    const classes = this.getSelectedClassesForInference();
    if (classes.length === 0) return showToast("Select at least one class for text inference", "error");

    const payload = {
      project_id: this.projectId,
      threshold: store.state.config.threshold,
      batch_size: store.state.config.batchSize,
      api_base_url: store.state.config.sam3ApiUrl
    };

    const batchConfig = await this.openBatchConfigModal(classes);
    if (!batchConfig) return;
    payload.classes = classes;
    payload.scope_mode = batchConfig.scope_mode;
    payload.related_classes = batchConfig.related_classes || [];
    payload.image_ids = batchConfig.image_ids || [];
    payload.retry_image_ids = batchConfig.retry_image_ids || [];
    payload.all_images = batchConfig.scope_mode === 'all' && payload.image_ids.length === 0 && payload.retry_image_ids.length === 0;

    try {
      const res = await api.startBatchInfer(payload);
        
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
          if (job.status === 'done') {
            this.clearImageBundleCache();
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
    renderAnnotationList(list, this.annotations, {
      focusedAnnotationId: this.focusedAnnotationId,
      isLoading: this.isImageLoading,
      loadingText: i18n.t('loading_image_annotations'),
      emptyText: '无标注数据',
      getClassColor: (className) => this.getClassColor(className),
    });
    bindAnnotationListEvents(list, {
      onFocus: (annId) => this.toggleAnnotationFocus(annId),
      onEditClass: (annId) => this.editAnnotationClass(annId),
      onDelete: (annId) => this.deleteAnnotation(annId),
    });
  },

  updateAnnotationFocusListState() {
    updateAnnotationListFocus(document.getElementById('annotation-list-container'), this.focusedAnnotationId);
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
    if (this.viewer) {
      const ann = nextId
        ? (this.annotations || []).find((item) => String(item?.id || '') === String(nextId))
        : null;
      const bbox = ann?.bbox || ann?.box || null;
      if (typeof this.viewer.focusAnnotation === 'function') {
        this.viewer.focusAnnotation(nextId, bbox);
      } else {
        this.viewer.setFocusedAnnotation(nextId);
        if (nextId && bbox) this.viewer.centerOn(bbox);
      }
    }
    this.updateAnnotationFocusListState();
    this.updateAnnotationSelectionControls();
    this.scheduleProjectUIStateSave();
  },

  clearAnnotationFocus() {
    this.focusedAnnotationId = null;
    if (this.viewer && typeof this.viewer.focusAnnotation === 'function') {
      this.viewer.focusAnnotation(null, null);
    } else if (this.viewer) {
      this.viewer.setFocusedAnnotation(null);
    }
    this.updateAnnotationFocusListState();
    this.updateAnnotationSelectionControls();
    this.scheduleProjectUIStateSave();
  },

  cloneAnnotations(annotations = this.annotations) {
    return this.annotationController.cloneAnnotations(annotations);
  },

  updateUndoRedoButtons() {
    const undoBtn = document.getElementById('btn-tool-undo');
    const redoBtn = document.getElementById('btn-tool-redo');
    if (undoBtn) undoBtn.disabled = !(this.annotationHistory && this.annotationHistory.length > 0);
    if (redoBtn) redoBtn.disabled = !(this.annotationRedoStack && this.annotationRedoStack.length > 0);
  },

  updateAnnotationSelectionControls() {
    const deleteBtn = document.getElementById('btn-tool-delete-ann');
    if (deleteBtn) {
      deleteBtn.disabled = !this.focusedAnnotationId;
      deleteBtn.style.opacity = this.focusedAnnotationId ? '1' : '0.45';
    }
    const reviewDeleteBtn = document.getElementById('btn-review-delete-ann');
    if (reviewDeleteBtn) {
      reviewDeleteBtn.disabled = !this.focusedAnnotationId;
      reviewDeleteBtn.style.opacity = this.focusedAnnotationId ? '1' : '0.45';
    }
    const reviewApplyBtn = document.getElementById('btn-review-apply-class');
    if (reviewApplyBtn) {
      reviewApplyBtn.disabled = !this.focusedAnnotationId;
      reviewApplyBtn.style.opacity = this.focusedAnnotationId ? '1' : '0.45';
    }
  },

  pushAnnotationHistory() {
    this.annotationController.pushHistory();
  },

  restoreAnnotationSnapshot(snapshot) {
    this.annotationController.restoreSnapshot(snapshot);
  },

  undoAnnotationChange() {
    this.annotationController.undo();
  },

  redoAnnotationChange() {
    this.annotationController.redo();
  },

  setAnnotationSaveStatus(text, tone = 'muted') {
    const el = document.getElementById('annotation-save-status');
    if (!el) return;
    el.textContent = text;
    el.style.color = tone === 'error'
      ? '#ef4444'
      : (tone === 'active' ? 'var(--neu-text-active)' : 'var(--neu-text-light)');
  },

  markManualAnnotation(ann) {
    return this.annotationController.markManualAnnotation(ann);
  },

  selectedOrDefaultClass() {
    return String(this.selectedClass || this.projectMeta?.classes?.[0] || 'object').trim() || 'object';
  },

  createManualAnnotation(shape) {
    const previousMode = this.promptMode;
    this.annotationController.createAnnotation(shape, this.selectedOrDefaultClass());
    if (
      this.workspaceMode === 'review'
      && this.reviewContinuousMode
      && (previousMode === 'manual-box' || previousMode === 'manual-polygon')
    ) {
      setTimeout(() => this.setPromptMode(previousMode), 0);
    }
  },

  selectAnnotationFromCanvas(annId) {
    this.annotationController.selectFromCanvas(annId);
  },

  handleManualAnnotationUpdated(ann) {
    this.annotationController.handleGeometryUpdated(ann);
  },

  markSelectedImageLabeledState(labeled) {
    const img = (this.images || []).find((item) => String(item.id) === String(this.selectedImageId));
    const wasLabeled = Boolean(img && (img.status === 'labeled' || img.labeled));
    if (img) {
      img.status = labeled ? 'labeled' : 'unlabeled';
      img.labeled = Boolean(labeled);
    }
    if (this.projectMeta && wasLabeled !== Boolean(labeled)) {
      const total = Number(this.projectMeta.num_images || 0);
      const current = Number(this.projectMeta.labeled_images || 0);
      this.projectMeta.labeled_images = Math.max(0, Math.min(total, current + (labeled ? 1 : -1)));
      this.projectMeta.unlabeled_images = Math.max(0, total - Number(this.projectMeta.labeled_images || 0));
      const progress = total > 0 ? (Number(this.projectMeta.labeled_images || 0) / total) * 100 : 0;
      const progressBar = document.getElementById('ws-progress-bar');
      const progressText = document.getElementById('ws-progress-text');
      const metaLabeled = document.getElementById('ws-meta-labeled');
      if (progressBar) progressBar.style.width = `${progress}%`;
      if (progressText) progressText.innerText = `${this.projectMeta.labeled_images || 0} / ${total}`;
      if (metaLabeled) metaLabeled.innerText = this.projectMeta.labeled_images || 0;
    }
    setImageListItemLabeledState(this.selectedImageId, labeled);
  },

  markAnnotationsDirty(reason = '') {
    this.annotationController.markDirty(reason);
  },

  scheduleAnnotationAutosave(reason = '') {
    this.annotationController.scheduleAutosave(reason);
  },

  async ensureAnnotationClasses(annotations) {
    if (!this.projectMeta) return;
    if (!Array.isArray(this.projectMeta.classes)) this.projectMeta.classes = [];
    const current = new Set((this.projectMeta?.classes || []).map((cls) => String(cls || '').trim()).filter(Boolean));
    const needed = Array.from(new Set((annotations || [])
      .map((ann) => String(ann?.class_name || ann?.label || '').trim())
      .filter((cls) => cls && !current.has(cls))));
    if (needed.length === 0) return;
    await api.addClass(this.projectId, needed.join('\n'));
    this.projectMeta.classes = Array.from(new Set([...(this.projectMeta.classes || []), ...needed]));
  },

  async saveAnnotationsToServer(imageId, annotations) {
    return api.saveAnnotations(this.projectId, imageId, annotations);
  },

  async addProjectClasses(classesText) {
    return api.addClass(this.projectId, classesText);
  },

  async flushAnnotationAutosave(reason = '') {
    return this.annotationController.flushSave(reason);
  },

  getSelectedClassesForInference() {
    const checked = [];
    document.querySelectorAll('.cls-chk-infer[type="checkbox"]:checked').forEach(chk => {
       checked.push(chk.dataset.cls);
    });
    return checked;
  },

  async saveCurrentAnns() {
    try {
      const saved = await this.annotationController.saveCurrent();
      if (saved) showToast(i18n.t('save_success'), "success");
    } catch(e) { showToast(e.message, "error"); }
  },

  async clearCurrentAnns() {
    if (!this.selectedImageId) return;
    if (!confirm("Clear all annotations on this image?")) return;
    try {
      this.annotationController.clearAnnotations();
    } catch(e) { showToast(e.message, "error"); }
  },
  
  async deleteAnnotation(annId) {
    try {
      this.annotationController.deleteAnnotation(annId);
    } catch(e) { showToast(e.message, "error"); }
  },

  async deleteProjectImage(imageId, relPath = '') {
    await this.imageNavigationController.deleteProjectImage(imageId, relPath);
  },

  editAnnotationClass(annId) {
    const ann = (this.annotations || []).find((item) => String(item?.id || '') === String(annId || ''));
    if (!ann) return showToast('未找到该标注', 'error');

    const existing = document.getElementById('modal-edit-ann-class');
    if (existing) existing.remove();

    const currentClass = String(ann.class_name || '').trim();
    const classes = Array.from(new Set([
      currentClass,
      ...(this.projectMeta?.classes || []).map((cls) => String(cls || '').trim()),
    ].filter(Boolean)));
    const options = classes.map((cls) => `
      <option value="${escapeAttr(cls)}" ${cls === currentClass ? 'selected' : ''}>${escapeHtml(cls)}</option>
    `).join('');

    const modal = document.createElement('div');
    modal.id = 'modal-edit-ann-class';
    modal.className = 'modal-overlay';
    modal.style.cssText = 'position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; z-index: 9999; background: rgba(0,0,0,0.3); backdrop-filter: blur(4px);';
    modal.innerHTML = `
      <div class="neu-card" style="width: 420px; max-width: calc(100vw - 40px); padding: 28px; border-radius: 20px; position: relative;">
        <button class="neu-button" id="btn-close-edit-ann-class" style="position: absolute; top: 15px; right: 15px; width: 30px; height: 30px; padding: 0; border-radius: 50%; font-size: 16px; color: #ef4444;">&times;</button>
        <h3 style="margin: 0 0 8px 0; font-size: 16px;">修改标注类别</h3>
        <div style="font-size: 12px; color: var(--neu-text-light); line-height: 1.7; margin-bottom: 18px;">
          当前类别：<b style="color: var(--neu-text);">${escapeHtml(currentClass || '--')}</b>
        </div>
        <label style="display: block; font-size: 12px; font-weight: 700; color: var(--neu-text-light); margin-bottom: 8px;">选择已有类别</label>
        <select id="sel-edit-ann-class" class="neu-input" style="width: 100%; height: 38px; font-size: 13px; margin-bottom: 14px;">
          ${options}
        </select>
        <label style="display: block; font-size: 12px; font-weight: 700; color: var(--neu-text-light); margin-bottom: 8px;">或输入新类别</label>
        <input id="inp-edit-ann-class" class="neu-input" type="text" placeholder="留空则使用上面的已有类别" style="width: 100%; height: 38px; font-size: 13px;" />
        <div style="display: flex; justify-content: flex-end; gap: 10px; margin-top: 18px;">
          <button class="neu-button" style="padding: 10px 20px;" id="btn-cancel-edit-ann-class">取消</button>
          <button class="neu-button" style="padding: 10px 20px; color: var(--neu-text-active); font-weight: 700;" id="btn-confirm-edit-ann-class">保存</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    const closeModal = () => modal.remove();
    const classSelect = document.getElementById('sel-edit-ann-class');
    const classInput = document.getElementById('inp-edit-ann-class');
    const confirmBtn = document.getElementById('btn-confirm-edit-ann-class');
    const confirmChange = async () => {
      const nextClass = String(classInput?.value || '').trim() || String(classSelect?.value || '').trim();
      if (!nextClass) return showToast('请选择或输入类别名称', 'error');
      try {
        if (confirmBtn) {
          confirmBtn.disabled = true;
          confirmBtn.innerText = '保存中...';
        }
        const updated = await this.updateAnnotationClass(annId, nextClass);
        if (updated) closeModal();
      } finally {
        if (confirmBtn) {
          confirmBtn.disabled = false;
          confirmBtn.innerText = '保存';
        }
      }
    };

    document.getElementById('btn-close-edit-ann-class').onclick = closeModal;
    document.getElementById('btn-cancel-edit-ann-class').onclick = closeModal;
    if (confirmBtn) confirmBtn.onclick = confirmChange;
    if (classInput) {
      classInput.focus();
      classInput.onkeydown = (e) => {
        if (e.key === 'Enter') confirmChange();
        if (e.key === 'Escape') closeModal();
      };
    }
    if (classSelect) {
      classSelect.onkeydown = (e) => {
        if (e.key === 'Enter') confirmChange();
        if (e.key === 'Escape') closeModal();
      };
    }
  },

  async updateAnnotationClass(annId, nextClass) {
    const updated = await this.annotationController.updateClass(annId, nextClass);
    if (updated) {
      this.renderClasses();
      this.syncReviewModeSummary();
    }
    return updated;
  },

  async openDataDashboard() {
    await this.dataDashboardController.open();
  },

  openSmartFilter() {
    this.smartFilterController.open();
  },

  openExport() {
    this.exportController.open();
  }
};
