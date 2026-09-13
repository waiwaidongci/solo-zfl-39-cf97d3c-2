import http from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = join(__dirname, "data", "paper-pulp-fermentation.json");
const port = Number(process.env.PORT || 3039);

// ---------- 领域常量 ----------
const STATUSES = ["入缸", "发酵中", "异常观察", "可抄纸"];
const VATS = ["一号缸", "二号缸", "三号缸", "四号缸", "五号缸"];
const SMELLS = ["清香", "微酸", "正常发酵味", "酸败异味", "腐臭味"];
const FIBERS = ["紧实", "开始松散", "松散", "成絮可抄"];
const MOLDS = ["无", "少量", "成片"];
const TASK_DUE_DAYS = 2; // 待处置事项超期时限
const TASK_LABEL = { 建档: "建档", 原料: "原料", 换缸: "换缸", 观察: "观察", 处置: "处置", 状态: "状态" };

// ---------- 存储 ----------
async function loadDb() {
  if (!existsSync(dbPath)) {
    await mkdir(dirname(dbPath), { recursive: true });
    const fresh = { meta: { version: 2, seq: 0 }, batches: [] };
    await writeFile(dbPath, JSON.stringify(fresh, null, 2));
    return fresh;
  }
  const raw = JSON.parse(await readFile(dbPath, "utf8"));
  if (raw && !raw.meta) return migrate(raw);
  return raw;
}
async function saveDb(db) {
  await writeFile(dbPath, JSON.stringify(db, null, 2));
}
// 沿用旧记录：v1 items 结构迁移为 v2 batches
function migrate(raw) {
  const db = { meta: { version: 2, seq: 100 }, batches: [] };
  for (const it of raw.items || []) {
    const id = it.id || it.code || `PF-101`;
    const at = "2026-06-15T08:00:00.000Z";
    const b = {
      id,
      source: it.source || "",
      vat: it.vat || "",
      owner: it.owner || "",
      status: STATUSES.includes(it.status) ? it.status : "发酵中",
      materials: it.source ? [{ name: it.source, ratio: 100 }] : [],
      occupancy: it.vat ? [{ vat: it.vat, start: at, end: null }] : [],
      observations: [],
      tasks: [],
      timeline: [],
    };
    addEvent(b, "建档", `建档 ${id}，负责人 ${b.owner}`, { source: b.source, vat: b.vat }, at);
    if (it.source) addEvent(b, "原料", `登记原料：${it.source} 100%`, { materials: b.materials }, at);
    if (it.vat) addEvent(b, "状态", `入缸 ${it.vat}`, { status: "入缸" }, at);
    let n = 0;
    for (const log of it.logs || []) {
      const lat = log.at && log.at.includes("T") ? log.at : `${log.at || "2026-06-15"}T08:00:00.000Z`;
      if (log.step === "观察") {
        n += 1;
        const obs = {
          id: `O-${String(n).padStart(2, "0")}`,
          at: lat,
          temperature: log.note?.match(/温度\s*([\d.]+)/)?.[1] ?? "",
          smell: log.note?.includes("酸") ? "微酸" : "正常发酵味",
          fiber: log.note?.includes("松散") ? "开始松散" : "紧实",
          changedWater: false,
          mold: "无",
          abnormal: false,
        };
        b.observations.push(obs);
        addEvent(b, "观察", log.note || "每日观察", { observation: obs }, lat);
      } else {
        addEvent(b, log.step === "状态" ? "状态" : "观察", log.note || log.step || "记录", {}, lat);
      }
    }
    for (const ob of it.observations || []) {
      n += 1;
      const obs = {
        id: `O-${String(n).padStart(2, "0")}`,
        at: ob.at,
        temperature: ob.temperature ?? "",
        smell: ob.smell || "",
        fiber: ob.fiber || "",
        changedWater: String(ob.changedWater || "").includes("是"),
        mold: "无",
        abnormal: !!ob.abnormal,
      };
      b.observations.push(obs);
      addEvent(b, "观察", `温度 ${obs.temperature}，${obs.smell}，${obs.fiber}${obs.changedWater ? "，已换水" : ""}`, { observation: obs }, ob.at);
    }
    addEvent(b, "状态", `沿用历史状态：${b.status}`, { status: b.status }, new Date().toISOString());
    db.batches.push(b);
  }
  return db;
}
async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}
function send(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}
function bad(res, error) { send(res, 400, { error }); }
function html(res, text) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(text);
}

