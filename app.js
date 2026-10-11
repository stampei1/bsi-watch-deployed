'use strict';
// BSI Watch — the patients on a (simulated) allo-HCT unit, grouped by what needs a look today.
const ORGS = ['ecoli', 'entero'];
const NAME = { ecoli: 'E. coli', entero: 'Enterococcus' };
const NI = { ecoli: '<i>E. coli</i>', entero: '<i>Enterococcus</i>' };
const STALE = 7;                         // a stool result older than this many days no longer counts
const HORIZON = 14;
const RANK = { high: 3, watch: 2, low: 1, due: 0, na: -1 };
const TIER_LABEL = { high: 'High', watch: 'Watch', low: 'Low', due: 'No recent stool', na: 'Not scored' };
// Performance figures are taken from the project brief (AGENT_BRIEF), not computed here.
const AUC = { ecoli: { model: 0.897, abundance: 0.827 }, entero: { model: 0.816, abundance: 0.753 } };
// Review choices: workflow steps only. DRAFT wording (2026-10-11) — for Isaac to approve.
const REVIEW_CHOICES = ['Reviewed – no change', 'Discuss at rounds', 'Notify attending'];
const RKEY = 'bsiwd-reviews-v1';
const S = { W: null, day: 24, sel: null, histOpen: false, reviews: {}, mem: false, lane: null, pinned: null };
const $ = (id) => document.getElementById(id);
const pct = (v, d) => v == null ? '—' : (v * 100).toFixed(d ?? (v < 0.01 ? 2 : 1)) + '%';
const abTxt = (v) => v == null ? '—' : v === 0 ? 'not detected' : v < 0.001 ? '<0.1%' : (v * 100).toFixed(v < 0.1 ? 1 : 0) + '%';
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const fmtN = (n) => n.toLocaleString('en-US');
const dayTxt = (h) => (h > 0 ? '+' : h < 0 ? '−' : '') + Math.abs(h);
const tempTxt = (t) => t == null ? '<span class="na">—</span>' : `<span class="${t >= 100.4 ? 'fever' : ''}">${t.toFixed(1)}°</span>`;
const oneIn = (r) => r > 0 ? `1 in ${Math.max(1, Math.round(1 / r))}` : '—';
const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const BUILD = document.querySelector('meta[name="build"]')?.content || '';
const COVERED = (o, a) => (o === 'ecoli' && a === 'Escherichia') || (o === 'entero' && a.startsWith('Enterococcus'));
const agent = (a) => ({ Escherichia: 'E. coli', Enterococcus_Faecium_Vancomycin_Resistant: 'VRE', Enterococcus_Faecium: 'E. faecium',
  Enterococcus_Faecalis: 'E. faecalis', Enterococcus_Vancomycin_Resistant: 'VRE', Klebsiella_Pneumoniae: 'K. pneumoniae' })[a] || a.replace(/_/g, ' ');

// ------------------------------------------------------------------ storage (reviews persist only if localStorage works)
function loadReviews() {
  try { S.reviews = JSON.parse(localStorage.getItem(RKEY) || '{}') || {}; } catch (e) { S.reviews = {}; S.mem = true; }
}
function saveReviews() {
  try { localStorage.setItem(RKEY, JSON.stringify(S.reviews)); } catch (e) { S.mem = true; }
}
function theme(get, val) { try { if (get) return localStorage.getItem('bsiw-theme'); localStorage.setItem('bsiw-theme', val); } catch (e) { return null; } }

async function init() {
  const t = theme(true); if (t) document.documentElement.dataset.theme = t;
  loadReviews();
  S.W = await (await fetch(`data/ward.json?v=${BUILD}`)).json();
  checkReasonCoverage();
  S.day = Math.min(Math.max(S.day, S.W.span[0]), S.W.span[1]);
  $('prevDay').onclick = () => go(-1);
  $('nextDay').onclick = () => go(1);
  document.addEventListener('keydown', (e) => {
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) return;
    if (e.key === 'ArrowLeft') go(-1);
    if (e.key === 'ArrowRight') go(1);
    if (e.key === 'Escape') document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden'));
  });
  $('aboutBtn').onclick = () => { about(); show('about'); };
  $('factsLink').onclick = () => { $('about').classList.add('hidden'); facts(); show('facts'); };
  $('resetReviews').onclick = () => { S.reviews = {}; saveReviews(); about(); render(); $('resetNote').textContent = 'Demo reviews cleared.'; };
  document.querySelectorAll('.modal').forEach(m => m.addEventListener('click', (e) => {
    if (e.target === m || e.target.hasAttribute('data-close')) m.classList.add('hidden'); }));
  $('themeBtn').onclick = () => {
    const dark = document.documentElement.dataset.theme === 'dark' ||
      (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = dark ? 'light' : 'dark'; theme(false, document.documentElement.dataset.theme); render();
  };
  let rt; addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(render, 120); });
  render();
}
const show = (id) => $(id).classList.remove('hidden');
function go(d) { S.day = Math.min(Math.max(S.day + d, S.W.span[0]), S.W.span[1]); render(); }

