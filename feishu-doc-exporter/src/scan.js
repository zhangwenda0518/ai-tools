/* Feishu doc scanner: walks the virtualized docx body and collects
 * every image block (original-resolution token) and every table block. */
(function () {
  'use strict';
  if (window.__FXE) return;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const ZW = /[\u200b\u200c\u200d\ufeff]/g;

  function clean(s) {
    return (s || '').replace(ZW, '').replace(/\u00a0/g, ' ').trim();
  }

  function findScroller(doc) {
    const preferred = doc.querySelector('.bear-web-x-container');
    if (preferred && preferred.scrollHeight > preferred.clientHeight + 100) return preferred;
    let best = null;
    let bestScore = 0;
    for (const el of doc.querySelectorAll('div, main, section')) {
      const st = getComputedStyle(el);
      if (!/(auto|scroll)/.test(st.overflowY)) continue;
      const score = el.scrollHeight - el.clientHeight;
      if (el.clientHeight > 300 && score > bestScore) {
        best = el;
        bestScore = score;
      }
    }
    return best;
  }

  function docTitle(doc) {
    const h = doc.querySelector('.docx-page-block [data-block-type="page"]') || doc.querySelector('.docx-page-block');
    let t = clean(document.title).replace(/\s*-\s*飞书云文档\s*$/, '');
    if (h) {
      const first = h.querySelector('[data-block-type="heading1"], [data-block-type="heading2"], .docx-title-block');
      const ht = first ? clean(first.innerText) : '';
      if (ht) t = ht;
    }
    return t || '飞书文档';
  }

  function blockOffset(sc, el) {
    const scRect = sc.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    return Math.round(sc.scrollTop + r.top - scRect.top);
  }

  function cellText(td) {
    const lines = [];
    const walk = (node) => {
      if (!node) return;
      if (node.nodeType === 3) {
        const v = node.nodeValue;
        if (v && clean(v)) lines.push(clean(v));
        return;
      }
      if (node.nodeType !== 1) return;
      const tag = node.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE') return;
      for (const c of node.childNodes) walk(c);
    };
    walk(td);
    return lines.join('\n');
  }

  function parseTable(tableEl) {
    const trs = [...tableEl.querySelectorAll('tr')];
    const grid = [];
    trs.forEach((tr, ri) => {
      if (!grid[ri]) grid[ri] = [];
      let ci = 0;
      for (const cell of tr.children) {
        if (cell.tagName !== 'TD' && cell.tagName !== 'TH') continue;
        while (grid[ri][ci] !== undefined) ci++;
        const rs = Math.max(1, parseInt(cell.getAttribute('rowspan') || '1', 10));
        const cs = Math.max(1, parseInt(cell.getAttribute('colspan') || '1', 10));
        const text = cellText(cell);
        for (let r = 0; r < rs; r++) {
          if (!grid[ri + r]) grid[ri + r] = [];
          for (let c = 0; c < cs; c++) {
            grid[ri + r][ci + c] = r === 0 && c === 0 ? text : '';
          }
        }
        ci += cs;
      }
    });
    // trim trailing holes
    const clean_ = grid.map((row) => {
      const r = row.map((v) => (v === undefined ? '' : v));
      while (r.length && r[r.length - 1] === '') r.pop();
      return r;
    }).filter((r) => r.length > 0);
    const cols = clean_.reduce((m, r) => Math.max(m, r.length), 0);
    const filled = clean_.some((r) => r.some((v) => v !== ''));
    return { grid: clean_, rows: clean_.length, cols, hasText: filled };
  }

  function imgToken(block) {
    const holder = block.querySelector('[image-token]');
    if (holder) return holder.getAttribute('image-token');
    return null;
  }

  function imgEl(block) {
    return block.querySelector('img');
  }

  function firstHeadingText(doc, block, indexMap) {
    // walk backwards through recorded blocks for the nearest heading anchor
    for (let i = indexMap.length - 1; i >= 0; i--) {
      const rec = indexMap[i];
      if (rec.type && /^heading\d$/.test(rec.type)) return rec.text || '';
      if (rec.type === 'page') break;
    }
    return '';
  }

  async function scan(opts) {
    const { onProgress = () => {}, shouldStop = () => false } = opts || {};
    const doc = document;
    const sc = findScroller(doc);
    if (!sc) {
      return { ok: false, reason: 'no-scroller', url: location.href, title: docTitle(doc) };
    }

    const originalTop = sc.scrollTop;
    // always start from the very top: the body renders lazily, so a mid-document
    // scan would miss everything above the current viewport.
    sc.scrollTop = 0;
    await sleep(600);
    const images = new Map();
    const tables = new Map();
    const sheets = new Map();
    const timeline = []; // ordered non-image blocks, used for heading context
    let steps = 0;
    const t0 = Date.now();

    const collect = () => {
      for (const b of doc.querySelectorAll('[data-block-id]')) {
        const id = b.getAttribute('data-block-id');
        const type = b.getAttribute('data-block-type');
        if (!id || !type) continue;
        const off = blockOffset(sc, b);
        if (type === 'image') {
          if (images.has(id)) continue;
          const el = imgEl(b);
          const token = imgToken(b);
          if (!el && !token) continue;
          const w = el ? el.naturalWidth : 0;
          const h = el ? el.naturalHeight : 0;
          if (el && w && w < 60 && h && h < 60) continue; // icons / avatars
          images.set(id, {
            kind: 'image',
            blockId: id,
            token,
            src: el ? el.currentSrc || el.src : '',
            w,
            h,
            offset: off,
            heading: firstHeadingText(doc, b, timeline)
          });
          continue;
        }
        if (type === 'table') {
          const tableEl = b.querySelector('table');
          const prev = tables.get(id);
          if (!tableEl) {
            if (!prev) tables.set(id, { kind: 'table', blockId: id, offset: off, rows: 0, cols: 0, grid: [], hasText: false, pending: true });
            continue;
          }
          const parsed = parseTable(tableEl);
          tables.set(id, {
            kind: 'table',
            blockId: id,
            offset: off,
            rows: parsed.rows,
            cols: parsed.cols,
            grid: parsed.grid,
            hasText: parsed.hasText,
            pending: false
          });
          continue;
        }
        if (type === 'sheet') {
          if (!sheets.has(id)) {
            sheets.set(id, { kind: 'sheet', blockId: id, offset: off, title: clean(b.innerText).slice(0, 120) });
          }
          continue;
        }
        if (/^heading\d$/.test(type) || type === 'page') {
          if (!prevSeen(timeline, id)) {
            timeline.push({ id, type, text: clean(b.innerText).slice(0, 120) });
          }
        }
      }
    };

    const seenTimeline = new Set();
    function prevSeen(list, id) {
      if (seenTimeline.has(id)) return true;
      seenTimeline.add(id);
      return false;
    }

    let stable = 0;
    let lastH = sc.scrollHeight;
    const maxSteps = 6000;

    while (steps < maxSteps) {
      if (shouldStop()) break;
      collect();

      const atBottom = sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 6;
      if (atBottom) {
        await sleep(420);
        if (sc.scrollHeight !== lastH) {
          lastH = sc.scrollHeight;
          stable = 0;
        } else if (++stable >= 3) {
          break;
        }
      } else {
        stable = 0;
      }

      // give pending tables a chance while they sit inside the viewport
      const pending = [...tables.values()].filter((t) => t.pending || !t.hasText);
      if (pending.length) {
        const scRect = sc.getBoundingClientRect();
        for (const t of pending) {
          const el = doc.querySelector(`[data-block-id="${t.blockId}"][data-block-type="table"]`);
          if (!el) continue;
          const r = el.getBoundingClientRect();
          if (r.bottom > scRect.top - 100 && r.top < scRect.bottom + 100) {
            await sleep(600);
            collect();
            break;
          }
        }
      }

      sc.scrollTop = Math.min(sc.scrollTop + sc.clientHeight * 0.85, sc.scrollHeight);
      steps++;
      await sleep(130);

      onProgress({
        step: steps,
        percent: Math.min(99, Math.round((sc.scrollTop / Math.max(1, sc.scrollHeight)) * 100)),
        images: images.size,
        tables: tables.size,
        sheets: sheets.size
      });
    }

    collect();
    sc.scrollTop = originalTop;
    await sleep(250);

    const byOffset = (a, b) => a.offset - b.offset || (Number(a.blockId) || 0) - (Number(b.blockId) || 0);
    let sourceUrl = location.href;
    try {
      if (window.top && window.top !== window) sourceUrl = window.top.location.href;
    } catch (e) {
      /* cross-origin top: keep the frame url */
    }
    return {
      ok: true,
      url: sourceUrl,
      title: docTitle(doc),
      elapsedMs: Date.now() - t0,
      steps,
      images: [...images.values()].sort(byOffset),
      tables: [...tables.values()].sort(byOffset),
      sheets: [...sheets.values()].sort(byOffset)
    };
  }

  async function fetchImageBytes(img) {
    const attempts = [];
    if (img.token) {
      attempts.push(`/space/api/box/stream/download/all/${img.token}/?mount_point=docx_image`);
      attempts.push(`/space/api/box/stream/download/v2/cover/${img.token}/`);
    }
    if (img.src) attempts.push(img.src);
    let lastErr = null;
    for (const url of attempts) {
      try {
        const res = await fetch(url, { credentials: 'include' });
        if (!res.ok) {
          lastErr = new Error(`HTTP ${res.status} for ${url.slice(0, 80)}`);
          continue;
        }
        const blob = await res.blob();
        if (!blob.size) {
          lastErr = new Error('empty body');
          continue;
        }
        return { blob, from: url };
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error('fetch failed');
  }

  /* real pixel size straight from the downloaded bytes (the on-page <img> is a
   * downscaled preview, so naturalWidth there is NOT the original size). */
  function dimsFromBytes(buf) {
    try {
      const u = new Uint8Array(buf);
      if (u.length > 24 && u[0] === 0x89 && u[1] === 0x50 && u[2] === 0x4e && u[3] === 0x47) {
        const dv = new DataView(u.buffer, u.byteOffset, u.byteLength);
        return { w: dv.getUint32(16), h: dv.getUint32(20), fmt: 'png' };
      }
      if (u.length > 30 && u[0] === 0xff && u[1] === 0xd8) {
        let i = 2;
        while (i + 9 < u.length) {
          if (u[i] !== 0xff) { i++; continue; }
          const m = u[i + 1];
          const len = (u[i + 2] << 8) | u[i + 3];
          if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
            return { h: (u[i + 5] << 8) | u[i + 6], w: (u[i + 7] << 8) | u[i + 8], fmt: 'jpg' };
          }
          i += 2 + len;
        }
      }
      if (u.length > 30 && u[0] === 0x47 && u[1] === 0x49 && u[2] === 0x46) {
        return { w: u[6] | (u[7] << 8), h: u[8] | (u[9] << 8), fmt: 'gif' };
      }
      if (u.length > 30 && u[0] === 0x52 && u[1] === 0x49 && u[8] === 0x57) {
        const dv = new DataView(u.buffer, u.byteOffset, u.byteLength);
        const fourcc = String.fromCharCode(u[12], u[13], u[14], u[15]);
        if (fourcc === 'VP8X') return { w: 1 + (u[24] | (u[25] << 8) | (u[26] << 16)), h: 1 + (u[27] | (u[28] << 8) | (u[29] << 16)), fmt: 'webp' };
        return { w: dv.getUint16(26, true), h: dv.getUint16(28, true), fmt: 'webp' };
      }
    } catch (e) {
      /* ignore */
    }
    return null;
  }

  function extFromBlob(blob, fallback) {
    const t = (blob && blob.type) || '';
    if (t.includes('png')) return 'png';
    if (t.includes('jpeg') || t.includes('jpg')) return 'jpg';
    if (t.includes('gif')) return 'gif';
    if (t.includes('webp')) return 'webp';
    if (t.includes('svg')) return 'svg';
    if (t.includes('bmp')) return 'bmp';
    return fallback || 'png';
  }

  window.__FXE = {
    scan,
    fetchImageBytes,
    extFromBlob,
    dimsFromBytes,
    clean,
    findScroller,
    docTitle
  };
})();
