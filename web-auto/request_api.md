# Missing Backend APIs for Frontend Requirements

Based on the `FRONTEND_REQUIREMENTS.md`, there are a few APIs that the backend currently lacks and needs to implement to fully support the frontend features.

## 1. Video Playback and Frame Fetching
**Requirement:** The frontend needs to stream video for playback and fetch specific frames from a video.
- **GET `/api/projects/{project_id}/video/stream`**
    - Returns a `StreamingResponse` for the `.mp4` file via HTTP 206 Partial Content.
- **GET `/api/projects/{project_id}/video/frame/{frame_index}`**
    - Returns a JPEG image of the requested frame.

## 2. Video Annotations
**Requirement:** The frontend needs to get and save annotations (tracking data) for the entire video or specific frames.
- **GET `/api/projects/{project_id}/video/annotations`**
    - Returns all tracking data, objects, and mask shapes.
- **POST `/api/projects/{project_id}/video/annotations/save`**
    - Saves updated tracking bounding boxes or masks.

## 3. Global Configuration / Cache Directory API (NEW)
**Requirement:** The frontend needs a way to view and dynamically update the global "Cache Directory" (which corresponds to `DATA_DIR` in `main.py`). Currently, `DATA_DIR` is hardcoded to `BASE_DIR / 'data'` and instantiated once at startup. 

We need APIs to get and update this path globally:

### `GET /api/config/cache_dir`
**Response:**
```json
{
  "cache_dir": "/absolute/path/to/web-auto/data",
  "default_dir": "/absolute/path/to/web-auto"
}
```

### `POST /api/config/cache_dir`
**Request Body:**
```json
{
  "cache_dir": "D:/new/cache/path"
}
```
**Response:**
```json
{
  "ok": true,
  "cache_dir": "D:/new/cache/path",
  "message": "Storage directory updated successfully."
}
```
*Note: Depending on your backend design, changing the cache directory at runtime might require re-instantiating the `Storage` class and migrating existing `.sqlite3` / `projects.json` files, or simply requiring a server restart via environment variable configuration. Please implement the backend logic to handle this safely.*