// ------------------------------------------------------------------ status of one patient on one day (data up to day d only)
function tierOf(o, p) { const t = S.W.tiers[o]; return p >= t.high ? 'high' : p >= t.watch ? 'watch' : 'low'; }
function status(pt, d) {
  const past = pt.samples.filter(s => s.d <= d);
  const last = past[past.length - 1];
  const out = { last, age: last ? d - last.d : null, org: {} };
  for (const o of ORGS) {
    const sc = past.filter(s => s['p_' + o] != null);
    const s = sc[sc.length - 1], prev = sc[sc.length - 2];
    if (!s) { out.org[o] = { tier: 'na' }; continue; }
    const age = d - s.d, tier = age > STALE ? 'due' : tierOf(o, s['p_' + o]);
    const prevTier = prev ? tierOf(o, prev['p_' + o]) : null;
    out.org[o] = { tier, p: s['p_' + o], s, age, prev: prev || null, prevTier,
      // "New": today's stool result moved this organism into High or Watch
      isNew: s.d === d && (tier === 'high' || tier === 'watch') && (!prevTier || RANK[tier] > RANK[prevTier]) };
  }
  const fresh = ORGS.map(o => out.org[o]).filter(x => x.tier !== 'na' && x.tier !== 'due');
  out.tier = !last || out.age > STALE ? 'due' : fresh.length ? fresh.reduce((a, b) => RANK[b.tier] > RANK[a.tier] ? b : a).tier : 'na';
  out.top = ORGS.reduce((a, o) => (RANK[out.org[o].tier] > RANK[out.org[a].tier] ? o : a), 'ecoli');
  out.culture = pt.infections.filter(([day]) => day <= d && d - day <= 7);
  out.isNew = ORGS.some(o => out.org[o].isNew);
  return out;
}

// ------------------------------------------------------------------ review state
// A review counts only on days at or after the day it was made. A patient needs review when their highest tier is
// High or Watch and either (a) there is no review yet, or (b) a stool result newer than the last review puts an
// organism in a higher tier than at that review (Low → Watch, Watch → High). Same or lower tier does not re-open.
function lastReview(pt, d, store) {
  const rs = (store[pt.bed] || []).filter(r => r.day <= d);
  return rs.length ? rs[rs.length - 1] : null;
}
function needsReview(pt, s, d, store) {
  if (s.culture.length || !(s.tier === 'high' || s.tier === 'watch')) return false;
  const r = lastReview(pt, d, store);
  if (!r) return true;
  return ORGS.some(o => { const os = s.org[o];
    if (!(os.tier === 'high' || os.tier === 'watch')) return false;
    const was = r.tiers[o] in RANK ? RANK[r.tiers[o]] : 0;
    return os.s && os.s.d > (r.sampleDay[o] ?? -Infinity) && RANK[os.tier] > Math.max(was, RANK.low); });
}
function makeReview(s, d, choice, note) {
  const tiers = {}, sampleDay = {};
  for (const o of ORGS) { tiers[o] = s.org[o].tier; sampleDay[o] = s.org[o].s ? s.org[o].s.d : null; }
  return { day: d, choice, note: (note || '').slice(0, 200), tiers, sampleDay };
}
function burden(upTo) {                               // replay: every needs-review patient reviewed the same day, "no change"
  const sim = {}, perDay = [];
  for (let d = S.W.span[0]; d <= upTo; d++) {
    let n = 0;
    for (const pt of S.W.patients.filter(p => p.stay[0] <= d && d <= p.stay[1])) {
      const s = status(pt, d);
      if (needsReview(pt, s, d, sim)) { n++; (sim[pt.bed] = sim[pt.bed] || []).push(makeReview(s, d, REVIEW_CHOICES[0], '')); }
    }
    perDay.push(n);
  }
  return { mean: perDay.reduce((a, b) => a + b, 0) / perDay.length, min: Math.min(...perDay), max: Math.max(...perDay), days: perDay.length };
}

