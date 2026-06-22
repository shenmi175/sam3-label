import { api } from '../../api.js';
import { i18n } from '../../i18n.js';
import { store } from '../../store.js';

function notify(message, type = 'info') {
  if (typeof window !== 'undefined' && typeof window.showToast === 'function') {
    window.showToast(message, type);
  }
}

export class AutoConfigController {
  bind() {
    const sam3UrlInp = document.getElementById('inp-sam3-url');
    if (sam3UrlInp) sam3UrlInp.onchange = (e) => store.setConfig('sam3ApiUrl', e.target.value);

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
    try {
      btnTest.disabled = true;
      btnTest.innerText = 'Testing...';
      await api.testSam3(store.state.config.sam3ApiUrl);
      notify("SAM3 API is Online", "success");
    } catch(e) {
      notify("SAM3 API Connection Failed: " + e.message, "error");
    } finally {
      btnTest.disabled = false;
      btnTest.innerText = i18n.t('test_api');
    }
  }
}
