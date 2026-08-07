export const API_BASE = '/api';

export interface ApiError extends Error {
  code?: string;
  detail?: unknown;
}

export interface RequestOptions {
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export async function request<T = unknown>(
  method: string,
  endpoint: string,
  data: unknown = null,
  isFormData = false,
  requestOptions: RequestOptions = {},
): Promise<T> {
  const options: RequestInit = {
    method,
    headers: { ...(requestOptions.headers || {}) },
    signal: requestOptions.signal,
  };
  if (data && !isFormData) {
    (options.headers as Record<string, string>)['Content-Type'] = 'application/json';
    options.body = JSON.stringify(data);
  } else if (data && isFormData) {
    options.body = data as FormData;
  }

  const response = await fetch(`${API_BASE}${endpoint}`, options);
  if (!response.ok) {
    let errorMsg = response.statusText;
    let errorCode = '';
    let errorDetail: unknown = null;
    try {
      const d = await response.json();
      if (d && d.code) errorCode = String(d.code);
      if (d && d.detail) errorMsg = typeof d.detail === 'string' ? d.detail : JSON.stringify(d.detail);
      if (d && d.message) errorMsg = String(d.message);
      errorDetail = d?.detail || d;
    } catch {
      // non-JSON error body
    }
    const err = new Error(`API Error ${response.status}: ${errorMsg}`) as ApiError;
    err.code = errorCode;
    err.detail = errorDetail;
    throw err;
  }
  return response.json();
}

export const get = <T = unknown>(endpoint: string, opts?: RequestOptions) =>
  request<T>('GET', endpoint, null, false, opts);
export const post = <T = unknown>(endpoint: string, data?: unknown, opts?: RequestOptions) =>
  request<T>('POST', endpoint, data, false, opts);
export const del = <T = unknown>(endpoint: string, data?: unknown, opts?: RequestOptions) =>
  request<T>('DELETE', endpoint, data, false, opts);

export interface UploadDatasetParams {
  file: File;
  targetDir: string;
  relativePath?: string;
  overwrite?: boolean;
  onProgress?: (loaded: number, total: number) => void;
  onXhr?: (xhr: XMLHttpRequest) => void;
}

export function uploadDatasetFile({
  file,
  targetDir,
  relativePath = '',
  overwrite = false,
  onProgress,
  onXhr,
}: UploadDatasetParams): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('target_dir', targetDir);
    fd.append('relative_path', relativePath || (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name);
    fd.append('overwrite', overwrite ? 'true' : 'false');

    const xhr = new XMLHttpRequest();
    if (onXhr) onXhr(xhr);
    xhr.open('POST', `${API_BASE}/uploads/dataset`);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && onProgress) onProgress(event.loaded, event.total);
    };
    xhr.onload = () => {
      let data: Record<string, unknown> = {};
      try {
        data = xhr.responseText ? JSON.parse(xhr.responseText) : {};
      } catch {
        // ignore parse failure
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(data);
        return;
      }
      const errorCode = data && data.code ? String(data.code) : '';
      const detailRaw = data && data.detail ? data.detail : xhr.statusText;
      const detail = typeof detailRaw === 'string' ? detailRaw : JSON.stringify(detailRaw);
      const uploadErr = new Error(`API Error ${xhr.status}: ${detail}`) as Error & {
        code?: string;
        detail?: unknown;
      };
      uploadErr.code = errorCode;
      uploadErr.detail = data && data.detail ? data.detail : data;
      reject(uploadErr);
    };
    xhr.onerror = () => reject(new Error('network error during upload'));
    xhr.onabort = () => reject(new Error('upload canceled'));
    xhr.send(fd);
  });
}
