import { api } from '../../api.js';
import { focusImageListItem, renderImageList, updateImageListSelection } from '../../components/image-list.js';
import { i18n } from '../../i18n.js';

function notify(message, type = 'info') {
  if (typeof window !== 'undefined' && typeof window.showToast === 'function') {
    window.showToast(message, type);
  }
}

export class ImageNavigationController {
  constructor(workspace) {
    this.workspace = workspace;
  }

  sanitizeOffset(offsetValue = this.workspace.offset, totalValue = this.workspace.totalImages) {
    const ws = this.workspace;
    const total = Math.max(0, Number(totalValue || 0));
    const limit = Math.max(1, Number(ws.limit || 50));
    let nextOffset = Math.max(0, Number(offsetValue || 0));
    if (total > 0 && nextOffset >= total) {
      nextOffset = Math.max(0, Math.floor((total - 1) / limit) * limit);
    }
    return nextOffset;
  }

  getTotalPages() {
    const ws = this.workspace;
    const total = Math.max(0, Number(ws.totalImages || 0));
    const limit = Math.max(1, Number(ws.limit || 50));
    return Math.ceil(total / limit) || 1;
  }

  getCurrentPage() {
    const ws = this.workspace;
    const limit = Math.max(1, Number(ws.limit || 50));
    const offset = this.sanitizeOffset(ws.offset, ws.totalImages);
    return Math.floor(offset / limit) + 1;
  }

  syncPaginationControls() {
    const totalPages = this.getTotalPages();
    const currentPage = this.getCurrentPage();
    const pageInput = document.getElementById('inp-page-jump');
    const pageTotal = document.getElementById('ws-page-total');
    const btnPrev = document.getElementById('btn-img-prev');
    const btnNext = document.getElementById('btn-img-next');

    if (pageInput && document.activeElement !== pageInput) {
      pageInput.value = String(currentPage);
    }
    if (pageInput) {
      pageInput.setAttribute('max', String(totalPages));
      pageInput.setAttribute('title', `输入页码，按 Enter 跳转。当前 ${currentPage} / ${totalPages}`);
    }
    if (pageTotal) pageTotal.innerText = String(totalPages);
    if (btnPrev) btnPrev.disabled = currentPage <= 1;
    if (btnNext) btnNext.disabled = currentPage >= totalPages;
  }

  async goToPage(pageValue) {
    const ws = this.workspace;
    const totalPages = this.getTotalPages();
    const fallbackPage = this.getCurrentPage();
    const requestedPage = Number.parseInt(String(pageValue || ''), 10);
    const safePage = Math.max(1, Math.min(totalPages, Number.isFinite(requestedPage) ? requestedPage : fallbackPage));
    const nextOffset = (safePage - 1) * Math.max(1, Number(ws.limit || 50));

    if (nextOffset === ws.offset) {
      this.syncPaginationControls();
      return;
    }

    ws.offset = nextOffset;
    await this.loadImages();
  }

  hasFilter() {
    const ws = this.workspace;
    return Boolean(ws.imageFilterClass || (ws.imageFilterStatus && ws.imageFilterStatus !== 'all'));
  }

  async loadImages() {
    const ws = this.workspace;
    const listCont = document.getElementById('image-list-container');
    const requestSeq = ++ws.imageListLoadSeq;
    try {
      ws.offset = this.sanitizeOffset(ws.offset, ws.totalImages);
      const data = await api.getImages(ws.projectId, ws.offset, ws.limit, {
        status: ws.imageFilterStatus,
        className: ws.imageFilterClass,
        imageId: ws.selectedImageId || '',
      });
      if (ws.isUnmounted || requestSeq !== ws.imageListLoadSeq) return;

      ws.images = data.items || [];
      ws.totalImages = data.total || 0;
      ws.offset = this.sanitizeOffset(ws.offset, ws.totalImages);

      this.syncPaginationControls();

      const imageCountBadge = document.getElementById('ws-img-count-badge');
      if (imageCountBadge) imageCountBadge.innerText = ws.totalImages;

      renderImageList(listCont, ws.images, ws.selectedImageId, i18n.t('no_images'));
      ws.prefetchAdjacentImages(ws.selectedImageId || ws.images[0]?.id || '');
      ws.scheduleProjectUIStateSave();
    } catch (e) {
      if (listCont) {
        listCont.innerHTML = `<div style="color: #ef4444; padding: 10px; font-size: 12px;">${e.message}</div>`;
      }
    }
  }

  async applyFilters() {
    const ws = this.workspace;
    ws.offset = 0;
    await this.loadImages();
    const selectedVisible = ws.images.some((img) => String(img.id) === String(ws.selectedImageId || ''));
    if (!selectedVisible && ws.images.length > 0) {
      await ws.selectImage(ws.images[0].id, ws.images[0].rel_path);
    } else {
      this.updateSelectedImageListState();
    }
    ws.scheduleProjectUIStateSave();
  }

  updateSelectedImageListState() {
    updateImageListSelection(this.workspace.selectedImageId);
  }

