export class CanvasViewer {
  constructor(containerId) {
    this.container = document.getElementById(containerId);
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d');
    
    // Set styles to fill container
    this.canvas.style.display = 'block';
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
    this.container.appendChild(this.canvas);
    this.container.style.cursor = 'default';
    
    // State
    this.image = null;
    this.annotations = [];
    this.previews = []; // Temporary SAM results
    this.transform = { x: 0, y: 0, scale: 1 };
    this.focusedAnnotationId = null;
    this.imageLoadToken = 0;
    this.fitMode = true;
    this.fitFrame = null;
    this.fitRetryCount = 0;
    
    // Interaction state
    this.isPanning = false;
    this.lastX = 0;
    this.lastY = 0;
    
    // Prompting state
    this.promptMode = 'pointer'; // 'pointer', 'point', 'box'
    this.prompts = [];
    this.isDrawingBox = false;
    this.boxDrawPurpose = 'prompt';
    this.boxStart = null;
    this.onPromptAdded = null;
    this.options = { showMasks: true };

    // Manual annotation editing state
    this.onAnnotationSelected = null;
    this.onAnnotationEditStart = null;
    this.onAnnotationUpdated = null;
    this.onAnnotationCreated = null;
    this.isDraggingAnnotation = false;
    this.dragOperation = null;
    this.dragStart = null;
    this.dragAnnotation = null;
    this.dragOriginal = null;
    this.dragMoved = false;
    this.dragStartedHistory = false;
    this.activePolygonPoints = [];
    
    // Bind methods
    this.onResize = this.onResize.bind(this);
    this.onWheel = this.onWheel.bind(this);
    this.onMouseDown = this.onMouseDown.bind(this);
    this.onMouseMove = this.onMouseMove.bind(this);
    this.onMouseUp = this.onMouseUp.bind(this);
    this.onDoubleClick = this.onDoubleClick.bind(this);
    this.onKeyDown = this.onKeyDown.bind(this);
    this.onKeyUp = this.onKeyUp.bind(this);
    
    // Listeners
    window.addEventListener('resize', this.onResize);
    this.canvas.addEventListener('wheel', this.onWheel, {passive: false});
    this.canvas.addEventListener('mousedown', this.onMouseDown);
    this.canvas.addEventListener('dblclick', this.onDoubleClick);
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
    this.canvas.removeEventListener('wheel', this.onWheel);
    this.canvas.removeEventListener('mousedown', this.onMouseDown);
    this.canvas.removeEventListener('dblclick', this.onDoubleClick);
    window.removeEventListener('mousemove', this.onMouseMove);
    window.removeEventListener('mouseup', this.onMouseUp);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    if (this.resizeObserver) this.resizeObserver.disconnect();
    if (this.fitFrame) cancelAnimationFrame(this.fitFrame);
    this.canvas.remove();
  }

