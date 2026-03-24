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
    
    // Interaction state
    this.isPanning = false;
    this.lastX = 0;
    this.lastY = 0;
    
    // Prompting state
    this.promptMode = 'pointer'; // 'pointer', 'point', 'box'
    this.prompts = [];
    this.isDrawingBox = false;
    this.boxStart = null;
    this.onPromptAdded = null;
    this.options = { showMasks: true };
    
    // Bind methods
    this.onResize = this.onResize.bind(this);
    this.onWheel = this.onWheel.bind(this);
    this.onMouseDown = this.onMouseDown.bind(this);
    this.onMouseMove = this.onMouseMove.bind(this);
    this.onMouseUp = this.onMouseUp.bind(this);
    this.onKeyDown = this.onKeyDown.bind(this);
    this.onKeyUp = this.onKeyUp.bind(this);
    
    // Listeners
    window.addEventListener('resize', this.onResize);
    this.canvas.addEventListener('wheel', this.onWheel, {passive: false});
    this.canvas.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mousemove', this.onMouseMove);
    window.addEventListener('mouseup', this.onMouseUp);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    
    this.onResize();
  }
  
  destroy() {
    window.removeEventListener('resize', this.onResize);
    this.canvas.removeEventListener('wheel', this.onWheel);
    this.canvas.removeEventListener('mousedown', this.onMouseDown);
    window.removeEventListener('mousemove', this.onMouseMove);
    window.removeEventListener('mouseup', this.onMouseUp);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    this.canvas.remove();
  }

  onKeyDown(e) {
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
  
  onResize() {
    const rect = this.container.getBoundingClientRect();
    this.canvas.width = rect.width;
    this.canvas.height = rect.height;
    this.draw();
  }
  
  async loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        this.image = img;
        this.fitToScreen();
        resolve();
      };
      img.onerror = reject;
      img.src = src;
    });
  }
  
  setAnnotations(anns) {
    this.annotations = anns || [];
    this.draw();
  }

  setPreviews(previews) {
    this.previews = previews || [];
    this.draw();
  }
  
  setPromptMode(mode) {
    this.promptMode = mode;
    this.updateCursor();
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
    if (this.promptMode === 'box') {
      this.container.style.cursor = 'crosshair';
      return;
    }
    if (this.promptMode === 'point') {
      this.container.style.cursor = 'copy';
      return;
    }
    this.container.style.cursor = 'default';
  }
  
  fitToScreen() {
    if(!this.image) return;
    const padding = 60;
    const wr = (this.canvas.width - padding) / this.image.width;
    const hr = (this.canvas.height - padding) / this.image.height;
    this.transform.scale = Math.min(wr, hr, 1.0);
    this.transform.x = (this.canvas.width - this.image.width * this.transform.scale) / 2;
    this.transform.y = (this.canvas.height - this.image.height * this.transform.scale) / 2;
    this.draw();
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
    
    this.draw();
  }
  
  onMouseDown(e) {
    const rect = this.canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    
    const imgX = (mx - this.transform.x) / this.transform.scale;
    const imgY = (my - this.transform.y) / this.transform.scale;

    // Alt + Left Click to Pan
    if (e.button === 0 && e.altKey) {
      this.isPanning = true;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      this.container.style.cursor = 'grabbing';
      return;
    }

    if (e.button === 0) { // Left click
      if (this.promptMode === 'point') {
        if (this.onPromptAdded) this.onPromptAdded('point', [imgX, imgY]);
      } else if (this.promptMode === 'box') {
        this.isDrawingBox = true;
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
    if (this.isPanning) {
      const dx = e.clientX - this.lastX;
      const dy = e.clientY - this.lastY;
      this.transform.x += dx;
      this.transform.y += dy;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      this.draw();
    } else if (this.isDrawingBox) {
      const rect = this.canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      this.boxEnd = [(mx - this.transform.x) / this.transform.scale, (my - this.transform.y) / this.transform.scale];
      this.draw();
    }
  }
  
  onMouseUp(e) {
    if (this.isDrawingBox && this.boxStart && this.boxEnd) {
      const x1 = Math.min(this.boxStart[0], this.boxEnd[0]);
      const y1 = Math.min(this.boxStart[1], this.boxEnd[1]);
      const x2 = Math.max(this.boxStart[0], this.boxEnd[0]);
      const y2 = Math.max(this.boxStart[1], this.boxEnd[1]);
      if (Math.abs(x2 - x1) > 2 && Math.abs(y2 - y1) > 2) {
        if (this.onPromptAdded) this.onPromptAdded('box', [x1, y1, x2, y2]);
      }
    }
    this.isPanning = false;
    this.isDrawingBox = false;
    this.boxStart = null;
    this.boxEnd = null;
    this.container.style.cursor = e.altKey ? 'grab' : 'default';
    this.updateCursor();
  }
  
  draw() {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (!this.image) return;
    
    this.ctx.save();
    this.ctx.translate(this.transform.x, this.transform.y);
    this.ctx.scale(this.transform.scale, this.transform.scale);
    
    // Draw image
    this.ctx.drawImage(this.image, 0, 0);
    
    // Draw annotations (Permanent)
    for(const ann of this.annotations) {
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
      const labelPos = bbox ? [bbox[0], bbox[1]] : (points ? [points[0], points[1]] : null);
      if (labelPos) {
         this.ctx.fillStyle = color;
         const fontSize = 12 / this.transform.scale;
         this.ctx.font = `600 ${fontSize}px Inter, sans-serif`;
         const text = ann.class_name || ann.label || 'Object';
         this.ctx.fillText(`${text}`, labelPos[0], labelPos[1] - 4 / this.transform.scale);
      }
    }
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

  centerOn(bbox) {
    if (!this.image || !Array.isArray(bbox) || bbox.length !== 4) return;
    const [x1, y1, x2, y2] = bbox.map(v => Number(v || 0));
    const cx = (x1 + x2) / 2;
    const cy = (y1 + y2) / 2;
    this.transform.x = (this.canvas.width / 2) - (cx * this.transform.scale);
    this.transform.y = (this.canvas.height / 2) - (cy * this.transform.scale);
    this.draw();
  }
}
