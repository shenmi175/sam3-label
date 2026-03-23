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
    this.container.style.cursor = 'grab';
    
    // State
    this.image = null;
    this.annotations = [];
    this.transform = { x: 0, y: 0, scale: 1 };
    
    // Interaction state
    this.isDragging = false;
    this.lastX = 0;
    this.lastY = 0;
    
    // Bind methods
    this.onResize = this.onResize.bind(this);
    this.onWheel = this.onWheel.bind(this);
    this.onMouseDown = this.onMouseDown.bind(this);
    this.onMouseMove = this.onMouseMove.bind(this);
    this.onMouseUp = this.onMouseUp.bind(this);
    
    // Listeners
    window.addEventListener('resize', this.onResize);
    this.canvas.addEventListener('wheel', this.onWheel, {passive: false});
    this.canvas.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mousemove', this.onMouseMove);
    window.addEventListener('mouseup', this.onMouseUp);
    
    this.onResize();
  }
  
  destroy() {
    window.removeEventListener('resize', this.onResize);
    this.canvas.removeEventListener('wheel', this.onWheel);
    this.canvas.removeEventListener('mousedown', this.onMouseDown);
    window.removeEventListener('mousemove', this.onMouseMove);
    window.removeEventListener('mouseup', this.onMouseUp);
    this.canvas.remove();
  }
  
  onResize() {
    const rect = this.container.getBoundingClientRect();
    this.canvas.width = rect.width;
    this.canvas.height = rect.height;
    this.draw();
  }
  
  loadImage(src) {
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
  
  fitToScreen() {
    if(!this.image) return;
    const padding = 40;
    const wr = (this.canvas.width - padding) / this.image.width;
    const hr = (this.canvas.height - padding) / this.image.height;
    this.transform.scale = Math.min(wr, hr);
    this.transform.x = (this.canvas.width - this.image.width * this.transform.scale) / 2;
    this.transform.y = (this.canvas.height - this.image.height * this.transform.scale) / 2;
    this.draw();
  }
  
  onWheel(e) {
    e.preventDefault();
    const zoomFactor = 1.1;
    const direction = e.deltaY < 0 ? 1 : -1;
    
    // Zoom around mouse
    const rect = this.canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    
    const scaleChange = direction > 0 ? zoomFactor : 1 / zoomFactor;
    const newScale = this.transform.scale * scaleChange;
    
    // Max constraints limits can be added here
    if (newScale < 0.05 || newScale > 50) return;
    
    this.transform.x = mx - (mx - this.transform.x) * scaleChange;
    this.transform.y = my - (my - this.transform.y) * scaleChange;
    this.transform.scale = newScale;
    
    this.draw();
  }
  
  onMouseDown(e) {
    if(e.button === 1 || e.button === 0) { // Middle or left click pan for now
       this.isDragging = true;
       this.lastX = e.clientX;
       this.lastY = e.clientY;
       this.container.style.cursor = 'grabbing';
    }
  }
  
  onMouseMove(e) {
    if(!this.isDragging) return;
    const dx = e.clientX - this.lastX;
    const dy = e.clientY - this.lastY;
    this.transform.x += dx;
    this.transform.y += dy;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    this.draw();
  }
  
  onMouseUp(e) {
    this.isDragging = false;
    this.container.style.cursor = 'grab';
  }
  
  draw() {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (!this.image) return;
    
    this.ctx.save();
    this.ctx.translate(this.transform.x, this.transform.y);
    this.ctx.scale(this.transform.scale, this.transform.scale);
    
    // Draw image
    this.ctx.drawImage(this.image, 0, 0);
    
    // Draw annotations
    for(const ann of this.annotations) {
      this.drawAnnotation(ann);
    }
    
    this.ctx.restore();
  }
  
  drawAnnotation(ann) {
    const color = this.getColorForClass(ann.class_name);
    
    if (ann.polygon && ann.polygon.length > 2) {
      this.ctx.beginPath();
      this.ctx.moveTo(ann.polygon[0][0], ann.polygon[0][1]);
      for (let i = 1; i < ann.polygon.length; i++) {
        this.ctx.lineTo(ann.polygon[i][0], ann.polygon[i][1]);
      }
      this.ctx.closePath();
      
      this.ctx.fillStyle = `${color}33`; // 20% opacity
      this.ctx.fill();
      this.ctx.strokeStyle = color;
      this.ctx.lineWidth = 2 / this.transform.scale;
      this.ctx.stroke();
    } else if (ann.bbox && ann.bbox.length === 4) {
      const [x1, y1, x2, y2] = ann.bbox;
      this.ctx.strokeStyle = color;
      this.ctx.lineWidth = 2 / this.transform.scale;
      this.ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
    }
    
    // Text label
    if (ann.bbox) {
       const [x1, y1] = ann.bbox;
       this.ctx.fillStyle = color;
       const fontSize = 14 / this.transform.scale;
       this.ctx.font = `${fontSize}px Arial`;
       this.ctx.fillText(`${ann.class_name} ${ann.score ? (ann.score).toFixed(2) : ''}`, x1, y1 - 4/this.transform.scale);
    } else if (ann.polygon && ann.polygon.length > 0) {
       this.ctx.fillStyle = color;
       const fontSize = 14 / this.transform.scale;
       this.ctx.font = `${fontSize}px Arial`;
       this.ctx.fillText(`${ann.class_name}`, ann.polygon[0][0], ann.polygon[0][1] - 4/this.transform.scale);
    }
  }
  
  getColorForClass(className) {
     // rudimentary string hash to color
     let hash = 0;
     for (let i = 0; i < className.length; i++) {
        hash = className.charCodeAt(i) + ((hash << 5) - hash);
     }
     const hue = Math.abs(hash) % 360;
     return `hsl(${hue}, 70%, 50%)`;
  }
}