  onKeyDown(e) {
    if (this.promptMode === 'manual-polygon') {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.finishManualPolygon();
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        this.cancelManualPolygon();
        return;
      }
    }
    if (e.altKey) {
      this.container.style.cursor = 'grab';
    }
  }

  onKeyUp(e) {
    if (!e.altKey) {
      if (this.isPanning) {
        this.isPanning = false;
      }
      this.updateCursor();
    }
  }
  
  getContainerSize() {
    const rect = this.container.getBoundingClientRect();
    const width = Math.round(rect.width || this.container.clientWidth || 0);
    const height = Math.round(rect.height || this.container.clientHeight || 0);
    return { width, height };
  }

  syncCanvasSize() {
    const oldWidth = this.canvas.width;
    const oldHeight = this.canvas.height;
    const { width, height } = this.getContainerSize();

    if (width <= 0 || height <= 0) return false;
    if (this.canvas.width === width && this.canvas.height === height) return;

    this.canvas.width = width;
    this.canvas.height = height;

    if (this.image && oldWidth > 0 && oldHeight > 0) {
      if (this.fitMode) {
        this.fitToScreen();
        return true;
      }

      const centerX = (oldWidth - this.image.width * this.transform.scale) / 2;
      const centerY = (oldHeight - this.image.height * this.transform.scale) / 2;

      const isWasCenteredX = Math.abs(this.transform.x - centerX) < 2;
      const isWasCenteredY = Math.abs(this.transform.y - centerY) < 2;

      if (isWasCenteredX) {
        this.transform.x = (this.canvas.width - this.image.width * this.transform.scale) / 2;
      }
      if (isWasCenteredY) {
        this.transform.y = (this.canvas.height - this.image.height * this.transform.scale) / 2;
      }
    }

    return true;
  }

  onResize() {
    this.syncCanvasSize();
    this.draw();
  }

  clearImage() {
    this.imageLoadToken++;
    this.image = null;
    this.annotations = [];
    this.previews = [];
    this.prompts = [];
    this.focusedAnnotationId = null;
    this.isPanning = false;
    this.isDrawingBox = false;
    this.boxDrawPurpose = 'prompt';
    this.boxStart = null;
    this.boxEnd = null;
    this.isDraggingAnnotation = false;
    this.dragOperation = null;
    this.dragStart = null;
    this.dragAnnotation = null;
    this.dragOriginal = null;
    this.dragMoved = false;
    this.dragStartedHistory = false;
    this.activePolygonPoints = [];
    if (this.fitFrame) {
      cancelAnimationFrame(this.fitFrame);
      this.fitFrame = null;
    }
    this.draw();
  }

  setImage(img) {
    if (!img) return false;
    this.image = img;
    this.isPanning = false;
    this.isDrawingBox = false;
    this.boxDrawPurpose = 'prompt';
    this.boxStart = null;
    this.boxEnd = null;
    this.isDraggingAnnotation = false;
    this.dragMoved = false;
    this.dragStartedHistory = false;
    this.fitMode = true;
    this.syncCanvasSize();
    this.fitToScreen();
    this.scheduleFitToScreen();
    return true;
  }
  
  async loadImage(src, options = {}) {
    const commit = options.commit !== false;
    const token = ++this.imageLoadToken;
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        if (token !== this.imageLoadToken) {
          resolve(false);
          return;
        }
        if (commit) {
          this.setImage(img);
          resolve(true);
        } else {
          resolve(img);
        }
      };
      img.onerror = (error) => {
        if (token !== this.imageLoadToken) {
          resolve(false);
          return;
        }
        reject(error);
      };
      img.src = src;
    });
  }
  
  setAnnotations(anns) {
    this.annotations = anns || [];
    this.draw();
  }

  setFocusedAnnotation(annotationId = null, options = {}) {
    this.focusedAnnotationId = annotationId || null;
    if (options.draw !== false) this.draw();
  }

  focusAnnotation(annotationId = null, bbox = null) {
    this.focusedAnnotationId = annotationId || null;
    if (annotationId && bbox) {
      this.centerTransformOnBbox(bbox);
    }
    this.draw();
  }

  setPreviews(previews) {
    this.previews = previews || [];
    this.draw();
  }
  
  setPromptMode(mode) {
    this.promptMode = mode;
    if (mode !== 'manual-polygon' && this.activePolygonPoints.length > 0) {
      this.activePolygonPoints = [];
    }
    this.updateCursor();
    this.draw();
  }

  setOptions(nextOptions = {}) {
    this.options = { ...this.options, ...nextOptions };
    this.draw();
  }
  
  setPrompts(prompts) {
    this.prompts = prompts || [];
    this.draw();
  }

  clearPrompts() {
    this.prompts = [];
    this.draw();
  }

  getPrompts() {
    return this.prompts.map(p => ({
      type: p.type,
      data: p.data 
    }));
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

  canvasToImage(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const mx = clientX - rect.left;
    const my = clientY - rect.top;
    return [
      (mx - this.transform.x) / this.transform.scale,
      (my - this.transform.y) / this.transform.scale,
    ];
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

  bboxFromPolygon(points) {
    const pairs = this.polygonToPairs(points);
    if (pairs.length === 0) return null;
    const xs = pairs.map((p) => Number(p[0] || 0));
    const ys = pairs.map((p) => Number(p[1] || 0));
    return [
      Math.min(...xs),
      Math.min(...ys),
      Math.max(...xs),
      Math.max(...ys),
    ];
  }

  getAnnotationBbox(ann) {
    const bbox = this.normalizeBbox(ann?.bbox || ann?.bbox_xyxy || ann?.box);
    if (bbox) return bbox;
    return this.bboxFromPolygon(ann?.polygon || ann?.points);
  }

  setAnnotationBbox(ann, bbox) {
    const next = this.normalizeBbox(bbox);
    if (!next) return;
    ann.bbox = next;
    delete ann.box;
    delete ann.bbox_xyxy;
  }

  pointInBbox(point, bbox) {
    if (!bbox) return false;
    const [x, y] = point;
    return x >= bbox[0] && x <= bbox[2] && y >= bbox[1] && y <= bbox[3];
  }

  pointInPolygon(point, polygon) {
    const pts = this.polygonToPairs(polygon);
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
    const tolerance = 8 / Math.max(this.transform.scale, 0.01);
    const selected = this.focusedAnnotationId
      ? this.annotations.find((ann) => String(ann?.id || '') === String(this.focusedAnnotationId))
      : null;

    if (selected) {
      const polygon = this.polygonToPairs(selected.polygon || selected.points);
      if (polygon.length >= 3) {
        for (let i = 0; i < polygon.length; i += 1) {
          if (this.distance(point, polygon[i]) <= tolerance) {
            return { annotation: selected, operation: 'polygon-vertex', vertexIndex: i };
          }
        }
      } else {
        const bbox = this.getAnnotationBbox(selected);
        for (const handle of this.bboxHandles(bbox)) {
          if (this.distance(point, handle.point) <= tolerance) {
            return { annotation: selected, operation: 'bbox-handle', handle: handle.name };
          }
        }
      }
    }

    for (let i = this.annotations.length - 1; i >= 0; i -= 1) {
      const ann = this.annotations[i];
      const polygon = ann?.polygon || ann?.points;
      if (this.pointInPolygon(point, polygon)) {
        return { annotation: ann, operation: 'move' };
      }
      const bbox = this.getAnnotationBbox(ann);
      if (this.pointInBbox(point, bbox)) {
        return { annotation: ann, operation: 'move' };
      }
    }
    return null;
  }

  cloneGeometry(ann) {
    return {
      bbox: ann?.bbox ? [...ann.bbox] : null,
      polygon: ann?.polygon ? this.polygonToPairs(ann.polygon).map((p) => [...p]) : null,
      points: ann?.points ? this.polygonToPairs(ann.points).map((p) => [...p]) : null,
    };
  }

  applyMoveGeometry(ann, original, dx, dy) {
    if (original.polygon && original.polygon.length > 0) {
      ann.polygon = original.polygon.map((p) => this.clampPoint([p[0] + dx, p[1] + dy]));
      delete ann.points;
      const bbox = this.bboxFromPolygon(ann.polygon);
      if (bbox) this.setAnnotationBbox(ann, bbox);
      return;
    }
    if (original.points && original.points.length > 0) {
      ann.polygon = original.points.map((p) => this.clampPoint([p[0] + dx, p[1] + dy]));
      delete ann.points;
      const bbox = this.bboxFromPolygon(ann.polygon);
      if (bbox) this.setAnnotationBbox(ann, bbox);
      return;
    }
    const bbox = original.bbox || this.getAnnotationBbox(ann);
    if (bbox) this.setAnnotationBbox(ann, [bbox[0] + dx, bbox[1] + dy, bbox[2] + dx, bbox[3] + dy]);
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
    const bbox = this.bboxFromPolygon(points);
    if (bbox) this.setAnnotationBbox(ann, bbox);
  }
  
  fitToScreen() {
    if(!this.image) return;
    if (this.syncCanvasSize() === false) {
      this.scheduleFitToScreen();
      return;
    }
    this.fitRetryCount = 0;

    const padding = Math.min(60, Math.max(0, Math.min(this.canvas.width, this.canvas.height) * 0.16));
    const availableWidth = Math.max(1, this.canvas.width - padding);
    const availableHeight = Math.max(1, this.canvas.height - padding);
    const wr = availableWidth / this.image.width;
    const hr = availableHeight / this.image.height;
    this.transform.scale = Math.max(0.01, Math.min(wr, hr, 1.0));
    this.transform.x = (this.canvas.width - this.image.width * this.transform.scale) / 2;
    this.transform.y = (this.canvas.height - this.image.height * this.transform.scale) / 2;
    this.fitMode = true;
    this.draw();
  }

  scheduleFitToScreen() {
    if (this.fitRetryCount > 20) return;
    this.fitRetryCount += 1;
    if (this.fitFrame) cancelAnimationFrame(this.fitFrame);
    this.fitFrame = requestAnimationFrame(() => {
      this.fitFrame = requestAnimationFrame(() => {
        this.fitFrame = null;
        this.fitToScreen();
      });
    });
  }
  
  onWheel(e) {
    e.preventDefault();
    const zoomFactor = 1.15;
    const direction = e.deltaY < 0 ? 1 : -1;
    
    const rect = this.canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    
    const scaleChange = direction > 0 ? zoomFactor : 1 / zoomFactor;
    const newScale = this.transform.scale * scaleChange;
    
    if (newScale < 0.01 || newScale > 100) return;
    
    this.transform.x = mx - (mx - this.transform.x) * scaleChange;
    this.transform.y = my - (my - this.transform.y) * scaleChange;
    this.transform.scale = newScale;
    this.fitMode = false;
    
    this.draw();
  }
  
  onMouseDown(e) {
    const [imgXRaw, imgYRaw] = this.canvasToImage(e.clientX, e.clientY);
    const [imgX, imgY] = this.clampPoint([imgXRaw, imgYRaw]);

    // Alt + Left Click to Pan (always available)
    if (e.button === 0 && e.altKey) {
      this.isPanning = true;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      this.container.style.cursor = 'grabbing';
      return;
    }

    // Pan mode: left click drags
    if (e.button === 0 && this.promptMode === 'pan') {
      this.isPanning = true;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      this.container.style.cursor = 'grabbing';
      return;
    }

    if (e.button === 0 && this.promptMode === 'pointer') {
      const hit = this.hitTestAnnotation([imgX, imgY]);
      if (hit?.annotation) {
        this.focusedAnnotationId = hit.annotation.id || null;
        if (this.onAnnotationSelected) this.onAnnotationSelected(this.focusedAnnotationId);
        this.isDraggingAnnotation = true;
        this.dragOperation = hit;
        this.dragStart = [imgX, imgY];
        this.dragAnnotation = hit.annotation;
        this.dragOriginal = this.cloneGeometry(hit.annotation);
        this.dragMoved = false;
        this.dragStartedHistory = false;
        this.container.style.cursor = hit.operation === 'move' ? 'move' : 'grabbing';
        this.draw();
        return;
      }
      this.focusedAnnotationId = null;
      if (this.onAnnotationSelected) this.onAnnotationSelected(null);
      this.isPanning = true;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      this.container.style.cursor = 'grabbing';
      this.draw();
      return;
    }

    if (e.button === 0 && this.promptMode === 'manual-polygon') {
      if (e.detail >= 2) {
        this.finishManualPolygon();
        return;
      }
      if (this.activePolygonPoints.length >= 3 && this.distance([imgX, imgY], this.activePolygonPoints[0]) <= (10 / Math.max(this.transform.scale, 0.01))) {
        this.finishManualPolygon();
        return;
      }
      this.activePolygonPoints.push([imgX, imgY]);
      this.draw();
      return;
    }

    if (e.button === 0) { // Left click in annotation modes
      if (this.promptMode === 'point') {
        if (this.onPromptAdded) this.onPromptAdded('point', [imgX, imgY]);
      } else if (this.promptMode === 'box') {
        this.isDrawingBox = true;
        this.boxDrawPurpose = 'prompt';
        this.boxStart = [imgX, imgY];
      } else if (this.promptMode === 'manual-box') {
        this.isDrawingBox = true;
        this.boxDrawPurpose = 'annotation';
        this.boxStart = [imgX, imgY];
      }
    } else if (e.button === 1) { // Middle click pan
       this.isPanning = true;
       this.lastX = e.clientX;
       this.lastY = e.clientY;
       this.container.style.cursor = 'grabbing';
    }
  }
  
  onMouseMove(e) {
    if (this.isDraggingAnnotation && this.dragAnnotation && this.dragOperation && this.dragStart && this.dragOriginal) {
      const point = this.clampPoint(this.canvasToImage(e.clientX, e.clientY));
      const dx = point[0] - this.dragStart[0];
      const dy = point[1] - this.dragStart[1];
      if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) this.dragMoved = true;
      if (this.dragMoved && !this.dragStartedHistory) {
        if (this.onAnnotationEditStart) this.onAnnotationEditStart(this.dragAnnotation);
        this.dragStartedHistory = true;
      }
      if (this.dragOperation.operation === 'move') {
        this.applyMoveGeometry(this.dragAnnotation, this.dragOriginal, dx, dy);
      } else if (this.dragOperation.operation === 'bbox-handle') {
        this.applyBboxResize(this.dragAnnotation, this.dragOriginal, this.dragOperation.handle, point);
      } else if (this.dragOperation.operation === 'polygon-vertex') {
        this.applyPolygonVertexDrag(this.dragAnnotation, this.dragOriginal, this.dragOperation.vertexIndex, point);
      }
      this.draw();
    } else if (this.isPanning) {
      const dx = e.clientX - this.lastX;
      const dy = e.clientY - this.lastY;
      this.transform.x += dx;
      this.transform.y += dy;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      this.fitMode = false;
      this.draw();
    } else if (this.isDrawingBox) {
      this.boxEnd = this.clampPoint(this.canvasToImage(e.clientX, e.clientY));
      this.draw();
    }
  }
  
  onMouseUp(e) {
    if (this.isDraggingAnnotation && this.dragAnnotation) {
      const updated = this.dragAnnotation;
      this.isDraggingAnnotation = false;
      this.dragOperation = null;
      this.dragStart = null;
      this.dragAnnotation = null;
      this.dragOriginal = null;
      const moved = this.dragMoved;
      this.dragMoved = false;
      this.dragStartedHistory = false;
      if (moved && this.onAnnotationUpdated) this.onAnnotationUpdated(updated, { commit: true });
      this.updateCursor();
      this.draw();
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
          this.onPromptAdded('box', [x1, y1, x2, y2]);
        }
      }
    }
    this.isPanning = false;
    this.isDrawingBox = false;
    this.boxDrawPurpose = 'prompt';
    this.boxStart = null;
    this.boxEnd = null;
    this.container.style.cursor = e.altKey ? 'grab' : 'default';
    this.updateCursor();
  }

  onDoubleClick(e) {
    if (this.promptMode !== 'manual-polygon') return;
    e.preventDefault();
    this.finishManualPolygon();
  }

  finishManualPolygon() {
    if (this.activePolygonPoints.length < 3) return;
    const polygon = this.activePolygonPoints.map((p) => this.clampPoint(p));
    const bbox = this.bboxFromPolygon(polygon);
    this.activePolygonPoints = [];
    if (bbox && this.onAnnotationCreated) {
      this.onAnnotationCreated({ polygon, bbox });
    }
    this.draw();
  }

  cancelManualPolygon() {
    this.activePolygonPoints = [];
    this.draw();
  }
  
  draw() {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (!this.image) return;
    
    this.ctx.save();
    this.ctx.translate(this.transform.x, this.transform.y);
    this.ctx.scale(this.transform.scale, this.transform.scale);
    
    // Draw image
    this.ctx.drawImage(this.image, 0, 0);
    
    const visibleAnnotations = this.annotations;

    // Draw annotations (Permanent)
    for(const ann of visibleAnnotations) {
      this.drawAnnotation(ann, false);
    }
    
    // Draw previews (Temporary SAM results)
    for(const pre of this.previews) {
      this.drawAnnotation(pre, true);
    }
    
    // Draw current prompts
    for(const p of this.prompts) {
      this.drawPrompt(p);
    }

    this.drawFocusedHandles();
    this.drawActivePolygon();
    
    // Draw currently drag-drawing box
    if (this.isDrawingBox && this.boxStart && this.boxEnd) {
      this.ctx.strokeStyle = 'rgba(49, 130, 206, 0.8)';
      this.ctx.setLineDash([5, 5]);
      this.ctx.lineWidth = 2 / this.transform.scale;
      this.ctx.strokeRect(this.boxStart[0], this.boxStart[1], this.boxEnd[0] - this.boxStart[0], this.boxEnd[1] - this.boxStart[1]);
      this.ctx.setLineDash([]);
    }
    
    this.ctx.restore();
  }
  
  drawPrompt(p) {
    this.ctx.fillStyle = '#3182ce';
    this.ctx.strokeStyle = '#fff';
    this.ctx.lineWidth = 1 / this.transform.scale;
    
    if (p.type === 'point') {
       const [x, y] = p.data;
       const radius = 5 / this.transform.scale;
       this.ctx.beginPath();
       this.ctx.arc(x, y, radius, 0, Math.PI * 2);
       this.ctx.fill();
       this.ctx.stroke();
    } else if (p.type === 'box') {
       const [x1, y1, x2, y2] = p.data;
       this.ctx.strokeStyle = '#3182ce';
       this.ctx.setLineDash([2, 2]);
       this.ctx.lineWidth = 1.5 / this.transform.scale;
       this.ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
       this.ctx.setLineDash([]);
    }
  }
  
  drawAnnotation(ann, isPreview = false) {
    const color = isPreview ? 'rgba(66, 153, 225, 0.9)' : (ann.color || this.getColorForClass(ann.class_name));
    
    const points = ann.points || ann.polygon;
    if (this.options.showMasks && points && points.length > 2) {
      this.ctx.beginPath();
      if (typeof points[0] === 'number') {
        this.ctx.moveTo(points[0], points[1]);
        for (let i = 2; i < points.length; i += 2) {
          this.ctx.lineTo(points[i], points[i+1]);
        }
      } else {
        this.ctx.moveTo(points[0][0], points[0][1]);
        for (let i = 1; i < points.length; i++) {
          this.ctx.lineTo(points[i][0], points[i][1]);
        }
      }
      this.ctx.closePath();
      
      const alpha = isPreview ? 0.45 : 0.3;
      if (color.startsWith('rgba')) {
         this.ctx.fillStyle = color; // Already has alpha if previews use rgba
      } else {
         this.ctx.fillStyle = color.replace('hsl', 'hsla').replace(')', `, ${alpha})`);
      }
      
      this.ctx.fill();
      this.ctx.strokeStyle = isPreview ? 'rgba(255, 255, 255, 0.8)' : color;
      if (isPreview) this.ctx.setLineDash([4, 4]);
      this.ctx.lineWidth = (isPreview ? 2 : 1.5) / this.transform.scale;
      this.ctx.stroke();
      this.ctx.setLineDash([]);
    } 
    
    const bbox = ann.bbox || ann.box; 
    if (bbox && bbox.length === 4) {
      const [x1, y1, x2, y2] = bbox;
      this.ctx.strokeStyle = isPreview ? 'rgba(66, 153, 225, 1)' : color;
      if (isPreview) this.ctx.setLineDash([2, 2]);
      this.ctx.lineWidth = 1 / this.transform.scale;
      this.ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
      this.ctx.setLineDash([]);
    }
    
    if (!isPreview) {
      const polyPairs = this.polygonToPairs(points);
      const labelPos = bbox ? [bbox[0], bbox[1]] : (polyPairs.length > 0 ? polyPairs[0] : null);
      if (labelPos) {
         this.ctx.fillStyle = color;
         const fontSize = 12 / this.transform.scale;
         this.ctx.font = `600 ${fontSize}px Inter, sans-serif`;
         const text = ann.class_name || ann.label || 'Object';
         this.ctx.fillText(`${text}`, labelPos[0], labelPos[1] - 4 / this.transform.scale);
      }
    }
  }

  drawHandle(point, color = '#ffffff') {
    const radius = 5 / Math.max(this.transform.scale, 0.01);
    this.ctx.beginPath();
    this.ctx.arc(point[0], point[1], radius, 0, Math.PI * 2);
    this.ctx.fillStyle = color;
    this.ctx.fill();
    this.ctx.strokeStyle = '#111827';
    this.ctx.lineWidth = 1.5 / Math.max(this.transform.scale, 0.01);
    this.ctx.stroke();
  }

  drawFocusedHandles() {
    if (!this.focusedAnnotationId) return;
    const ann = this.annotations.find((item) => String(item?.id || '') === String(this.focusedAnnotationId));
    if (!ann) return;
    const color = ann.color || this.getColorForClass(ann.class_name);
    const polygon = this.polygonToPairs(ann.polygon || ann.points);
    if (polygon.length >= 3) {
      this.ctx.strokeStyle = color;
      this.ctx.lineWidth = 2 / Math.max(this.transform.scale, 0.01);
      this.ctx.setLineDash([6 / Math.max(this.transform.scale, 0.01), 4 / Math.max(this.transform.scale, 0.01)]);
      this.ctx.beginPath();
      this.ctx.moveTo(polygon[0][0], polygon[0][1]);
      for (let i = 1; i < polygon.length; i += 1) this.ctx.lineTo(polygon[i][0], polygon[i][1]);
      this.ctx.closePath();
      this.ctx.stroke();
      this.ctx.setLineDash([]);
      polygon.forEach((point) => this.drawHandle(point, '#ffffff'));
      return;
    }
    const bbox = this.getAnnotationBbox(ann);
    if (!bbox) return;
    const [x1, y1, x2, y2] = bbox;
    this.ctx.strokeStyle = color;
    this.ctx.lineWidth = 2 / Math.max(this.transform.scale, 0.01);
    this.ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
    this.bboxHandles(bbox).forEach((handle) => this.drawHandle(handle.point, '#ffffff'));
  }

  drawActivePolygon() {
    if (this.activePolygonPoints.length === 0) return;
    const points = this.activePolygonPoints;
    this.ctx.strokeStyle = '#3182ce';
    this.ctx.fillStyle = 'rgba(49, 130, 206, 0.12)';
    this.ctx.lineWidth = 2 / Math.max(this.transform.scale, 0.01);
    this.ctx.beginPath();
    this.ctx.moveTo(points[0][0], points[0][1]);
    for (let i = 1; i < points.length; i += 1) {
      this.ctx.lineTo(points[i][0], points[i][1]);
    }
    if (points.length >= 3) {
      this.ctx.closePath();
      this.ctx.fill();
    }
    this.ctx.stroke();
    points.forEach((point, index) => this.drawHandle(point, index === 0 ? '#93c5fd' : '#ffffff'));
  }
  
  getColorForClass(className) {
     let hash = 0;
     const str = String(className || 'unknown');
     for (let i = 0; i < str.length; i++) {
        hash = str.charCodeAt(i) + ((hash << 5) - hash);
     }
     const hue = Math.abs(hash) % 360;
     return `hsl(${hue}, 75%, 50%)`;
  }

  centerTransformOnBbox(bbox) {
    if (!this.image || !Array.isArray(bbox) || bbox.length !== 4) return;
    const [x1, y1, x2, y2] = bbox.map(v => Number(v || 0));
    const cx = (x1 + x2) / 2;
    const cy = (y1 + y2) / 2;
    this.transform.x = (this.canvas.width / 2) - (cx * this.transform.scale);
    this.transform.y = (this.canvas.height / 2) - (cy * this.transform.scale);
    this.fitMode = false;
    return true;
  }

  centerOn(bbox) {
    if (!this.centerTransformOnBbox(bbox)) return;
    this.draw();
  }
}
