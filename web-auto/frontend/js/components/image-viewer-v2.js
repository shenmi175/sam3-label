export class ImageViewerV2 {
  constructor(containerId) {
    this.container = document.getElementById(containerId);
    const position = window.getComputedStyle(this.container).position;
    if (!position || position === 'static') this.container.style.position = 'relative';

    this.root = document.createElement('div');
    this.osdElement = document.createElement('div');
    this.previewImage = document.createElement('img');
    this.staticCanvas = document.createElement('canvas');
    this.overlayCanvas = document.createElement('canvas');
    this.staticCtx = this.staticCanvas.getContext('2d');
    this.ctx = this.overlayCanvas.getContext('2d');

    Object.assign(this.root.style, {
      position: 'absolute',
      inset: '0',
      overflow: 'hidden',
      background: 'var(--canvas-bg)',
    });
    Object.assign(this.osdElement.style, {
      position: 'absolute',
      inset: '0',
      width: '100%',
      height: '100%',
      zIndex: '5',
    });
    Object.assign(this.previewImage.style, {
      position: 'absolute',
      inset: '0',
      width: '100%',
      height: '100%',
      objectFit: 'contain',
      display: 'none',
      zIndex: '10',
      pointerEvents: 'none',
      background: 'var(--canvas-bg)',
    });
    Object.assign(this.staticCanvas.style, {
      position: 'absolute',
      left: '0',
      top: '0',
      width: '100%',
      height: '100%',
      display: 'none',
      zIndex: '15',
      pointerEvents: 'none',
      transformOrigin: '0 0',
      willChange: 'transform',
    });
    Object.assign(this.overlayCanvas.style, {
      position: 'absolute',
      inset: '0',
      width: '100%',
      height: '100%',
      display: 'block',
      zIndex: '20',
      touchAction: 'none',
    });

    this.root.appendChild(this.osdElement);
    this.root.appendChild(this.previewImage);
    this.root.appendChild(this.staticCanvas);
    this.root.appendChild(this.overlayCanvas);
    this.container.appendChild(this.root);
    this.container.style.cursor = 'default';

    this.viewer = null;
    this.image = null;
    this.tileInfo = null;
    this.previewInfo = null;
    this.isTileOpen = false;
    this.annotations = [];
    this.previews = [];
    this.prompts = [];
    this.focusedAnnotationId = null;
    this.promptMode = 'pointer';
    this.boxPromptLabel = 1;
    this.options = { showMasks: true };
    this.drawFrame = null;
    this.staticFrame = null;
    this.staticRenderTimer = null;
    this.staticRenderState = null;
    this.staticExcludeAnnotationId = null;
    this.annotationGeometryCache = new WeakMap();
    this.wheelFrame = null;
    this.pendingWheelScale = 1;
    this.pendingWheelClientX = 0;
    this.pendingWheelClientY = 0;
    this.panFrame = null;
    this.pendingPanDx = 0;
    this.pendingPanDy = 0;
    this.drawOffsetX = 0;
    this.drawOffsetY = 0;

    this.isPanning = false;
    this.isDrawingBox = false;
    this.boxDrawPurpose = 'prompt';
    this.boxDraftLabel = 1;
    this.boxStart = null;
    this.boxEnd = null;
    this.lastX = 0;
    this.lastY = 0;
    this.activePolygonPoints = [];

    this.isDraggingAnnotation = false;
    this.dragOperation = null;
    this.dragStart = null;
    this.dragAnnotation = null;
    this.dragOriginal = null;
    this.dragMoved = false;
    this.dragStartedHistory = false;

    this.onPromptAdded = null;
    this.onAnnotationSelected = null;
    this.onAnnotationEditStart = null;
    this.onAnnotationUpdated = null;
    this.onAnnotationCreated = null;

    this.onResize = this.onResize.bind(this);
    this.onWheel = this.onWheel.bind(this);
    this.onMouseDown = this.onMouseDown.bind(this);
    this.onMouseMove = this.onMouseMove.bind(this);
    this.onMouseUp = this.onMouseUp.bind(this);
    this.onDoubleClick = this.onDoubleClick.bind(this);
    this.onKeyDown = this.onKeyDown.bind(this);
    this.onKeyUp = this.onKeyUp.bind(this);
    this.onContextMenu = this.onContextMenu.bind(this);

    window.addEventListener('resize', this.onResize);
    this.overlayCanvas.addEventListener('wheel', this.onWheel, { passive: false });
    this.overlayCanvas.addEventListener('mousedown', this.onMouseDown);
    this.overlayCanvas.addEventListener('dblclick', this.onDoubleClick);
    this.overlayCanvas.addEventListener('contextmenu', this.onContextMenu);
    window.addEventListener('mousemove', this.onMouseMove);
    window.addEventListener('mouseup', this.onMouseUp);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    this.resizeObserver = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(() => this.onResize())
      : null;
    if (this.resizeObserver) this.resizeObserver.observe(this.container);

    this.onResize();
  }

  destroy() {
    window.removeEventListener('resize', this.onResize);
    this.overlayCanvas.removeEventListener('wheel', this.onWheel);
    this.overlayCanvas.removeEventListener('mousedown', this.onMouseDown);
    this.overlayCanvas.removeEventListener('dblclick', this.onDoubleClick);
    this.overlayCanvas.removeEventListener('contextmenu', this.onContextMenu);
    window.removeEventListener('mousemove', this.onMouseMove);
    window.removeEventListener('mouseup', this.onMouseUp);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    if (this.resizeObserver) this.resizeObserver.disconnect();
    if (this.drawFrame) cancelAnimationFrame(this.drawFrame);
    if (this.staticFrame) cancelAnimationFrame(this.staticFrame);
    if (this.wheelFrame) cancelAnimationFrame(this.wheelFrame);
    if (this.panFrame) cancelAnimationFrame(this.panFrame);
    if (this.staticRenderTimer) clearTimeout(this.staticRenderTimer);
    if (this.viewer) {
      this.viewer.destroy();
      this.viewer = null;
    }
    this.root.remove();
  }

  onResize() {
    const rect = this.container.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width || this.container.clientWidth || 1));
    const height = Math.max(1, Math.round(rect.height || this.container.clientHeight || 1));
    if (this.overlayCanvas.width !== width) this.overlayCanvas.width = width;
    if (this.overlayCanvas.height !== height) this.overlayCanvas.height = height;
    this.staticRenderState = null;
    this.requestStaticRedraw(true);
    this.requestDraw();
  }

  ensureViewer() {
    if (this.viewer) return this.viewer;
    const OpenSeadragon = window.OpenSeadragon;
    if (!OpenSeadragon) throw new Error('OpenSeadragon is not loaded');
    this.viewer = OpenSeadragon({
      element: this.osdElement,
      showNavigationControl: false,
      showNavigator: false,
      animationTime: 0.12,
      blendTime: 0,
      immediateRender: true,
      preserveViewport: false,
      visibilityRatio: 0.5,
      minZoomImageRatio: 0.05,
      maxZoomPixelRatio: 8,
      maxImageCacheCount: 400,
      gestureSettingsMouse: {
        scrollToZoom: false,
        clickToZoom: false,
        dblClickToZoom: false,
        dragToPan: false,
      },
    });
    this.viewer.addHandler('open', () => {
      this.isTileOpen = true;
      this.staticRenderState = null;
      this.requestStaticRedraw(true);
      this.requestDraw();
    });
    this.viewer.addHandler('tile-loaded', () => {
      this.hidePreview();
      this.staticRenderState = null;
      this.requestStaticRedraw(true);
      this.requestDraw();
    });
    ['animation', 'animation-finish', 'pan', 'zoom', 'resize'].forEach((eventName) => {
      this.viewer.addHandler(eventName, () => this.onViewportChanged());
    });
    return this.viewer;
  }

  onViewportChanged() {
    this.updateStaticTransform();
    this.requestDraw();
    this.requestStaticRedraw(true);
  }

  hasLiveOverlay() {
    return Boolean(
      this.staticExcludeAnnotationId
      || this.focusedAnnotationId
      || this.activePolygonPoints.length > 0
      || (this.isDrawingBox && this.boxStart && this.boxEnd)
    );
  }

  setImageSource(tileInfo) {
    return false;
  }

  setPreviewSource(previewInfo) {
    const url = previewInfo?.preview_url || previewInfo?.thumbnail_url || '';
    if (!url) {
      this.clearPreview();
      return false;
    }
    this.previewInfo = previewInfo;
    this.image = {
      width: Number(previewInfo.source_width || previewInfo.width || previewInfo.preview_width || 0),
      height: Number(previewInfo.source_height || previewInfo.height || previewInfo.preview_height || 0),
    };
    this.isPanning = false;
    this.isDrawingBox = false;
    this.isDraggingAnnotation = false;
    this.activePolygonPoints = [];
    this.isTileOpen = false;
    this.staticRenderState = null;
    this.staticExcludeAnnotationId = null;
    this.boxStart = null;
    this.boxEnd = null;
    if (this.staticCtx) this.staticCtx.clearRect(0, 0, this.staticCanvas.width, this.staticCanvas.height);
    this.previewImage.src = url;
    this.previewImage.style.display = 'block';
    this.previewImage.style.opacity = '1';
    const viewer = this.ensureViewer();
    viewer.open({
      type: 'image',
      url: url,
      buildPyramid: false,
    });
    this.requestDraw();
    return true;
  }

  hidePreview() {
    if (this.previewImage) this.previewImage.style.display = 'none';
  }

  clearPreview() {
    this.previewInfo = null;
    if (!this.previewImage) return;
    this.previewImage.removeAttribute('src');
    this.previewImage.style.display = 'none';
  }

  closeImageTiles() {
    this.tileInfo = null;
    this.isTileOpen = false;
    this.staticRenderState = null;
    this.staticExcludeAnnotationId = null;
    if (this.viewer) this.viewer.close();
    if (this.staticCtx) this.staticCtx.clearRect(0, 0, this.staticCanvas.width, this.staticCanvas.height);
    this.draw();
  }

  clearImage() {
    this.image = null;
    this.tileInfo = null;
    this.previewInfo = null;
    this.annotations = [];
    this.previews = [];
    this.prompts = [];
    this.focusedAnnotationId = null;
    this.isTileOpen = false;
    this.isPanning = false;
    this.isDrawingBox = false;
    this.isDraggingAnnotation = false;
    this.activePolygonPoints = [];
    this.staticRenderState = null;
    this.staticExcludeAnnotationId = null;
    this.pendingWheelScale = 1;
    this.pendingPanDx = 0;
    this.pendingPanDy = 0;
    if (this.viewer) this.viewer.close();
    this.clearPreview();
    if (this.staticCtx) this.staticCtx.clearRect(0, 0, this.staticCanvas.width, this.staticCanvas.height);
    this.draw();
  }

  setAnnotations(anns) {
    this.annotations = anns || [];
    this.annotationGeometryCache = new WeakMap();
    this.requestStaticRedraw(true);
    this.requestDraw();
  }

  setPreviews(previews) {
    this.previews = previews || [];
    this.annotationGeometryCache = new WeakMap();
    this.requestStaticRedraw(true);
    this.requestDraw();
  }

  setPrompts(prompts) {
    this.prompts = prompts || [];
    this.requestStaticRedraw(true);
    this.requestDraw();
  }

  clearPrompts() {
    this.prompts = [];
    this.requestStaticRedraw(true);
    this.requestDraw();
  }

  getPrompts() {
    return this.prompts.map((p) => ({ type: p.type, data: p.data }));
  }

  setOptions(nextOptions = {}) {
    this.options = { ...this.options, ...nextOptions };
    this.requestStaticRedraw(true);
    this.requestDraw();
  }

  setPromptMode(mode) {
    this.promptMode = mode;
    if (mode !== 'manual-polygon' && this.activePolygonPoints.length > 0) {
      this.activePolygonPoints = [];
    }
    this.updateCursor();
    this.requestDraw();
  }

  setBoxPromptLabel(label) {
    this.boxPromptLabel = Number(label) === 0 ? 0 : 1;
    this.requestDraw();
  }

  hasActiveManualPolygon() {
    return this.promptMode === 'manual-polygon' && this.activePolygonPoints.length > 0;
  }

  activeManualPolygonPointCount() {
    return this.activePolygonPoints.length;
  }

  setFocusedAnnotation(annotationId = null, options = {}) {
    this.focusedAnnotationId = annotationId || null;
    if (options.draw !== false) this.requestDraw();
  }

  focusAnnotation(annotationId = null, bbox = null) {
    this.focusedAnnotationId = annotationId || null;
    if (annotationId && bbox) this.centerTransformOnBbox(bbox);
    this.requestDraw();
  }

  centerOn(bbox) {
    this.centerTransformOnBbox(bbox);
  }

  fitToScreen() {
    if (this.viewer) this.viewer.viewport.goHome(true);
    this.onViewportChanged();
  }

  requestDraw() {
    if (this.drawFrame) return;
    this.drawFrame = requestAnimationFrame(() => {
      this.drawFrame = null;
      this.draw();
    });
  }

  draw() {
    if (!this.ctx) return;
    this.ctx.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);
    if (!this.image || !this.isTileOpen || !this.viewer?.viewport) return;

    for (const ann of this.annotations || []) {
      if (this.annotationVisible(ann)) this.drawAnnotation(ann, false);
    }
    for (const pre of this.previews || []) {
      if (this.annotationVisible(pre)) this.drawAnnotation(pre, true);
    }
    for (const p of this.prompts) this.drawPrompt(p);
    this.drawFocusedHandles();
    this.drawActivePolygon();
    if (this.isDrawingBox && this.boxStart && this.boxEnd) this.drawBoxDraft();
  }

  requestStaticRedraw(immediate = false) {
    if (!this.staticCtx) return;
    if (this.staticRenderTimer) {
      clearTimeout(this.staticRenderTimer);
      this.staticRenderTimer = null;
    }
    if (!immediate) {
      this.staticRenderTimer = setTimeout(() => {
        this.staticRenderTimer = null;
        this.requestStaticRedraw(true);
      }, 90);
      return;
    }
    if (this.staticFrame) return;
    this.staticFrame = requestAnimationFrame(() => {
      this.staticFrame = null;
      this.drawStaticAnnotations();
    });
  }

  drawStaticAnnotations() {
    if (!this.staticCtx) return;
    const width = Math.max(1, this.overlayCanvas.width || this.container.clientWidth || 1);
    const height = Math.max(1, this.overlayCanvas.height || this.container.clientHeight || 1);
    if (!this.image || !this.isTileOpen || !this.viewer?.viewport) {
      this.staticCtx.clearRect(0, 0, this.staticCanvas.width, this.staticCanvas.height);
      this.staticRenderState = null;
      return;
    }

    const margin = Math.min(1024, Math.max(384, Math.round(Math.max(width, height) * 0.35)));
    const canvasWidth = width + margin * 2;
    const canvasHeight = height + margin * 2;
    if (this.staticCanvas.width !== canvasWidth) this.staticCanvas.width = canvasWidth;
    if (this.staticCanvas.height !== canvasHeight) this.staticCanvas.height = canvasHeight;
    Object.assign(this.staticCanvas.style, {
      left: `${-margin}px`,
      top: `${-margin}px`,
      width: `${canvasWidth}px`,
      height: `${canvasHeight}px`,
      transform: 'translate3d(0, 0, 0) scale(1)',
    });

    const previousCtx = this.ctx;
    const previousOffsetX = this.drawOffsetX;
    const previousOffsetY = this.drawOffsetY;
    try {
      this.ctx = this.staticCtx;
      this.drawOffsetX = margin;
      this.drawOffsetY = margin;
      this.staticCtx.clearRect(0, 0, canvasWidth, canvasHeight);
      for (const ann of this.annotations || []) {
        if (this.staticExcludeAnnotationId && String(ann?.id || '') === String(this.staticExcludeAnnotationId)) continue;
        if (this.annotationVisible(ann)) this.drawAnnotation(ann, false);
      }
      for (const pre of this.previews || []) {
        if (this.annotationVisible(pre)) this.drawAnnotation(pre, true);
      }
      for (const p of this.prompts) this.drawPrompt(p);
    } finally {
      this.ctx = previousCtx;
      this.drawOffsetX = previousOffsetX;
      this.drawOffsetY = previousOffsetY;
    }

    this.staticRenderState = {
      margin,
      origin: this.imageToScreenRaw([0, 0]),
      scale: this.imageScaleRaw(),
    };
    this.updateStaticTransform();
  }

  updateStaticTransform() {
    if (!this.staticRenderState || !this.image || !this.viewer?.viewport) return;
    const baseOrigin = this.staticRenderState.origin;
    const baseScale = Math.max(0.0001, this.staticRenderState.scale || 1);
    const currentOrigin = this.imageToScreenRaw([0, 0]);
    const currentScale = this.imageScaleRaw();
    const scale = currentScale / baseScale;
    const margin = Number(this.staticRenderState.margin || 0);
    const tx = currentOrigin[0] - scale * baseOrigin[0] - (scale - 1) * margin;
    const ty = currentOrigin[1] - scale * baseOrigin[1] - (scale - 1) * margin;
    this.staticCanvas.style.transform = `translate3d(${tx}px, ${ty}px, 0) scale(${scale})`;
  }

  updateCursor() {
    if (this.isPanning) {
      this.container.style.cursor = 'grabbing';
      return;
    }
    if (this.promptMode === 'pan') {
      this.container.style.cursor = 'grab';
      return;
    }
    if (this.promptMode === 'box' || this.promptMode === 'manual-box' || this.promptMode === 'manual-polygon') {
      this.container.style.cursor = 'crosshair';
      return;
    }
    if (this.promptMode === 'point') {
      this.container.style.cursor = 'copy';
      return;
    }
    this.container.style.cursor = 'default';
  }

  screenPoint(clientX, clientY) {
    const rect = this.overlayCanvas.getBoundingClientRect();
    return [clientX - rect.left, clientY - rect.top];
  }

  screenToImage(clientX, clientY) {
    if (!this.viewer?.viewport || !this.image) return [0, 0];
    const OpenSeadragon = window.OpenSeadragon;
    const [x, y] = this.screenPoint(clientX, clientY);
    const vp = this.viewer.viewport.pointFromPixel(new OpenSeadragon.Point(x, y), true);
    return this.clampPoint([
      vp.x * this.image.width,
      vp.y * this.image.width,
    ]);
  }

  imageToScreenRaw(point) {
    if (!this.viewer?.viewport || !this.image) return [0, 0];
    const OpenSeadragon = window.OpenSeadragon;
    const ix = Number(point?.[0] || 0);
    const iy = Number(point?.[1] || 0);
    // OSD viewport coords normalize BOTH axes by image width (image width = 1.0, height = H/W)
    const w = this.image.width || 1;
    const vp = new OpenSeadragon.Point(ix / w, iy / w);
    const px = this.viewer.viewport.pixelFromPoint(vp, true);
    return [px.x, px.y];
  }

  imageToScreen(point) {
    const raw = this.imageToScreenRaw(point);
    return [raw[0] + this.drawOffsetX, raw[1] + this.drawOffsetY];
  }

  imageScaleRaw() {
    if (!this.image) return 1;
    const a = this.imageToScreenRaw([0, 0]);
    const b = this.imageToScreenRaw([100, 0]);
    return Math.max(0.0001, this.distance(a, b) / 100);
  }

  imageScale() {
    return this.imageScaleRaw();
  }

  clampPoint(point) {
    const x = Number(point?.[0] || 0);
    const y = Number(point?.[1] || 0);
    if (!this.image) return [x, y];
    return [
      Math.max(0, Math.min(this.image.width, x)),
      Math.max(0, Math.min(this.image.height, y)),
    ];
  }

  normalizeBbox(bbox) {
    if (!Array.isArray(bbox) || bbox.length !== 4) return null;
    const p1 = this.clampPoint([bbox[0], bbox[1]]);
    const p2 = this.clampPoint([bbox[2], bbox[3]]);
    return [
      Math.min(p1[0], p2[0]),
      Math.min(p1[1], p2[1]),
      Math.max(p1[0], p2[0]),
      Math.max(p1[1], p2[1]),
    ];
  }

  polygonToPairs(points) {
    if (!Array.isArray(points)) return [];
    if (points.length > 0 && typeof points[0] === 'number') {
      const out = [];
      for (let i = 0; i < points.length - 1; i += 2) {
        out.push(this.clampPoint([points[i], points[i + 1]]));
      }
      return out;
    }
    return points
      .filter((p) => Array.isArray(p) && p.length >= 2)
      .map((p) => this.clampPoint([p[0], p[1]]));
  }

  pointPairs(points) {
    if (Array.isArray(points) && points.length > 0 && Array.isArray(points[0])) return points;
    return this.polygonToPairs(points);
  }

  getAnnotationGeometry(ann) {
    if (!ann || typeof ann !== 'object') return { bbox: null, polygon: [], polygons: [] };
    const bboxRef = ann.bbox || ann.bbox_xyxy || ann.box || null;
    const polygonRef = ann.polygon || null;
    const polygonsRef = ann.polygons || null;
    const pointsRef = ann.points || null;
    const cached = this.annotationGeometryCache.get(ann);
    if (
      cached
      && cached.bboxRef === bboxRef
      && cached.polygonRef === polygonRef
      && cached.polygonsRef === polygonsRef
      && cached.pointsRef === pointsRef
      && cached.imageWidth === this.image?.width
      && cached.imageHeight === this.image?.height
    ) {
      return cached.geometry;
    }

    const polygon = this.polygonToPairs(polygonRef || pointsRef);
    const polygons = Array.isArray(polygonsRef)
      ? polygonsRef.map((p) => this.polygonToPairs(p)).filter((p) => p.length >= 3)
      : [];
    const bbox = this.normalizeBbox(bboxRef) || this.bboxFromPairs(polygon);
    const geometry = { bbox, polygon, polygons };
    this.annotationGeometryCache.set(ann, {
      bboxRef,
      polygonRef,
      polygonsRef,
      pointsRef,
      imageWidth: this.image?.width,
      imageHeight: this.image?.height,
      geometry,
    });
    return geometry;
  }

  invalidateAnnotationGeometry(ann) {
    if (ann && typeof ann === 'object') this.annotationGeometryCache.delete(ann);
  }

  bboxFromPolygon(points) {
    const pairs = this.polygonToPairs(points);
    return this.bboxFromPairs(pairs);
  }

  bboxFromPairs(pairs) {
    if (pairs.length === 0) return null;
    const xs = pairs.map((p) => Number(p[0] || 0));
    const ys = pairs.map((p) => Number(p[1] || 0));
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  }

  getAnnotationBbox(ann) {
    return this.getAnnotationGeometry(ann).bbox;
  }

  setAnnotationBbox(ann, bbox) {
    const next = this.normalizeBbox(bbox);
    if (!next) return;
    ann.bbox = next;
    delete ann.box;
    delete ann.bbox_xyxy;
    this.invalidateAnnotationGeometry(ann);
  }

  annotationVisible(ann) {
    const bbox = this.getAnnotationBbox(ann);
    if (!bbox) return true;
    const p1 = this.imageToScreen([bbox[0], bbox[1]]);
    const p2 = this.imageToScreen([bbox[2], bbox[3]]);
    const minX = Math.min(p1[0], p2[0]);
    const minY = Math.min(p1[1], p2[1]);
    const maxX = Math.max(p1[0], p2[0]);
    const maxY = Math.max(p1[1], p2[1]);
    const margin = 80;
    const canvasWidth = this.overlayCanvas.width + Math.max(0, this.drawOffsetX) * 2;
    const canvasHeight = this.overlayCanvas.height + Math.max(0, this.drawOffsetY) * 2;
    return maxX >= -margin && maxY >= -margin && minX <= canvasWidth + margin && minY <= canvasHeight + margin;
  }

  pointInBbox(point, bbox) {
    if (!bbox) return false;
    const [x, y] = point;
    return x >= bbox[0] && x <= bbox[2] && y >= bbox[1] && y <= bbox[3];
  }

  pointInExpandedBbox(point, bbox, tolerance = 0) {
    if (!bbox) return false;
    const [x, y] = point;
    return x >= bbox[0] - tolerance
      && x <= bbox[2] + tolerance
      && y >= bbox[1] - tolerance
      && y <= bbox[3] + tolerance;
  }

  distanceToSegment(point, a, b) {
    const [px, py] = point;
    const [ax, ay] = a;
    const [bx, by] = b;
    const dx = bx - ax;
    const dy = by - ay;
    if (dx === 0 && dy === 0) return this.distance(point, a);
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
    return this.distance(point, [ax + t * dx, ay + t * dy]);
  }

  pointNearBboxEdge(point, bbox, tolerance) {
    if (!bbox) return false;
    const [x1, y1, x2, y2] = bbox;
    return [
      [[x1, y1], [x2, y1]],
      [[x2, y1], [x2, y2]],
      [[x2, y2], [x1, y2]],
      [[x1, y2], [x1, y1]],
    ].some(([a, b]) => this.distanceToSegment(point, a, b) <= tolerance);
  }

  pointInPolygon(point, polygon) {
    const pts = this.pointPairs(polygon);
    if (pts.length < 3) return false;
    const [x, y] = point;
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const xi = pts[i][0], yi = pts[i][1];
      const xj = pts[j][0], yj = pts[j][1];
      const intersect = ((yi > y) !== (yj > y))
        && (x < ((xj - xi) * (y - yi)) / ((yj - yi) || 1e-9) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  }

  pointInAnnotationPolygons(point, geom) {
    if (Array.isArray(geom.polygons) && geom.polygons.length > 0) {
      return geom.polygons.some((poly) => this.pointInPolygon(point, poly));
    }
    return geom.polygon.length >= 3 && this.pointInPolygon(point, geom.polygon);
  }

  distance(a, b) {
    const dx = Number(a?.[0] || 0) - Number(b?.[0] || 0);
    const dy = Number(a?.[1] || 0) - Number(b?.[1] || 0);
    return Math.sqrt(dx * dx + dy * dy);
  }

  bboxHandles(bbox) {
    if (!bbox) return [];
    const [x1, y1, x2, y2] = bbox;
    const cx = (x1 + x2) / 2;
    const cy = (y1 + y2) / 2;
    return [
      { name: 'nw', point: [x1, y1] },
      { name: 'n', point: [cx, y1] },
      { name: 'ne', point: [x2, y1] },
      { name: 'e', point: [x2, cy] },
      { name: 'se', point: [x2, y2] },
      { name: 's', point: [cx, y2] },
      { name: 'sw', point: [x1, y2] },
      { name: 'w', point: [x1, cy] },
    ];
  }

  hitTestAnnotation(point) {
    const tolerance = 8 / this.imageScale();
    const selected = this.focusedAnnotationId
      ? this.annotations.find((ann) => String(ann?.id || '') === String(this.focusedAnnotationId))
      : null;
    if (selected) {
      const selectedGeom = this.getAnnotationGeometry(selected);
      const polygon = selectedGeom.polygon;
      const bbox = selectedGeom.bbox;
      for (const handle of this.bboxHandles(bbox)) {
        if (this.distance(point, handle.point) <= tolerance) return { annotation: selected, operation: 'bbox-handle', handle: handle.name };
      }
      if (polygon.length >= 3 && this.pointInExpandedBbox(point, bbox, tolerance)) {
        for (let i = 0; i < polygon.length; i += 1) {
          if (this.distance(point, polygon[i]) <= tolerance) return { annotation: selected, operation: 'polygon-vertex', vertexIndex: i };
        }
        if (this.pointInAnnotationPolygons(point, selectedGeom)) return { annotation: selected, operation: 'move' };
      }
      if (this.pointNearBboxEdge(point, bbox, tolerance)) {
        return { annotation: selected, operation: 'bbox-body' };
      }
      if (this.pointInBbox(point, bbox)) return { annotation: selected, operation: polygon.length >= 3 ? 'bbox-body' : 'move' };
    }

    for (let i = this.annotations.length - 1; i >= 0; i -= 1) {
      const ann = this.annotations[i];
      if (!this.annotationVisible(ann)) continue;
      const geom = this.getAnnotationGeometry(ann);
      const polygon = geom.polygon;
      const bbox = geom.bbox;
      if (!this.pointInExpandedBbox(point, bbox, tolerance)) continue;
      if (this.pointInAnnotationPolygons(point, geom)) return { annotation: ann, operation: 'move' };
      if (this.pointNearBboxEdge(point, bbox, tolerance)) return { annotation: ann, operation: 'bbox-body' };
      if (this.pointInBbox(point, bbox)) {
        return { annotation: ann, operation: polygon.length >= 3 ? 'bbox-body' : 'move' };
      }
    }
    return null;
  }

  cloneGeometry(ann) {
    return {
      bbox: ann?.bbox ? [...ann.bbox] : null,
      polygon: ann?.polygon ? this.polygonToPairs(ann.polygon).map((p) => [...p]) : null,
      polygons: Array.isArray(ann?.polygons)
        ? ann.polygons.map((poly) => this.polygonToPairs(poly).map((p) => [...p]))
        : null,
      points: ann?.points ? this.polygonToPairs(ann.points).map((p) => [...p]) : null,
    };
  }

  applyMoveGeometry(ann, original, dx, dy) {
    const originalBbox = original.bbox || this.getAnnotationBbox(ann);
    const originalPoints = original.polygon || original.points;
    if (original.polygons && original.polygons.length > 0) {
      ann.polygons = original.polygons.map((poly) => poly.map((p) => this.clampPoint([p[0] + dx, p[1] + dy])));
    }
    if (originalPoints && originalPoints.length > 0) {
      ann.polygon = originalPoints.map((p) => this.clampPoint([p[0] + dx, p[1] + dy]));
      delete ann.points;
      if (originalBbox) this.setAnnotationBbox(ann, [originalBbox[0] + dx, originalBbox[1] + dy, originalBbox[2] + dx, originalBbox[3] + dy]);
      else this.setAnnotationBbox(ann, this.bboxFromPolygon(ann.polygon));
      this.invalidateAnnotationGeometry(ann);
      return;
    }
    if (originalBbox) this.setAnnotationBbox(ann, [originalBbox[0] + dx, originalBbox[1] + dy, originalBbox[2] + dx, originalBbox[3] + dy]);
    this.invalidateAnnotationGeometry(ann);
  }

  applyBboxResize(ann, original, handle, point) {
    const bbox = original.bbox || this.getAnnotationBbox(ann);
    if (!bbox) return;
    let [x1, y1, x2, y2] = bbox;
    const [x, y] = this.clampPoint(point);
    if (handle.includes('w')) x1 = x;
    if (handle.includes('e')) x2 = x;
    if (handle.includes('n')) y1 = y;
    if (handle.includes('s')) y2 = y;
    this.setAnnotationBbox(ann, [x1, y1, x2, y2]);
  }

  applyPolygonVertexDrag(ann, original, vertexIndex, point) {
    const points = (original.polygon || original.points || []).map((p) => [...p]);
    if (vertexIndex < 0 || vertexIndex >= points.length) return;
    points[vertexIndex] = this.clampPoint(point);
    ann.polygon = points;
    delete ann.points;
    // Manual reshape degrades a merged multi-contour annotation to its main polygon.
    delete ann.polygons;
    this.setAnnotationBbox(ann, this.bboxFromPolygon(points));
    this.invalidateAnnotationGeometry(ann);
  }

  panByPixels(dx, dy) {
    if (!this.viewer?.viewport || !window.OpenSeadragon) return;
    const delta = this.viewer.viewport.deltaPointsFromPixels(new window.OpenSeadragon.Point(-dx, -dy), true);
    this.viewer.viewport.panBy(delta, false);
    this.viewer.viewport.applyConstraints();
    this.onViewportChanged();
  }

  zoomBy(scaleChange, clientX, clientY) {
    if (!this.viewer?.viewport || !window.OpenSeadragon) return;
    const [x, y] = this.screenPoint(clientX, clientY);
    const refPoint = this.viewer.viewport.pointFromPixel(new window.OpenSeadragon.Point(x, y), true);
    this.viewer.viewport.zoomBy(scaleChange, refPoint, false);
    this.viewer.viewport.applyConstraints();
    this.onViewportChanged();
  }

  onContextMenu(e) {
    e.preventDefault();
  }

  onWheel(e) {
    if (!this.image) return;
    e.preventDefault();
    let delta = Number(e.deltaY || 0);
    if (e.deltaMode === 1) delta *= 16;
    else if (e.deltaMode === 2) delta *= this.overlayCanvas.height || window.innerHeight || 800;
    delta = Math.max(-160, Math.min(160, delta));
    this.pendingWheelScale *= Math.exp(-delta * 0.0015);
    this.pendingWheelClientX = e.clientX;
    this.pendingWheelClientY = e.clientY;
    if (this.wheelFrame) return;
    this.wheelFrame = requestAnimationFrame(() => {
      const scale = this.pendingWheelScale;
      const clientX = this.pendingWheelClientX;
      const clientY = this.pendingWheelClientY;
      this.pendingWheelScale = 1;
      this.wheelFrame = null;
      this.zoomBy(scale, clientX, clientY);
    });
  }

  onMouseDown(e) {
    if (!this.image) return;
    e.preventDefault();
    const point = this.screenToImage(e.clientX, e.clientY);

    if (e.button === 0 && (e.altKey || this.promptMode === 'pan')) {
      this.isPanning = true;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      this.container.style.cursor = 'grabbing';
      return;
    }

    if (e.button === 0 && this.promptMode === 'pointer') {
      const hit = this.hitTestAnnotation(point);
      if (hit?.annotation) {
        this.focusedAnnotationId = hit.annotation.id || null;
        if (this.onAnnotationSelected) this.onAnnotationSelected(this.focusedAnnotationId);
        if (hit.operation === 'bbox-body') {
          this.requestDraw();
          return;
        }
        this.isDraggingAnnotation = true;
        this.dragOperation = hit;
        this.dragStart = point;
        this.dragAnnotation = hit.annotation;
        this.dragOriginal = this.cloneGeometry(hit.annotation);
        this.dragMoved = false;
        this.dragStartedHistory = false;
        this.staticExcludeAnnotationId = hit.annotation.id || null;
        this.requestStaticRedraw(true);
        this.container.style.cursor = hit.operation === 'move' ? 'move' : 'grabbing';
        this.requestDraw();
        return;
      }
      this.focusedAnnotationId = null;
      if (this.onAnnotationSelected) this.onAnnotationSelected(null);
      this.isPanning = true;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      this.container.style.cursor = 'grabbing';
      this.requestDraw();
      return;
    }

    if (e.button === 0 && this.promptMode === 'manual-polygon') {
      if (this.activePolygonPoints.length >= 3 && this.distance(point, this.activePolygonPoints[0]) <= 10 / this.imageScale()) {
        this.finishManualPolygon();
        return;
      }
      this.activePolygonPoints.push(point);
      this.requestDraw();
      return;
    }

    if (e.button === 0) {
      if (this.promptMode === 'point') {
        if (this.onPromptAdded) this.onPromptAdded('point', point);
      } else if (this.promptMode === 'box' || this.promptMode === 'manual-box') {
        this.isDrawingBox = true;
        this.boxDrawPurpose = this.promptMode === 'manual-box' ? 'annotation' : 'prompt';
        this.boxDraftLabel = this.boxDrawPurpose === 'prompt' ? this.boxPromptLabel : 1;
        this.boxStart = point;
        this.boxEnd = point;
      }
    } else if (e.button === 1) {
      this.isPanning = true;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      this.container.style.cursor = 'grabbing';
    }
  }

  onMouseMove(e) {
    if (this.isDraggingAnnotation && this.dragAnnotation && this.dragOperation && this.dragStart && this.dragOriginal) {
      const point = this.screenToImage(e.clientX, e.clientY);
      const dx = point[0] - this.dragStart[0];
      const dy = point[1] - this.dragStart[1];
      const tolerance = 3 / this.imageScale();
      if (!this.dragMoved && Math.abs(dx) <= tolerance && Math.abs(dy) <= tolerance) return;
      this.dragMoved = true;
      if (!this.dragStartedHistory) {
        if (this.onAnnotationEditStart) this.onAnnotationEditStart(this.dragAnnotation);
        this.dragStartedHistory = true;
      }
      if (this.dragOperation.operation === 'move') this.applyMoveGeometry(this.dragAnnotation, this.dragOriginal, dx, dy);
      else if (this.dragOperation.operation === 'bbox-handle') this.applyBboxResize(this.dragAnnotation, this.dragOriginal, this.dragOperation.handle, point);
      else if (this.dragOperation.operation === 'polygon-vertex') this.applyPolygonVertexDrag(this.dragAnnotation, this.dragOriginal, this.dragOperation.vertexIndex, point);
      this.requestDraw();
      return;
    }
    if (this.isPanning) {
      const dx = e.clientX - this.lastX;
      const dy = e.clientY - this.lastY;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      this.pendingPanDx += dx;
      this.pendingPanDy += dy;
      if (!this.panFrame) {
        this.panFrame = requestAnimationFrame(() => {
          const panDx = this.pendingPanDx;
          const panDy = this.pendingPanDy;
          this.pendingPanDx = 0;
          this.pendingPanDy = 0;
          this.panFrame = null;
          this.panByPixels(panDx, panDy);
        });
      }
      return;
    }
    if (this.isDrawingBox) {
      this.boxEnd = this.screenToImage(e.clientX, e.clientY);
      this.requestDraw();
    }
  }

  onMouseUp(e) {
    if (this.isDraggingAnnotation && this.dragAnnotation) {
      const updated = this.dragAnnotation;
      const moved = this.dragMoved;
      this.isDraggingAnnotation = false;
      this.dragOperation = null;
      this.dragStart = null;
      this.dragAnnotation = null;
      this.dragOriginal = null;
      this.dragMoved = false;
      this.dragStartedHistory = false;
      this.staticExcludeAnnotationId = null;
      this.requestStaticRedraw(true);
      if (moved && this.onAnnotationUpdated) this.onAnnotationUpdated(updated, { commit: true });
      this.updateCursor();
      this.requestDraw();
      return;
    }

    if (this.isDrawingBox && this.boxStart && this.boxEnd) {
      const x1 = Math.min(this.boxStart[0], this.boxEnd[0]);
      const y1 = Math.min(this.boxStart[1], this.boxEnd[1]);
      const x2 = Math.max(this.boxStart[0], this.boxEnd[0]);
      const y2 = Math.max(this.boxStart[1], this.boxEnd[1]);
      if (Math.abs(x2 - x1) > 2 && Math.abs(y2 - y1) > 2) {
        if (this.boxDrawPurpose === 'annotation') {
          if (this.onAnnotationCreated) this.onAnnotationCreated({ bbox: [x1, y1, x2, y2] });
        } else if (this.onPromptAdded) {
          this.onPromptAdded('box', [x1, y1, x2, y2, this.boxDraftLabel]);
        }
      }
    }
    this.isPanning = false;
    this.isDrawingBox = false;
    this.boxDrawPurpose = 'prompt';
    this.boxStart = null;
    this.boxEnd = null;
    this.updateCursor();
    this.requestDraw();
  }

  onDoubleClick(e) {
    if (this.promptMode !== 'manual-polygon') return;
    e.preventDefault();
    this.finishManualPolygon();
  }

  onKeyDown(e) {
    if (e.key === 'Escape') {
      if (this.promptMode === 'manual-polygon' && this.activePolygonPoints.length > 0) {
        e.preventDefault();
        this.cancelManualPolygon();
        return;
      }
      if (this.focusedAnnotationId) {
        e.preventDefault();
        this.focusedAnnotationId = null;
        if (this.onAnnotationSelected) this.onAnnotationSelected(null);
        this.requestDraw();
      }
    } else if (this.promptMode === 'manual-polygon' && e.key === 'Enter') {
      e.preventDefault();
      this.finishManualPolygon();
    } else if (e.altKey) {
      this.container.style.cursor = 'grab';
    }
  }

  onKeyUp(e) {
    if (!e.altKey) {
      if (this.isPanning) this.isPanning = false;
      this.updateCursor();
    }
  }

  finishManualPolygon() {
    if (this.activePolygonPoints.length < 3) return false;
    const polygon = this.activePolygonPoints.map((p) => this.clampPoint(p));
    const bbox = this.bboxFromPolygon(polygon);
    this.activePolygonPoints = [];
    if (bbox && this.onAnnotationCreated) {
      this.onAnnotationCreated({ polygon, bbox });
      this.requestDraw();
      return true;
    }
    this.requestDraw();
    return false;
  }

  cancelManualPolygon() {
    this.activePolygonPoints = [];
    this.requestDraw();
  }

  centerTransformOnBbox(bbox) {
    if (!this.viewer?.viewport || !this.image || !Array.isArray(bbox) || bbox.length !== 4) return false;
    const OpenSeadragon = window.OpenSeadragon;
    const [x1, y1, x2, y2] = bbox.map((v) => Number(v || 0));
    const w = this.image.width || 1;
    const rect = new OpenSeadragon.Rect(
      x1 / w, y1 / w,
      Math.max(1, x2 - x1) / w, Math.max(1, y2 - y1) / w,
    );
    this.viewer.viewport.fitBoundsWithConstraints(rect, true);
    this.onViewportChanged();
    return true;
  }

  drawPath(points, close = true) {
    const pairs = this.pointPairs(points);
    if (pairs.length === 0) return [];
    const screen = pairs.map((p) => this.imageToScreen(p));
    this.ctx.beginPath();
    this.ctx.moveTo(screen[0][0], screen[0][1]);
    for (let i = 1; i < screen.length; i += 1) this.ctx.lineTo(screen[i][0], screen[i][1]);
    if (close) this.ctx.closePath();
    return screen;
  }

  drawAnnotation(ann, isPreview = false) {
    const color = isPreview ? 'rgba(66, 153, 225, 0.9)' : (ann.color || this.getColorForClass(ann.class_name));
    const geom = this.getAnnotationGeometry(ann);
    const points = geom.polygon;
    const paths = (geom.polygons && geom.polygons.length > 0)
      ? geom.polygons
      : (points && points.length > 2 ? [points] : []);
    if (this.options.showMasks && paths.length > 0) {
      for (const path of paths) {
        this.drawPath(path, true);
        const alpha = isPreview ? 0.45 : 0.3;
        this.ctx.fillStyle = this.colorWithAlpha(color, alpha);
        this.ctx.fill();
        this.ctx.strokeStyle = isPreview ? 'rgba(255, 255, 255, 0.8)' : color;
        if (isPreview) this.ctx.setLineDash([4, 4]);
        this.ctx.lineWidth = isPreview ? 2 : 1.5;
        this.ctx.stroke();
        this.ctx.setLineDash([]);
      }
    }

    const bbox = geom.bbox;
    if (bbox) {
      const p1 = this.imageToScreen([bbox[0], bbox[1]]);
      const p2 = this.imageToScreen([bbox[2], bbox[3]]);
      this.ctx.strokeStyle = isPreview ? 'rgba(66, 153, 225, 1)' : color;
      if (isPreview) this.ctx.setLineDash([2, 2]);
      this.ctx.lineWidth = 1;
      this.ctx.strokeRect(p1[0], p1[1], p2[0] - p1[0], p2[1] - p1[1]);
      this.ctx.setLineDash([]);
    }

    if (!isPreview) {
      const labelPoint = bbox ? [bbox[0], bbox[1]] : (points.length > 0 ? points[0] : null);
      if (labelPoint && this.imageScale() > 0.08) {
        const pos = this.imageToScreen(labelPoint);
        this.ctx.fillStyle = color;
        this.ctx.font = '600 12px Inter, sans-serif';
        this.ctx.fillText(ann.class_name || ann.label || 'Object', pos[0], pos[1] - 4);
      }
    }
  }

  drawPrompt(p) {
    this.ctx.fillStyle = '#3182ce';
    this.ctx.strokeStyle = '#fff';
    this.ctx.lineWidth = 1;
    if (p.type === 'point') {
      const pos = this.imageToScreen(p.data);
      this.ctx.beginPath();
      this.ctx.arc(pos[0], pos[1], 5, 0, Math.PI * 2);
      this.ctx.fill();
      this.ctx.stroke();
    } else if (p.type === 'box') {
      const positive = p.data.length < 5 || Number(p.data[4]) !== 0;
      const p1 = this.imageToScreen([p.data[0], p.data[1]]);
      const p2 = this.imageToScreen([p.data[2], p.data[3]]);
      this.ctx.strokeStyle = positive ? '#16a34a' : '#dc2626';
      this.ctx.setLineDash(positive ? [] : [5, 4]);
      this.ctx.lineWidth = 2;
      this.ctx.strokeRect(p1[0], p1[1], p2[0] - p1[0], p2[1] - p1[1]);
      this.ctx.fillStyle = positive ? '#16a34a' : '#dc2626';
      this.ctx.font = '800 14px Inter, sans-serif';
      this.ctx.fillText(positive ? '+' : '−', p1[0] + 4, p1[1] + 16);
      this.ctx.setLineDash([]);
    }
  }

  drawBoxDraft() {
    const p1 = this.imageToScreen(this.boxStart);
    const p2 = this.imageToScreen(this.boxEnd);
    this.ctx.strokeStyle = this.boxDraftLabel === 0 ? 'rgba(220, 38, 38, 0.9)' : 'rgba(22, 163, 74, 0.9)';
    this.ctx.setLineDash([5, 5]);
    this.ctx.lineWidth = 2;
    this.ctx.strokeRect(p1[0], p1[1], p2[0] - p1[0], p2[1] - p1[1]);
    this.ctx.setLineDash([]);
  }

  drawHandle(point, color = '#ffffff') {
    const pos = this.imageToScreen(point);
    this.ctx.beginPath();
    this.ctx.arc(pos[0], pos[1], 5, 0, Math.PI * 2);
    this.ctx.fillStyle = color;
    this.ctx.fill();
    this.ctx.strokeStyle = '#111827';
    this.ctx.lineWidth = 1.5;
    this.ctx.stroke();
  }

  drawFocusedHandles() {
    if (!this.focusedAnnotationId) return;
    const ann = this.annotations.find((item) => String(item?.id || '') === String(this.focusedAnnotationId));
    if (!ann) return;
    const color = ann.color || this.getColorForClass(ann.class_name);
    const geom = this.getAnnotationGeometry(ann);
    const polygon = geom.polygon;
    const bbox = geom.bbox;
    const focusPaths = (geom.polygons && geom.polygons.length > 0)
      ? geom.polygons
      : (polygon.length >= 3 ? [polygon] : []);
    for (const path of focusPaths) {
      this.drawPath(path, true);
      this.ctx.strokeStyle = color;
      this.ctx.lineWidth = 2;
      this.ctx.setLineDash([6, 4]);
      this.ctx.stroke();
      this.ctx.setLineDash([]);
    }
    if (polygon.length >= 3 && this.shouldDrawPolygonVertices(polygon)) {
      polygon.forEach((point) => this.drawHandle(point, '#ffffff'));
    }
    if (!bbox) return;
    const p1 = this.imageToScreen([bbox[0], bbox[1]]);
    const p2 = this.imageToScreen([bbox[2], bbox[3]]);
    this.ctx.strokeStyle = color;
    this.ctx.lineWidth = 2;
    this.ctx.strokeRect(p1[0], p1[1], p2[0] - p1[0], p2[1] - p1[1]);
    this.bboxHandles(bbox).forEach((handle) => this.drawHandle(handle.point, '#ffffff'));
  }

  shouldDrawPolygonVertices(polygon) {
    if (!Array.isArray(polygon) || polygon.length === 0) return false;
    if (polygon.length <= 80) return true;
    if (polygon.length > 240) return false;
    return this.imageScale() >= 0.35;
  }

  drawActivePolygon() {
    if (this.activePolygonPoints.length === 0) return;
    const screen = this.activePolygonPoints.map((p) => this.imageToScreen(p));
    this.ctx.strokeStyle = '#3182ce';
    this.ctx.fillStyle = 'rgba(49, 130, 206, 0.12)';
    this.ctx.lineWidth = 2;
    this.ctx.beginPath();
    this.ctx.moveTo(screen[0][0], screen[0][1]);
    for (let i = 1; i < screen.length; i += 1) this.ctx.lineTo(screen[i][0], screen[i][1]);
    if (screen.length >= 3) {
      this.ctx.closePath();
      this.ctx.fill();
    }
    this.ctx.stroke();
    this.activePolygonPoints.forEach((point, index) => this.drawHandle(point, index === 0 ? '#93c5fd' : '#ffffff'));
  }

  getColorForClass(className) {
    let hash = 0;
    const str = String(className || 'unknown');
    for (let i = 0; i < str.length; i += 1) hash = str.charCodeAt(i) + ((hash << 5) - hash);
    return `hsl(${Math.abs(hash) % 360}, 75%, 50%)`;
  }

  colorWithAlpha(color, alpha) {
    const value = String(color || '').trim();
    if (value.startsWith('rgba')) return value;
    if (value.startsWith('rgb(')) return value.replace(/^rgb\((.*)\)$/i, `rgba($1, ${alpha})`);
    if (value.startsWith('hsl(')) return value.replace(/^hsl\((.*)\)$/i, `hsla($1, ${alpha})`);
    if (/^#[0-9a-f]{6}$/i.test(value)) {
      const r = parseInt(value.slice(1, 3), 16);
      const g = parseInt(value.slice(3, 5), 16);
      const b = parseInt(value.slice(5, 7), 16);
      return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }
    return value || `rgba(49, 130, 206, ${alpha})`;
  }
}