// ---------- 领域工具 ----------
function addEvent(batch, type, note, detail = {}, at = new Date().toISOString()) {
  batch.timeline ||= [];
  batch.timeline.push({ id: `E-${batch.timeline.length + 1}`, at, type, note, detail });
}
function nextBatchId(db) {
  db.meta.seq = (db.meta.seq || 0) + 1;
  return `PF-${String(db.meta.seq).padStart(3, "0")}`;
}
function nextSubId(list, prefix) {
  const max = list.reduce((m, x) => {
    const n = Number(String(x.id || "").split("-")[1]);
    return Number.isFinite(n) ? Math.max(m, n) : m;
  }, 0);
  return `${prefix}-${String(max + 1).padStart(2, "0")}`;
}
function parseAt(input) {
  if (!input) return new Date();
  const d = new Date(input);
  return Number.isNaN(d.getTime()) ? null : d;
}
function overlap(aStart, aEnd, bStart, bEnd) {
  return aStart < (bEnd || Infinity) && bStart < (aEnd || Infinity);
}
// 同缸重叠占用检测（可排除某批次自身）
function vatConflict(db, vat, startIso, endIso, excludeBatchId) {
  const s = new Date(startIso).getTime();
  const e = endIso ? new Date(endIso).getTime() : null;
  for (const b of db.batches) {
    if (b.id === excludeBatchId) continue;
    for (const occ of b.occupancy || []) {
      if (occ.vat !== vat) continue;
      const os = new Date(occ.start).getTime();
      const oe = occ.end ? new Date(occ.end).getTime() : null;
      if (overlap(s, e, os, oe)) return b;
    }
  }
  return null;
}
function openTasks(b) {
  return (b.tasks || []).filter((t) => t.status !== "已关闭");
}
function taskOverdue(t, now = Date.now()) {
  return t.status !== "已关闭" && new Date(t.dueAt).getTime() < now;
}
function detectAbnormal(input) {
  const mold = String(input.mold || "无");
  const smell = String(input.smell || "");
  return mold !== "无" && mold !== "" || smell === "酸败异味" || smell === "腐臭味";
}
function setStatus(batch, next, note, detail) {
  const prev = batch.status;
  if (prev === next) return;
  batch.status = next;
  addEvent(batch, "状态", note || `状态变更：${prev} → ${next}`, { from: prev, to: next, ...(detail || {}) });
}
function decorate(b, now = Date.now()) {
  const tasks = (b.tasks || []).map((t) => ({ ...t, overdue: taskOverdue(t, now) }));
  return { ...b, tasks, openCount: tasks.filter((t) => t.status !== "已关闭").length, currentVat: currentVatOf(b) };
}
function currentVatOf(b) {
  const occ = [...(b.occupancy || [])].reverse().find((o) => !o.end);
  return occ ? occ.vat : "";
}

