export const API_BASE = '/api';

export async function request(method, endpoint, data = null, isFormData = false, requestOptions = {}) {
  const options = {
    method,
    ...requestOptions,
    headers: { ...(requestOptions.headers || {}) },
  };
  if (data && !isFormData) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(data);
  } else if (data && isFormData) {
    options.body = data;
  }

  const response = await fetch(`${API_BASE}${endpoint}`, options);
  if (!response.ok) {
    let errorMsg = response.statusText;
    let errorCode = '';
    try {
      const d = await response.json();
      if (d && d.code) errorCode = String(d.code);
      if (d && d.detail) errorMsg = typeof d.detail === 'string' ? d.detail : JSON.stringify(d.detail);
    } catch (e) {}
    if (response.status === 401 || errorCode === 'login_required') {
      window.location.href = '/login';
      throw new Error('Login required');
    }
    if (response.status === 403 && errorCode === 'setup_required') {
      window.location.href = '/setup';
      throw new Error('Setup required');
    }
    if (response.status === 503 && errorCode === 'admin_not_configured') {
      window.location.href = '/login';
      throw new Error('Admin credentials are not configured');
    }
    throw new Error(`API Error ${response.status}: ${errorMsg}`);
  }
  return response.json();
}

export function uploadDatasetFile({ file, targetDir, relativePath = '', overwrite = false, onProgress = null, onXhr = null }) {
  return new Promise((resolve, reject) => {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('target_dir', targetDir);
    fd.append('relative_path', relativePath || file.webkitRelativePath || file.name);
    fd.append('overwrite', overwrite ? 'true' : 'false');

    const xhr = new XMLHttpRequest();
    if (onXhr) onXhr(xhr);
    xhr.open('POST', `${API_BASE}/uploads/dataset`);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && onProgress) onProgress(event.loaded, event.total);
    };
    xhr.onload = () => {
      let data = {};
      try {
        data = xhr.responseText ? JSON.parse(xhr.responseText) : {};
      } catch (e) {}
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(data);
        return;
      }
      const errorCode = data && data.code ? String(data.code) : '';
      if (xhr.status === 401 || errorCode === 'login_required') {
        window.location.href = '/login';
        reject(new Error('Login required'));
        return;
      }
      const detail = data && data.detail ? (typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail)) : xhr.statusText;
      reject(new Error(`API Error ${xhr.status}: ${detail}`));
    };
    xhr.onerror = () => reject(new Error('network error during upload'));
    xhr.onabort = () => reject(new Error('upload canceled'));
    xhr.send(fd);
  });
}
