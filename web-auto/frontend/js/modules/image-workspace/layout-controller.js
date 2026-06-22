export class LayoutController {
  constructor(workspace) {
    this.workspace = workspace;
  }

  initialize() {
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

    if (leftPanel) leftPanel.style.minWidth = '320px';
    if (rightPanel) rightPanel.style.minWidth = '320px';

    const pointerBtn = document.getElementById('btn-tool-pointer');
    if (pointerBtn) pointerBtn.textContent = 'P';
    if (fitBtn) fitBtn.textContent = 'F';

    const leftToggle = document.getElementById('btn-toggle-left-panel');
    const rightToggle = document.getElementById('btn-toggle-right-panel');
    if (centerPanel && leftToggle && leftToggle.parentElement !== centerPanel) centerPanel.appendChild(leftToggle);
    if (centerPanel && rightToggle && rightToggle.parentElement !== centerPanel) centerPanel.appendChild(rightToggle);
    if (leftToggle) leftToggle.textContent = '<';
    if (rightToggle) rightToggle.textContent = '>';

    this.initializeClassesSection(rightPanel);
    this.initializePreviewSection();
  }

  initializeClassesSection(rightPanel) {
    const classesSection = rightPanel?.children?.[0] || null;
    if (!classesSection || document.getElementById('classes-section-body')) return;
    classesSection.id = 'classes-section';
    const title = classesSection.querySelector('h3');
    const classesList = document.getElementById('classes-list');
    const addClassBtn = document.getElementById('btn-add-class-ws');
    if (!title || !classesList || !addClassBtn) return;

    const header = document.createElement('div');
    header.style.cssText = 'display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 15px;';
    title.parentNode.insertBefore(header, title);
    header.appendChild(title);

    const toggleBtn = document.createElement('button');
    toggleBtn.id = 'btn-toggle-classes-section';
    toggleBtn.className = 'neu-button';
    toggleBtn.style.cssText = 'width: 30px; height: 30px; padding: 0; font-size: 14px;';
    toggleBtn.textContent = '-';
    header.appendChild(toggleBtn);

    const body = document.createElement('div');
    body.id = 'classes-section-body';
    body.style.cssText = 'display: flex; flex-direction: column; gap: 8px; min-height: 0;';
    classesSection.appendChild(body);
    body.appendChild(classesList);
    body.appendChild(addClassBtn);
  }

  initializePreviewSection() {
    const previewList = document.getElementById('preview-list');
    const previewCard = previewList?.closest('.neu-box') || null;
    if (!previewCard || document.getElementById('btn-collapse-preview')) return;
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

  applyState() {
    const ws = this.workspace;
    const leftPanel = document.getElementById('left-panel');
    const rightPanel = document.getElementById('right-panel');
    const leftBtn = document.getElementById('btn-toggle-left-panel');
    const rightBtn = document.getElementById('btn-toggle-right-panel');
    if (leftPanel) leftPanel.style.display = ws.leftPanelHidden ? 'none' : 'flex';
    if (rightPanel) rightPanel.style.display = ws.rightPanelHidden ? 'none' : 'flex';
    if (leftBtn) leftBtn.textContent = ws.leftPanelHidden ? '>' : '<';
    if (rightBtn) rightBtn.textContent = ws.rightPanelHidden ? '<' : '>';

    const classesBody = document.getElementById('classes-section-body');
    const classesBtn = document.getElementById('btn-toggle-classes-section');
    if (classesBody) classesBody.style.display = ws.classesSectionCollapsed ? 'none' : 'flex';
    if (classesBtn) classesBtn.textContent = ws.classesSectionCollapsed ? '+' : '-';

    const annWrapper = document.getElementById('annotation-list-wrapper');
    const annBtn = document.getElementById('btn-collapse-anns');
    if (annWrapper) annWrapper.style.display = ws.annotationsSectionCollapsed ? 'none' : 'flex';
    if (annBtn) annBtn.textContent = ws.annotationsSectionCollapsed ? '+' : '-';

    const previewWrapper = document.getElementById('preview-section-body');
    const previewBtn = document.getElementById('btn-collapse-preview');
    if (previewWrapper) previewWrapper.style.display = ws.previewSectionCollapsed ? 'none' : 'flex';
    if (previewBtn) previewBtn.textContent = ws.previewSectionCollapsed ? '+' : '-';

    requestAnimationFrame(() => {
      if (ws.viewer) ws.viewer.onResize();
    });
  }

  toggleSidePanel(side) {
    const ws = this.workspace;
    const panelId = side === 'left' ? 'left-panel' : 'right-panel';
    const btnId = side === 'left' ? 'btn-toggle-left-panel' : 'btn-toggle-right-panel';
    const panel = document.getElementById(panelId);
    const btn = document.getElementById(btnId);
    if (!panel) return;
    const hidden = panel.style.display === 'none';
    panel.style.display = hidden ? 'flex' : 'none';
    if (side === 'left') ws.leftPanelHidden = !hidden;
    else ws.rightPanelHidden = !hidden;
    if (btn) btn.textContent = side === 'left'
      ? (hidden ? '<' : '>')
      : (hidden ? '>' : '<');
    ws.scheduleProjectUIStateSave();
    requestAnimationFrame(() => {
      if (ws.viewer) ws.viewer.onResize();
    });
  }

  toggleSection(section) {
    const ws = this.workspace;
    if (section === 'classes') {
      const body = document.getElementById('classes-section-body');
      const btn = document.getElementById('btn-toggle-classes-section');
      if (!body) return;
      ws.classesSectionCollapsed = !ws.classesSectionCollapsed;
      body.style.display = ws.classesSectionCollapsed ? 'none' : 'flex';
      const classesSection = document.getElementById('classes-section');
      if (classesSection) classesSection.style.maxHeight = ws.classesSectionCollapsed ? 'auto' : '40%';
      if (btn) btn.textContent = ws.classesSectionCollapsed ? '+' : '-';
      ws.scheduleProjectUIStateSave();
    } else if (section === 'annotations') {
      const wrapper = document.getElementById('annotation-list-wrapper');
      const btn = document.getElementById('btn-collapse-anns') || document.getElementById('btn-toggle-annotations-section');
      if (!wrapper) return;
      ws.annotationsSectionCollapsed = !ws.annotationsSectionCollapsed;
      wrapper.style.display = ws.annotationsSectionCollapsed ? 'none' : 'flex';
      if (btn) btn.textContent = ws.annotationsSectionCollapsed ? '+' : '-';
      ws.scheduleProjectUIStateSave();
    } else if (section === 'preview') {
      const wrapper = document.getElementById('preview-section-body');
      const btn = document.getElementById('btn-collapse-preview');
      if (!wrapper) return;
      ws.previewSectionCollapsed = !ws.previewSectionCollapsed;
      wrapper.style.display = ws.previewSectionCollapsed ? 'none' : 'flex';
      if (btn) btn.textContent = ws.previewSectionCollapsed ? '+' : '-';
      ws.scheduleProjectUIStateSave();
    }
  }
}
