#!/usr/bin/env python3
"""Verify annotation overlay alignment mathematically via Playwright."""
import json
import sys
from playwright.sync_api import sync_playwright

BASE = 'http://localhost:8000'
PID = 'prj_d55b86643cac'
IMG = '34d6de211390558c'
OUT = '/tmp/align'

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'])
    page = browser.new_page(viewport={'width': 1600, 'height': 900})
    page.goto(BASE)
    page.wait_for_timeout(1500)
    # login
    if page.locator('input[type="password"]').count() > 0:
        page.locator('input[type="text"], input:not([type="password"])').first.fill('admin')
        page.locator('input[type="password"]').fill('qaFpuXcxkUJ8Awm0fNJy')
        page.locator('button').first.click()
        page.wait_for_timeout(2000)
    page.goto(f'{BASE}/#/project/image/{PID}')
    page.wait_for_timeout(2500)
    page.screenshot(path=f'{OUT}_01_project.png')

    # click the target image thumbnail
    thumb = page.locator(f'[data-image-id="{IMG}"]')
    if thumb.count() == 0:
        # fallback: click first thumbnail-ish element
        thumb = page.locator('.image-card, .thumb-item, .image-item').first
    thumb.first.click()
    page.wait_for_timeout(3000)

    # enable all class checkboxes
    boxes = page.locator('input[type="checkbox"]')
    for i in range(boxes.count()):
        cb = boxes.nth(i)
        try:
            if not cb.is_checked():
                cb.check(force=True)
        except Exception:
            pass
    page.wait_for_timeout(2000)
    page.screenshot(path=f'{OUT}_02_annotated.png')

    result = page.evaluate("""async () => {
      const r = await fetch('/api/projects/%s/images/%s/bundle', {credentials:'include'});
      const bundle = await r.json();
      const pi = bundle.preview_info || bundle.previewInfo || {};
      const W = pi.source_width, H = pi.source_height;
      const anns = (bundle.annotations || []).map(a => ({id: a.id || a.annotation_id, bbox: a.bbox_xyxy || a.bbox, cls: a.class_name || a.class_id}));

      // overlay canvas: topmost canvas that is not inside openseadragon container
      const canvases = Array.from(document.querySelectorAll('canvas'));
      const overlay = canvases.filter(c => !c.closest('.openseadragon-canvas')).pop();
      if (!overlay) return {error: 'no overlay canvas', W, H, annCount: anns.length};
      const orect = overlay.getBoundingClientRect();
      const dpr = overlay.width / orect.width;

      // OSD viewer container = the element holding openseadragon-canvas
      const osdCanvasEl = document.querySelector('.openseadragon-canvas canvas');
      const osd = document.querySelector('.openseadragon-canvas').parentElement;
      const crect = osd.getBoundingClientRect();

      const ctx = overlay.getContext('2d');
      const data = ctx.getImageData(0, 0, overlay.width, overlay.height).data;
      const opaqueAt = (x, y) => {
        const xi = Math.round(x * dpr), yi = Math.round(y * dpr);
        if (xi < 0 || yi < 0 || xi >= overlay.width || yi >= overlay.height) return false;
        return data[(yi * overlay.width + xi) * 4 + 3] > 40;
      };
      const nearOpaque = (x, y, tol) => {
        for (let dy = -tol; dy <= tol; dy++)
          for (let dx = -tol; dx <= tol; dx++)
            if (opaqueAt(x + dx, y + dy)) return true;
        return false;
      };

      // expected image display rect (home fit, centered)
      const s = Math.min(crect.width / W, crect.height / H);
      const dw = W * s, dh = H * s;
      const ox = crect.left - orect.left + (crect.width - dw) / 2;
      const oy = crect.top - orect.top + (crect.height - dh) / 2;

      const checks = anns.filter(a => Array.isArray(a.bbox)).map(a => {
        const [x1, y1, x2, y2] = a.bbox;
        const ex1 = ox + x1 * s, ey1 = oy + y1 * s, ex2 = ox + x2 * s, ey2 = oy + y2 * s;
        const mx = (ex1 + ex2) / 2, my = (ey1 + ey2) / 2;
        const edges = {
          top: nearOpaque(mx, ey1, 6),
          bottom: nearOpaque(mx, ey2, 6),
          left: nearOpaque(ex1, my, 6),
          right: nearOpaque(ex2, my, 6),
        };
        return {id: a.id, cls: a.cls, bbox: a.bbox,
                expected: [ex1, ey1, ex2, ey2].map(v => Math.round(v)),
                edges, allEdges: Object.values(edges).every(Boolean)};
      });
      return {W, H, container: [crect.width, crect.height], scale: s,
              imageRect: [Math.round(ox), Math.round(oy), Math.round(dw), Math.round(dh)],
              annCount: anns.length, checks};
    }""" % (PID, IMG))

    print(json.dumps(result, indent=2, ensure_ascii=False))
    ok = bool(result.get('checks')) and all(c['allEdges'] for c in result['checks'])
    print('ALIGNMENT:', 'PASS' if ok else 'FAIL')

    # zoom + pan tracking screenshots
    page.mouse.move(800, 450)
    page.mouse.wheel(0, -600)
    page.wait_for_timeout(1200)
    page.screenshot(path=f'{OUT}_03_zoomed.png')
    page.mouse.move(800, 450)
    page.mouse.down()
    page.mouse.move(600, 350, steps=10)
    page.mouse.up()
    page.wait_for_timeout(1200)
    page.screenshot(path=f'{OUT}_04_panned.png')

    browser.close()
    sys.exit(0 if ok else 1)