// ------------------------------------------------------------------ context + reasons (ported from BSI Timeline)
function context(pt, d) {
  const anc = pt.anc.filter(([day]) => day <= d && d - day <= 3);
  const ancDay = anc.length ? Math.max(...anc.map(a => a[0])) : null;
  const ancV = ancDay != null ? Math.max(...anc.filter(a => a[0] === ancDay).map(a => a[1])) : null;
  const t = pt.temp.filter(([day]) => day <= d && d - day <= 1);
  const tmax = t.length ? Math.max(...t.map(a => a[1])) : null;
  const abx = [...new Set(pt.drugs.filter(([, a, b]) => a <= d && d <= b).map(([n]) => n))];
  const peak = {};                                    // highest abundance in the past 14 days, up to today only
  for (const o of ORGS) peak[o] = Math.max(0, ...pt.samples.filter(q => q.d <= d && q.d >= d - 14 && q['ab_' + o] != null).map(q => q['ab_' + o]));
  return { anc: ancV, tmax, abx, hct: d - pt.hct_shift, peak };
}
// DRAFT wording (shared with BSI Timeline) — for Isaac to approve. Every phrase returns a string.
const DOMINANT = 0.3;                                  // ≥ 30% of the community = domination (Taur et al., Clin Infect Dis 2012)
function abPhrase(o) {
  return (c, s) => {
    const now = s['ab_' + o], pk = c.peak[o], n = now ?? 0, nowTxt = now == null ? 'no reading' : abTxt(now);
    if (pk >= 0.01 && pk >= 10 * n) return `${NI[o]} in stool: now ${nowTxt}, up to ${abTxt(pk)} in the past 2 weeks`;
    return `${NI[o]} in stool: ${nowTxt}${n >= DOMINANT ? ' (dominant)' : ''}`;
  };
}
const abNote = (o) => (c, s) => (s['ab_' + o] ?? 0) >= DOMINANT ? 'Dominant = at least 30% of the stool community (Taur et al., Clin Infect Dis 2012).' : null;
const REASON = {
  'E. coli abundance and trend': [abPhrase('ecoli'), 'ab', abNote('ecoli')],
  'Enterococcus abundance and trend': [abPhrase('entero'), 'ab', abNote('entero')],
  'Lineages containing Enterococcus': [() => '<i>Enterococcus</i>-related bacteria in stool (not plotted)', null,
    'Higher-level bacterial groups that contain Enterococcus (e.g. its family and order).'],
  'Pathogen vs commensal ratios': [() => 'Balance of <i>Enterococcus</i> vs commensal anaerobes', 'ab',
    'Compares Enterococcus with anaerobic commensal bacteria; only Enterococcus is plotted here.'],
  'Protective commensal indices': [() => 'Protective commensal bacteria pattern (not plotted)', null,
    'An index of gut bacteria reported in the literature as protective (e.g. Blautia, Barnesiella).'],
  'Bacteroides interaction': [() => 'Pattern involving <i>Bacteroides</i> (not plotted)', null, 'How much Bacteroides there is together with the pathogen.'],
  'Other gut bacteria': [() => 'Pattern of other gut bacteria (not plotted)', null, 'Current amounts of the many other bacterial groups in the stool sample.'],
  'Other bacteria, trends': [() => 'Recent shifts in other gut bacteria (not plotted)', null, 'Recent trends (e.g. 7–30-day mean, max, slope) of other bacterial groups.'],
  'Antibiotics, prior 14 days': [(c) => c.abx.length ? `Antibiotics in the last 2 weeks (now: ${c.abx.slice(0, 2).join(', ')})` : 'Antibiotics in the last 2 weeks', 'abx'],
  'Antibiotics by class': [(c) => c.abx.length ? `Recent antibiotics (now: ${c.abx.slice(0, 2).join(', ')})` : 'Recent antibiotic exposure', 'abx'],
  'Antibiotic totals': [() => 'Amount of recent antibiotic exposure', 'abx'],
  'Antibiotic groups': [() => 'Broad-spectrum / anti-anaerobe exposure', 'abx'],
  'Antibiotic intensification': [() => 'Recent escalation of antibiotics', 'abx'],
  'Days since last antibiotic dose': [() => 'Time since the last antibiotic dose', 'abx'],
  'Antibiotic → commensal-loss cascade': [() => 'Antibiotics followed by loss of anaerobes', 'abx'],
  'Neutrophil count (ANC)': [(c) => c.anc == null ? 'Neutrophil data' : c.anc < 0.5 ? `Neutropenia (ANC ${c.anc})` : `Neutrophil count (ANC ${c.anc})`, 'anc'],
  'ANC trend, prior 14 days': [() => 'Neutrophil trend over 2 weeks', 'anc'],
  'Neutropenia × Enterococcus': [() => 'Neutropenia while <i>Enterococcus</i> is present', 'anc'],
  'ANC recovery timing': [() => 'Timing of neutrophil recovery', 'anc'],
  'Day relative to transplant': [(c) => c.hct < 0 ? `Before transplant (day ${dayTxt(c.hct)})`
    : c.hct <= 30 ? `Early after transplant (day ${dayTxt(c.hct)})` : `Day ${dayTxt(c.hct)} after transplant`, null, 'The number of days since transplant.'],
};
const NO_SINGLE = 'No single factor stood out; the score reflects several small contributions.';   // DRAFT wording
function checkReasonCoverage() {
  for (const o of ORGS) for (const g of S.W.groups[o])
    if (!(g in REASON)) console.warn(`BSI Watch: driver group "${g}" (${NAME[o]}) has no REASON phrase`);
}
function reasons(o, s, c) {
  const g = s['g_' + o]; if (!g) return [];
  const names = S.W.groups[o], seen = new Set(), out = [];
  g.map((v, i) => [v, i]).filter(([v]) => v > Math.log(1.1)).sort((a, b) => b[0] - a[0]).forEach(([, i]) => {
    const r = REASON[names[i]] || [() => names[i], null];
    const txt = r[0](c, s), note = typeof r[2] === 'function' ? r[2](c, s) : r[2] || null;
    if (!seen.has(txt) && out.length < 2) { seen.add(txt); out.push({ txt, lane: r[1], note, group: names[i] }); }
  });
  return out;
}