// ---------- 页面 ----------
function page() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>古法纸浆发酵批次追溯与处置</title>
  <style>
    :root { --bg:#f1f3ef; --panel:#fff; --ink:#20241f; --muted:#687066; --line:#d4ddd0; --accent:#526f43; --warn:#9b4937; --amber:#8a6d1f; }
    * { box-sizing:border-box; }
    body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    header { padding:20px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; gap:16px; align-items:center; }
    h1 { margin:0; font-size:24px; } h2 { margin:0 0 12px; font-size:17px; } h3 { margin:0; font-size:16px; }
    main { display:grid; grid-template-columns:340px 1fr; gap:20px; padding:20px 28px; align-items:start; }
    form,.panel,.card,.stat { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:15px; }
    label { display:block; margin:9px 0 4px; color:var(--muted); font-size:13px; }
    input,select,textarea { width:100%; border:1px solid var(--line); border-radius:6px; padding:8px; font:inherit; background:#fff; }
    textarea { min-height:56px; resize:vertical; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:9px 13px; font-weight:700; cursor:pointer; margin-top:10px; }
    button.secondary { background:#69736a; } button.danger { background:var(--warn); } button.small{ padding:5px 9px; font-size:12px; margin:0; }
    .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(110px,1fr)); gap:10px; margin-bottom:12px; }
    .stat strong { display:block; font-size:23px; } .stat.overdue { border-color:var(--warn); } .stat.overdue strong{ color:var(--warn); }
    .toolbar { display:flex; gap:8px; flex-wrap:wrap; margin-bottom:12px; }
    .toolbar input,.toolbar select { width:auto; min-width:130px; flex:1; }
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(260px,1fr)); gap:11px; }
    .card { display:grid; gap:6px; cursor:pointer; }
    .card.active { border-color:var(--accent); box-shadow:0 0 0 2px rgba(82,111,67,.25); }
    .meta { color:var(--muted); font-size:12.5px; }
    .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:2px 8px; font-size:12px; }
    .pill.warn { color:var(--warn); border-color:var(--warn); } .pill.amber{ color:var(--amber); border-color:var(--amber); } .pill.ok{ color:var(--accent); border-color:var(--accent); }
    table { width:100%; border-collapse:collapse; font-size:13px; } th,td { border-bottom:1px solid var(--line); padding:6px 8px; text-align:left; vertical-align:top; }
    .timeline { max-height:340px; overflow:auto; }
    .timeline .ev { display:grid; grid-template-columns:150px 56px 1fr; gap:8px; padding:6px 4px; border-bottom:1px dashed var(--line); font-size:13px; }
    .tag { font-size:11px; border-radius:4px; padding:1px 6px; height:fit-content; text-align:center; color:#fff; background:#69736a; }
    .tag.建档{background:#4b5d6b}.tag.原料{background:#7a5e8c}.tag.换缸{background:#3f6f8f}.tag.观察{background:#526f43}.tag.处置{background:var(--warn)}.tag.状态{background:#8a6d1f}
    .matrow { display:grid; grid-template-columns:1fr 90px 34px; gap:6px; margin-bottom:6px; }
    .sections { display:grid; grid-template-columns:1fr 1fr; gap:14px; }
    .full { grid-column:1 / -1; }
    .err { color:var(--warn); font-weight:700; font-size:13px; min-height:16px; }
    .overdue-line { color:var(--warn); font-weight:700; }
    .muted-btn{ background:none; color:var(--muted); border:1px solid var(--line); }
    @media (max-width:980px){ header{display:block;padding:16px;} main{grid-template-columns:1fr;padding:14px;} .sections{grid-template-columns:1fr;} }
  </style>
</head>
<body>
  <header>
    <div><h1>古法纸浆发酵批次追溯与处置</h1><div class="meta">建档 · 原料配比 · 换缸缸位 · 每日观察 · 异常处置 · 状态流转</div></div>
    <button id="reload" class="secondary">刷新</button>
  </header>
  <main>
    <section>
      <form id="createForm" class="panel">
        <h2>新建批次（建档）</h2>
        <label>原料来源/名称（摘要）</label><input name="source" required placeholder="如：构树皮">
        <label>负责人</label><input name="owner" required placeholder="如：林素">
        <label>初始缸号</label><select name="vat">${VATS.map((v) => `<option>${v}</option>`).join("")}</select>
        <label>入缸时间</label><input name="at" type="datetime-local">
        <label>原料与占比（合计须为 100%）</label>
        <div id="matRows"></div>
        <button type="button" class="small muted-btn" id="addMat">＋ 添加原料</button>
        <div class="meta" id="ratioSum">合计：0%</div>
        <div class="err" id="createErr"></div>
        <button>建档</button>
      </form>
    </section>
    <section>
      <div class="stats" id="stats"></div>
      <div class="panel" id="overduePanel" style="margin-bottom:12px"><h2>超期待办</h2><div id="overdueList"></div></div>
      <div class="toolbar">
        <input id="q" placeholder="批次编号">
        <select id="vatFilter"><option value="">全部缸号</option>${VATS.map((v) => `<option>${v}</option>`).join("")}</select>
        <input id="ownerFilter" placeholder="负责人">
        <select id="statusFilter"><option value="">全部状态</option>${STATUSES.map((s) => `<option>${s}</option>`).join("")}</select>
      </div>
      <div class="grid" id="cards"></div>
      <div class="panel" id="detail" style="margin-top:14px; display:none"></div>
    </section>
  </main>
  <script>
    const STATUSES = ${JSON.stringify(STATUSES)};
    const VATS = ${JSON.stringify(VATS)};
    const SMELLS = ${JSON.stringify(SMELLS)};
    const FIBERS = ${JSON.stringify(FIBERS)};
    const MOLDS = ${JSON.stringify(MOLDS)};
    let batches = [], selectedId = null;
    const $ = (s) => document.querySelector(s);
    const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
    const dtLocal = (iso) => { try { const d=new Date(iso); return isNaN(d)?"":new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16); } catch { return ""; } };
    const fmt = (iso) => { try { const d=new Date(iso); return isNaN(d)?"":d.toLocaleString("zh-CN",{hour12:false}); } catch { return iso||""; } };
    async function api(path, options) {
      const res = await fetch(path, options && options.body ? { ...options, headers: { "Content-Type": "application/json" } } : options);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "请求失败");
      return data;
    }
    // ---- 原料行 ----
    function matRow(name = "", ratio = "") {
      return '<div class="matrow"><input placeholder="原料名称" class="m-name" value="'+esc(name)+'"><input type="number" step="0.1" min="0" max="100" placeholder="占比%" class="m-ratio" value="'+esc(ratio)+'"><button type="button" class="small muted-btn" onclick="this.parentElement.remove();sumRatio()">×</button></div>';
    }
    function collectMaterials() {
      return [...document.querySelectorAll("#matRows .matrow")].map(r => ({ name: r.querySelector(".m-name").value.trim(), ratio: Number(r.querySelector(".m-ratio").value) }))
        .filter(m => m.name || m.ratio);
    }
    function sumRatio() {
      const sum = collectMaterials().reduce((n, m) => n + (Number(m.ratio) || 0), 0);
      const el = $("#ratioSum");
      el.textContent = "合计：" + Math.round(sum * 10) / 10 + "%";
      el.style.color = Math.abs(sum - 100) < 0.001 ? "var(--accent)" : "var(--warn)";
    }
    // ---- 渲染 ----
    function render() {
      const q = $("#q").value.trim();
      const vat = $("#vatFilter").value;
      const owner = $("#ownerFilter").value.trim();
      const status = $("#statusFilter").value;
      const visible = batches.filter(b =>
        (!q || b.id.includes(q)) &&
        (!vat || (b.occupancy||[]).some(o => o.vat === vat)) &&
        (!owner || (b.owner||"").includes(owner)) &&
        (!status || b.status === status));
      // 状态数量统计始终基于全部批次
      const counts = Object.fromEntries(STATUSES.map(s => [s, 0]));
      batches.forEach(b => { if (counts[b.status] !== undefined) counts[b.status]++; });
      const now = Date.now();
      const allOpen = batches.flatMap(b => (b.tasks||[]).filter(t=>t.status!=="已关闭").map(t=>({b,t})));
      const overdue = allOpen.filter(x => new Date(x.t.dueAt).getTime() < now);
      $("#stats").innerHTML = STATUSES.map(s => '<div class="stat"><span>'+s+'</span><strong>'+counts[s]+'</strong></div>').join("")
        + '<div class="stat overdue"><span>超期待办</span><strong>'+overdue.length+'</strong></div>';
      $("#overdueList").innerHTML = overdue.length ? overdue.map(x =>
        '<div class="overdue-line">'+x.b.id+' · '+esc(x.t.title)+'（截止 '+fmt(x.t.dueAt)+'，负责人 '+esc(x.b.owner)+'） <button class="small" data-open="'+x.b.id+'">前往处理</button></div>').join("")
        : '<div class="meta">暂无超期待办</div>';
      $("#cards").innerHTML = visible.map(cardHtml).join("") || '<div class="meta">无匹配批次</div>';
      document.querySelectorAll("[data-open]").forEach(btn => btn.onclick = (e) => { e.stopPropagation(); selectedId = btn.dataset.open; render(); renderDetail(); });
      $("#cards .card").forEach(c => c.onclick = () => { selectedId = c.dataset.id; render(); renderDetail(); });
      renderDetail();
    }
    function cardHtml(b) {
      const mats = (b.materials||[]).map(m => esc(m.name)+" "+m.ratio+"%").join("，");
      return '<article class="card '+(b.id===selectedId?"active":"")+'" data-id="'+b.id+'">'
        + '<h3>'+b.id+' <span class="pill '+(b.status==="异常观察"?"warn":b.status==="可抄纸"?"ok":"")+'">'+b.status+'</span></h3>'
        + '<div class="meta">负责人：'+esc(b.owner)+'　当前缸：'+esc(b.currentVat||"—")+'</div>'
        + '<div class="meta">原料：'+(mats||"—")+'</div>'
        + '<div class="meta">观察 '+(b.observations||[]).length+' 次 · 待办 '+b.openCount+' 项</div>'
        + '</article>';
    }
    function statusPill(t) {
      if (t.status === "已关闭") return '<span class="pill ok">已关闭</span>';
      return t.overdue ? '<span class="pill warn">待处置·已超期</span>' : '<span class="pill amber">待处置</span>';
    }
    function renderDetail() {
      const el = $("#detail");
      const b = batches.find(x => x.id === selectedId);
      if (!b) { el.style.display = "none"; return; }
      el.style.display = "block";
      openTask = (b.tasks || []).find(t => t.status !== "已关闭") || null;
      const canPaper = b.openCount === 0;
      el.innerHTML =
      '<h2>'+b.id+'　<span class="pill '+(b.status==="异常观察"?"warn":b.status==="可抄纸"?"ok":"")+'">'+b.status+'</span>'
      + (b.openCount ? ' <span class="pill warn">有 '+b.openCount+' 项未关闭处置</span>' : '') + '</h2>'
      + '<div class="sections">'
      // 原料
      + '<div class="panel"><h3>原料与占比</h3><table><tr><th>原料</th><th>占比</th></tr>'
      + (b.materials||[]).map(m=>"<tr><td>"+esc(m.name)+"</td><td>"+m.ratio+"%</td></tr>").join("") + "</table></div>"
      // 换缸 / 缸位时段
      + '<div class="panel"><h3>缸位时段</h3><table><tr><th>缸号</th><th>开始</th><th>结束</th></tr>'
      + (b.occupancy||[]).map(o=>"<tr><td>"+esc(o.vat)+"</td><td>"+fmt(o.start)+"</td><td>"+(o.end?fmt(o.end):"<b>占用中</b>")+"</td></tr>").join("")
      + '</table><form id="moveForm" style="margin-top:8px"><label>换入缸号</label><select name="vat">'+VATS.map(v=>'<option>'+v+'</option>').join("")+'</select>'
      + '<label>换缸时间</label><input name="at" type="datetime-local"><label>说明</label><input name="note" placeholder="如：出缸沥水后转入">'
      + '<div class="err" id="moveErr"></div><button type="submit">换缸</button></form></div>'
      // 每日观察
      + '<div class="panel"><h3>每日观察</h3>'
      + '<table><tr><th>时间</th><th>温度</th><th>气味</th><th>纤维</th><th>换水</th><th>霉点</th><th></th></tr>'
      + (b.observations||[]).slice().reverse().map(o=>"<tr><td>"+fmt(o.at)+"</td><td>"+esc(o.temperature)+"</td><td>"+esc(o.smell)+(o.abnormal?' <span class="pill warn">异常</span>':"")+"</td><td>"+esc(o.fiber)+"</td><td>"+(o.changedWater?"是":"否")+"</td><td>"+esc(o.mold)+"</td></tr>").join("")
      + '</table><form id="obsForm" style="margin-top:8px"><div style="display:grid;grid-template-columns:1fr 1fr;gap:6px">'
      + '<div><label>时间</label><input name="at" type="datetime-local"></div>'
      + '<div><label>温度(℃)</label><input name="temperature" placeholder="如 25.2"></div>'
      + '<div><label>气味</label><select name="smell">'+SMELLS.map(s=>'<option>'+s+'</option>').join("")+'</select></div>'
      + '<div><label>纤维松散度</label><select name="fiber">'+FIBERS.map(s=>'<option>'+s+'</option>').join("")+'</select></div>'
      + '<div><label>换水</label><select name="changedWater"><option value="false">未换水</option><option value="true">已换水</option></select></div>'
      + '<div><label>霉点</label><select name="mold">'+MOLDS.map(s=>'<option>'+s+'</option>').join("")+'</select></div>'
      + '</div><div class="meta">霉点或酸败异味将自动转入「异常观察」并生成待处置事项</div><div class="err" id="obsErr"></div><button type="submit">提交观察</button></form></div>'
      // 处置事项
      + '<div class="panel"><h3>待处置事项</h3>'
      + ((b.tasks||[]).length ? '<table><tr><th>事项</th><th>来源</th><th>截止</th><th>状态</th></tr>'
        + b.tasks.slice().reverse().map(t=>"<tr><td>"+esc(t.title)+(t.overdue?' <span class="pill warn">超期</span>':"")+"</td><td>"+fmt(t.createdAt)+"</td><td>"+fmt(t.dueAt)+"</td><td>"+statusPill(t)+"</td></tr>").join("")+"</table>"
        : '<div class="meta">暂无处置事项</div>')
      + (openTask ? closeForm(openTask) : "")
      + '</div>'
      // 状态变更
      + '<div class="panel full"><h3>状态变更</h3><div class="meta">未关闭的处置事项全部关闭后，方可转为「可抄纸」。</div>'
      + '<form id="statusForm" style="display:flex;gap:10px;align-items:end;flex-wrap:wrap"><div style="flex:1;min-width:160px"><label>目标状态</label><select name="status">'+STATUSES.map(s=>'<option '+(s===b.status?"selected":"")+'>'+s+'</option>').join("")+'</select></div>'
      + '<button type="submit">变更状态</button><span class="err" id="statusErr"></span></form></div>'
      // 时间线
      + '<div class="panel full"><h3>时间线（建档/原料/换缸/观察/处置/状态）</h3><div class="timeline">'
      + (b.timeline||[]).slice().reverse().map(e=>'<div class="ev"><span class="meta">'+fmt(e.at)+'</span><span class="tag '+e.type+'">'+e.type+'</span><span>'+esc(e.note)+'</span></div>').join("")
      + '</div></div>'
      + '</div>';
      bindDetail(b);
    }
    let openTask = null;
    function closeForm(t) {
      return '<form id="closeForm" style="margin-top:10px;border-top:1px solid var(--line);padding-top:8px">'
      + '<label>处置事项</label><div class="meta">'+esc(t.title)+'　截止 '+fmt(t.dueAt)+(t.overdue?' <span class="pill warn">已超期</span>':'')+'</div>'
      + '<label>处理说明（必填）</label><textarea name="handling" required placeholder="描述采取的处置措施，如刮除霉斑、换水、加草木灰…"></textarea>'
      + '<label>复核人</label><input name="reviewer" required placeholder="复核负责人">'
      + '<label>复核结果</label><select name="passed"><option value="true">合格</option><option value="false">不合格（退回重新处理）</option></select>'
      + '<label>复核备注</label><input name="reviewNote">'
      + '<div class="err" id="closeErr"></div><button type="submit">提交处置并复核</button></form>';
    }
    function bindDetail(b) {
      const moveForm = $("#moveForm");
      moveForm.onsubmit = async (ev) => { ev.preventDefault(); const f = new FormData(moveForm);
        try { await api("/api/batches/"+b.id+"/move", { method:"POST", body: JSON.stringify({ vat:f.get("vat"), at:f.get("at"), note:f.get("note") }) }); await load(); }
        catch(e){ $("#moveErr").textContent = e.message; } };
      const obsForm = $("#obsForm");
      obsForm.onsubmit = async (ev) => { ev.preventDefault(); const f = new FormData(obsForm);
        try { await api("/api/batches/"+b.id+"/observations", { method:"POST", body: JSON.stringify(Object.fromEntries(f.entries())) }); await load(); }
        catch(e){ $("#obsErr").textContent = e.message; } };
      const closeFormEl = $("#closeForm");
      if (closeFormEl) closeFormEl.onsubmit = async (ev) => { ev.preventDefault(); const f = new FormData(closeFormEl);
        try { await api("/api/batches/"+b.id+"/tasks/"+openTask.id+"/close", { method:"POST", body: JSON.stringify(Object.fromEntries(f.entries())) }); await load(); }
        catch(e){ $("#closeErr").textContent = e.message; } };
      const statusForm = $("#statusForm");
      statusForm.onsubmit = async (ev) => { ev.preventDefault(); const f = new FormData(statusForm);
        try { await api("/api/batches/"+b.id+"/status", { method:"POST", body: JSON.stringify({ status:f.get("status") }) }); await load(); }
        catch(e){ $("#statusErr").textContent = e.message; } };
    }
    async function load() {
      batches = (await api("/api/batches")).map(b => ({ ...b }));
      render();
    }
    $("#addMat").onclick = () => { $("#matRows").insertAdjacentHTML("beforeend", matRow()); sumRatio(); };
    $("#matRows").addEventListener("input", sumRatio);
    $("#createForm").onsubmit = async (ev) => {
      ev.preventDefault();
      const f = new FormData($("#createForm"));
      const payload = { source:f.get("source"), owner:f.get("owner"), vat:f.get("vat"), at:f.get("at"), materials: collectMaterials() };
      try { const b = await api("/api/batches", { method:"POST", body: JSON.stringify(payload) }); $("#createForm").reset(); $("#matRows").innerHTML=matRow(); sumRatio(); $("#createErr").textContent=""; selectedId = b.id; await load(); }
      catch (e) { $("#createErr").textContent = e.message; }
    };
    $("#q").oninput = render; $("#vatFilter").onchange = render; $("#ownerFilter").oninput = render; $("#statusFilter").onchange = render;
    $("#reload").onclick = load;
    $("#matRows").innerHTML = matRow(); sumRatio();
    load();
  </script>
