import { api } from '../api.js';
import {
  bindAnnotationListEvents,
  renderAnnotationList,
  updateAnnotationListFocus,
} from '../components/annotation-list.js';
import { openAnnotationClassModal } from '../components/annotation-class-modal.js';
import { bindImageListEvents, setImageListItemLabeledState } from '../components/image-list.js';
import { ImageViewerV2 } from '../components/image-viewer-v2.js';
import { renderWorkspaceToolbar } from '../components/workspace-toolbar.js';
import { i18n } from '../i18n.js';
import { AnnotationController } from '../modules/image-workspace/annotation-controller.js';
import { AutoConfigController } from '../modules/image-workspace/auto-config-controller.js';
import { ClassController } from '../modules/image-workspace/class-controller.js';
import { DataDashboardController } from '../modules/image-workspace/data-dashboard-controller.js';
import { ExportController } from '../modules/image-workspace/export-controller.js';
import { GpuStatusController } from '../modules/image-workspace/gpu-status-controller.js';
import { ImageNavigationController } from '../modules/image-workspace/image-navigation-controller.js';
import { InferenceController } from '../modules/image-workspace/inference-controller.js';
import { KeyboardCommandManager } from '../modules/image-workspace/keyboard-command-manager.js';
import { LayoutController } from '../modules/image-workspace/layout-controller.js';
import { PreviewController } from '../modules/image-workspace/preview-controller.js';
import { ReviewController } from '../modules/image-workspace/review-controller.js';
import { SmartFilterController } from '../modules/image-workspace/smart-filter-controller.js';
import {
  clearBundleState,
  bundleSatisfies,
  getBundleFromCache,
  invalidateBundleState,
  makeImageBundleKey,
  storeBundleInCache,
  touchBundleCache,
} from '../modules/image-workspace/workspace-state.js';
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
  annotationController: null,
  autoConfigController: null,
  classController: null,
  dataDashboardController: null,
  exportController: null,
  gpuStatusController: null,
  imageNavigationController: null,
  inferenceController: null,
  keyboardCommandManager: null,
  layoutController: null,
  previewController: null,
  reviewController: null,
  smartFilterController: null,
  isUnmounted: false,
  promptMode: 'pointer',
  boxPromptLabel: 1,
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
  lowTilePrefetchKeys: null,
  imageBundleCacheLimit: 20,
  imagePrefetchRadius: 10,
  tileStatusPollTimer: null,
  uiStateSaveTimer: null,
  activeJobId: '',
  isPolling: false,
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
  routeWorkspaceMode: 'auto',
  reviewContinuousMode: true,
  annotationSourceFilter: null,
  
  async render(container, params) {
    this.container = container;
    this.projectId = params.id;
    this.routeWorkspaceMode = params.workspaceMode === 'review' ? 'review' : 'auto';
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
    this.boxPromptLabel = 1;
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
    this.lowTilePrefetchKeys = new Set();
    this.tileStatusPollTimer = null;
    this.activeJobId = '';
    this.isPolling = false;
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
    this.annotationSourceFilter = new Set(['sam3', 'locate-anything', 'manual']);
    this.annotationController = new AnnotationController(this);
    this.autoConfigController = new AutoConfigController(this);
    this.classController = new ClassController(this);
    this.dataDashboardController = new DataDashboardController(this);
    this.exportController = new ExportController(this);
    this.gpuStatusController = new GpuStatusController(this);
    this.imageNavigationController = new ImageNavigationController(this);
    this.inferenceController = new InferenceController(this);
    this.keyboardCommandManager = new KeyboardCommandManager(this);
    this.layoutController = new LayoutController(this);
    this.previewController = new PreviewController(this);
    this.reviewController = new ReviewController(this);
    this.smartFilterController = new SmartFilterController(this);
    window.currentWorkspace = this;
    
    container.innerHTML = `
      <div class="workspace-layout" style="display: flex; height: 100%; flex-direction: column; background: var(--neu-bg); overflow: hidden; min-height: 0; min-width: 0; box-sizing: border-box;">
        <!-- 1. Top Navigation Bar -->
        <div class="neu-box" style="height: 56px; flex-shrink: 0; display: flex; align-items: center; padding: 0 24px; z-index: 100; border-radius: 0; gap: 20px; border-bottom: 1px solid rgba(0,0,0,0.05); box-sizing: border-box; position: relative;">
          <div id="ws-back-dashboard" role="button" tabindex="0" style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
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
             <button id="btn-dashboard-nav" class="neu-button" style="padding: 6px 14px; font-size: 12px; font-weight: 600;">${i18n.t('dashboard')}</button>
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
            <button id="btn-task-cancel" class="neu-button" style="height: 28px; padding: 0 12px; font-size: 10px; font-weight: 700; color: #ef4444; display: none;">${i18n.t('cancel_task')}</button>
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
                      <button class="neu-button" id="btn-tool-box-positive" title="S：${i18n.t('positive_box_tool')}" style="height: 40px; padding: 0 10px; border-radius: 20px; color: #16a34a; font-weight: 800;">+框</button>
                      <button class="neu-button" id="btn-tool-box-negative" title="${i18n.t('negative_box_tool')}" style="height: 40px; padding: 0 10px; border-radius: 20px; color: #dc2626; font-weight: 800;">−框</button>
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
                   <div style="display: flex; gap: 6px;">
                     <button id="btn-migrate-sources" class="neu-button" style="height: 26px; padding: 0 10px; font-size: 10px; font-weight: 600;" title="${i18n.t('migrate_sources')}">${i18n.t('migrate_sources')}</button>
                     <button id="btn-collapse-anns" class="neu-button" style="width: 28px; height: 28px; padding: 0; border-radius: 50%; font-size: 12px;" title="折叠/展开">−</button>
                   </div>
                </div>
                <div id="source-filter-bar" style="padding: 6px 20px; display: flex; gap: 6px; border-bottom: 1px solid rgba(0,0,0,0.03);">
                  <button class="neu-button source-chip" data-source="sam3" style="height: 22px; padding: 0 8px; font-size: 10px; border-radius: 11px;">sam3</button>
                  <button class="neu-button source-chip" data-source="locate-anything" style="height: 22px; padding: 0 8px; font-size: 10px; border-radius: 11px;">LA</button>
                  <button class="neu-button source-chip" data-source="manual" style="height: 22px; padding: 0 8px; font-size: 10px; border-radius: 11px;">${i18n.t('source_manual')}</button>
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
      <div id="modal-both-loaded" class="modal-overlay" style="display: none;"></div>
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
    this.workspaceMode = this.routeWorkspaceMode;
    this.syncWorkspaceModeUI();
    this.renderImageFilterControls();
    this.applyLayoutState();
    await this.loadImages();
    await this.restoreSelectedImage();
    this.startHealthCheck();
    this.startGpuStatusPolling();
  },

  initializeLayoutControls() {
    this.layoutController.initialize();
  },

  applyLayoutState() {
    this.layoutController.applyState();
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
    if (this.gpuStatusController) this.gpuStatusController.stop();
    if (this.smartFilterController) this.smartFilterController.clearTimer();
    if (this.uiStateSaveTimer) {
      clearTimeout(this.uiStateSaveTimer);
      this.uiStateSaveTimer = null;
    }
    if (this.annotationController) this.annotationController.clearSaveTimer();
    if (this.keyboardCommandManager) this.keyboardCommandManager.detach();
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

  async setWorkspaceMode(mode) {
    const nextMode = mode === 'review' ? 'review' : 'auto';
    if (this.projectId && this.routeWorkspaceMode !== nextMode) {
      await this.navigateWorkspaceRoute(nextMode);
      return;
    }
    this.reviewController.setWorkspaceMode(nextMode);
  },

  async navigateWorkspaceRoute(mode) {
    const nextMode = mode === 'review' ? 'review' : 'auto';
    if (!this.commitPendingManualPolygon()) return;
    if (this.annotationDirty) {
      await this.flushAnnotationAutosave('workspace-mode-route-switch');
      if (this.annotationDirty) {
        showToast('当前图片标注尚未保存，保存成功后再切换工作台', 'error');
        return;
      }
    }
    window.location.hash = `/project/image/${encodeURIComponent(this.projectId)}/${nextMode}`;
  },

  setModeElementVisibility(selector, visible) {
    this.reviewController.setModeElementVisibility(selector, visible);
  },

  syncWorkspaceModeUI() {
    this.reviewController.syncWorkspaceModeUI();
  },

  syncReviewModeSummary() {
    this.reviewController.syncReviewModeSummary();
  },

  toggleReviewContinuousMode() {
    this.reviewController.toggleContinuousMode();
  },

  async saveAndNavigate(delta = 1) {
    await this.reviewController.saveAndNavigate(delta);
  },

  selectClassByIndex(index) {
    this.reviewController.selectClassByIndex(index);
  },

  async applySelectedClassToFocusedAnnotation() {
    await this.reviewController.applySelectedClassToFocusedAnnotation();
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
    return this.gpuStatusController.formatMemory(mb);
  },

  setGpuWidgetUnavailable(message = 'GPU unavailable') {
    this.gpuStatusController.setUnavailable(message);
  },

  markGpuWidgetStale(message = 'GPU status refresh delayed') {
    this.gpuStatusController.markStale(message);
  },

  renderGpuWidget(status) {
    this.gpuStatusController.render(status);
  },

  startGpuStatusPolling() {
    this.gpuStatusController.start();
  },

  bindEvents() {
    const goToDashboard = () => {
      window.location.hash = '/';
    };
    const backDashboard = document.getElementById('ws-back-dashboard');
    const btnDashboardNav = document.getElementById('btn-dashboard-nav');
    if (backDashboard) {
      backDashboard.onclick = goToDashboard;
      backDashboard.onkeydown = (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          goToDashboard();
        }
      };
    }
    if (btnDashboardNav) btnDashboardNav.onclick = goToDashboard;

    this.autoConfigController.bind();

    const btnWorkspaceAuto = document.getElementById('btn-workspace-mode-auto');
    const btnWorkspaceReview = document.getElementById('btn-workspace-mode-review');
    if (btnWorkspaceAuto) btnWorkspaceAuto.onclick = () => this.setWorkspaceMode('auto');
    if (btnWorkspaceReview) btnWorkspaceReview.onclick = () => this.setWorkspaceMode('review');

    this.reviewController.bind();

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

    const btnCancel = document.getElementById('btn-task-cancel');
    if (btnCancel) btnCancel.onclick = () => this.cancelActiveTask();

    // Source Filter Chips (single-select)
    document.querySelectorAll('.source-chip').forEach(chip => {
      chip.onclick = () => {
        const src = chip.dataset.source;
        this.annotationSourceFilter = new Set([src]);
        this.updateSourceChipStyles();
        this.renderAnnotations();
        if (this.viewer) this.viewer.setAnnotations(this.visibleAnnotations());
        this.scheduleProjectUIStateSave();
      };
    });
    this.updateSourceChipStyles();

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
    const btnToolBoxPositive = document.getElementById('btn-tool-box-positive');
    const btnToolBoxNegative = document.getElementById('btn-tool-box-negative');
    const btnToolUndo = document.getElementById('btn-tool-undo');
    const btnToolRedo = document.getElementById('btn-tool-redo');
    const btnToolDeleteAnn = document.getElementById('btn-tool-delete-ann');
    const btnToolClear = document.getElementById('btn-tool-clear') || document.getElementById('btn-vtool-clear');
    const btnToolFit = document.getElementById('btn-tool-fit');

    if (btnToolPointer) btnToolPointer.onclick = () => this.setPromptMode('pointer');
    if (btnToolManualBox) btnToolManualBox.onclick = () => this.setPromptMode('manual-box');
    if (btnToolManualPolygon) btnToolManualPolygon.onclick = () => this.setPromptMode('manual-polygon');
    if (btnToolBoxPositive) btnToolBoxPositive.onclick = () => this.setBoxPromptLabel(1);
    if (btnToolBoxNegative) btnToolBoxNegative.onclick = () => this.setBoxPromptLabel(0);
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

    // Migrate annotation sources (tag legacy annotations)
    const btnMigrateSources = document.getElementById('btn-migrate-sources');
    if (btnMigrateSources) btnMigrateSources.onclick = () => this.migrateAnnotationSources();

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
    this.previewController.bindListEvents();

    // Theme Toggle
    const btnTheme = document.getElementById('btn-toggle-theme');
    if (btnTheme) btnTheme.onclick = () => {
      const next = store.state.config.theme === 'dark' ? 'light' : 'dark';
      store.setConfig('theme', next);
      const icon = document.getElementById('theme-icon');
      if (icon) icon.innerText = next === 'dark' ? '☀️' : '🌓';
    };

    this.keyboardCommandManager.bind();
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
    this.layoutController.toggleSidePanel(side);
  },

  toggleSection(section) {
    this.layoutController.toggleSection(section);
  },

  selectAllPreviews() {
    return this.previewController.selectAll();
  },

  updateActionBar() {
    this.previewController.updateActionBar();
  },

  async keepAllPreviews() {
    await this.previewController.keepAll();
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
    this.classController.render();
  },

  selectClass(cls) {
    this.classController.select(cls);
  },

  async deleteClass(className) {
    await this.classController.delete(className);
  },

  showAddClassModal() {
    this.classController.showAddModal();
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
    if (mode === 'box') return this.boxPromptLabel === 0 ? i18n.t('negative_box_tool') : i18n.t('positive_box_tool');
    return '选择/编辑';
  },

  setPromptMode(mode) {
    if (mode === 'point') mode = 'pointer';
    if (this.workspaceMode === 'review' && mode === 'box') {
      mode = 'pointer';
    }
    this.promptMode = mode;
    document.querySelectorAll('[id^="btn-tool-"]').forEach(btn => btn.classList.remove('active'));
    const activeToolId = mode === 'box'
      ? (this.boxPromptLabel === 0 ? 'btn-tool-box-negative' : 'btn-tool-box-positive')
      : `btn-tool-${mode}`;
    const btn = document.getElementById(activeToolId);
    if (btn) btn.classList.add('active');
    
    const canvasEl = document.getElementById('canvas-container');
    if (canvasEl) {
      canvasEl.style.cursor = mode === 'pan'
        ? 'grab'
        : (mode === 'box' || mode === 'manual-box' || mode === 'manual-polygon' ? 'crosshair' : 'default');
    }
    
    if (this.viewer) {
      this.viewer.setPromptMode(mode);
      this.viewer.setBoxPromptLabel(this.boxPromptLabel);
    }
    const imageStatus = document.getElementById('ws-image-status');
    if (imageStatus) {
      const modeText = this.getPromptModeLabel(mode);
      imageStatus.innerText = this.selectedImagePath ? `${this.selectedImagePath} | ${modeText}` : modeText;
    }
  },

  setBoxPromptLabel(label) {
    this.boxPromptLabel = Number(label) === 0 ? 0 : 1;
    this.setPromptMode('box');
  },

  addPrompt(type, data) {
    if (type === 'point') return;
    const promptData = type === 'box'
      ? [...data.slice(0, 4), data.length >= 5 ? (Number(data[4]) === 0 ? 0 : 1) : this.boxPromptLabel]
      : data;
    this.currentPrompts.push({type, data: promptData, timestamp: new Date().getTime()});
    if (this.viewer) this.viewer.setPrompts(this.currentPrompts);
  },

  renderPreviews() {
    this.previewController.render();
  },

  bindPreviewListEvents() {
    this.previewController.bindListEvents();
  },

  removePreview(id) {
    this.previewController.remove(id);
  },

  async keepSinglePreview(id) {
    await this.previewController.keepSingle(id);
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

  storeImageBundle(id, relPath, imageInfo, annotations, previewInfo = null, flags = {}) {
    this.imageBundleCache = storeBundleInCache(
      this.imageBundleCache,
      this.imageBundleKey(id),
      id,
      relPath,
      imageInfo,
      annotations,
      previewInfo,
      flags,
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
    this.storeImageBundle(
      this.selectedImageId,
      this.selectedImagePath || cached.relPath,
      cached.imageInfo,
      annotations,
      cached.previewInfo,
      {
        annotationsLoaded: true,
        previewLoaded: Boolean(cached.previewLoaded),
        tileInfoLoaded: Boolean(cached.tileInfoLoaded),
      },
    );
  },

  async loadImageBundle(id, relPath, options = {}) {
    const cached = this.getCachedImageBundle(id);
    const requirements = {
      annotations: options.includeAnnotations !== false,
      preview: options.includePreview !== false,
    };
    if (bundleSatisfies(cached, requirements)) return cached;

    const key = this.imageBundleKey(id);
    const promiseKey = [
      key,
      requirements.annotations ? 'ann' : 'noann',
      requirements.preview ? 'preview' : 'nopreview',
    ].join(':');
    if (!this.imageBundlePromises) this.imageBundlePromises = new Map();
    const existing = this.imageBundlePromises.get(promiseKey);
    if (existing) return existing;

    const requestOptions = options.signal ? { signal: options.signal } : {};
    const needAnn = requirements.annotations && !cached?.annotationsLoaded;
    const needPreview = requirements.preview && !cached?.previewLoaded;
    const promise = api.getImageBundle(this.projectId, id, requestOptions, {
      includeAnnotations: needAnn,
      includePreview: needPreview,
      includeTileInfo: false,
    }).then(res => {
      this.storeImageBundle(
        id,
        relPath,
        cached?.imageInfo || null,
        needAnn ? (res?.annotations ?? cached?.annotations ?? []) : (cached?.annotations || []),
        res?.preview_info || cached?.previewInfo || null,
        {
          annotationsLoaded: Boolean(requirements.annotations || cached?.annotationsLoaded),
          previewLoaded: Boolean(requirements.preview || cached?.previewLoaded),
        },
      );
      const bundle = this.getCachedImageBundle(id);
      if (bundle?.previewInfo) this.warmPreviewImage(bundle.previewInfo);
      return bundle;
    });

    if (!options.signal) {
      this.imageBundlePromises.set(promiseKey, promise);
      const cleanup = () => {
        if (this.imageBundlePromises?.get(promiseKey) === promise) {
          this.imageBundlePromises.delete(promiseKey);
        }
      };
      promise.then(cleanup, cleanup);
    }

    return promise;
  },

  warmPreviewImage(previewInfo) {
    const url = previewInfo?.preview_url || previewInfo?.thumbnail_url || '';
    if (!url || typeof Image === 'undefined') return;
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
  },

  commitImageBundle(bundle) {
    if (!bundle || !this.viewer) return;
    this.annotationController.resetForImage(bundle.annotations);
    this.isImageLoading = false;
    this.viewer.setPrompts([]);
    this.viewer.setPreviews([]);
    const previewShown = this.viewer.setPreviewSource?.(bundle.previewInfo) || false;
    this.viewer.setAnnotations(this.visibleAnnotations());
    this.viewer.setFocusedAnnotation(null);
    this.setCanvasPlaceholder(!previewShown, i18n.t('loading_image_annotations'));
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
      const step = Math.abs(index - anchorIndex);
      this.loadImageBundle(img.id, img.rel_path, {
        includeAnnotations: step <= 1,
        includePreview: true,
        includeTileInfo: false,
      }).catch(() => {});
    });
  },

  async selectImage(id, relPath, options = {}) {
    if (!this.commitPendingManualPolygon()) return;
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
    const cachedBundleReady = bundleSatisfies(cachedBundle, { annotations: true, preview: true });
    this.isImageLoading = !cachedBundleReady;
    
    if (this.viewer) {
      this.viewer.setPrompts([]);
      this.viewer.setPreviews([]);
      this.viewer.setFocusedAnnotation(null);
      if (!cachedBundle?.previewLoaded) {
        this.viewer.clearImage();
        this.viewer.setAnnotations([]);
      }
    }
    
    this.renderPreviews();
    this.updateActionBar();
    this.updateSelectedImageListState();

    if (cachedBundleReady) {
      this.commitImageBundle(cachedBundle);
      if (this.imageLoadAbortController === abortController) {
        this.imageLoadAbortController = null;
      }
      this.prefetchAdjacentImages(id);
      return;
    }

    if (cachedBundle?.previewLoaded) {
      this.commitImageBundle(cachedBundle);
    }

    this.renderAnnotations();
    
    this.setCanvasPlaceholder(!cachedBundle?.previewLoaded, i18n.t('loading_image_annotations'));
    const imageStatus = document.getElementById('ws-image-status');
    if (imageStatus) {
      const modeText = this.getPromptModeLabel();
      imageStatus.innerText = `${relPath || id} | ${modeText} | ${i18n.t('loading_image_annotations')}`;
    }
    
    try {
      const bundle = await this.loadImageBundle(id, relPath, { signal: abortController.signal });
      if (this.isUnmounted || requestSeq !== this.imageLoadSeq || String(this.selectedImageId) !== String(id)) return;
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
    await this.inferenceController.runSingle();
  },

  async runExamplePreview() {
    await this.inferenceController.runExamplePreview();
  },

  async startBatchTask() {
    await this.inferenceController.startBatchTask();
  },

  async pollTaskStatus() {
    await this.inferenceController.pollTaskStatus();
  },

  async stopActiveTask() {
    await this.inferenceController.stopActiveTask();
  },

  async resumeActiveTask() {
    await this.inferenceController.resumeActiveTask();
  },

  async cancelActiveTask() {
    await this.inferenceController.cancelActiveTask();
  },

  async migrateAnnotationSources() {
    if (!this.projectId) return;
    if (!confirm(i18n.t('migrate_sources_confirm'))) return;
    try {
      const res = await api.migrateSources(this.projectId);
      const total = Number(res?.total || 0);
      const migrated = Number(res?.migrated || 0);
      showToast(i18n.t('migrate_done', { total: migrated, kept: total - migrated }), 'success');
      await this.loadProjectInfo();
      if (this.selectedImageId && this.selectedImagePath) {
        await this.selectImage(this.selectedImageId, this.selectedImagePath);
      }
    } catch (e) {
      showToast(e.message, 'error');
    }
  },

  visibleAnnotations() {
    const filter = this.annotationSourceFilter;
    return (this.annotations || []).filter(a => filter.has(String(a.source_model || 'sam3')));
  },

  updateSourceChipStyles() {
    document.querySelectorAll('.source-chip').forEach(chip => {
      const active = this.annotationSourceFilter && this.annotationSourceFilter.has(chip.dataset.source);
      chip.style.background = active ? 'var(--neu-bg)' : 'transparent';
      chip.style.color = active ? 'var(--neu-text-active)' : 'var(--neu-text-light)';
      chip.style.boxShadow = active ? 'var(--neu-inset-sm)' : 'none';
      chip.style.fontWeight = active ? '700' : '500';
    });
  },

  renderAnnotations() {
    const list = document.getElementById('annotation-list-container');
    const visible = this.visibleAnnotations();
    renderAnnotationList(list, visible, {
      focusedAnnotationId: this.focusedAnnotationId,
      isLoading: this.isImageLoading,
      loadingText: i18n.t('loading_image_annotations'),
      emptyText: i18n.t('no_annotations_visible'),
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
    return this.inferenceController.openBatchConfigModal(defaultClasses);
  },

  showBatchResultModal(job) {
    this.inferenceController.showBatchResultModal(job);
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

  commitPendingManualPolygon() {
    if (!this.viewer || typeof this.viewer.hasActiveManualPolygon !== 'function') return true;
    if (!this.viewer.hasActiveManualPolygon()) return true;
    const pointCount = typeof this.viewer.activeManualPolygonPointCount === 'function'
      ? this.viewer.activeManualPolygonPointCount()
      : 0;
    if (pointCount < 3) {
      showToast('多边形至少需要 3 个点，完成或按 Esc 取消后再保存', 'error');
      return false;
    }
    const committed = this.viewer.finishManualPolygon();
    if (!committed) {
      showToast('多边形未能完成，请重试或按 Esc 取消', 'error');
      return false;
    }
    return true;
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
    openAnnotationClassModal({
      annotation: ann,
      classes: this.projectMeta?.classes || [],
      notify: showToast,
      onConfirm: (nextClass) => this.updateAnnotationClass(annId, nextClass),
    });
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