// ------------------------------------------------------------------ list
function render() {
  const d = S.day;
  $('dayNum').textContent = d;
  $('prevDay').disabled = d <= S.W.span[0]; $('nextDay').disabled = d >= S.W.span[1];
  const st = S.W.patients.filter(p => p.stay[0] <= d && d <= p.stay[1]).map(p => [p, status(p, d)]);
  const byRisk = (a, b) => RANK[b[1].tier] - RANK[a[1].tier] || (b[1].org[b[1].top].p || 0) - (a[1].org[a[1].top].p || 0);
  const cult = st.filter(([, s]) => s.culture.length).sort(byRisk);
  const rest = st.filter(([, s]) => !s.culture.length);
  const need = rest.filter(([p, s]) => needsReview(p, s, d, S.reviews)).sort(byRisk);
  const done = rest.filter(([p, s]) => (s.tier === 'high' || s.tier === 'watch') && !needsReview(p, s, d, S.reviews)).sort(byRisk);
  const low = rest.filter(([, s]) => !(s.tier === 'high' || s.tier === 'watch')).sort(byRisk);
  const nHigh = rest.filter(([, s]) => s.tier === 'high').length, nNew = st.filter(([, s]) => s.isNew).length;
  $('summary').innerHTML = `<b>${plural(st.length, 'patient')}</b> · <span class="${nHigh ? 'hi' : ''}">${nHigh} high risk</span> · ` +
    `<span class="${need.length ? 'nr' : ''}">${need.length} need review</span>` + (nNew ? ` · ${nNew} new today` : '') +
    (cult.length ? ` · <span class="hi">${plural(cult.length, 'positive blood culture')}</span>` : '');
  const all = [...cult, ...need, ...done, ...low];
  if (!S.sel || !st.some(([p]) => p.bed === S.sel)) S.sel = (need[0] || cult[0] || all[0])?.[0].bed ?? null;
  const section = (title, rows, cls) => rows.length ? `<tr class="sec ${cls}"><th colspan="7">${title} <span class="cnt">${rows.length}</span></th></tr>` +
    rows.map(([p, s]) => rowHTML(p, s, d)).join('') : '';
  $('list').innerHTML = `<table class="grid"><thead><tr><th>Bed</th><th class="c-pt">Patient</th><th class="c-num" title="Day relative to transplant">HCT day</th>
    <th class="c-num" title="Maximum temperature, last 24 h (°F)">Temp</th><th class="c-st" title="Age of the newest stool result">Stool</th><th class="c-sc">E. coli</th>
    <th class="c-sc"><span class="long">Enterococcus</span><span class="short">Entero.</span></th></tr></thead><tbody>
    ${section('Positive blood culture', cult, 'cult')}${section('Needs review', need, 'need')}${section('Reviewed', done, 'done')}${section('Low risk / no recent stool', low, 'low')}
    </tbody></table>`;
  $('list').querySelectorAll('tr.row').forEach(r => {
    const pick = () => { S.sel = +r.dataset.bed; render();
      if (matchMedia('(max-width: 900px)').matches) $('detail').scrollIntoView({ behavior: 'smooth', block: 'start' }); };
    r.onclick = pick; r.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } };
  });
  const sel = st.find(([p]) => p.bed === S.sel);
  if (sel) detail(sel, d);
}
function cell(s, o, d) {
  const os = s.org[o];
  if (s.culture.some(([, a]) => COVERED(o, a))) return `<span class="score pos">BSI</span>`;
  if (os.tier === 'na' || os.tier === 'due') return `<span class="score na">—</span>`;
  let ar = '', tip = '';
  if (os.prev) {
    const pp = os.prev['p_' + o];
    ar = os.p > pp * 1.05 ? '↑' : os.p < pp / 1.05 ? '↓' : '→';
    tip = ` title="previous sample (day ${dayTxt(os.prev.hct)}): ${pct(pp)}${os.prevTier !== os.tier ? ` · ${TIER_LABEL[os.prevTier]} → ${TIER_LABEL[os.tier]}` : ''}"`;
  }
  return `<span class="score ${os.tier}"${tip}>${pct(os.p)}</span>${ar ? `<i class="ar ${ar === '↑' ? 'up' : ar === '↓' ? 'dn' : 'eq'}"${tip}>${ar}</i>` : ''}${os.isNew ? '<span class="newtag">New</span>' : ''}`;
}
function rowHTML(p, s, d) {
  const c = context(p, d), rv = lastReview(p, d, S.reviews);
  const stool = s.last ? (s.age === 0 ? 'today' : `${s.age} d`) : '—';
  return `<tr class="row ${S.sel === p.bed ? 'sel' : ''}" data-bed="${p.bed}" tabindex="0">
    <td class="c-bed">${p.bed}</td>
    <td class="c-pt"><span class="pid">${p.pid}</span>${s.culture.length ? '<span class="tag" title="positive blood culture in the last 7 days">+BC</span>' : ''}${
      rv && !s.culture.length && (s.tier === 'high' || s.tier === 'watch') && !needsReview(p, s, d, S.reviews) ? `<span class="rvd" title="Reviewed day ${rv.day}: ${esc(rv.choice)}">✓</span>` : ''}</td>
    <td class="c-num">${dayTxt(c.hct)}</td>
    <td class="c-num">${tempTxt(c.tmax)}</td>
    <td class="c-st ${s.last && s.age > STALE ? 'old' : ''}">${stool}</td>
    <td class="c-sc">${cell(s, 'ecoli', d)}</td>
    <td class="c-sc">${cell(s, 'entero', d)}</td></tr>`;
}