</body>
</html>`;
}

// ---------- HTTP 服务 ----------
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const db = await loadDb();

    if (req.method === "GET" && url.pathname === "/") return html(res, page());

    if (req.method === "GET" && url.pathname === "/api/meta")
      return send(res, 200, { statuses: STATUSES, vats: VATS, smells: SMELLS, fibers: FIBERS, molds: MOLDS });

    // 列表 + 查询（批次/缸号/负责人/状态）
    if (req.method === "GET" && url.pathname === "/api/batches") {
      const now = Date.now();
      let list = db.batches.map((b) => decorate(b, now));
      const { q, vat, owner, status } = Object.fromEntries(url.searchParams);
      if (q) list = list.filter((b) => b.id.includes(q));
      if (vat) list = list.filter((b) => (b.occupancy || []).some((o) => o.vat === vat));
      if (owner) list = list.filter((b) => (b.owner || "").includes(owner));
      if (status) list = list.filter((b) => b.status === status);
      return send(res, 200, list);
    }

    // 首页汇总
    if (req.method === "GET" && url.pathname === "/api/summary") {
      const now = Date.now();
      const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
      db.batches.forEach((b) => { if (counts[b.status] !== undefined) counts[b.status]++; });
      const overdue = [];
      for (const b of db.batches)
        for (const t of openTasks(b))
          if (taskOverdue(t, now)) overdue.push({ batchId: b.id, owner: b.owner, taskId: t.id, title: t.title, dueAt: t.dueAt });
      return send(res, 200, { counts, overdue });
    }

    // 建档
    if (req.method === "POST" && url.pathname === "/api/batches") {
      const input = await body(req);
      const atD = parseAt(input.at);
      if (input.at && !atD) return bad(res, "入缸时间格式不正确");
      const at = (atD || new Date()).toISOString();
      if (!input.owner || !String(input.owner).trim()) return bad(res, "负责人不能为空");
      if (!input.vat || !VATS.includes(input.vat)) return bad(res, "请选择有效的缸号");
      const materials = Array.isArray(input.materials)
        ? input.materials.map((m) => ({ name: String(m.name || "").trim(), ratio: Number(m.ratio) }))
        : [];
      if (materials.length === 0) return bad(res, "原料占比缺失：每批至少登记一份原料");
      if (materials.some((m) => !m.name)) return bad(res, "存在未填写名称的原料行");
      if (materials.some((m) => !Number.isFinite(m.ratio) || m.ratio <= 0)) return bad(res, "每份原料占比须为大于 0 的数值");
      const sum = Math.round(materials.reduce((n, m) => n + m.ratio, 0) * 100) / 100;
      if (Math.abs(sum - 100) > 0.01) return bad(res, `原料占比合计须为 100%，当前为 ${sum}%（缺失或超额）`);
      const conflict = vatConflict(db, input.vat, at, null);
      if (conflict) return bad(res, `缸位冲突：${input.vat} 在该时段已被批次 ${conflict.id} 占用`);

      const id = nextBatchId(db);
      const batch = {
        id,
        source: String(input.source || materials.map((m) => m.name).join("/")),
        owner: String(input.owner).trim(),
        status: "入缸",
        materials,
        occupancy: [{ vat: input.vat, start: at, end: null }],
        observations: [],
        tasks: [],
        timeline: [],
      };
      addEvent(batch, "建档", `建档 ${id}，负责人 ${batch.owner}`, { source: batch.source }, at);
      addEvent(batch, "原料", `登记原料 ${materials.length} 份，合计 100%：${materials.map((m) => `${m.name} ${m.ratio}%`).join("、")}`, { materials }, at);
      addEvent(batch, "换缸", `入缸 ${input.vat}`, { vat: input.vat, start: at }, at);
      addEvent(batch, "状态", "状态变更：（新建）→ 入缸", { from: null, to: "入缸" }, at);
      db.batches.unshift(batch);
      await saveDb(db);
      return send(res, 201, decorate(batch));
    }

    const moveM = url.pathname.match(/^\/api\/batches\/([^/]+)\/move$/);
    if (moveM && req.method === "POST") {
      const b = db.batches.find((x) => x.id === moveM[1]);
      if (!b) return send(res, 404, { error: "批次不存在" });
      const input = await body(req);
      if (!input.vat || !VATS.includes(input.vat)) return bad(res, "请选择有效的缸号");
      const atD = parseAt(input.at);
      if (input.at && !atD) return bad(res, "换缸时间格式不正确");
      const at = (atD || new Date()).toISOString();
      const current = [...(b.occupancy || [])].reverse().find((o) => !o.end);
      if (!current) return bad(res, "该批次当前无占用中的缸位");
      if (new Date(at).getTime() < new Date(current.start).getTime()) return bad(res, "换缸时间不能早于当前缸位的开始时间");
      if (current.vat === input.vat) return bad(res, "新缸号与当前缸号相同，无需换缸");
      // 换缸时段重叠：目标缸被占用 或 与本批历史时段重叠（时间倒流会撞上自己的历史占用）
      const conflict = vatConflict(db, input.vat, at, null, b.id);
      if (conflict) return bad(res, `缸位冲突：${input.vat} 在该时段已被批次 ${conflict.id} 占用`);
      const selfHit = (b.occupancy || []).some((o) => o.end && overlap(new Date(at).getTime(), null, new Date(o.start).getTime(), new Date(o.end).getTime()));
      if (selfHit) return bad(res, "换缸时间与本批历史缸位时段冲突");

      current.end = at; // 保留缸位时段
      b.occupancy.push({ vat: input.vat, start: at, end: null });
      addEvent(b, "换缸", `由 ${current.vat} 换入 ${input.vat}${input.note ? `（${input.note}）` : ""}`, { from: current.vat, to: input.vat, at });
      await saveDb(db);
      return send(res, 200, decorate(b));
    }

    // 每日观察
    const obsM = url.pathname.match(/^\/api\/batches\/([^/]+)\/observations$/);
    if (obsM && req.method === "POST") {
      const b = db.batches.find((x) => x.id === obsM[1]);
      if (!b) return send(res, 404, { error: "批次不存在" });
      const input = await body(req);
      const atD = parseAt(input.at);
      if (input.at && !atD) return bad(res, "观察时间格式不正确");
      const at = (atD || new Date()).toISOString();
      if (input.temperature !== "" && input.temperature != null && !Number.isFinite(Number(input.temperature)))
        return bad(res, "温度须为数值");
      const obs = {
        id: nextSubId(b.observations, "O"),
        at,
        temperature: input.temperature ?? "",
        smell: String(input.smell || ""),
        fiber: String(input.fiber || ""),
        changedWater: String(input.changedWater) === "true" || String(input.changedWater).includes("是"),
        mold: String(input.mold || "无"),
        abnormal: false,
      };
      obs.abnormal = detectAbnormal(obs);
      b.observations.push(obs);
      const flags = [];
      if (obs.mold && obs.mold !== "无") flags.push(`霉点${obs.mold}`);
      if (obs.smell === "酸败异味" || obs.smell === "腐臭味") flags.push(obs.smell);
      addEvent(b, "观察", `温度 ${obs.temperature || "—"}，${obs.smell || "—"}，纤维${obs.fiber || "—"}，${obs.changedWater ? "已换水" : "未换水"}，霉点${obs.mold || "无"}${obs.abnormal ? `；异常：${flags.join("、")}` : ""}`, { observation: obs }, at);

      if (obs.abnormal) {
        const due = new Date(new Date(at).getTime() + TASK_DUE_DAYS * 86400000).toISOString();
        const title = `${flags.join("、")}处置`;
        const task = {
          id: nextSubId(b.tasks || [], "T"),
          title,
          reason: flags.join("、"),
          observationId: obs.id,
          status: "待处置",
          createdAt: at,
          dueAt: due,
          handling: null,
          handledAt: null,
          reviewer: null,
          passed: null,
          reviewNote: null,
          reviewedAt: null,
        };
        b.tasks.push(task);
        addEvent(b, "处置", `生成待处置事项：${title}（限 ${TASK_DUE_DAYS} 日内处理，截止 ${new Date(due).toLocaleString("zh-CN")}）`, { taskId: task.id, title, dueAt: due }, at);
        setStatus(b, "异常观察", `观察到${flags.join("、")}，转入异常观察`, { observationId: obs.id });
      } else if (b.status === "入缸") {
        setStatus(b, "发酵中", "首次正常观察，进入发酵中");
      }
      await saveDb(db);
      return send(res, 201, decorate(b));
    }

    // 处置：填写处理说明 + 复核结果
    const closeM = url.pathname.match(/^\/api\/batches\/([^/]+)\/tasks\/([^/]+)\/close$/);
    if (closeM && req.method === "POST") {
      const b = db.batches.find((x) => x.id === closeM[1]);
      if (!b) return send(res, 404, { error: "批次不存在" });
      const t = (b.tasks || []).find((x) => x.id === closeM[2]);
      if (!t) return send(res, 404, { error: "处置事项不存在" });
      if (t.status === "已关闭") return bad(res, "该事项已关闭");
      const input = await body(req);
      const handling = String(input.handling || "").trim();
      const reviewer = String(input.reviewer || "").trim();
      if (!handling) return bad(res, "处理说明为必填项，填写后才能关闭");
      if (!reviewer) return bad(res, "请填写复核人");
      const passed = String(input.passed) === "true";
      const at = new Date().toISOString();
      t.handling = handling;
      t.handledAt = at;
      t.reviewer = reviewer;
      t.passed = passed;
      t.reviewNote = String(input.reviewNote || "");
      t.reviewedAt = at;
      addEvent(b, "处置", `提交处理：${t.title}；措施：${handling}；复核人 ${reviewer}，复核${passed ? "合格" : "不合格（退回重新处理）"}${t.reviewNote ? "；备注：" + t.reviewNote : ""}`, { taskId: t.id, handling, reviewer, passed });
      if (!passed) {
        // 复核不合格：退回，事项保持待处置
        await saveDb(db);
        return send(res, 200, decorate(b));
      }
      t.status = "已关闭";
      t.closedAt = at;
      addEvent(b, "处置", `处置事项关闭：${t.title}（复核合格）`, { taskId: t.id });
      // 全部关闭 → 状态恢复
      if (openTasks(b).length === 0 && b.status === "异常观察") {
        setStatus(b, "发酵中", "异常处置全部关闭且复核合格，恢复为发酵中");
      }
      await saveDb(db);
      return send(res, 200, decorate(b));
    }

    // 状态变更（未关闭事项不能转可抄纸）
    const statusM = url.pathname.match(/^\/api\/batches\/([^/]+)\/status$/);
    if (statusM && req.method === "POST") {
      const b = db.batches.find((x) => x.id === statusM[1]);
      if (!b) return send(res, 404, { error: "批次不存在" });
      const input = await body(req);
      if (!STATUSES.includes(input.status)) return bad(res, "目标状态无效");
      if (input.status === "可抄纸" && openTasks(b).length > 0)
        return bad(res, `尚有 ${openTasks(b).length} 项处置事项未关闭，不能转为可抄纸`);
      setStatus(b, input.status);
      await saveDb(db);
      return send(res, 200, decorate(b));
    }

    // 时间线查询
    const tlM = url.pathname.match(/^\/api\/batches\/([^/]+)\/timeline$/);
    if (tlM && req.method === "GET") {
      const b = db.batches.find((x) => x.id === tlM[1]);
      if (!b) return send(res, 404, { error: "批次不存在" });
      return send(res, 200, (b.timeline || []).slice().reverse());
    }

    return send(res, 404, { error: "not_found" });
  } catch (error) {
    send(res, 500, { error: error.message });
  }
});

server.listen(port, () => console.log("古法纸浆发酵批次追溯与处置系统 listening on http://localhost:" + port));
