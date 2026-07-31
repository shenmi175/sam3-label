import { api } from '../../api.js';
import { i18n } from '../../i18n.js';
import { store } from '../../store.js';

function notify(message, type = 'info') {
  if (typeof window !== 'undefined' && typeof window.showToast === 'function') {
    window.showToast(message, type);
  }
}

export class AutoConfigController {
  constructor(workspace) {
    this.workspace = workspace;
  }

  bind() {
    const sam3UrlInp = document.getElementById('inp-sam3-url');
    if (sam3UrlInp) sam3UrlInp.onchange = (e) => store.setConfig('sam3ApiUrl', e.target.value);

    const locateUrlInp = document.getElementById('inp-locate-url');
    if (locateUrlInp) locateUrlInp.onchange = (e) => store.setConfig('locateApiUrl', e.target.value);

    const selBackend = document.getElementById('sel-backend');
    if (selBackend) {
      selBackend.value = store.state.config.defaultBackend || 'sam3';
      selBackend.onchange = (e) => {
        store.setConfig('defaultBackend', e.target.value);
        this.syncBackendUI();
        this.syncSourceFilter();
      };
    }
    this.syncBackendUI();
    this.syncSourceFilter();

    const selContour = document.getElementById('sel-contour-mode');
    if (selContour) {
      selContour.value = store.state.config.contourMode || 'split';
      selContour.onchange = (e) => store.setConfig('contourMode', e.target.value);
    }

    const btnThresholdDec = document.getElementById('btn-threshold-dec');
    const btnThresholdInc = document.getElementById('btn-threshold-inc');
    const btnBatchDec = document.getElementById('btn-batch-dec');
    const btnBatchInc = document.getElementById('btn-batch-inc');
    if (btnThresholdDec) btnThresholdDec.onclick = () => this.adjustThreshold(-0.05);
    if (btnThresholdInc) btnThresholdInc.onclick = () => this.adjustThreshold(0.05);
    if (btnBatchDec) btnBatchDec.onclick = () => this.adjustBatchSize(-1);
    if (btnBatchInc) btnBatchInc.onclick = () => this.adjustBatchSize(1);
    this.syncControls();

    const btnTest = document.getElementById('btn-test-api');
    if (btnTest) btnTest.onclick = () => this.testApi(btnTest);
  }

  syncBackendUI() {
    const isLocate = store.state.config.defaultBackend === 'locate-anything';
    const sam3UrlInp = document.getElementById('inp-sam3-url');
    const locateUrlInp = document.getElementById('inp-locate-url');
    const btnExample = document.getElementById('btn-example-segment');
    if (sam3UrlInp) sam3UrlInp.style.display = isLocate ? 'none' : '';
    if (locateUrlInp) locateUrlInp.style.display = isLocate ? '' : 'none';
    const selContour = document.getElementById('sel-contour-mode');
    if (selContour) {
      selContour.disabled = isLocate;
      selContour.style.opacity = isLocate ? '0.45' : '1';
    }
    if (btnExample) {
      btnExample.disabled = isLocate;
      btnExample.style.opacity = isLocate ? '0.45' : '1';
    }
  }

  syncSourceFilter() {
    const ws = this.workspace;
    if (!ws || !ws.annotationSourceFilter) return;
    const backend = store.state.config.defaultBackend || 'sam3';
    ws.annotationSourceFilter = new Set([backend]);
    if (typeof ws.updateSourceChipStyles === 'function') ws.updateSourceChipStyles();
    if (typeof ws.renderAnnotations === 'function') ws.renderAnnotations();
    if (ws.viewer && typeof ws.visibleAnnotations === 'function') {
      ws.viewer.setAnnotations(ws.visibleAnnotations());
    }
  }

  syncControls() {
    const thresholdLabel = document.getElementById('lbl-threshold-value');
    const batchLabel = document.getElementById('lbl-batch-size-value');
    if (thresholdLabel) thresholdLabel.innerText = Number(store.state.config.threshold).toFixed(2);
    if (batchLabel) batchLabel.innerText = String(store.state.config.batchSize);
  }

  adjustThreshold(delta) {
    const next = Number((Number(store.state.config.threshold || 0.5) + delta).toFixed(2));
    store.setConfig('threshold', next);
    this.syncControls();
  }

  adjustBatchSize(delta) {
    const next = Number(store.state.config.batchSize || 1) + delta;
    store.setConfig('batchSize', next);
    this.syncControls();
  }

  async testApi(btnTest) {
    const isLocate = store.state.config.defaultBackend === 'locate-anything';
    try {
      btnTest.disabled = true;
      btnTest.innerText = 'Testing...';
      if (isLocate) {
        const res = await api.testLocate(store.state.config.locateApiUrl);
        const loaded = res?.result?.model_loaded ?? res?.model_loaded ?? false;
        notify(loaded ? 'LocateAnything API Online (model loaded)' : 'LocateAnything API Online (model not loaded)', 'success');
      } else {
        await api.testSam3(store.state.config.sam3ApiUrl);
        notify("SAM3 API is Online", "success");
      }
    } catch(e) {
      notify((isLocate ? 'LocateAnything' : 'SAM3') + ' API Connection Failed: ' + e.message, "error");
    } finally {
      btnTest.disabled = false;
      btnTest.innerText = i18n.t('test_api');
    }
  }
}