// ------------------------------------------------------------------ detail
function detail([p, s], d) {
  const c = context(p, d);
  if (S.pinFor !== p.bed) { S.pinned = null; S.pinFor = p.bed; }
  let h = `<div class="dhead"><h2>Bed ${p.bed}</h2><div class="meta">${p.pid} · day ${dayTxt(c.hct)} after transplant${c.tmax != null ? ` · ${tempTxt(c.tmax)}F` : ''}
    · bloodstream infection (BSI) risk, next 14 days</div></div>`;
  for (const [day, a] of s.culture)
    h += `<div class="event">Positive blood culture ${day === d ? 'today' : plural(d - day, 'day') + ' ago'}: ${agent(a)}</div>`;
  const shown = ORGS.filter(o => ['high', 'watch'].includes(s.org[o].tier) && !s.culture.some(([, a]) => COVERED(o, a)))
    .sort((a, b) => RANK[s.org[b].tier] - RANK[s.org[a].tier]);
  if (shown.length) h += shown.map(o => hero(p, s.org[o], o, c, d)).join('');
  else if (!s.culture.length) h += `<div class="hero"><p class="say">${s.tier === 'due'
    ? `No stool result in the last ${STALE} days${s.last ? ` (newest: ${plural(s.age, 'day')} ago)` : ''}.` : 'Low risk for <i>E. coli</i> and <i>Enterococcus</i>.'}</p></div>`;
  if (!s.culture.length && (s.tier === 'high' || s.tier === 'watch')) h += reviewHTML(p, s, d);
  h += `<details class="hist" ${S.histOpen ? 'open' : ''}><summary>History</summary><div id="histBox"></div></details>`;
  $('detail').innerHTML = h;
  const det = $('detail').querySelector('details.hist');
  const paint = () => document.querySelectorAll('#histBox [data-hl]').forEach(r => r.classList.toggle('on', r.dataset.hl === S.lane));
  const draw = () => { if (det.open) { $('histBox').innerHTML = history(p, d, $('histBox').clientWidth || 560); paint(); } };
  det.ontoggle = () => { S.histOpen = det.open; draw(); };
  S.lane = null; draw();
  // reasons <-> History lanes (tapping a reason while History is closed opens it); the lit lane survives redraws
  $('detail').querySelectorAll('.why li[data-lane]').forEach(li => {
    const set = (v) => { S.lane = v ? li.dataset.lane : (S.pinned || null); paint(); };
    li.addEventListener('mouseenter', () => set(true)); li.addEventListener('mouseleave', () => set(false));
    li.addEventListener('focus', () => set(true)); li.addEventListener('blur', () => set(false));
    li.addEventListener('click', () => { S.pinned = S.pinned === li.dataset.lane ? null : li.dataset.lane; S.lane = S.pinned;
      if (!det.open) { det.open = true; S.histOpen = true; draw(); } else paint(); });
  });
  $('detail').querySelectorAll('[data-facts]').forEach(b => b.onclick = () => { facts(b.dataset.facts); show('facts'); });
  wireReview(p, s, d);
}
function hero(p, os, o, c, d) {
  const st = S.W.tiers[o].stats[os.tier], rs = reasons(o, os.s, c);
  let change = '';
  if (os.prev) {
    const pp = os.prev['p_' + o], dir = os.p > pp * 1.05 ? '↑ up from' : os.p < pp / 1.05 ? '↓ down from' : '→ about the same as';
    change = `<div class="chg">${dir} ${pct(pp)} (day ${dayTxt(os.prev.d - p.hct_shift)})${os.prevTier !== os.tier ? ` · <b>${TIER_LABEL[os.prevTier]} → ${TIER_LABEL[os.tier]}</b>` : ''}</div>`;
  }
  return `<div class="hero ${os.tier}"><div class="hl"><span class="oname">${NI[o]} BSI risk, next 14 days</span>
      <span class="hr"><span class="score ${os.tier}">${TIER_LABEL[os.tier]}</span><button class="info" data-facts="${o}" aria-label="Model facts for ${NAME[o]}" title="Model facts">ⓘ</button></span></div>
    <div class="big"><span class="num">${pct(os.p)}</span></div>${change}
    <div class="srcline">From a stool sample ${os.age === 0 ? 'taken today' : plural(os.age, 'day') + ' ago'} (day ${dayTxt(os.s.d - p.hct_shift)})</div>
    <p class="say">About <b>${oneIn(st.rate)}</b> stool samples at this level were followed by an ${NI[o]} BSI within 14 days.</p>
    <div class="whyh">What raised the model's score</div>${rs.length ? `<ul class="why">${rs.map(r =>
      `<li tabindex="0" ${r.lane ? `data-lane="${r.lane}"` : ''} ${r.note ? `title="${esc(r.note)}"` : ''}><span>${r.txt}${r.note ? ' <span class="nl">ⓘ</span>' : ''}</span></li>`).join('')}</ul>`
      : `<p class="nosingle">${NO_SINGLE}</p>`}</div>`;
}
function reviewHTML(p, s, d) {
  const rv = lastReview(p, d, S.reviews), need = needsReview(p, s, d, S.reviews);
  const status = rv ? `<div class="rvlast ${need ? 'stale' : ''}">${need ? 'Earlier review' : 'Reviewed'} on day ${rv.day}: <b>${esc(rv.choice)}</b>${rv.note ? ` — “${esc(rv.note)}”` : ''}${
    need ? '<br><span>A newer stool result raised a tier since then.</span>' : ''}</div>` : '';
  return `<div class="review"><div class="rvh">Review <span class="draft" title="Workflow choices only; wording is a draft">draft</span></div>${status}
    <div class="rvchoices" role="radiogroup" aria-label="Review choice">${REVIEW_CHOICES.map((c, i) =>
      `<button class="rvc" role="radio" aria-checked="false" data-choice="${i}">${c}</button>`).join('')}</div>
    <textarea id="rvNote" maxlength="200" rows="2" placeholder="Optional note (200 characters)"></textarea>
    <div class="rvrow"><span id="rvCount" class="fine">0 / 200</span><button id="rvSave" class="btn" disabled>Save review</button></div>
    ${S.mem ? '<div class="fine">Reviews are kept for this visit only (browser storage is unavailable).</div>' : ''}</div>`;
}
function wireReview(p, s, d) {
  const box = $('detail').querySelector('.review'); if (!box) return;
  let choice = null;
  box.querySelectorAll('.rvc').forEach(b => b.onclick = () => {
    choice = +b.dataset.choice;
    box.querySelectorAll('.rvc').forEach(x => { x.classList.toggle('on', x === b); x.setAttribute('aria-checked', x === b); });
    $('rvSave').disabled = false;
  });
  $('rvNote').oninput = (e) => { $('rvCount').textContent = `${e.target.value.length} / 200`; };
  $('rvSave').onclick = () => {
    if (choice == null) return;
    const list = (S.reviews[p.bed] = (S.reviews[p.bed] || []).filter(r => r.day <= d));   // later-day reviews would be in the future
    list.push(makeReview(s, d, REVIEW_CHOICES[choice], $('rvNote').value));
    saveReviews(); render();
  };
}

