/* Floating panel: scan the doc, multi-select images / tables, export a ZIP. */
(function () {
  'use strict';
  if (window.__FXE_PANEL) return;
  window.__FXE_PANEL = true;

  const FXE = window.__FXE;
  if (!FXE) return;

  const state = {
    open: false,
    scanning: false,
    scanned: false,
    exporting: false,
    stopFlag: false,
    title: '',
    sourceUrl: '',
    images: [],
    tables: [],
    sheets: [],
    selected: new Set(), // "img:<blockId>" / "tbl:<blockId>"
    progress: ''
  };

  const el = {};
  let root = null;

  function h(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function safeName(s) {
    return (s || '飞书文档')
      .replace(/[\\/:*?"<>|\r\n]+/g, '_')
      .replace(/^\.+/, '')
      .slice(0, 80)
      .trim() || '飞书文档';
  }

  function stamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
  }

  function coverUrl(img) {
    if (img.token) return `/space/api/box/stream/download/v2/cover/${img.token}/`;
    return img.src || '';
  }

  /* ---------------- UI ---------------- */

  function buildUi() {
    root = h('div', 'fxe-root');

    const fab = h('button', 'fxe-fab');
    fab.type = 'button';
    fab.title = '飞书文档导出助手';
    fab.innerHTML = '<span>导出</span>';
    fab.addEventListener('click', () => toggle(true));
    el.fab = fab;

    const panel = h('div', 'fxe-panel');
    el.panel = panel;

    const head = h('div', 'fxe-head');
    const title = h('div', 'fxe-title', '飞书文档导出助手');
    el.title = title;
    const close = h('button', 'fxe-x', '×');
    close.type = 'button';
    close.addEventListener('click', () => toggle(false));
    head.append(title, close);

    const bar = h('div', 'fxe-bar');
    const scanBtn = h('button', 'fxe-btn fxe-btn-primary fxe-scanbtn', '扫描文档');
    scanBtn.type = 'button';
    scanBtn.addEventListener('click', startScan);
    el.scanBtn = scanBtn;

    const selAll = h('button', 'fxe-btn', '全选');
    selAll.type = 'button';
    selAll.addEventListener('click', () => {
      state.selected.clear();
      state.images.forEach((i) => state.selected.add('img:' + i.blockId));
      state.tables.forEach((t) => { if (!t.pending) state.selected.add('tbl:' + t.blockId); });
      render();
    });

    const selNone = h('button', 'fxe-btn', '清空');
    selNone.type = 'button';
    selNone.addEventListener('click', () => { state.selected.clear(); render(); });

    bar.append(scanBtn, selAll, selNone);

    const status = h('div', 'fxe-status', '点「扫描文档」收集本页所有图片与表格');
    el.status = status;

    const prog = h('div', 'fxe-prog');
    const progFill = h('div', 'fxe-prog-fill');
    prog.appendChild(progFill);
    el.prog = prog;
    el.progFill = progFill;

    const body = h('div', 'fxe-body');
    el.body = body;

    const foot = h('div', 'fxe-foot');
    const expBtn = h('button', 'fxe-btn fxe-btn-primary fxe-export', '导出选中');
    expBtn.type = 'button';
    expBtn.disabled = true;
    expBtn.addEventListener('click', startExport);
    el.expBtn = expBtn;
    const hint = h('div', 'fxe-hint', '图片取原图；表格导出为 CSV');
    el.hint = hint;
    foot.append(expBtn, hint);

    panel.append(head, bar, status, prog, body, foot);
    root.append(panel, fab);
    document.body.appendChild(root);
  }

  function toggle(open) {
    state.open = open === undefined ? !state.open : open;
    el.panel.classList.toggle('fxe-open', state.open);
    el.fab.classList.toggle('fxe-hidden', state.open);
    if (state.open && !state.scanned && !state.scanning) setStatus('点「扫描文档」开始；长文档需要滚动收集，可能要一两分钟');
  }

  function setStatus(t) {
    el.status.textContent = t;
  }

  function setProgress(percent) {
    el.progFill.style.width = Math.max(0, Math.min(100, percent)) + '%';
  }

  function render() {
    const body = el.body;
    body.textContent = '';

    if (!state.scanned) {
      el.expBtn.disabled = true;
      return;
    }

    const imgWrap = h('div', 'fxe-section');
    const imgHead = h('div', 'fxe-sec-title');
    imgHead.textContent = `图片 ${state.images.length}`;
    imgWrap.appendChild(imgHead);

    const grid = h('div', 'fxe-grid');
    state.images.forEach((img, i) => {
      const key = 'img:' + img.blockId;
      const card = h('div', 'fxe-card' + (state.selected.has(key) ? ' fxe-sel' : ''));
      card.title = `${img.w}×${img.h}${img.heading ? '\n所属：' + img.heading : ''}`;
      const im = h('img', 'fxe-thumb');
      im.loading = 'lazy';
      im.src = coverUrl(img);
      im.alt = '';
      const num = h('span', 'fxe-num', String(i + 1));
      const chk = h('span', 'fxe-check');
      card.append(im, num, chk);
      card.addEventListener('click', () => {
        if (state.selected.has(key)) state.selected.delete(key);
        else state.selected.add(key);
        card.classList.toggle('fxe-sel', state.selected.has(key));
        refreshCount();
      });
      grid.appendChild(card);
    });
    imgWrap.appendChild(grid);
    body.appendChild(imgWrap);

    if (state.tables.length) {
      const tw = h('div', 'fxe-section');
      const th = h('div', 'fxe-sec-title');
      th.textContent = `表格 ${state.tables.length}`;
      tw.appendChild(th);
      state.tables.forEach((t, i) => {
        const key = 'tbl:' + t.blockId;
        const row = h('div', 'fxe-trow' + (state.selected.has(key) ? ' fxe-sel' : '') + (t.pending ? ' fxe-disabled' : ''));
        const chk = h('span', 'fxe-check');
        const info = h('div', 'fxe-tinfo');
        const name = h('b', '', `表格 ${i + 1}`);
        const meta = h('span', 'fxe-meta', t.pending ? '未能读取内容（只读视图下未渲染）' : `${t.rows} 行 × ${t.cols} 列`);
        info.append(name, meta);
        if (!t.pending && t.grid.length) {
          const prev = h('div', 'fxe-prev');
          prev.textContent = t.grid[0].slice(0, 4).join(' | ').slice(0, 90);
          info.appendChild(prev);
        }
        row.append(chk, info);
        if (!t.pending) {
          row.addEventListener('click', () => {
            if (state.selected.has(key)) state.selected.delete(key);
            else state.selected.add(key);
            row.classList.toggle('fxe-sel', state.selected.has(key));
            refreshCount();
          });
        }
        tw.appendChild(row);
      });
      body.appendChild(tw);
    }

    if (state.sheets.length) {
      const sw = h('div', 'fxe-section');
      const sh = h('div', 'fxe-sec-title');
      sh.textContent = `嵌入表格 / 电子表格 ${state.sheets.length}（暂不支持导出数据）`;
      sw.appendChild(sh);
      body.appendChild(sw);
    }

    if (!state.images.length && !state.tables.length) {
      setStatus('没有找到图片或表格');
    }
    refreshCount();
  }

  function selectedList() {
    const imgs = state.images.filter((i) => state.selected.has('img:' + i.blockId));
    const tbls = state.tables.filter((t) => state.selected.has('tbl:' + t.blockId) && !t.pending);
    return { imgs, tbls };
  }

  function refreshCount() {
    const { imgs, tbls } = selectedList();
    const n = imgs.length + tbls.length;
    el.expBtn.disabled = n === 0 || state.exporting || state.scanning;
    el.expBtn.textContent = `导出选中（${imgs.length} 图 / ${tbls.length} 表）`;
  }

  /* ---------------- scan ---------------- */

  async function startScan() {
    if (state.scanning) {
      state.stopFlag = true;
      return;
    }
    state.scanning = true;
    state.stopFlag = false;
    state.scanned = false;
    state.selected.clear();
    el.scanBtn.textContent = '停止';
    el.body.textContent = '';
    setStatus('正在扫描…请勿操作页面滚动');
    setProgress(0);

    let lastTick = 0;
    try {
      const res = await FXE.scan({
        onProgress: (p) => {
          const now = Date.now();
          if (now - lastTick < 120) return;
          lastTick = now;
          setProgress(p.percent);
          setStatus(`扫描中 ${p.percent}% · 已发现图片 ${p.images} · 表格 ${p.tables}`);
        },
        shouldStop: () => state.stopFlag
      });

      if (!res.ok) {
        setStatus('没找到文档正文容器，请确认当前页面是一篇飞书文档');
        setProgress(0);
        return;
      }

      state.title = res.title;
      state.sourceUrl = res.url || location.href;
      state.images = res.images;
      state.tables = res.tables;
      state.sheets = res.sheets;
      state.scanned = true;

      res.images.forEach((i) => state.selected.add('img:' + i.blockId));
      res.tables.forEach((t) => { if (!t.pending) state.selected.add('tbl:' + t.blockId); });

      el.title.textContent = res.title;
      setProgress(100);
      setStatus(`扫描完成：图片 ${res.images.length} · 表格 ${res.tables.length}` + (state.stopFlag ? '（已中途停止，结果可能不全）' : ''));
      render();
    } catch (e) {
      setStatus('扫描出错：' + (e && e.message ? e.message : e));
    } finally {
      state.scanning = false;
      el.scanBtn.textContent = '重新扫描';
      refreshCount();
    }
  }

  /* ---------------- export ---------------- */

  function toCsv(grid) {
    const esc = (v) => {
      const s = String(v == null ? '' : v);
      return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    return grid.map((row) => row.map(esc).join(',')).join('\r\n');
  }

  async function startExport() {
    if (state.exporting) return;
    const { imgs, tbls } = selectedList();
    if (!imgs.length && !tbls.length) return;

    state.exporting = true;
    refreshCount();
    el.expBtn.disabled = true;

    const files = [];
    const report = [];
    let okImg = 0;
    const total = imgs.length + tbls.length;
    let done = 0;

    try {
      // fetch originals with a small concurrency pool (serial is far too slow
      // for 100+ full-resolution images), then keep the document order.
      const slots = new Array(imgs.length);
      let cursor = 0;
      const CONCURRENCY = Math.min(4, Math.max(1, imgs.length));
      const worker = async () => {
        for (;;) {
          const i = cursor++;
          if (i >= imgs.length) return;
          const img = imgs[i];
          try {
            const { blob } = await FXE.fetchImageBytes(img);
            const ext = FXE.extFromBlob(blob, 'png');
            const buf = new Uint8Array(await blob.arrayBuffer());
            const name = `images/img_${String(i + 1).padStart(3, '0')}_${img.blockId}.${ext}`;
            const d = FXE.dimsFromBytes(buf);
            const size = d ? `${d.w}×${d.h}` : `${img.w}×${img.h}`;
            slots[i] = { name, data: buf, note: `${size}${img.heading ? ' · ' + img.heading : ''}` };
            okImg++;
          } catch (e) {
            slots[i] = { error: `- images/img_${String(i + 1).padStart(3, '0')}_${img.blockId} — 下载失败：${e && e.message}` };
          }
          done++;
          setStatus(`下载原图 ${done}/${imgs.length}…（${Math.round(((done - 0) / total) * 100)}%）`);
          setProgress((done / total) * 100);
        }
      };
      await Promise.all(Array.from({ length: CONCURRENCY }, worker));
      slots.forEach((s) => {
        if (!s) return;
        if (s.error) report.push(s.error);
        else {
          files.push({ name: s.name, data: s.data });
          report.push(`- ${s.name} — ${s.note}`);
        }
      });

      tbls.forEach((t, i) => {
        const csv = '\ufeff' + toCsv(t.grid);
        const name = `tables/table_${String(i + 1).padStart(2, '0')}.csv`;
        files.push({ name, data: new TextEncoder().encode(csv) });
        report.push(`- ${name} — ${t.rows} 行 × ${t.cols} 列`);
        done++;
      });

      if (!files.length) {
        setStatus('没有可导出的内容');
        return;
      }

      const index = [
        `# ${state.title}`,
        '',
        `- 来源：${state.sourceUrl || location.href}`,
        `- 导出时间：${new Date().toLocaleString()}`,
        `- 图片 ${okImg}/${imgs.length}，表格 ${tbls.length}`,
        '',
        '## 文件清单',
        '',
        ...report,
        ''
      ].join('\n');
      files.push({ name: 'index.md', data: new TextEncoder().encode('\ufeff' + index) });

      setStatus('打包中…');
      setProgress(100);
      const zip = window.__FXE_ZIP.buildZip(files);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(zip);
      a.download = `${safeName(state.title)}_${stamp()}.zip`;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        URL.revokeObjectURL(a.href);
        a.remove();
      }, 4000);

      setStatus(`已导出 ${okImg} 张图片、${tbls.length} 个表格（${(zip.size / 1048576).toFixed(1)} MB）`);
    } catch (e) {
      setStatus('导出出错：' + (e && e.message ? e.message : e));
    } finally {
      state.exporting = false;
      refreshCount();
    }
  }

  /* ---------------- boot ---------------- */

  function boot() {
    let tries = 0;
    const timer = setInterval(() => {
      tries++;
      const sc = FXE.findScroller(document);
      if (sc) {
        clearInterval(timer);
        buildUi();
      } else if (tries > 40) {
        clearInterval(timer);
      }
    }, 500);
  }

  boot();
})();