  navigate(delta) {
    const ws = this.workspace;
    if (ws.unlabeledNavigationEnabled) {
      this.navigateUnlabeled(delta);
      return;
    }
    if (!ws.images || ws.images.length === 0) return;
    const currentIndex = ws.images.findIndex((img) => String(img.id) === String(ws.selectedImageId));
    const nextIndex = currentIndex + delta;
    if (nextIndex >= 0 && nextIndex < ws.images.length) {
      const img = ws.images[nextIndex];
      ws.selectImage(img.id, img.rel_path);
      setTimeout(() => {
        const el = focusImageListItem(img.id);
        if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }, 50);
    } else if (nextIndex < 0 && ws.offset >= ws.limit) {
      ws.offset -= ws.limit;
      this.loadImages().then(() => {
        const img = ws.images[ws.images.length - 1];
        if (img) ws.selectImage(img.id, img.rel_path);
      });
    } else if (nextIndex >= ws.images.length && ws.offset + ws.limit < ws.totalImages) {
      ws.offset += ws.limit;
      this.loadImages().then(() => {
        const img = ws.images[0];
        if (img) ws.selectImage(img.id, img.rel_path);
      });
    }
  }

  toggleUnlabeledNavigation() {
    const ws = this.workspace;
    ws.unlabeledNavigationEnabled = !ws.unlabeledNavigationEnabled;
    this.refreshUnlabeledButton();
    ws.scheduleProjectUIStateSave();
    notify(
      ws.unlabeledNavigationEnabled
        ? '未标注导航已开启，方向键将只切换未标注图片'
        : '未标注导航已关闭，方向键恢复普通切图',
      'info',
    );
  }

  refreshUnlabeledButton() {
    const btn = document.getElementById('btn-find-unlabeled');
    if (!btn) return;
    const active = this.workspace.unlabeledNavigationEnabled;
    btn.style.boxShadow = active ? 'var(--neu-inset)' : 'var(--neu-outset-sm)';
    btn.style.color = active ? 'var(--neu-text-active)' : 'var(--neu-text)';
    btn.textContent = active ? '未标注: 开' : '未标注';
  }

  async navigateUnlabeled(delta) {
    const ws = this.workspace;
    try {
      const direction = delta < 0 ? 'prev' : 'next';
      const res = await api.getUnlabeledImage(ws.projectId, ws.selectedImageId || '', direction);
      const image = res?.image || null;
      const imageIndex = Number(res?.image_index ?? -1);
      if (!image || !image.id) {
        notify('No unlabeled images found', 'info');
        return;
      }
      if (imageIndex >= 0) {
        ws.offset = Math.floor(imageIndex / ws.limit) * ws.limit;
      }
      await this.loadImages();
      await ws.selectImage(image.id, image.rel_path);
      setTimeout(() => {
        const el = focusImageListItem(image.id);
        if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }, 50);
    } catch (e) {
      notify(e.message, 'error');
    }
  }

  async deleteProjectImage(imageId, relPath = '') {
    const ws = this.workspace;
    const targetId = String(imageId || '').trim();
    if (!targetId) return;
    const currentPageIndex = (ws.images || []).findIndex((item) => String(item.id) === targetId);
    const targetImage = currentPageIndex >= 0 ? ws.images[currentPageIndex] : null;
    const displayPath = String(relPath || targetImage?.rel_path || targetId);
    const deletingSelected = String(ws.selectedImageId || '') === targetId;

    if (deletingSelected && ws.annotationSaving) {
      notify('当前图片正在保存，稍后再删除', 'error');
      return;
    }
    if (!confirm(`确认删除图片 "${displayPath}" 及对应标注文件吗？\n\n该操作会删除原图文件，不能从页面撤销。`)) return;

    try {
      if (deletingSelected) {
        ws.imageLoadSeq += 1;
        if (ws.imageLoadAbortController) {
          ws.imageLoadAbortController.abort();
          ws.imageLoadAbortController = null;
        }
        ws.annotationController.clearSaveTimer();
        ws.annotationDirty = false;
        ws.annotationSaveImageId = '';
      }

      await api.deleteImage(ws.projectId, targetId);
      ws.invalidateImageBundle(targetId);
      await ws.loadProjectInfo();
      await this.loadImages();

      if (ws.images.length === 0 && ws.totalImages > 0 && ws.offset > 0) {
        ws.offset = Math.max(0, ws.offset - ws.limit);
        await this.loadImages();
      }

      if (deletingSelected) {
        const nextImage = ws.images[Math.min(Math.max(currentPageIndex, 0), Math.max(ws.images.length - 1, 0))];
        if (nextImage) {
          await ws.selectImage(nextImage.id, nextImage.rel_path, { preserveFit: false });
          focusImageListItem(nextImage.id);
        } else {
          ws.selectedImageId = null;
          ws.selectedImagePath = null;
          ws.annotationController.resetEmptySelection();
          ws.currentPrompts = [];
          ws.previews = [];
          if (ws.viewer) {
            ws.viewer.clearImage();
            ws.viewer.setAnnotations([]);
            ws.viewer.setPrompts([]);
            ws.viewer.setPreviews([]);
            ws.viewer.setFocusedAnnotation(null);
          }
          ws.updateUndoRedoButtons();
          ws.updateAnnotationSelectionControls();
          ws.renderAnnotations();
          ws.renderPreviews();
          ws.updateActionBar();
          ws.setCanvasPlaceholder(true, i18n.t('select_image_prompt'));
        }
      } else {
        this.updateSelectedImageListState();
      }

      notify(`已删除图片: ${displayPath}`, 'success');
    } catch (e) {
      notify(`删除图片失败: ${e.message}`, 'error');
    }
  }
}