// ------------------------------------------------------------------ history (up to today only)
function history(p, d, W) {
  const first = p.samples.length ? p.samples[0].d : d;
  const d0 = Math.max(first - 7, d - 60), d1 = d + 0.5;
  const G = Math.min(150, Math.max(104, W * 0.26)), R = 8, PW = W - G - R;
  const x = (t) => G + (t - d0) / (d1 - d0) * PW;
  const T = S.W.tiers, rows = [];
  const drugs = [...new Set(p.drugs.filter(([, a, b]) => b >= d0 && a <= d).map(([n]) => n))];
  const ML = W < 520 ? 16 : 24;
  const H = { risk: 54, ab: 50, lane: 13, anc: 50, temp: 50, gap: 12 };
  let y = 6;
  const add = (key, h) => { rows.push({ key, y, h }); y += h + H.gap; };
  add('ecoli', H.risk); add('entero', H.risk); add('ab', H.ab); if (drugs.length) add('abx', drugs.length * H.lane + 16); add('anc', H.anc); add('temp', H.temp);
  const total = y + 14;
  let o = `<svg viewBox="0 0 ${W} ${total}" class="histsvg" role="img" aria-label="History">`;
  for (const r of rows) o += `<rect x="${G - 4}" y="${r.y - 4}" width="${PW + 8}" height="${r.h + 8}" rx="7" class="h-hl" data-hl="${r.key}"/>`;
  const label = (r, t, sub) => o += `<text x="0" y="${r.y + 12}" class="hl1">${t}</text>` + (sub ? `<text x="0" y="${r.y + 25}" class="hl2">${sub}</text>` : '');
  const frame = (r) => o += `<rect x="${G}" y="${r.y}" width="${PW}" height="${r.h}" class="hbg"/>`;
  const hct = (t) => t - p.hct_shift, step = (d1 - d0) > 40 ? 14 : 7;
  for (let t = Math.ceil(hct(d0) / step) * step; t <= hct(d); t += step) {
    const X = x(t + p.hct_shift);
    o += `<line x1="${X}" x2="${X}" y1="2" y2="${y - H.gap}" class="hgrid"/><text x="${X}" y="${total - 2}" class="htick" text-anchor="middle">${dayTxt(t)}</text>`;
  }
  o += `<text x="0" y="${total - 2}" class="htick">day vs transplant</text>`;
  const none = (r) => o += `<text x="${G + 8}" y="${r.y + r.h / 2 + 3}" class="htick">no data recorded</text>`;
  for (const r of rows) {
    if (r.key === 'ecoli' || r.key === 'entero') {
      const org = r.key, lo = Math.log10(0.001), hi = Math.log10(0.5);
      const ly = (v) => r.y + r.h - (Math.log10(Math.max(0.001, Math.min(0.5, v))) - lo) / (hi - lo) * r.h;
      frame(r); label(r, `<tspan font-style="italic">${NAME[org]}</tspan>`, 'risk, 14 d');
      o += `<rect x="${G}" y="${r.y}" width="${PW}" height="${ly(T[org].high) - r.y}" class="hband"/>
        <rect x="${G}" y="${ly(T[org].high)}" width="${PW}" height="${ly(T[org].watch) - ly(T[org].high)}" class="wband"/>`;
      const pts = p.samples.filter(s => s['p_' + org] != null && s.d <= d && s.d >= d0 - 30);
      if (pts.length) {
        let path = '';
        pts.forEach((s, i) => { const X = Math.max(G, x(s.d)), Y = ly(s['p_' + org]); path += i ? `H${X}V${Y}` : `M${X},${Y}`; });
        o += `<path d="${path}H${x(d)}" class="hline"/>`;
        for (const s of pts.filter(s => s.d >= d0)) {
          const v = s['p_' + org], t = tierOf(org, v);
          o += `<circle cx="${x(s.d)}" cy="${ly(v)}" r="${t === 'low' ? 2.6 : 3.4}" class="hpt ${t}"><title>${NAME[org]} · day ${dayTxt(hct(s.d))}: ${pct(v)} (${TIER_LABEL[t]})</title></circle>`;
        }
      }
    } else if (r.key === 'ab') {
      const lo = Math.log10(0.0005), ly = (v) => r.y + r.h - (Math.log10(Math.max(0.0005, Math.min(1, v))) - lo) / (0 - lo) * r.h;
      frame(r); label(r, 'In stool', 'relative abundance');
      for (const [org, cls] of [['ecoli', 'a'], ['entero', 'b']]) {
        const pts = p.samples.filter(s => s['ab_' + org] != null && s.d <= d && s.d >= d0);
        if (!pts.length) continue;
        o += `<path d="${pts.map((s, i) => `${i ? 'L' : 'M'}${x(s.d)},${ly(s['ab_' + org])}`).join('')}" class="hab-${cls}"/>` +
          pts.map(s => `<circle cx="${x(s.d)}" cy="${ly(s['ab_' + org])}" r="2" class="hdot-${cls}"><title>${NAME[org]} in stool, day ${dayTxt(hct(s.d))}: ${abTxt(s['ab_' + org])}</title></circle>`).join('');
      }
      o += `<line x1="${G + 6}" x2="${G + 22}" y1="${r.y + 9}" y2="${r.y + 9}" class="hab-a"/><text x="${G + 25}" y="${r.y + 12}" class="htick" font-style="italic">E. coli</text>
        <line x1="${G + 64}" x2="${G + 80}" y1="${r.y + 9}" y2="${r.y + 9}" class="hab-b"/><text x="${G + 83}" y="${r.y + 12}" class="htick" font-style="italic">Enterococcus</text>`;
    } else if (r.key === 'abx') {
      label(r, 'Antibiotics', '');
      drugs.forEach((n, k) => {
        const yy = r.y + 16 + k * H.lane;
        o += `<text x="${G - 6}" y="${yy + 9}" class="htick" text-anchor="end">${esc(n.length > ML ? n.slice(0, ML - 1) + '…' : n)}<title>${esc(n)}</title></text>`;
        for (const [nn, a, b] of p.drugs) if (nn === n && b >= d0 && a <= d) {
          const xa = x(Math.max(a, d0) - 0.4), xb = x(Math.min(b, d) + 0.4);
          o += `<rect x="${xa}" y="${yy + 1}" width="${Math.max(2, xb - xa)}" height="${H.lane - 3}" rx="2" class="habx"><title>${esc(n)} · day ${dayTxt(hct(a))} to ${dayTxt(hct(Math.min(b, d)))}</title></rect>`;
        }
      });
    } else if (r.key === 'anc') {
      const lo = Math.log10(0.05), hi = Math.log10(30);
      const ly = (v) => r.y + r.h - (Math.log10(Math.max(0.05, Math.min(30, v))) - lo) / (hi - lo) * r.h;
      frame(r); label(r, 'Neutrophils', 'ANC, ×10³/µL');
      o += `<rect x="${G}" y="${ly(0.5)}" width="${PW}" height="${r.y + r.h - ly(0.5)}" class="nband"/>`;
      const byDay = new Map();
      for (const [t, v] of p.anc) if (t >= d0 && t <= d) byDay.set(t, Math.max(byDay.get(t) ?? -1, v));
      const ds = [...byDay.keys()].sort((a, b) => a - b);
      if (!ds.length) none(r);
      else o += `<path d="${ds.map((t, i) => `${i ? 'L' : 'M'}${x(t)},${ly(byDay.get(t))}`).join('')}" class="hline thin"/>` +
        ds.map(t => `<circle cx="${x(t)}" cy="${ly(byDay.get(t))}" r="1.8" class="hdot"><title>ANC day ${dayTxt(hct(t))}: ${byDay.get(t)}</title></circle>`).join('');
    } else if (r.key === 'temp') {
      const lo = 96, hi = 104, ly = (v) => r.y + r.h - (Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo) * r.h;
      frame(r); label(r, 'Temperature', 'daily max, °F');
      o += `<rect x="${G}" y="${r.y}" width="${PW}" height="${ly(100.4) - r.y}" class="fband"/>`;
      const pts = p.temp.filter(([t]) => t >= d0 && t <= d);
      if (!pts.length) none(r);
      else o += `<path d="${pts.map(([t, v], i) => `${i ? 'L' : 'M'}${x(t)},${ly(v)}`).join('')}" class="hline thin"/>` +
        pts.map(([t, v]) => `<circle cx="${x(t)}" cy="${ly(v)}" r="${v >= 100.4 ? 2.6 : 1.8}" class="${v >= 100.4 ? 'hfever' : 'hdot'}"><title>Temp day ${dayTxt(hct(t))}: ${v} °F</title></circle>`).join('');
    }
  }
  for (const [t, a] of p.infections) if (t >= d0 && t <= d)
    o += `<line x1="${x(t)}" x2="${x(t)}" y1="2" y2="${y - H.gap}" class="hbsi"><title>Positive blood culture: ${agent(a)}</title></line>`;
  o += `<line x1="${x(d)}" x2="${x(d)}" y1="2" y2="${y - H.gap}" class="htoday"/>`;
  return o + '</svg>';
}

