/* Tablero de Evaluación 5S — GitHub Pages + Supabase */
(() => {
  'use strict';

  const CFG = window.CONFIG || {};
  const META = Number(CFG.META) || 85;
  const VERDE = Number(CFG.VERDE) || 90;
  const DEMO = !CFG.SUPABASE_URL || !CFG.SUPABASE_ANON_KEY;
  const ESES = [
    { n: 1, nombre: 'SEIRI', es: 'Seleccionar', lema: 'Mantener solo lo necesario' },
    { n: 2, nombre: 'SEITON', es: 'Organizar', lema: 'Un lugar para cada cosa y cada cosa en su lugar' },
    { n: 3, nombre: 'SEISO', es: 'Limpieza', lema: 'Un área de trabajo impecable' },
    { n: 4, nombre: 'SEIKETSU', es: 'Estandarizar', lema: 'Todo siempre igual' },
    { n: 5, nombre: 'SHITSUKE', es: 'Autodisciplina', lema: 'Seguir las reglas y ser consistente' }
  ];
  const CRITERIOS = '0 = 5 o más problemas · 1 = 4 problemas · 2 = 3 problemas · 3 = 2 problemas · 4 = 1 problema · 5 = 0 problemas';

  const state = { areas: [], preguntas: [], evals: [], pregById: new Map(), areaById: new Map(), evalsByArea: new Map() };
  let db = null;
  let charts = [];
  let currentRoute = null;

  // ---------------------------------------------------------------- utils
  const $ = (sel, el = document) => el.querySelector(sel);
  const $$ = (sel, el = document) => Array.from(el.querySelectorAll(sel));
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const r1 = (x) => Math.round(x * 10) / 10;
  const fmtPct = (x) => (x == null ? '—' : r1(x).toLocaleString('es', { minimumFractionDigits: 1, maximumFractionDigits: 1 }));
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* sin almacenamiento */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* sin almacenamiento */ } }
  };

  const parseFecha = (f) => { const [y, m, d] = String(f).slice(0, 10).split('-').map(Number); return new Date(y, m - 1, d); };
  const isoDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const hoy = () => isoDate(new Date());
  const lunesDe = (d) => { const x = new Date(d); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); x.setHours(0, 0, 0, 0); return x; };
  const semanaKey = (f) => isoDate(lunesDe(parseFecha(f)));
  const numSemana = (d) => {
    const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    const dia = t.getUTCDay() || 7;
    t.setUTCDate(t.getUTCDate() + 4 - dia);
    const ini = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
    return Math.ceil(((t - ini) / 86400000 + 1) / 7);
  };
  const fmtCorta = new Intl.DateTimeFormat('es', { day: 'numeric', month: 'short' });
  const fmtLarga = new Intl.DateTimeFormat('es', { day: 'numeric', month: 'short', year: 'numeric' });
  const fmtFecha = (f) => fmtLarga.format(parseFecha(f));
  const etiquetaSemana = (key) => {
    const ini = parseFecha(key); const fin = new Date(ini); fin.setDate(fin.getDate() + 6);
    return `Semana ${numSemana(ini)} · ${fmtCorta.format(ini)} – ${fmtLarga.format(fin)}`;
  };

  // ≥ VERDE verde · META–VERDE amarillo · < META rojo
  const cls = (pct) => (pct == null ? 'none' : r1(pct) >= VERDE ? 'ok' : r1(pct) >= META ? 'mid' : 'bad');
  const tierColor = (pct) => (pct == null ? cssVar('--border') : cssVar(`--${cls(pct)}-bar`));
  const resultadoTxt = (pct) => (r1(pct) >= META ? 'SATISFACTORIO' : 'NO SATISFACTORIO');
  const resCls = (pct) => (r1(pct) >= META ? 'sat' : 'nosat');
  const pill = (pct) => `<span class="pill ${cls(pct)}">${fmtPct(pct)}</span>`;
  const deltaHtml = (a, b) => {
    if (a == null || b == null) return '<span class="delta flat">—</span>';
    const d = r1(a - b);
    if (d === 0) return '<span class="delta flat">= 0,0</span>';
    return `<span class="delta ${d > 0 ? 'up' : 'down'}">${d > 0 ? '▲' : '▼'} ${fmtPct(Math.abs(d))}</span>`;
  };

  function toast(msg, isError = false) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'toast show' + (isError ? ' error' : '');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { t.className = 'toast'; }, isError ? 6000 : 3200);
  }

  function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

  // ---------------------------------------------------------------- data
  async function fetchAll(table, orderCol) {
    const out = [];
    const page = 1000;
    for (let from = 0; ; from += page) {
      const { data, error } = await db.from(table).select('*').order(orderCol, { ascending: true }).range(from, from + page - 1);
      if (error) throw error;
      out.push(...data);
      if (data.length < page) break;
    }
    return out;
  }

  async function loadData() {
    if (DEMO) {
      const d = window.DEMO_DATA || { areas: [], preguntas: [], evaluaciones: [] };
      state.areas = d.areas.map((a) => ({ ...a }));
      state.preguntas = d.preguntas.map((p) => ({ ...p }));
      state.evals = d.evaluaciones.map((e) => ({ ...e }));
    } else {
      const [areas, preguntas, evals] = await Promise.all([fetchAll('areas', 'orden'), fetchAll('preguntas', 'id'), fetchAll('evaluaciones', 'id')]);
      state.areas = areas; state.preguntas = preguntas; state.evals = evals;
    }
    indexar();
  }

  function indexar() {
    state.areas = state.areas.filter((a) => a.activa !== false).sort((a, b) => a.orden - b.orden || a.id - b.id);
    state.areaById = new Map(state.areas.map((a) => [a.id, a]));
    state.pregById = new Map(state.preguntas.map((p) => [p.id, p]));
    state.evalsByArea = new Map(state.areas.map((a) => [a.id, []]));
    for (const e of state.evals) {
      e.calc = calcular(e);
      if (state.evalsByArea.has(e.area_id)) state.evalsByArea.get(e.area_id).push(e);
    }
    for (const list of state.evalsByArea.values()) list.sort(cmpEvalDesc);
  }

  const cmpEvalDesc = (a, b) => (b.fecha > a.fecha ? 1 : b.fecha < a.fecha ? -1 : String(b.created_at) > String(a.created_at) ? 1 : -1);

  function calcular(ev) {
    const porS = ESES.map(() => ({ sum: 0, n: 0 }));
    let sum = 0; let n = 0;
    for (const r of ev.respuestas || []) {
      const p = state.pregById.get(r.p);
      const c = Number(r.c);
      if (p) { porS[p.s - 1].sum += c; porS[p.s - 1].n++; }
      sum += c; n++;
    }
    const pct = ev.puntaje != null ? Number(ev.puntaje) : n ? (sum / (n * 5)) * 100 : 0;
    return { sum, max: n * 5, pct, porS: porS.map((x) => ({ ...x, pts: x.n ? (x.sum / (x.n * 5)) * 20 : null })) };
  }

  async function guardarEvaluacion(ev) {
    if (DEMO) {
      const nuevo = { ...ev, id: Date.now(), created_at: new Date().toISOString(), puntaje: null };
      nuevo.puntaje = r1(calcular(nuevo).pct);
      state.evals.push(nuevo);
      indexar();
      return nuevo;
    }
    const { data, error } = await db.from('evaluaciones').insert(ev).select().single();
    if (error) throw error;
    if (!state.evals.some((e) => e.id === data.id)) state.evals.push(data);
    indexar();
    return data;
  }

  function escucharCambios() {
    if (DEMO) return;
    db.channel('evaluaciones-en-vivo')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'evaluaciones' }, (payload) => {
        const ev = payload.new;
        if (state.evals.some((e) => e.id === ev.id)) return;
        state.evals.push(ev);
        indexar();
        const area = state.areaById.get(ev.area_id);
        toast(`Nueva evaluación: ${area ? area.nombre : 'área'} (${ev.auditor})`);
        renderNav();
        // no interrumpir a quien está llenando el formulario
        if (currentRoute && currentRoute.view !== 'nueva') render();
      })
      .subscribe();
  }

  // ---------------------------------------------------------------- navegación
  function parseRoute() {
    const parts = location.hash.replace(/^#\/?/, '').split('/');
    if (parts[0] === 'area' && parts[1]) return { view: 'area', id: Number(parts[1]), evalId: parts[2] ? Number(parts[2]) : null };
    if (parts[0] === 'nueva') return { view: 'nueva', id: parts[1] ? Number(parts[1]) : null };
    return { view: 'resumen', semana: parts[1] || null };
  }

  function renderNav() {
    const route = parseRoute();
    $('#navAreas').innerHTML = state.areas.map((a) => {
      const ult = state.evalsByArea.get(a.id)[0];
      const active = route.view === 'area' && route.id === a.id;
      return `<a class="nav-item${active ? ' active' : ''}" href="#/area/${a.id}">
        <span class="nav-name">${esc(a.nombre)}</span>${ult ? pill(ult.calc.pct) : '<span class="pill none">—</span>'}</a>`;
    }).join('');
    $('.nav-resumen').classList.toggle('active', route.view === 'resumen');

    const sel = $('#mobileNav');
    const val = route.view === 'area' ? `#/area/${route.id}` : route.view === 'nueva' ? '#/nueva' : '#/resumen';
    sel.innerHTML = `<option value="#/resumen">Resumen general</option>
      <optgroup label="Áreas">${state.areas.map((a) => `<option value="#/area/${a.id}">${esc(a.nombre)}</option>`).join('')}</optgroup>
      <option value="#/nueva">+ Nueva evaluación</option>`;
    sel.value = val;
  }

  function destroyCharts() { charts.forEach((c) => c.destroy()); charts = []; }

  function render() {
    currentRoute = parseRoute();
    destroyCharts();
    renderNav();
    const main = $('#main');
    const r = currentRoute;
    if (r.view === 'area' && state.areaById.has(r.id)) renderArea(main, r.id, r.evalId);
    else if (r.view === 'nueva') renderNueva(main, r.id);
    else renderResumen(main, r.semana);
    $('#btnNueva').href = r.view === 'area' ? `#/nueva/${r.id}` : '#/nueva';
  }

  // ---------------------------------------------------------------- charts
  const metaLinePlugin = {
    id: 'metaLine',
    afterDatasetsDraw(chart, _args, opts) {
      if (opts == null || opts.value == null) return;
      const horizontal = chart.options.indexAxis === 'y';
      const scale = horizontal ? chart.scales.x : chart.scales.y;
      const px = scale.getPixelForValue(opts.value);
      const { ctx, chartArea: a } = chart;
      ctx.save();
      ctx.strokeStyle = opts.color; ctx.lineWidth = 1.5; ctx.setLineDash([5, 4]);
      ctx.beginPath();
      if (horizontal) { ctx.moveTo(px, a.top); ctx.lineTo(px, a.bottom); } else { ctx.moveTo(a.left, px); ctx.lineTo(a.right, px); }
      ctx.stroke();
      ctx.setLineDash([]); ctx.fillStyle = opts.color; ctx.font = '600 11px Inter, sans-serif';
      const txt = opts.label || `Meta ${opts.value}%`;
      if (horizontal) { ctx.textAlign = 'center'; ctx.fillText(txt, px, a.top - 6); } else { ctx.textAlign = 'right'; ctx.fillText(txt, a.right, px - 5); }
      ctx.restore();
    }
  };

  function baseChartOpts() {
    const muted = cssVar('--muted'); const grid = cssVar('--border');
    Chart.defaults.font.family = 'Inter, system-ui, sans-serif';
    Chart.defaults.font.size = 12;
    Chart.defaults.color = muted;
    return { responsive: true, maintainAspectRatio: false, animation: { duration: 250 }, gridColor: grid };
  }

  // escribe el valor encima (vertical) o al final (horizontal) de cada barra, como en el Excel
  const valoresPlugin = {
    id: 'valores',
    afterDatasetsDraw(chart, _args, opts) {
      const { ctx } = chart;
      const horizontal = chart.options.indexAxis === 'y';
      const meta = chart.getDatasetMeta(0);
      ctx.save();
      ctx.font = '600 11px Inter, sans-serif';
      ctx.fillStyle = (opts && opts.color) || cssVar('--text');
      meta.data.forEach((bar, i) => {
        const v = chart.data.datasets[0].data[i];
        if (v == null) return;
        const txt = fmtPct(v);
        if (horizontal) { ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText(txt, bar.x + 5, bar.y); } else { ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'; ctx.fillText(txt, bar.x, bar.y - 4); }
      });
      ctx.restore();
    }
  };

  const recortar = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

  function chartBarras(canvas, labels, values, onClick) {
    const b = baseChartOpts();
    // en pantallas angostas las 21 barras se leen mejor en horizontal
    const horizontal = canvas.parentElement.clientWidth < 640;
    const valueAxis = { min: 0, max: 100, grid: { color: b.gridColor }, ticks: { stepSize: 25, callback: (v) => `${v}%` } };
    const catAxis = { grid: { display: false }, ticks: { autoSkip: false, font: { size: 11 }, maxRotation: 50, minRotation: horizontal ? 0 : 50, callback(v) { return recortar(this.getLabelForValue(v), horizontal ? 22 : 24); } } };
    const c = new Chart(canvas, {
      type: 'bar',
      data: { labels, datasets: [{ data: values, backgroundColor: values.map(tierColor), borderRadius: 4, maxBarThickness: horizontal ? 16 : 30 }] },
      options: {
        responsive: true, maintainAspectRatio: false, animation: b.animation, indexAxis: horizontal ? 'y' : 'x',
        layout: { padding: horizontal ? { top: 18, right: 34 } : { top: 20 } },
        scales: horizontal ? { x: valueAxis, y: catAxis } : { y: valueAxis, x: catAxis },
        plugins: { legend: { display: false }, metaLine: { value: META, color: cssVar('--muted') },
          tooltip: { callbacks: { label: (ctx) => (ctx.raw == null ? 'Sin evaluar' : `${fmtPct(ctx.raw)}%`) } } },
        onClick: (_e, els) => { if (els.length && onClick) onClick(els[0].index); },
        onHover: (e, els) => { e.native.target.style.cursor = els.length ? 'pointer' : 'default'; }
      },
      plugins: [metaLinePlugin, valoresPlugin]
    });
    charts.push(c);
  }

  function chartLinea(canvas, labels, values, onClick) {
    const b = baseChartOpts();
    const brand = cssVar('--brand');
    const minV = Math.min(...values.filter((v) => v != null), META);
    const c = new Chart(canvas, {
      type: 'line',
      data: { labels, datasets: [{ data: values, borderColor: brand, backgroundColor: brand, pointRadius: 4, pointHoverRadius: 6, tension: 0.25, spanGaps: true, borderWidth: 2 }] },
      options: {
        responsive: true, maintainAspectRatio: false, animation: b.animation,
        scales: {
          y: { suggestedMin: Math.max(0, Math.floor((minV - 8) / 5) * 5), max: 100, grid: { color: b.gridColor }, ticks: { callback: (v) => `${v}%` } },
          x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkipPadding: 12 } }
        },
        plugins: { legend: { display: false }, metaLine: { value: META, color: cssVar('--muted') },
          tooltip: { callbacks: { label: (ctx) => `${fmtPct(ctx.raw)}%` } } },
        onClick: (_e, els) => { if (els.length && onClick) onClick(els[0].index); }
      },
      plugins: [metaLinePlugin]
    });
    charts.push(c);
  }

  function chartEses(canvas, ev) {
    const b = baseChartOpts();
    const vals = ev.calc.porS.map((x) => (x.pts == null ? null : r1(x.pts)));
    const c = new Chart(canvas, {
      type: 'bar',
      data: { labels: ESES.map((s) => [s.nombre, s.es]), datasets: [{ data: vals, backgroundColor: vals.map((v) => tierColor(v == null ? null : (v / 20) * 100)), borderRadius: 4, maxBarThickness: 46 }] },
      options: {
        responsive: true, maintainAspectRatio: false, animation: b.animation,
        scales: { y: { min: 0, max: 20, grid: { color: b.gridColor }, ticks: { stepSize: 5 } }, x: { grid: { display: false }, ticks: { font: { size: 11 } } } },
        plugins: { legend: { display: false }, metaLine: { value: (META / 100) * 20, label: `Meta ${fmtPct((META / 100) * 20)} pts`, color: cssVar('--muted') },
          tooltip: { callbacks: { label: (ctx) => `${fmtPct(ctx.raw)} de 20 pts` } } }
      },
      plugins: [metaLinePlugin]
    });
    charts.push(c);
  }

  // ---------------------------------------------------------------- vista: resumen
  function filasResumen(semana) {
    return state.areas.map((a, i) => {
      const list = state.evalsByArea.get(a.id);
      const idx = semana ? list.findIndex((e) => semanaKey(e.fecha) === semana) : list.length ? 0 : -1;
      const ev = idx >= 0 ? list[idx] : null;
      const prev = idx >= 0 ? list[idx + 1] || null : null;
      return { no: i + 1, area: a, ev, prev };
    });
  }

  function semanasConDatos() {
    return Array.from(new Set(state.evals.map((e) => semanaKey(e.fecha)))).sort().reverse();
  }

  function renderResumen(main, semana) {
    const semanas = semanasConDatos();
    if (semana && !semanas.includes(semana)) semana = null;
    const filas = filasResumen(semana);
    const conEval = filas.filter((f) => f.ev);
    const prom = conEval.length ? conEval.reduce((s, f) => s + f.ev.calc.pct, 0) / conEval.length : null;
    const sat = conEval.filter((f) => resCls(f.ev.calc.pct) === 'sat').length;
    const semActual = semanaKey(hoy());
    const evalSemana = state.areas.filter((a) => (state.evalsByArea.get(a.id)[0] || {}).fecha && semanaKey(state.evalsByArea.get(a.id)[0].fecha) === semActual).length;
    const bajo = conEval.filter((f) => resCls(f.ev.calc.pct) === 'nosat').sort((a, b) => a.ev.calc.pct - b.ev.calc.pct);

    main.innerHTML = `
      <div class="page-head">
        <div>
          <h1>Resumen de evaluaciones 5´s</h1>
          <div class="sub">${semana ? esc(etiquetaSemana(semana)) : 'Última evaluación registrada de cada área'} · Meta: ${META}%</div>
        </div>
        <div class="page-actions">
          <select id="selSemana" aria-label="Semana">
            <option value="">Última evaluación de cada área</option>
            ${semanas.map((s) => `<option value="${s}" ${s === semana ? 'selected' : ''}>${esc(etiquetaSemana(s))}</option>`).join('')}
          </select>
          <button class="btn" id="btnXlsx">Descargar Excel</button>
          <button class="btn" id="btnPdf">Descargar PDF</button>
          <button class="btn" id="btnCsv">CSV</button>
        </div>
      </div>

      <div class="kpis">
        <div class="card kpi"><div class="k-label">Promedio general</div><div class="k-value ${cls(prom)}">${prom == null ? '—' : fmtPct(prom) + '%'}</div><div class="k-foot">${conEval.length} áreas con evaluación</div></div>
        <div class="card kpi"><div class="k-label">Áreas satisfactorias</div><div class="k-value">${sat}<span class="muted" style="font-size:16px"> / ${conEval.length}</span></div><div class="k-foot">≥ ${META}%</div></div>
        <div class="card kpi"><div class="k-label">No satisfactorias</div><div class="k-value ${bajo.length ? 'bad' : 'ok'}">${bajo.length}</div><div class="k-foot">${bajo.length ? esc(bajo[0].area.nombre) + ' es la más baja' : 'Todas cumplen la meta'}</div></div>
        <div class="card kpi"><div class="k-label">Evaluadas esta semana</div><div class="k-value">${evalSemana}<span class="muted" style="font-size:16px"> / ${state.areas.length}</span></div><div class="k-foot">${esc(etiquetaSemana(semActual).split(' · ')[0])}</div></div>
      </div>

      <div class="grid-2 resultados">
        <div class="card">
          <div class="card-head"><h2>Resultados por área</h2><span class="muted" style="font-size:12px">Clic en un área para ver el detalle</span></div>
          <div class="table-wrap"><table class="tabla-resultados">
            <thead><tr><th class="c">No.</th><th>Área</th><th class="c">Puntuación</th><th>Resultado</th><th class="r">vs. anterior</th></tr></thead>
            <tbody>${filas.map((f) => `
              <tr class="clickable" data-href="#/area/${f.area.id}${f.ev ? '/' + f.ev.id : ''}">
                <td class="c muted num">${f.no}</td>
                <td><a class="area-link" href="#/area/${f.area.id}${f.ev ? '/' + f.ev.id : ''}">${esc(f.area.nombre)}</a>
                  ${f.ev ? `<div class="sub-celda">${fmtFecha(f.ev.fecha)} · ${esc(f.ev.auditor)}</div>` : ''}</td>
                <td class="punt">${f.ev ? pill(f.ev.calc.pct) : '<span class="pill none">—</span>'}</td>
                <td class="nowrap">${f.ev ? `<span class="resultado ${resCls(f.ev.calc.pct)}">${resultadoTxt(f.ev.calc.pct)}</span>` : '<span class="muted">Sin evaluar</span>'}</td>
                <td class="r nowrap">${f.ev ? deltaHtml(f.ev.calc.pct, f.prev && f.prev.calc.pct) : ''}</td>
              </tr>`).join('')}
            </tbody>
          </table></div>
        </div>
        <div class="card">
          <div class="card-head"><h2>Puntuación por área</h2>
            <div class="leyenda"><span><i class="ok"></i>${VERDE}% o más</span><span><i class="mid"></i>${META}% – ${fmtPct(VERDE - 0.1)}%</span><span><i class="bad"></i>Menos de ${META}%</span></div>
          </div>
          <div class="chart-box tall"><canvas id="chBarras" aria-label="Puntuación por área"></canvas></div>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h2>Tendencia semanal del promedio general</h2><span class="muted" style="font-size:12px">Promedio de las áreas evaluadas cada semana</span></div>
        <div class="chart-box short"><canvas id="chTendencia" aria-label="Tendencia semanal"></canvas></div>
      </div>`;

    $('#selSemana').addEventListener('change', (e) => { location.hash = e.target.value ? `#/resumen/${e.target.value}` : '#/resumen'; });
    $('#btnCsv').addEventListener('click', () => exportarCsvGeneral());
    $('#btnXlsx').addEventListener('click', (e) => generar(e.currentTarget, () => excelGeneral(semana, filas)));
    $('#btnPdf').addEventListener('click', (e) => generar(e.currentTarget, () => pdfGeneral(semana, filas)));
    $$('tr[data-href]', main).forEach((tr) => tr.addEventListener('click', (e) => { if (!e.target.closest('a')) location.hash = tr.dataset.href; }));

    chartBarras($('#chBarras'), filas.map((f) => f.area.nombre), filas.map((f) => (f.ev ? r1(f.ev.calc.pct) : null)), (i) => { location.hash = `#/area/${filas[i].area.id}`; });

    const t = tendencia(semanas);
    chartLinea($('#chTendencia'), t.labels, t.values, (i) => { location.hash = `#/resumen/${t.semanas[i]}`; });
  }

  // promedio de las áreas evaluadas en cada una de las últimas 16 semanas
  function tendencia(semanas) {
    const ultimas = semanas.slice(0, 16).reverse();
    const values = ultimas.map((s) => {
      const evs = state.evals.filter((e) => semanaKey(e.fecha) === s);
      const porArea = new Map();
      evs.slice().sort(cmpEvalDesc).forEach((e) => { if (!porArea.has(e.area_id)) porArea.set(e.area_id, e.calc.pct); });
      const v = Array.from(porArea.values());
      return v.length ? r1(v.reduce((a, b) => a + b, 0) / v.length) : null;
    });
    return { semanas: ultimas, labels: ultimas.map((s) => `S${numSemana(parseFecha(s))}`), values };
  }

  // ---------------------------------------------------------------- vista: área
  function preguntasDeEval(ev) {
    const items = (ev.respuestas || []).map((r) => ({ r, p: state.pregById.get(r.p) })).filter((x) => x.p);
    return ESES.map((s) => items.filter((x) => x.p.s === s.n).sort((a, b) => a.p.orden - b.p.orden || a.p.id - b.p.id));
  }

  function renderArea(main, areaId, evalId) {
    const area = state.areaById.get(areaId);
    const list = state.evalsByArea.get(areaId);
    const ev = (evalId && list.find((e) => e.id === evalId)) || list[0] || null;

    if (!ev) {
      main.innerHTML = `<div class="page-head"><div><h1>${esc(area.nombre)}</h1><div class="sub">Sin evaluaciones registradas</div></div>
        <div class="page-actions"><a class="btn btn-primary" href="#/nueva/${area.id}">+ Evaluar esta área</a></div></div>
        <div class="card empty">Aún no hay evaluaciones para esta área.</div>`;
      return;
    }

    const idx = list.indexOf(ev);
    const prev = list[idx + 1] || null;
    const grupos = preguntasDeEval(ev);
    const mejoras = grupos.flat().filter((x) => Number(x.r.c) <= 3).sort((a, b) => a.r.c - b.r.c);
    const cronologico = list.slice().reverse();

    main.innerHTML = `
      <div class="page-head">
        <div>
          <h1>${esc(area.nombre)}</h1>
          <div class="sub">${list.length} evaluaciones registradas · Meta: ${META}%</div>
        </div>
        <div class="page-actions">
          <select id="selEval" aria-label="Evaluación">
            ${list.map((e) => `<option value="${e.id}" ${e.id === ev.id ? 'selected' : ''}>${fmtFecha(e.fecha)} · ${esc(e.auditor)} · ${fmtPct(e.calc.pct)}%</option>`).join('')}
          </select>
          <button class="btn" id="btnXlsxArea">Descargar Excel</button>
          <button class="btn" id="btnPdfArea">Descargar PDF</button>
          <button class="btn" id="btnCsvArea">CSV</button>
          <a class="btn btn-primary" href="#/nueva/${area.id}">+ Evaluar</a>
        </div>
      </div>

      <div class="grid-2">
        <div class="card">
          <div class="card-head"><h2>Formato de evaluación 5´s</h2>${idx === 0 ? '<span class="pill ok" style="min-width:0">Más reciente</span>' : ''}</div>
          <div class="meta-row">
            <div><span>Auditor</span><strong>${esc(ev.auditor)}</strong></div>
            <div><span>Área auditada</span><strong>${esc(area.nombre)}</strong></div>
            <div><span>Fecha</span><strong>${fmtFecha(ev.fecha)}</strong></div>
          </div>
          <div class="criterios"><strong>Criterios:</strong> ${CRITERIOS}</div>
          ${ESES.map((s, i) => {
            const g = grupos[i]; const ps = ev.calc.porS[i];
            if (!g.length) return '';
            return `<div class="s-block">
              <div class="s-title"><h3>${s.nombre} – ${s.es} <span>“${s.lema}”</span></h3></div>
              <div class="table-wrap"><table class="s-table">
                <thead><tr><th>Descripción</th><th class="c">Calificación</th><th>Comentarios</th></tr></thead>
                <tbody>${g.map((x) => `<tr><td class="q">${esc(x.p.texto)}</td><td class="cal"><span class="score s${x.r.c}">${x.r.c}</span></td><td class="com">${esc(x.r.o || '')}</td></tr>`).join('')}</tbody>
              </table></div>
              <div class="s-foot"><span>Suma: <strong class="num">${ps.sum} / ${ps.n * 5}</strong></span><span>Resultado ${s.es.toLowerCase()}: <strong class="num">${fmtPct(ps.pts)} / 20</strong></span></div>
            </div>`;
          }).join('')}
          <div class="total-row">
            <div><span>Puntos posibles</span><strong>${ev.calc.max}</strong></div>
            <div><span>Puntos obtenidos</span><strong>${ev.calc.sum}</strong></div>
            <div><span>Calificación</span><strong class="tier ${cls(ev.calc.pct)}">${fmtPct(ev.calc.pct)}%</strong></div>
            <div><span>Resultado</span><strong class="resultado ${resCls(ev.calc.pct)}" style="font-size:14px">${resultadoTxt(ev.calc.pct)}</strong></div>
          </div>
          ${ev.observaciones ? `<div class="obs"><h3>Observaciones generales</h3><p>${esc(ev.observaciones)}</p></div>` : ''}
        </div>

        <div class="stack">
          <div class="card">
            <div class="card-head"><h2>Resultado por S</h2><span>${deltaHtml(ev.calc.pct, prev && prev.calc.pct)} <span class="muted" style="font-size:12px">vs. anterior</span></span></div>
            <div class="chart-box short"><canvas id="chEses" aria-label="Resultado por S"></canvas></div>
          </div>
          <div class="card">
            <div class="card-head"><h2>Historial de puntuación</h2></div>
            <div class="chart-box short"><canvas id="chHist" aria-label="Historial de puntuación"></canvas></div>
          </div>
          <div class="card">
            <div class="card-head"><h2>Puntos a mejorar</h2><span class="muted" style="font-size:12px">Calificación 3 o menos</span></div>
            ${mejoras.length ? `<ul class="mejoras">${mejoras.map((x) => `<li><span class="score s${x.r.c}">${x.r.c}</span><div><div>${esc(x.p.texto)}</div><div class="s-tag">${ESES[x.p.s - 1].nombre}${x.r.o ? ' · ' + esc(x.r.o) : ''}</div></div></li>`).join('')}</ul>` : '<div class="empty">Sin aspectos con calificación baja.</div>'}
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h2>Historial de evaluaciones</h2><span class="muted" style="font-size:12px">Clic en una fila para verla</span></div>
        <div class="table-wrap"><table>
          <thead><tr><th>Fecha</th><th>Semana</th><th>Auditor</th>${ESES.map((s) => `<th class="c">${s.nombre}</th>`).join('')}<th class="c">Total</th><th>Resultado</th></tr></thead>
          <tbody>${list.map((e) => `
            <tr class="clickable${e.id === ev.id ? ' selected' : ''}" data-id="${e.id}">
              <td class="num">${fmtFecha(e.fecha)}</td>
              <td class="muted num">S${numSemana(parseFecha(e.fecha))}</td>
              <td>${esc(e.auditor)}</td>
              ${e.calc.porS.map((x) => `<td class="c num">${fmtPct(x.pts)}</td>`).join('')}
              <td class="c">${pill(e.calc.pct)}</td>
              <td class="nowrap"><span class="resultado ${resCls(e.calc.pct)}">${resultadoTxt(e.calc.pct)}</span></td>
            </tr>`).join('')}
          </tbody>
        </table></div>
      </div>`;

    $('#selEval').addEventListener('change', (e) => { location.hash = `#/area/${area.id}/${e.target.value}`; });
    $('#btnCsvArea').addEventListener('click', () => exportarCsvArea(area));
    $('#btnXlsxArea').addEventListener('click', (e) => generar(e.currentTarget, () => excelArea(area, ev)));
    $('#btnPdfArea').addEventListener('click', (e) => generar(e.currentTarget, () => pdfArea(area, ev)));
    $$('tr[data-id]', main).forEach((tr) => tr.addEventListener('click', () => { location.hash = `#/area/${area.id}/${tr.dataset.id}`; }));

    chartEses($('#chEses'), ev);
    chartLinea($('#chHist'), cronologico.map((e) => fmtCorta.format(parseFecha(e.fecha))), cronologico.map((e) => r1(e.calc.pct)), (i) => { location.hash = `#/area/${area.id}/${cronologico[i].id}`; });
  }

  // ---------------------------------------------------------------- vista: nueva evaluación
  function renderNueva(main, areaId) {
    const areaSel = areaId && state.areaById.has(areaId) ? areaId : null;
    main.innerHTML = `
      <div class="page-head">
        <div><h1>Nueva evaluación 5´s</h1><div class="sub">Califica cada aspecto de 0 a 5 y agrega comentarios donde haga falta</div></div>
      </div>
      <form id="frm" class="card" novalidate>
        <div class="form-head">
          <label class="field">Área auditada
            <select id="fArea" required>
              <option value="">Selecciona un área…</option>
              ${state.areas.map((a) => `<option value="${a.id}" ${a.id === areaSel ? 'selected' : ''}>${esc(a.nombre)}</option>`).join('')}
            </select>
          </label>
          <label class="field">Fecha de evaluación<input type="date" id="fFecha" value="${hoy()}" max="${hoy()}" required></label>
          <label class="field">Auditor
            <input type="text" id="fAuditor" autocomplete="off" maxlength="80" placeholder="Escribe tu nombre y apellido" required>
          </label>
        </div>
        <div id="avisoSemana"></div>
        <div class="criterios"><strong>Criterios:</strong> ${CRITERIOS}</div>
        <div id="preguntas"></div>
      </form>
      <div class="sticky-foot">
        <div class="live">
          <span class="muted">Respondidas <strong id="lvResp" class="num">0/0</strong></span>
          <span class="muted">Calificación <strong id="lvPct" class="num">—</strong></span>
          <span id="lvRes" class="resultado"></span>
        </div>
        <div style="display:flex;gap:8px">
          <a class="btn" href="${areaSel ? '#/area/' + areaSel : '#/resumen'}">Cancelar</a>
          <button class="btn btn-primary" id="btnGuardar" type="button">Guardar evaluación</button>
        </div>
      </div>`;

    const fArea = $('#fArea');
    fArea.addEventListener('change', () => { history.replaceState(null, '', fArea.value ? `#/nueva/${fArea.value}` : '#/nueva'); pintarPreguntas(); });
    $('#fFecha').addEventListener('change', avisoSemana);
    $('#btnGuardar').addEventListener('click', enviar);
    $('#preguntas').addEventListener('input', () => { actualizar(); guardarBorrador(); });
    $('#preguntas').addEventListener('change', (e) => { const row = e.target.closest('.q-row'); if (row) row.classList.remove('missing'); });
    pintarPreguntas();

    function claveBorrador() { return `5s_borrador_${fArea.value}`; }

    function pintarPreguntas() {
      const cont = $('#preguntas');
      const id = Number(fArea.value);
      avisoSemana();
      if (!id) { cont.innerHTML = '<div class="empty">Selecciona un área para ver los aspectos a evaluar.</div>'; actualizar(); return; }
      const pregs = state.preguntas.filter((p) => p.area_id === id && p.activo !== false);
      let num = 0;
      cont.innerHTML = ESES.map((s) => {
        const g = pregs.filter((p) => p.s === s.n).sort((a, b) => a.orden - b.orden || a.id - b.id);
        if (!g.length) return '';
        return `<div class="s-block">
          <div class="s-title"><h3>${s.nombre} – ${s.es} <span>“${s.lema}”</span></h3><span class="muted num" data-sub="${s.n}"></span></div>
          ${g.map((p) => { num++; return `
            <div class="q-row" data-p="${p.id}" data-s="${s.n}">
              <div class="q-text"><span class="q-num">${num}.</span>${esc(p.texto)}</div>
              <div class="seg" role="radiogroup" aria-label="Calificación pregunta ${num}">
                ${[0, 1, 2, 3, 4, 5].map((v) => `<input type="radio" name="q${p.id}" id="q${p.id}_${v}" value="${v}"><label for="q${p.id}_${v}" class="v${v}">${v}</label>`).join('')}
              </div>
              <div class="q-com"><input type="text" name="o${p.id}" maxlength="300" placeholder="Comentario u observación (opcional)"></div>
            </div>`; }).join('')}
        </div>`;
      }).join('') + `<div class="obs" style="padding-top:16px"><label class="field">Observaciones generales<textarea id="fObs" maxlength="2000" placeholder="Hallazgos, acuerdos, acciones correctivas…"></textarea></label></div>`;

      // restaurar borrador si existe
      try {
        const b = JSON.parse(store.get(claveBorrador()) || 'null');
        if (b) {
          Object.entries(b.c || {}).forEach(([pid, v]) => { const el = $(`#q${pid}_${v}`); if (el) el.checked = true; });
          Object.entries(b.o || {}).forEach(([pid, v]) => { const el = $(`input[name="o${pid}"]`); if (el) el.value = v; });
          if (b.obs) $('#fObs').value = b.obs;
          toast('Se recuperó un borrador sin guardar de esta área');
        }
      } catch { /* borrador inválido */ }
      actualizar();
    }

    function leer() {
      const rows = $$('.q-row');
      const respuestas = []; const faltan = [];
      for (const row of rows) {
        const pid = Number(row.dataset.p);
        const sel = $('input[type=radio]:checked', row);
        const o = $(`input[name="o${pid}"]`, row).value.trim();
        if (!sel) { faltan.push(row); continue; }
        const r = { p: pid, c: Number(sel.value) };
        if (o) r.o = o;
        respuestas.push(r);
      }
      return { rows, respuestas, faltan };
    }

    function actualizar() {
      const { rows, respuestas } = leer();
      $('#lvResp').textContent = `${respuestas.length}/${rows.length}`;
      const sum = respuestas.reduce((s, r) => s + r.c, 0);
      const pct = respuestas.length ? (sum / (rows.length * 5)) * 100 : null;
      $('#lvPct').textContent = pct == null ? '—' : `${fmtPct(pct)}%`;
      $('#lvPct').className = `num tier ${pct == null ? '' : cls(pct)}`;
      const res = $('#lvRes');
      if (rows.length && respuestas.length === rows.length) { res.textContent = resultadoTxt(pct); res.className = `resultado ${resCls(pct)}`; } else { res.textContent = ''; }
      ESES.forEach((s) => {
        const el = $(`[data-sub="${s.n}"]`); if (!el) return;
        const rs = $$(`.q-row[data-s="${s.n}"]`);
        const vals = rs.map((r) => $('input[type=radio]:checked', r)).filter(Boolean).map((i) => Number(i.value));
        el.textContent = `${vals.reduce((a, b) => a + b, 0)} / ${rs.length * 5}`;
      });
    }

    function guardarBorrador() {
      if (!fArea.value) return;
      const b = { c: {}, o: {}, obs: ($('#fObs') || {}).value || '' };
      $$('.q-row').forEach((row) => {
        const pid = row.dataset.p;
        const sel = $('input[type=radio]:checked', row); if (sel) b.c[pid] = sel.value;
        const o = $(`input[name="o${pid}"]`, row).value; if (o) b.o[pid] = o;
      });
      store.set(claveBorrador(), JSON.stringify(b));
    }

    function avisoSemana() {
      const id = Number(fArea.value); const f = $('#fFecha').value; const box = $('#avisoSemana');
      if (!id || !f) { box.innerHTML = ''; return; }
      const ya = (state.evalsByArea.get(id) || []).find((e) => semanaKey(e.fecha) === semanaKey(f));
      box.innerHTML = ya ? `<div class="aviso">Esta área ya tiene una evaluación en esa semana (${fmtFecha(ya.fecha)}, ${esc(ya.auditor)}, ${fmtPct(ya.calc.pct)}%). Si guardas otra, el resumen semanal mostrará la más reciente y ambas quedan en el historial.</div>` : '';
    }

    async function enviar() {
      const area = Number(fArea.value);
      const fecha = $('#fFecha').value;
      const auditor = $('#fAuditor').value.trim().replace(/\s+/g, ' ');
      if (!area) { toast('Selecciona el área auditada', true); fArea.focus(); return; }
      if (!fecha) { toast('Indica la fecha de evaluación', true); $('#fFecha').focus(); return; }
      if (fecha > hoy()) { toast('La fecha no puede ser futura', true); $('#fFecha').focus(); return; }
      if (auditor.length < 2) { toast('Escribe el nombre del auditor', true); $('#fAuditor').focus(); return; }
      const { respuestas, faltan } = leer();
      if (faltan.length) {
        faltan.forEach((r) => r.classList.add('missing'));
        faltan[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
        toast(faltan.length === 1 ? 'Falta 1 aspecto por calificar' : `Faltan ${faltan.length} aspectos por calificar`, true);
        return;
      }
      const btn = $('#btnGuardar');
      btn.disabled = true; btn.textContent = 'Guardando…';
      try {
        const obs = $('#fObs').value.trim();
        const nuevo = await guardarEvaluacion({ area_id: area, fecha, auditor, respuestas, observaciones: obs || null });
        store.del(claveBorrador());
        toast(`Evaluación guardada: ${fmtPct(calcular(nuevo).pct)}%`);
        location.hash = `#/area/${area}/${nuevo.id}`;
      } catch (err) {
        console.error(err);
        toast('No se pudo guardar. Revisa tu conexión e intenta de nuevo. ' + (err.message || ''), true);
        btn.disabled = false; btn.textContent = 'Guardar evaluación';
      }
    }
  }

  // ---------------------------------------------------------------- CSV
  function descargarCsv(nombre, filas) {
    const csv = filas.map((f) => f.map((v) => {
      const s = v == null ? '' : String(v);
      return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(',')).join('\r\n');
    descargarBlob(nombre, new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
  }

  function descargarBlob(nombre, blob) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = nombre;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function exportarCsvGeneral() {
    const filas = [['Fecha', 'Semana', 'Área', 'Auditor', ...ESES.map((s) => `${s.nombre} (/20)`), 'Puntuación %', 'Resultado', 'Observaciones']];
    state.evals.slice().sort((a, b) => -cmpEvalDesc(a, b)).forEach((e) => {
      const a = state.areaById.get(e.area_id);
      filas.push([e.fecha, numSemana(parseFecha(e.fecha)), a ? a.nombre : e.area_id, e.auditor, ...e.calc.porS.map((x) => (x.pts == null ? '' : r1(x.pts))), r1(e.calc.pct), resultadoTxt(e.calc.pct), e.observaciones || '']);
    });
    descargarCsv(`evaluaciones-5s-${hoy()}.csv`, filas);
  }

  function exportarCsvArea(area) {
    const list = state.evalsByArea.get(area.id).slice().reverse();
    const pids = Array.from(new Set(list.flatMap((e) => e.respuestas.map((r) => r.p))))
      .map((id) => state.pregById.get(id)).filter(Boolean).sort((a, b) => a.s - b.s || a.orden - b.orden || a.id - b.id);
    const filas = [['Fecha', 'Auditor', ...pids.flatMap((p) => [`${ESES[p.s - 1].nombre}: ${p.texto}`, 'Comentario']), 'Puntuación %', 'Resultado', 'Observaciones']];
    list.forEach((e) => {
      const m = new Map(e.respuestas.map((r) => [r.p, r]));
      filas.push([e.fecha, e.auditor, ...pids.flatMap((p) => { const r = m.get(p.id); return r ? [r.c, r.o || ''] : ['', '']; }), r1(e.calc.pct), resultadoTxt(e.calc.pct), e.observaciones || '']);
    });
    descargarCsv(`5s-${area.nombre.toLowerCase().replace(/[^a-z0-9áéíóúñ]+/gi, '-')}-${hoy()}.csv`, filas);
  }

  // ---------------------------------------------------------------- reportes (Excel y PDF)
  const EXCELJS_URL = 'https://cdnjs.cloudflare.com/ajax/libs/exceljs/4.4.0/exceljs.min.js';
  // colores fijos del tema claro: el reporte se ve igual sin importar el tema de quien lo descarga
  const RC = {
    quali: '00602A', text: '1D2318', muted: '66684F', border: 'E3E2D3', soft: 'F9F9F3', white: 'FFFFFF',
    ok: '2F8F45', okSoft: 'E1F1DF', okInk: '1A7A35',
    mid: 'F9B915', midSoft: 'FFF1C6', midInk: '8F6400',
    bad: 'F5361A', badSoft: 'FDE2DC', badInk: 'D12D12'
  };
  const tono = (pct) => ({ ok: ['ok', 'okSoft', 'okInk'], mid: ['mid', 'midSoft', 'midInk'], bad: ['bad', 'badSoft', 'badInk'] }[cls(pct)] || ['border', 'soft', 'muted']).map((k) => RC[k]);
  const tonoNota = (c) => tono(c >= 4 ? VERDE : c === 3 ? META : 0);
  const slug = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const fmtHoy = () => fmtLarga.format(new Date());

  async function generar(btn, fn) {
    const txt = btn.textContent;
    btn.disabled = true; btn.textContent = 'Generando…';
    try { await fn(); } catch (err) {
      console.error(err);
      toast('No se pudo generar el reporte. Revisa tu conexión e intenta de nuevo. ' + (err.message || ''), true);
    } finally { btn.disabled = false; btn.textContent = txt; }
  }

  function cargarScript(url) {
    return new Promise((ok, ko) => {
      const s = document.createElement('script');
      s.src = url; s.onload = ok; s.onerror = () => ko(new Error('No se pudo cargar ' + url));
      document.head.appendChild(s);
    });
  }

  // gráfica en PNG con fondo blanco, dibujada fuera de pantalla
  function graficaPng({ tipo = 'bar', labels, values, w, h, max = 100, min = 0, sufijo = '%', meta = META, metaLabel, aPct = (v) => v, rotar = false }) {
    const box = document.createElement('div');
    box.style.cssText = `position:fixed;left:-10000px;top:0;width:${w}px;height:${h}px`;
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    box.appendChild(canvas); document.body.appendChild(box);
    const texto = '#' + RC.text; const gris = '#' + RC.muted;
    const font = { family: 'Inter, Arial, sans-serif', size: 12 };
    const fondo = { id: 'fondo', beforeDraw(c) { c.ctx.save(); c.ctx.fillStyle = '#fff'; c.ctx.fillRect(0, 0, c.width, c.height); c.ctx.restore(); } };
    const dataset = tipo === 'bar'
      ? { data: values, backgroundColor: values.map((v) => '#' + tono(v == null ? null : aPct(v))[0]), borderRadius: 3, maxBarThickness: 46 }
      : { data: values, borderColor: '#' + RC.quali, backgroundColor: '#' + RC.quali, pointRadius: 3.5, tension: 0.25, spanGaps: true, borderWidth: 2 };
    const chart = new Chart(canvas, {
      type: tipo,
      data: { labels, datasets: [dataset] },
      options: {
        responsive: false, animation: false, devicePixelRatio: 2,
        layout: { padding: { top: 22, right: 12, left: 4 } },
        scales: {
          y: { min, max, grid: { color: '#' + RC.border }, ticks: { color: gris, font, callback: (v) => `${v}${sufijo}` } },
          x: { grid: { display: false }, ticks: { color: texto, font: { ...font, size: 11 }, autoSkip: false, maxRotation: rotar ? 55 : 0, minRotation: rotar ? 55 : 0,
            callback(v) { const l = this.getLabelForValue(v); return typeof l === 'string' ? recortar(l, 26) : l; } } }
        },
        plugins: { legend: { display: false }, tooltip: { enabled: false }, metaLine: { value: meta, label: metaLabel, color: gris }, valores: { color: texto } }
      },
      plugins: [fondo, metaLinePlugin, valoresPlugin]
    });
    const url = chart.toBase64Image('image/png', 1);
    chart.destroy(); box.remove();
    return url;
  }

  const minLinea = (values) => Math.max(0, Math.floor((Math.min(...values.filter((v) => v != null), META) - 8) / 5) * 5);
  const grafBarrasAreas = (filas, w, h) => graficaPng({ labels: filas.map((f) => f.area.nombre), values: filas.map((f) => (f.ev ? r1(f.ev.calc.pct) : null)), w, h, rotar: true });
  const grafTendencia = (t, w, h) => graficaPng({ tipo: 'line', labels: t.labels, values: t.values, w, h, min: minLinea(t.values) });
  const grafEses = (ev, w, h) => graficaPng({ labels: ESES.map((s) => [s.nombre, s.es]), values: ev.calc.porS.map((x) => (x.pts == null ? null : r1(x.pts))), w, h, max: 20, sufijo: '', meta: (META / 100) * 20, metaLabel: `Meta ${fmtPct((META / 100) * 20)} pts`, aPct: (v) => (v / 20) * 100 });
  function grafHistorial(list, w, h) {
    const crono = list.slice(0, 16).reverse();
    const values = crono.map((e) => r1(e.calc.pct));
    return graficaPng({ tipo: 'line', labels: crono.map((e) => fmtCorta.format(parseFecha(e.fecha))), values, w, h, min: minLinea(values) });
  }

  // los 4 logos del encabezado en una sola imagen (en file:// el navegador no deja leerlos: sale sin logos)
  function bannerLogos() {
    try {
      const imgs = $$('.logos img').filter((i) => i.complete && i.naturalWidth);
      if (!imgs.length) return null;
      const H = 80; const gap = 28;
      const anchos = imgs.map((i) => Math.round((i.naturalWidth / i.naturalHeight) * H));
      const c = document.createElement('canvas');
      c.width = anchos.reduce((a, b) => a + b, 0) + gap * (imgs.length - 1); c.height = H;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
      let x = 0;
      imgs.forEach((im, i) => { ctx.drawImage(im, x, 0, anchos[i], H); x += anchos[i] + gap; });
      return { data: c.toDataURL('image/png'), w: c.width / 2, h: H / 2 };
    } catch { return null; }
  }

  // ---------- Excel
  const xFill = (hex) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + hex } });
  const xLinea = { style: 'thin', color: { argb: 'FF' + RC.border } };
  const xBorde = { top: xLinea, left: xLinea, bottom: xLinea, right: xLinea };
  const xFecha = (f) => { const [y, m, d] = String(f).slice(0, 10).split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
  // alto aproximado de una fila con texto ajustado (Excel no lo calcula solo al abrir)
  const xAlto = (textos) => 15 * Math.max(1, ...textos.map(([t, ancho]) => Math.ceil(String(t || '').length / (ancho * 1.05))));

  function xHojaNombre(nombre, usados) {
    const base = nombre.replace(/[\\/?*[\]:]/g, ' ').trim().slice(0, 31);
    let n = base; let i = 2;
    while (usados.has(n.toLowerCase())) { const suf = ` (${i++})`; n = base.slice(0, 31 - suf.length) + suf; }
    usados.add(n.toLowerCase());
    return n;
  }

  function xImagen(wb, ws, dataUrl, col, row, w, h) {
    const id = wb.addImage({ base64: dataUrl, extension: 'png' });
    ws.addImage(id, { tl: { col, row }, ext: { width: w, height: h }, editAs: 'oneCell' });
  }

  // filas 1–3: logos, título y subtítulo
  function xEncabezado(wb, ws, titulo, subtitulo, logos, cols) {
    ws.getRow(1).height = logos ? 36 : 6;
    if (logos) xImagen(wb, ws, logos.data, 0, 0.15, logos.w * 0.9, logos.h * 0.9);
    ws.mergeCells(2, 1, 2, cols); ws.mergeCells(3, 1, 3, cols);
    Object.assign(ws.getCell(2, 1), { value: titulo, font: { bold: true, size: 15, color: { argb: 'FF' + RC.quali } } });
    Object.assign(ws.getCell(3, 1), { value: subtitulo, font: { size: 10, color: { argb: 'FF' + RC.muted } } });
    ws.getRow(2).height = 22;
    // franja de colores de la marca
    [RC.quali, 'BBD22F', '7F7A33', RC.bad, RC.mid].forEach((c, i) => { if (i < cols) ws.getCell(4, i + 1).fill = xFill(c); });
    ws.getRow(4).height = 4;
  }

  function xCabecera(row) {
    row.eachCell((c) => { c.font = { bold: true, color: { argb: 'FFFFFFFF' } }; c.fill = xFill(RC.quali); c.border = xBorde; c.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true }; });
    row.height = 20;
  }

  function xTono(cell, pct) {
    const [, soft, ink] = tono(pct);
    cell.fill = xFill(soft); cell.font = { bold: true, color: { argb: 'FF' + ink } };
  }

  // hoja con el formato 5S de una evaluación (como cada hoja de área del Excel original)
  function xFormato(wb, ws, area, ev, list, logos) {
    const idx = list.indexOf(ev);
    const prev = idx >= 0 ? list[idx + 1] || null : null;
    ws.columns = [{ width: 62 }, { width: 13 }, { width: 44 }, { width: 3 }];
    ws.views = [{ showGridLines: false }];
    ws.pageSetup = { orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9, margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 } };
    xEncabezado(wb, ws, `Formato de evaluación 5´s · ${area.nombre}`, CFG.SUBTITULO || '', logos, 3);

    let r = 6;
    [['Auditor', ev.auditor], ['Área auditada', area.nombre], ['Fecha', xFecha(ev.fecha)]].forEach(([k, v]) => {
      const a = ws.getCell(r, 1); const b = ws.getCell(r, 2);
      a.value = k; a.font = { bold: true, color: { argb: 'FF' + RC.muted } };
      ws.mergeCells(r, 2, r, 3); b.value = v; b.font = { bold: true }; b.alignment = { horizontal: 'left' };
      if (v instanceof Date) b.numFmt = 'dd/mm/yyyy';
      r++;
    });
    ws.mergeCells(r, 1, r, 3);
    Object.assign(ws.getCell(r, 1), { value: `Criterios: ${CRITERIOS}`, font: { size: 9, color: { argb: 'FF' + RC.muted } }, alignment: { wrapText: true, vertical: 'top' } });
    ws.getRow(r).height = 26; r += 2;

    preguntasDeEval(ev).forEach((g, i) => {
      if (!g.length) return;
      const s = ESES[i]; const ps = ev.calc.porS[i];
      ws.mergeCells(r, 1, r, 3);
      Object.assign(ws.getCell(r, 1), { value: `${s.nombre} – ${s.es}   “${s.lema}”`, font: { bold: true, color: { argb: 'FFFFFFFF' } }, fill: xFill(RC.quali), alignment: { vertical: 'middle' } });
      ws.getRow(r).height = 20; r++;
      const hr = ws.getRow(r); hr.values = ['Descripción', 'Calificación', 'Comentarios'];
      hr.eachCell((c) => { c.font = { bold: true, size: 10 }; c.fill = xFill(RC.soft); c.border = xBorde; c.alignment = { horizontal: c.col === 2 ? 'center' : 'left' }; });
      r++;
      g.forEach((x) => {
        const row = ws.getRow(r);
        row.values = [x.p.texto, Number(x.r.c), x.r.o || ''];
        row.eachCell({ includeEmpty: true }, (c) => { if (c.col <= 3) { c.border = xBorde; c.alignment = { wrapText: true, vertical: 'middle' }; } });
        const cal = row.getCell(2); const [, soft, ink] = tonoNota(Number(x.r.c));
        cal.fill = xFill(soft); cal.font = { bold: true, color: { argb: 'FF' + ink } }; cal.alignment = { horizontal: 'center', vertical: 'middle' };
        row.height = xAlto([[x.p.texto, 62], [x.r.o, 44]]);
        r++;
      });
      const pie = ws.getRow(r);
      pie.getCell(1).value = `Suma: ${ps.sum} / ${ps.n * 5}`;
      pie.getCell(3).value = `Resultado ${s.es.toLowerCase()}: ${fmtPct(ps.pts)} / 20`;
      pie.eachCell((c) => { c.font = { bold: true, size: 10, color: { argb: 'FF' + RC.muted } }; c.alignment = { horizontal: c.col === 3 ? 'right' : 'left' }; });
      r += 2;
    });

    const total = [['Puntos posibles', ev.calc.max], ['Puntos obtenidos', ev.calc.sum], ['Calificación', r1(ev.calc.pct) / 100], ['Resultado', resultadoTxt(ev.calc.pct)]];
    if (prev) total.push(['vs. evaluación anterior', r1(ev.calc.pct - prev.calc.pct)]);
    total.forEach(([k, v]) => {
      const a = ws.getCell(r, 1); const b = ws.getCell(r, 2);
      a.value = k; a.font = { bold: true }; a.border = xBorde; a.fill = xFill(RC.soft);
      ws.mergeCells(r, 2, r, 3); b.value = v; b.border = xBorde; b.alignment = { horizontal: 'left' }; b.font = { bold: true };
      if (k === 'Calificación') { b.numFmt = '0.0%'; xTono(b, ev.calc.pct); }
      if (k === 'Resultado') xTono(b, r1(ev.calc.pct) >= META ? VERDE : 0);
      if (k.startsWith('vs.')) { b.numFmt = '▲ 0.0;▼ 0.0;= 0.0'; b.font = { bold: true, color: { argb: 'FF' + (v > 0 ? RC.okInk : v < 0 ? RC.badInk : RC.muted) } }; }
      r++;
    });
    if (ev.observaciones) {
      r++;
      Object.assign(ws.getCell(r, 1), { value: 'Observaciones generales', font: { bold: true } });
      r++;
      ws.mergeCells(r, 1, r, 3);
      Object.assign(ws.getCell(r, 1), { value: ev.observaciones, alignment: { wrapText: true, vertical: 'top' }, border: xBorde });
      ws.getRow(r).height = xAlto([[ev.observaciones, 115]]);
    }

    // gráficas a la derecha del formato
    const t = (txt, row) => Object.assign(ws.getCell(row, 5), { value: txt, font: { bold: true, size: 12, color: { argb: 'FF' + RC.quali } } });
    t('Resultado por S (de 20 pts)', 6);
    xImagen(wb, ws, grafEses(ev, 620, 300), 4, 6, 520, 252);
    t('Historial de puntuación', 25);
    xImagen(wb, ws, grafHistorial(list, 620, 280), 4, 25, 520, 235);
  }

  function xHistorial(ws, evals, conArea) {
    const cab = ['Fecha', 'Semana', ...(conArea ? ['Área'] : []), 'Auditor', ...ESES.map((s) => `${s.nombre} (/20)`), 'Puntuación', 'Resultado', 'Observaciones'];
    ws.columns = cab.map((h) => ({ width: h === 'Área' ? 32 : h === 'Auditor' ? 22 : h === 'Observaciones' ? 50 : h === 'Resultado' ? 20 : 12 }));
    ws.addRow(cab); xCabecera(ws.getRow(1));
    evals.forEach((e) => {
      const a = state.areaById.get(e.area_id);
      const row = ws.addRow([xFecha(e.fecha), numSemana(parseFecha(e.fecha)), ...(conArea ? [a ? a.nombre : e.area_id] : []), e.auditor,
        ...e.calc.porS.map((x) => (x.pts == null ? null : r1(x.pts))), r1(e.calc.pct) / 100, resultadoTxt(e.calc.pct), e.observaciones || '']);
      row.getCell(1).numFmt = 'dd/mm/yyyy';
      const n = cab.length;
      const pct = row.getCell(n - 2); pct.numFmt = '0.0%'; xTono(pct, e.calc.pct);
      xTono(row.getCell(n - 1), r1(e.calc.pct) >= META ? VERDE : 0);
      row.eachCell({ includeEmpty: true }, (c) => { c.border = xBorde; });
    });
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cab.length } };
  }

  async function nuevoLibro() {
    if (!window.ExcelJS) await cargarScript(EXCELJS_URL);
    const wb = new window.ExcelJS.Workbook();
    wb.creator = CFG.TITULO || 'Evaluación 5S';
    wb.created = new Date();
    return wb;
  }

  async function guardarLibro(wb, nombre) {
    const buf = await wb.xlsx.writeBuffer();
    descargarBlob(nombre, new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    toast('Reporte de Excel descargado');
  }

  async function excelGeneral(semana, filas) {
    const wb = await nuevoLibro();
    const logos = bannerLogos();
    const usados = new Set(['resultados', 'historial']);
    const ws = wb.addWorksheet('Resultados', { views: [{ showGridLines: false }] });
    ws.columns = [{ width: 6 }, { width: 34 }, { width: 13 }, { width: 22 }, { width: 13 }, { width: 21 }, { width: 13 }, { width: 3 }];
    ws.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 };
    const periodo = semana ? etiquetaSemana(semana) : 'Última evaluación registrada de cada área';
    xEncabezado(wb, ws, 'Resumen de evaluaciones 5´s', `${CFG.SUBTITULO || ''} · ${periodo} · Meta: ${META}% · Generado el ${fmtHoy()}`, logos, 7);

    const conEval = filas.filter((f) => f.ev);
    const prom = conEval.length ? conEval.reduce((s, f) => s + f.ev.calc.pct, 0) / conEval.length : null;
    const sat = conEval.filter((f) => r1(f.ev.calc.pct) >= META).length;
    [[2, 'Promedio general', prom == null ? '—' : r1(prom) / 100], [4, 'Áreas satisfactorias', `${sat} / ${conEval.length}`], [6, 'No satisfactorias', conEval.length - sat]].forEach(([col, k, v]) => {
      Object.assign(ws.getCell(6, col), { value: k, font: { size: 10, color: { argb: 'FF' + RC.muted } } });
      const c = ws.getCell(7, col);
      c.value = v; c.font = { bold: true, size: 18 }; c.alignment = { horizontal: 'left' };
      if (col === 2 && prom != null) { c.numFmt = '0.0%'; c.font = { bold: true, size: 18, color: { argb: 'FF' + tono(prom)[2] } }; }
      if (col === 6 && v) c.font = { bold: true, size: 18, color: { argb: 'FF' + RC.badInk } };
    });
    ws.getRow(7).height = 26;

    const hr = ws.getRow(9); hr.values = ['No.', 'Área', 'Fecha', 'Auditor', 'Puntuación', 'Resultado', 'vs. anterior']; xCabecera(hr);
    filas.forEach((f, i) => {
      const row = ws.getRow(10 + i);
      if (!f.ev) { row.values = [f.no, f.area.nombre, null, null, null, 'Sin evaluar', null]; } else {
        const d = f.prev ? r1(f.ev.calc.pct - f.prev.calc.pct) : null;
        row.values = [f.no, f.area.nombre, xFecha(f.ev.fecha), f.ev.auditor, r1(f.ev.calc.pct) / 100, resultadoTxt(f.ev.calc.pct), d];
        row.getCell(3).numFmt = 'dd/mm/yyyy';
        row.getCell(5).numFmt = '0.0%'; xTono(row.getCell(5), f.ev.calc.pct);
        xTono(row.getCell(6), r1(f.ev.calc.pct) >= META ? VERDE : 0);
        const dc = row.getCell(7); dc.numFmt = '▲ 0.0;▼ 0.0;= 0.0';
        dc.font = { bold: true, color: { argb: 'FF' + (d > 0 ? RC.okInk : d < 0 ? RC.badInk : RC.muted) } };
      }
      row.eachCell({ includeEmpty: true }, (c) => { if (c.col <= 7) { c.border = xBorde; if (c.col !== 2 && c.col !== 4) c.alignment = { horizontal: 'center' }; } });
      row.height = 18;
    });

    const tit = (txt, row) => Object.assign(ws.getCell(row, 9), { value: txt, font: { bold: true, size: 12, color: { argb: 'FF' + RC.quali } } });
    tit(`Puntuación por área  (verde ≥ ${VERDE}% · amarillo ${META}–${fmtPct(VERDE - 0.1)}% · rojo < ${META}%)`, 6);
    xImagen(wb, ws, grafBarrasAreas(filas, 1100, 480), 8, 6.6, 760, 332);
    tit('Tendencia semanal del promedio general', 26);
    xImagen(wb, ws, grafTendencia(tendencia(semanasConDatos()), 1100, 340), 8, 26.6, 760, 235);

    // una hoja por área con su formato 5S
    filas.filter((f) => f.ev).forEach((f) => xFormato(wb, wb.addWorksheet(xHojaNombre(f.area.nombre, usados)), f.area, f.ev, state.evalsByArea.get(f.area.id), logos));

    xHistorial(wb.addWorksheet('Historial'), state.evals.slice().sort(cmpEvalDesc), true);
    await guardarLibro(wb, `reporte-5s-${semana ? 'semana-' + numSemana(parseFecha(semana)) + '-' + semana.slice(0, 4) : 'ultimas'}-${hoy()}.xlsx`);
  }

  async function excelArea(area, ev) {
    const wb = await nuevoLibro();
    const list = state.evalsByArea.get(area.id);
    xFormato(wb, wb.addWorksheet('Formato 5S'), area, ev, list, bannerLogos());
    xHistorial(wb.addWorksheet('Historial'), list, false);
    await guardarLibro(wb, `5s-${slug(area.nombre)}-${ev.fecha}.xlsx`);
  }

  // ---------- PDF (vista de impresión: el navegador ofrece "Guardar como PDF")
  function pdfEncabezado(titulo, sub) {
    const logos = $$('.logos img').map((i) => `<img src="${esc(i.src)}" alt="${esc(i.alt)}">`).join('');
    return `<div class="rp-head"><div class="rp-logos">${logos}</div>
      <div class="rp-tit"><strong>${esc(titulo)}</strong><span>${esc(sub)}</span></div></div><div class="rp-franja"><i></i><i></i><i></i><i></i><i></i></div>`;
  }
  const pdfPill = (pct) => `<span class="rp-pill ${cls(pct)}">${fmtPct(pct)}%</span>`;
  const pdfRes = (pct) => `<span class="rp-res ${resCls(pct)}">${resultadoTxt(pct)}</span>`;
  const pdfDelta = (a, b) => (a == null || b == null ? '—' : deltaHtml(a, b));

  function pdfFormato(area, ev, list) {
    const idx = list.indexOf(ev);
    const prev = list[idx + 1] || null;
    const grupos = preguntasDeEval(ev);
    const mejoras = grupos.flat().filter((x) => Number(x.r.c) <= 3).sort((a, b) => a.r.c - b.r.c);
    return `<section class="rp-pag">
      ${pdfEncabezado(`Formato de evaluación 5´s · ${area.nombre}`, `${CFG.SUBTITULO || ''} · Generado el ${fmtHoy()}`)}
      <div class="rp-meta"><div><span>Auditor</span><b>${esc(ev.auditor)}</b></div><div><span>Área auditada</span><b>${esc(area.nombre)}</b></div><div><span>Fecha</span><b>${fmtFecha(ev.fecha)}</b></div>
        <div><span>Calificación</span><b>${pdfPill(ev.calc.pct)}</b></div><div><span>Resultado</span><b>${pdfRes(ev.calc.pct)}</b></div><div><span>vs. anterior</span><b>${pdfDelta(ev.calc.pct, prev && prev.calc.pct)}</b></div></div>
      <div class="rp-crit"><b>Criterios:</b> ${CRITERIOS}</div>
      ${ESES.map((s, i) => {
        const g = grupos[i]; const ps = ev.calc.porS[i];
        if (!g.length) return '';
        return `<table class="rp-tabla rp-s">
          <thead><tr><th colspan="3" class="rp-s-tit">${s.nombre} – ${s.es} <span>“${s.lema}”</span></th></tr>
            <tr class="rp-sub"><th>Descripción</th><th class="c">Calif.</th><th>Comentarios</th></tr></thead>
          <tbody>${g.map((x) => `<tr><td>${esc(x.p.texto)}</td><td class="c"><span class="rp-nota n${x.r.c >= 4 ? 'ok' : x.r.c === 3 ? 'mid' : 'bad'}">${x.r.c}</span></td><td>${esc(x.r.o || '')}</td></tr>`).join('')}</tbody>
          <tfoot><tr><td>Suma: <b>${ps.sum} / ${ps.n * 5}</b></td><td colspan="2" class="r">Resultado ${s.es.toLowerCase()}: <b>${fmtPct(ps.pts)} / 20</b></td></tr></tfoot>
        </table>`;
      }).join('')}
      <div class="rp-total"><div><span>Puntos posibles</span><b>${ev.calc.max}</b></div><div><span>Puntos obtenidos</span><b>${ev.calc.sum}</b></div><div><span>Calificación</span><b>${pdfPill(ev.calc.pct)}</b></div><div><span>Resultado</span><b>${pdfRes(ev.calc.pct)}</b></div></div>
      ${ev.observaciones ? `<div class="rp-obs"><b>Observaciones generales</b><p>${esc(ev.observaciones)}</p></div>` : ''}
      <div class="rp-graf2">
        <figure><figcaption>Resultado por S (de 20 pts)</figcaption><img src="${grafEses(ev, 620, 300)}" alt=""></figure>
        <figure><figcaption>Historial de puntuación</figcaption><img src="${grafHistorial(list, 620, 300)}" alt=""></figure>
      </div>
      ${mejoras.length ? `<div class="rp-mejoras"><b>Puntos a mejorar (calificación 3 o menos)</b><ul>${mejoras.map((x) => `<li><span class="rp-nota n${x.r.c === 3 ? 'mid' : 'bad'}">${x.r.c}</span> ${esc(x.p.texto)} <em>${ESES[x.p.s - 1].nombre}${x.r.o ? ' · ' + esc(x.r.o) : ''}</em></li>`).join('')}</ul></div>` : ''}
    </section>`;
  }

  async function imprimir(html, titulo) {
    const cont = $('#reporte');
    cont.innerHTML = html;
    await Promise.all($$('img', cont).map((im) => (im.complete ? null : new Promise((ok) => { im.onload = ok; im.onerror = ok; }))));
    // el título de la página es el nombre que el navegador sugiere para el PDF
    const previo = document.title;
    document.title = titulo;
    window.addEventListener('afterprint', () => { document.title = previo; }, { once: true });
    toast('En la ventana de impresión elige "Guardar como PDF"');
    window.print();
  }

  async function pdfGeneral(semana, filas) {
    const conEval = filas.filter((f) => f.ev);
    const prom = conEval.length ? conEval.reduce((s, f) => s + f.ev.calc.pct, 0) / conEval.length : null;
    const sat = conEval.filter((f) => r1(f.ev.calc.pct) >= META).length;
    const periodo = semana ? etiquetaSemana(semana) : 'Última evaluación registrada de cada área';
    const html = `<section class="rp-pag">
        ${pdfEncabezado('Resumen de evaluaciones 5´s', `${CFG.SUBTITULO || ''} · ${periodo} · Meta: ${META}% · Generado el ${fmtHoy()}`)}
        <div class="rp-kpis">
          <div><span>Promedio general</span><b class="${cls(prom)}">${prom == null ? '—' : fmtPct(prom) + '%'}</b></div>
          <div><span>Áreas satisfactorias</span><b>${sat} / ${conEval.length}</b></div>
          <div><span>No satisfactorias</span><b class="${conEval.length - sat ? 'bad' : 'ok'}">${conEval.length - sat}</b></div>
          <div><span>Áreas sin evaluar</span><b>${filas.length - conEval.length}</b></div>
        </div>
        <table class="rp-tabla rp-res-tabla">
          <thead><tr><th class="c">No.</th><th>Área</th><th>Fecha</th><th>Auditor</th><th class="c">Puntuación</th><th>Resultado</th><th class="r">vs. anterior</th></tr></thead>
          <tbody>${filas.map((f) => `<tr><td class="c">${f.no}</td><td><b>${esc(f.area.nombre)}</b></td>
            ${f.ev ? `<td>${fmtFecha(f.ev.fecha)}</td><td>${esc(f.ev.auditor)}</td><td class="c">${pdfPill(f.ev.calc.pct)}</td><td>${pdfRes(f.ev.calc.pct)}</td><td class="r">${pdfDelta(f.ev.calc.pct, f.prev && f.prev.calc.pct)}</td>`
              : '<td colspan="5" class="rp-muted">Sin evaluar</td>'}</tr>`).join('')}</tbody>
        </table>
      </section>
      <section class="rp-pag">
        ${pdfEncabezado('Gráficas del resumen', periodo)}
        <figure class="rp-fig"><figcaption>Puntuación por área <span class="rp-ley"><i class="ok"></i>${VERDE}% o más <i class="mid"></i>${META}% – ${fmtPct(VERDE - 0.1)}% <i class="bad"></i>Menos de ${META}%</span></figcaption><img src="${grafBarrasAreas(filas, 1100, 520)}" alt=""></figure>
        <figure class="rp-fig"><figcaption>Tendencia semanal del promedio general</figcaption><img src="${grafTendencia(tendencia(semanasConDatos()), 1100, 380)}" alt=""></figure>
      </section>
      ${conEval.map((f) => pdfFormato(f.area, f.ev, state.evalsByArea.get(f.area.id))).join('')}`;
    await imprimir(html, `reporte-5s-${semana ? 'semana-' + numSemana(parseFecha(semana)) : 'ultimas'}-${hoy()}`);
  }

  async function pdfArea(area, ev) {
    await imprimir(pdfFormato(area, ev, state.evalsByArea.get(area.id)), `5s-${slug(area.nombre)}-${ev.fecha}`);
  }

  const ICONO_SOL = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4.5"/><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8"/></svg>';
  const ICONO_LUNA = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5a8.5 8.5 0 1 0 11 11z"/></svg>';

  function pintarBotonTema() {
    const oscuro = document.documentElement.dataset.theme === 'dark';
    const txt = oscuro ? 'Modo claro' : 'Modo oscuro';
    const btn = $('#btnTema');
    btn.innerHTML = `${oscuro ? ICONO_SOL : ICONO_LUNA}<span>${txt}</span>`;
    btn.title = `Cambiar a ${txt.toLowerCase()}`;
    btn.setAttribute('aria-label', btn.title);
  }

  // ---------------------------------------------------------------- inicio
  async function init() {
    if (CFG.TITULO) { $('#titulo').textContent = CFG.TITULO; document.title = CFG.TITULO; }
    if (CFG.SUBTITULO) $('#subtitulo').textContent = CFG.SUBTITULO;
    $('#semanaActual').textContent = etiquetaSemana(semanaKey(hoy()));
    $('#demoBanner').hidden = !DEMO;
    $('#mobileNav').addEventListener('change', (e) => { location.hash = e.target.value; });
    pintarBotonTema();
    $('#btnTema').addEventListener('click', () => {
      const tema = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = tema;
      store.set('5s_tema', tema);
      pintarBotonTema();
      // las gráficas toman los colores del tema al dibujarse; no redibujar a media captura
      if (currentRoute && currentRoute.view !== 'nueva') render();
    });
    const fijarAltoEncabezado = () => document.documentElement.style.setProperty('--head-h', `${$('#siteHead').offsetHeight}px`);
    fijarAltoEncabezado();
    let anchoPrevio = window.innerWidth;
    window.addEventListener('resize', () => {
      fijarAltoEncabezado();
      clearTimeout(init._t);
      // la gráfica de áreas cambia de vertical a horizontal según el ancho
      init._t = setTimeout(() => {
        if (Math.abs(window.innerWidth - anchoPrevio) > 80 && currentRoute && currentRoute.view === 'resumen') render();
        anchoPrevio = window.innerWidth;
      }, 300);
    });

    try {
      if (!DEMO) db = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);
      await loadData();
    } catch (err) {
      console.error(err);
      $('#main').innerHTML = `<div class="card card-pad"><h2>No se pudieron cargar los datos</h2>
        <p class="muted">Revisa que <code>config.js</code> tenga la URL y la clave correctas de Supabase y que hayas ejecutado <code>schema.sql</code>.</p>
        <p class="muted">Detalle: ${esc(err.message || err)}</p></div>`;
      return;
    }
    window.addEventListener('hashchange', () => { render(); $('#main').focus({ preventScroll: true }); window.scrollTo(0, 0); });
    render();
    escucharCambios();
  }

  init();
})();