// ------------------------------------------------------------------ About, tier table, Model facts
function tierTable(orgs) {
  const row = (o) => {
    const T = S.W.tiers[o], st = T.stats;
    return `<tr><td rowspan="3">${NI[o]}<br><span class="fine">baseline ${pct(T.base)}</span></td>
      <td><span class="score high">High</span></td><td>≥ ${pct(T.high)}</td><td>${pct(st.high.share, 0)}</td><td>${pct(st.high.caught, 0)}</td><td>${pct(st.high.rate)} (${oneIn(st.high.rate)})</td></tr>
      <tr><td><span class="score watch">Watch</span></td><td>${pct(T.watch)}–${pct(T.high)}</td><td>${pct(st.watch.share, 0)}</td><td>${pct(st.watch.caught, 0)}</td><td>${pct(st.watch.rate)} (${oneIn(st.watch.rate)})</td></tr>
      <tr><td><span class="score low lowb">Low</span></td><td>&lt; ${pct(T.watch)}</td><td>${pct(st.low.share, 0)}</td><td>${pct(st.low.caught, 0)}</td><td>${pct(st.low.rate)} (${oneIn(st.low.rate)})</td></tr>`;
  };
  return `<div class="tablewrap"><table class="stats"><thead><tr><th></th><th>Tier</th><th>Risk score</th><th>Share of samples</th>
    <th>Pre-infection samples in tier</th><th>Followed by BSI ≤ 14 d</th></tr></thead><tbody>${orgs.map(row).join('')}</tbody></table></div>`;
}
function about() {
  const h = Math.round(S.W.tiers.ecoli.sens.high * 100), w = Math.round(S.W.tiers.ecoli.sens.watch * 100);
  $('aboutTiers').innerHTML = `<p class="fine" style="margin-top:0">Tiers use the default cut-offs: <b>High</b> starts at the risk that catches ${h}% of stool samples
    taken in the 14 days before an infection, <b>Watch</b> at the one that catches ${w}%. Same definition and numbers as BSI Timeline.</p>` + tierTable(ORGS);
  const b = burden(S.day);
  $('aboutBurden').innerHTML = `On this simulated unit, this rule asked for about <b>${b.mean.toFixed(1)}</b> reviews a day (range ${b.min}–${b.max}),
    over days ${S.W.span[0]}–${S.day} so far, assuming every patient is reviewed the day they appear under Needs review.
    This depends on this unit's patients and how often their stool was sampled.`;
  $('resetNote').textContent = S.mem ? 'Browser storage is unavailable: reviews last for this visit only.' : '';
}
function facts(focus) {
  const C = S.W.cohort, orgs = focus ? [focus] : ORGS;
  const calib = (o) => {
    const c = S.W.calib[o], W = 240, Hh = 200, L = 40, B = 30, T = 8, Rr = 8, lo = Math.log10(0.001), hi = Math.log10(0.4);
    const sx = (v) => L + (Math.log10(Math.max(0.001, v)) - lo) / (hi - lo) * (W - L - Rr), sy = (v) => T + (1 - (Math.log10(Math.max(0.001, v)) - lo) / (hi - lo)) * (Hh - T - B);
    let s = `<svg viewBox="0 0 ${W} ${Hh}" class="calsvg" role="img" aria-label="Reliability plot, ${NAME[o]}">`;
    for (const v of [0.001, 0.01, 0.1]) s += `<line x1="${sx(v)}" x2="${sx(v)}" y1="${T}" y2="${Hh - B}" class="hgrid"/><line x1="${L}" x2="${W - Rr}" y1="${sy(v)}" y2="${sy(v)}" class="hgrid"/>
      <text x="${sx(v)}" y="${Hh - B + 13}" text-anchor="middle" class="htick">${v * 100}%</text><text x="${L - 4}" y="${sy(v) + 3}" text-anchor="end" class="htick">${v * 100}%</text>`;
    s += `<line x1="${sx(0.001)}" y1="${sy(0.001)}" x2="${sx(0.4)}" y2="${sy(0.4)}" class="cal-diag"/>`;
    s += `<path d="${c.bins.map((b, i) => `${i ? 'L' : 'M'}${sx(b.pred)},${sy(b.obs)}`).join('')}" class="cal-line"/>`;
    s += c.bins.map(b => b.zero
      ? `<circle cx="${sx(b.pred)}" cy="${sy(0.001)}" r="3.6" class="cal-pt zero"><title>predicted ${pct(b.pred)}, no BSIs observed (n = ${fmtN(b.n)})</title></circle><text x="${sx(b.pred)}" y="${sy(0.001) - 6}" text-anchor="middle" class="htick">0</text>`
      : `<circle cx="${sx(b.pred)}" cy="${sy(b.obs)}" r="3.4" class="cal-pt"><title>predicted ${pct(b.pred)}, observed ${pct(b.obs)} (n = ${fmtN(b.n)})</title></circle>`).join('');
    s += `<text x="${(L + W - Rr) / 2}" y="${Hh - 2}" text-anchor="middle" class="hl2">model's estimate</text>
      <text x="10" y="${(T + Hh - B) / 2}" text-anchor="middle" class="hl2" transform="rotate(-90 10 ${(T + Hh - B) / 2})">observed rate</text></svg>`;
    return `<figure class="cal"><figcaption>${NI[o]}</figcaption>${s}<div class="fine">10 bins of about ${fmtN(Math.round(c.total / 10))} samples (total ${fmtN(c.binned)} of ${fmtN(c.total)} scored)</div></figure>`;
  };
  const notHigh = (o) => `${pct(1 - S.W.tiers[o].stats.high.rate, 0)} of ${NI[o]} High samples were not followed by an ${NI[o]} BSI within 14 days`;
  $('factsBody').innerHTML = `
    <dl class="mf">
      <dt>Name</dt><dd>BSI Watch risk scores (${NI.ecoli} and ${NI.entero}) · build ${BUILD}</dd>
      <dt>Intended use</dt><dd>Research demonstration only. Not for clinical use and not for time-critical decisions.</dd>
      <dt>Population</dt><dd>MSK allogeneic HCT patients, retrospective: ${fmtN(C.patients)} patients, ${fmtN(C.samples)} stool samples
        (${fmtN(S.W.tiers.ecoli.n)} scored for ${NI.ecoli}, ${fmtN(S.W.tiers.entero.n)} for ${NI.entero}). This unit shows ${S.W.patients.length} of them, time-shifted onto one simulated unit.</dd>
      <dt>Outcome</dt><dd>Bloodstream infection (BSI) with the organism within 14 days after a stool sample. Samples on or after a patient's first BSI with an organism are not scored for that organism.</dd>
      <dt>Inputs</dt><dd>Only what was known on the day of the sample: stool microbiome composition and its recent trend; antibiotic exposure by class;
        neutrophil count (ANC) level and trend; day relative to transplant; for ${NI.entero}, also commensal-bacteria indices and an antibiotic → anaerobe-loss pattern.
        <b>Temperature is shown for context; it is not a model input.</b></dd>
      <dt>Method</dt><dd>Gradient-boosted survival models (XGBoost, Cox), 61 (${NI.ecoli}) and 640 (${NI.entero}) inputs. Every score shown comes from a model that never saw that patient
        (patient-grouped cross-validation, averaged over 5 repeats).</dd>
      <dt>Performance</dt><dd>Pooled out-of-fold AUC for BSI within 14 days: ${NI.ecoli} <b>${AUC.ecoli.model}</b> (pathogen abundance alone ${AUC.ecoli.abundance});
        ${NI.entero} <b>${AUC.entero.model}</b> (abundance alone ${AUC.entero.abundance}). Baseline rate of BSI within 14 days per stool sample:
        ${pct(S.W.tiers.ecoli.base)} (${NI.ecoli}), ${pct(S.W.tiers.entero.base)} (${NI.entero}).</dd>
    </dl>
    <h3>Tiers (default cut-offs)</h3>${tierTable(orgs)}
    <h3>Calibration</h3><div class="cals">${orgs.map(calib).join('')}</div>
    <p class="fine">Mean model estimate vs observed rate of BSI within 14 days, by tenths of the score; the diagonal is perfect agreement.
      Open circles: no BSIs observed in that bin (drawn at the axis floor). Out-of-fold, retrospective, single cohort.</p>
    <h3>Warnings</h3>
    <ul class="warn">
      <li>The model design was found by an agent-assisted search on this same cohort.</li>
      <li>Tier cut-offs were chosen on the same cohort (in-sample).</li>
      <li>No external or prospective validation.</li>
      <li>"What raised the model's score" describes the model, not causes.</li>
      <li>BSI is uncommon, so most High samples are not followed by BSI: ${notHigh('ecoli')}; ${notHigh('entero')}.</li>
    </ul>`;
}
init().catch(e => { document.querySelector('main').innerHTML = `<p style="padding:24px">Could not load data (${e.message}). Serve this folder over http.</p>`; });
