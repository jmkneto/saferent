// rentCheck: compares a rental ad with the official RTB average rent and common scam warning signs.
// Rents and fraud figures come live from the CSO (Central Statistics Office) open data API.
// The 3D map uses OpenStreetMap: Photon to find the address, OpenFreeMap for the map, MapLibre to draw it.
// All visible text is in translations.js.

const CSO_REST = "https://ws.cso.ie/public/api.restful/PxStat.Data.Cube_API.ReadDataset";
const CSO_RPC = "https://ws.cso.ie/public/api.jsonrpc";
const GEOCODER = "https://photon.komoot.io/api/";
const IRELAND_BOX = "-10.7,51.3,-5.9,55.5"; // west, south, east, north
const MAP_STYLE = "https://tiles.openfreemap.org/styles/liberty";
const RTB_REGISTER_URL = "https://rtb.ie/check-the-register/";
const PSRA_REGISTER_URL = "https://www.psr.ie";
const CONTACT_EMAIL = "hello@rentcheck.ie";
const RENTS_CACHE_KEY = "rentcheck-rents-v1";
const AREA_KEY = "rentcheck-fraud-area";
const LANG_KEY = "rentcheck-lang";
const ONE_DAY = 24 * 60 * 60 * 1000;

// Eircode = routing key (letter + 2 digits, or D6W) + 4 characters. B G I J L M O Q S U Z are never used.
const EIRCODE_RE = /^([ACDEFHKNPRTVWXY]\d{2}|D6W)[0-9ACDEFHKNPRTVWXY]{4}$/;

// Routing keys that cover one city or Dublin district in the rent table.
const ROUTING_KEY_AREAS = { T12: "Cork City", T23: "Cork City", H91: "Galway City", V94: "Limerick City", X91: "Waterford City", D6W: "Dublin 6W" };
for (let n = 1; n <= 24; n++) ROUTING_KEY_AREAS[`D${String(n).padStart(2, "0")}`] = `Dublin ${n}`;

const COUNTIES = [
  "Carlow", "Cavan", "Clare", "Cork", "Donegal", "Dublin", "Galway", "Kerry", "Kildare", "Kilkenny", "Laois", "Leitrim", "Limerick",
  "Longford", "Louth", "Mayo", "Meath", "Monaghan", "Offaly", "Roscommon", "Sligo", "Tipperary", "Waterford", "Westmeath", "Wexford", "Wicklow",
];

// Points per warning sign. The names match the checkboxes in index.html, "key" is the text in translations.js.
const SIGNS = {
  deposit_before_viewing: { points: 30, key: "s_deposit" },
  no_viewing: { points: 30, key: "s_noview" },
  unusual_payment: { points: 20, key: "s_payment" },
  pressure: { points: 10, key: "s_pressure" },
  id_before_viewing: { points: 10, key: "s_id" },
  off_platform: { points: 10, key: "s_messages" },
  anonymous_profile: { points: 10, key: "s_profile" },
};

// How far below the average rent the asking price is, in %.
const PRICE_BANDS = [
  { below: 40, points: 40, key: "band40" },
  { below: 25, points: 25, key: "band25" },
  { below: 10, points: 10, key: "band10" },
];

const SIZE_KEYS = { room: "sizeRoom", "One bed": "size1", "Two bed": "size2", "Three bed": "size3", "Four plus bed": "size4" };

const $ = (id) => document.getElementById(id);
const form = $("check-form");
const resultEl = $("result");

let lang = "en";
let rents = null; // { quarter, rows: [{ location, bedrooms, rent, quarter }] }
let rentsLoaded = false;
let rentsReady = null;
let fraud = null; // { quarters: ["2026Q2", ...], areas: { Ireland: [n, ...], "Cork City": [...] }, updated }
let fraudState = "loading"; // loading, ok or error
let lastCheck = null; // kept so the result can be redrawn in another language

// Language

// Text for a key in the current language, with {name} filled in. Falls back to English.
function t(key, vars = {}) {
  const text = TRANSLATIONS[lang][key] ?? TRANSLATIONS.en[key] ?? key;
  return text.replace(/\{(\w+)\}/g, (match, name) => (name in vars ? vars[name] : match));
}

const locale = () => LANGUAGES.find((l) => l.code === lang).locale;
const formatNumber = (n) => new Intl.NumberFormat(locale()).format(n);

function quarterName(q) {
  const year = Number(q.slice(0, 4));
  const first = (Number(q.slice(-1)) - 1) * 3;
  const month = new Intl.DateTimeFormat(locale(), { month: "short" });
  return `${month.format(new Date(year, first, 1))}–${month.format(new Date(year, first + 2, 1))} ${year}`;
}

// Saved choice first, then the browser's own language, then English.
function pickLanguage() {
  const saved = readStore(LANG_KEY);
  if (TRANSLATIONS[saved]) return saved;
  for (const l of navigator.languages || [navigator.language || ""]) {
    const code = l.slice(0, 2).toLowerCase();
    if (TRANSLATIONS[code]) return code;
  }
  return "en";
}

function applyLanguage(code) {
  lang = TRANSLATIONS[code] ? code : "en";
  document.documentElement.lang = lang;
  document.title = `rentCheck · ${t("title")}`;
  document.querySelectorAll("[data-i18n]").forEach((el) => (el.textContent = t(el.dataset.i18n)));
  document.querySelectorAll("[data-i18n-html]").forEach((el) => (el.innerHTML = t(el.dataset.i18nHtml)));
  document.querySelectorAll("[data-i18n-ph]").forEach((el) => (el.placeholder = t(el.dataset.i18nPh)));
  $("lang-select").value = lang;

  updateProgress();
  updateSigns();
  paintFraud();
  paintDataNote();
  if (lastCheck && !resultEl.hidden) {
    render(lastCheck, false);
    showMap(lastCheck.eircode, lastCheck.address, lastCheck.area);
  }
}

LANGUAGES.forEach((l) => $("lang-select").add(new Option(l.name, l.code)));
$("lang-select").addEventListener("change", (e) => {
  writeStore(LANG_KEY, e.target.value);
  applyLanguage(e.target.value);
});

// Scoring

function scoreListing(priceDiff, ticked) {
  const reasons = [];
  if (priceDiff !== null) {
    const band = PRICE_BANDS.find((b) => -priceDiff >= b.below);
    if (band) reasons.push(band);
  }
  ticked.forEach((name) => reasons.push(SIGNS[name]));
  reasons.sort((a, b) => b.points - a.points);
  const score = Math.min(100, reasons.reduce((sum, r) => sum + r.points, 0));
  const level = score >= 50 ? "High" : score >= 25 ? "Medium" : "Low";
  return { score, level, reasons };
}

// Field feedback: green when filled in correctly, red once touched and wrong

const rules = {
  address: (v) => v.trim().length >= 5 && /[a-z]/i.test(v),
  eircode: (v) => isEircode(v),
  price: (v) => /^\d+$/.test(v) && +v >= 50 && +v <= 10000,
  consent: (_, el) => el.checked,
  email: (v) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.trim()),
  message: (v) => v.trim().length >= 5,
};

const compact = (s) => s.toUpperCase().replace(/\s+/g, "");
const isEircode = (s) => EIRCODE_RE.test(compact(s));
const formatEircode = (s) => `${compact(s).slice(0, 3)} ${compact(s).slice(3)}`;
const inputOf = (wrap) => wrap.querySelector("input:not([type=radio]), textarea");
const required = [...document.querySelectorAll('[data-form="check"]')];

function check(wrap, touched) {
  const el = inputOf(wrap);
  const ok = rules[wrap.dataset.rule](el.value, el);
  if (touched) wrap.dataset.touched = "1";
  const bad = !ok && Boolean(wrap.dataset.touched);
  wrap.classList.toggle("is-valid", ok);
  wrap.classList.toggle("is-invalid", bad);
  el.setAttribute("aria-invalid", String(bad));
  return ok;
}

function validateAll(wraps) {
  const bad = wraps.filter((w) => !check(w, true));
  bad.forEach((w) => replay(w, "shake"));
  if (bad.length) inputOf(bad[0]).focus();
  return bad.length === 0;
}

function updateProgress() {
  const done = required.filter((w) => w.classList.contains("is-valid"));
  const all = done.length === required.length;
  required.forEach((w) => {
    const item = document.querySelector(`.checklist [data-for="${w.dataset.rule}"]`);
    if (item) item.classList.toggle("done", w.classList.contains("is-valid"));
  });
  $("progress-bar").style.width = `${(done.length / required.length) * 100}%`;
  $("progress-bar").parentElement.classList.toggle("done", all);
  $("progress-label").textContent = all ? t("ready") : t("progress", { done: done.length, total: required.length });
  $("progress-label").classList.toggle("done", all);
  $("submit").classList.toggle("ready", all);
}

document.querySelectorAll("[data-rule]").forEach((wrap) => {
  const el = inputOf(wrap);
  const isBox = el.type === "checkbox";
  el.addEventListener(isBox ? "change" : "input", () => {
    if (wrap.dataset.rule === "eircode") el.value = el.value.toUpperCase();
    if (wrap.dataset.rule === "price") el.value = el.value.replace(/\D/g, "");
    check(wrap, isBox);
    if (wrap.dataset.form === "check") updateProgress();
  });
  el.addEventListener("blur", () => {
    if (wrap.dataset.rule === "eircode" && isEircode(el.value)) el.value = formatEircode(el.value);
    if (el.value.trim() !== "" || wrap.dataset.touched) {
      check(wrap, true);
      if (wrap.dataset.form === "check") updateProgress();
    }
  });
});

// Warning signs

const signs = [...document.querySelectorAll(".sign")];

function updateSigns() {
  const picked = signs.map((s) => s.querySelector("input")).filter((i) => i.checked);
  const points = picked.reduce((sum, i) => sum + (SIGNS[i.name] ? SIGNS[i.name].points : 0), 0);
  const note = $("tag-note");
  note.textContent = picked.length ? t("signsTicked", { n: picked.length, points }) : t("noSigns");
  note.classList.toggle("warn", picked.length > 0);
}

signs.forEach((s) =>
  s.querySelector("input").addEventListener("change", () => {
    replay(s, "pop");
    updateSigns();
  })
);

// Rents: latest RTB average for every area in Ireland (CSO table RIQ02).
// Only the last ten quarters and "All property types" are requested, about 140 KB instead of 8 MB.

async function loadRents() {
  const cached = readStore(RENTS_CACHE_KEY);
  if (cached && Date.now() - cached.at < ONE_DAY) return cached.data;
  try {
    const res = await fetch(`${CSO_RPC}?data=${encodeURIComponent(JSON.stringify(rentQuery()))}`);
    const body = await res.json();
    const data = parseRents(body.result);
    if (data.rows.length) {
      writeStore(RENTS_CACHE_KEY, { at: Date.now(), data });
      return data;
    }
  } catch {
    // CSO unreachable: the price check is skipped and the result says so
  }
  return null;
}

function recentQuarterCodes(count) {
  let year = new Date().getFullYear();
  let q = Math.floor(new Date().getMonth() / 3) + 1;
  const codes = [];
  for (let i = 0; i < count; i++) {
    codes.push(`${year}${q}`); // the CSO writes 2025 Q4 as "20254"
    if (--q === 0) {
      q = 4;
      year--;
    }
  }
  return codes;
}

function rentQuery() {
  return {
    jsonrpc: "2.0",
    method: "PxStat.Data.Cube_API.ReadDataset",
    params: {
      class: "query",
      id: ["TLIST(Q1)", "C02969V03591"], // quarter, property type
      dimension: {
        "TLIST(Q1)": { category: { index: recentQuarterCodes(10) } },
        C02969V03591: { category: { index: ["-"] } }, // "-" = All property types
      },
      extension: { pivot: null, codes: false, language: { code: "en" }, format: { type: "JSON-stat", version: "2.0" }, matrix: "RIQ02" },
      version: "2.0",
    },
  };
}

// Category labels of one JSON-stat dimension, in order.
function labelsOf(ds, id) {
  const c = ds.dimension[id].category;
  const codes = Array.isArray(c.index) ? c.index : Object.keys(c.index).sort((a, b) => c.index[a] - c.index[b]);
  return codes.map((k) => c.label[k]);
}

// One row per location + bedrooms, keeping the latest quarter that has a value.
function parseRents(ds) {
  const names = ds.id.map((id) => ds.dimension[id].label);
  const dims = ds.id.map((id) => labelsOf(ds, id));
  const at = (re) => names.findIndex((n) => re.test(n));
  const kQ = at(/quarter/i);
  const kB = at(/bedroom/i);
  const kL = at(/location/i);
  const coord = new Array(dims.length).fill(0);
  const latest = new Map();

  ds.value.forEach((v, i) => {
    if (v === null || v === undefined) return;
    let rem = i;
    for (let k = dims.length - 1; k >= 0; k--) {
      coord[k] = rem % ds.size[k];
      rem = Math.floor(rem / ds.size[k]);
    }
    const row = { location: dims[kL][coord[kL]], bedrooms: dims[kB][coord[kB]], quarter: dims[kQ][coord[kQ]], rent: Number(v) };
    const key = `${row.location}|${row.bedrooms}`;
    const prev = latest.get(key);
    if (!prev || row.quarter > prev.quarter) latest.set(key, row);
  });

  const rows = [...latest.values()];
  const quarter = rows.reduce((q, r) => (r.quarter > q ? r.quarter : q), "");
  return { quarter, rows };
}

function paintDataNote() {
  if (!rentsLoaded) return;
  $("data-note").textContent = rents ? t("dataNote", { quarter: quarterName(rents.quarter) }) : t("dataNoteFail");
}

// Whole words only, so "Dublin 1" doesn't match inside "Dublin 15".
const words = (s) => ` ${String(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;
const longest = (list) => [...list].sort((a, b) => b.length - a.length)[0];

// Labels look like "Ballincollig, Cork" (town), "Galway City" / "Carlow Town" (city, county town) or "Kerry" (county).
function detectArea(address, eircode) {
  const labels = [...new Set(rents.rows.map((r) => r.location))];
  const addr = words(address);
  const named = (name) => addr.includes(words(name));

  // The county written last usually belongs to the property ("Dublin Road, Navan, Co. Meath").
  const county = COUNTIES.filter(named).sort((a, b) => addr.lastIndexOf(words(b)) - addr.lastIndexOf(words(a)))[0] || null;

  // 1. A town named in the address. If a county is named too, only towns in that county.
  const towns = labels.filter((l) => {
    const [town, inCounty] = l.split(",").map((s) => s.trim());
    return inCounty && named(town) && (!county || inCounty.startsWith(county)); // "Citywest, Dublin 24" is in Dublin
  });
  if (towns.length) return { location: longest(towns), how: "howTown" };

  // 2. A city or Dublin district from the Eircode.
  const fromKey = ROUTING_KEY_AREAS[compact(eircode).slice(0, 3)];
  if (fromKey && labels.includes(fromKey)) return { location: fromKey, how: "howEircode" };

  // 3. A city, county town or Dublin district named in the address.
  const places = labels.filter((l) => !l.includes(",") && !COUNTIES.includes(l) && named(l));
  if (places.length) return { location: longest(places), how: "howAddress" };

  // 4. The county average as a last resort.
  if (county && labels.includes(county)) return { location: county, how: "howCounty" };
  return null;
}

// Check this ad

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!validateAll(required)) {
    updateProgress();
    toast(t("fixFields"));
    return;
  }

  const btn = $("submit");
  btn.disabled = true;
  resultEl.hidden = true;

  const address = form.address.value.trim();
  const eircode = formatEircode(form.eircode.value);
  const price = Number(form.rent.value);
  const monthly = form.period.value === "week" ? (price * 52) / 12 : price;
  const bedrooms = form.bedrooms.value;
  const agency = form.q_agency.checked;
  const ticked = Object.keys(SIGNS).filter((name) => form[name].checked);
  const notes = [];

  if (!rentsLoaded) {
    $("status").textContent = t("loadingRents");
    await rentsReady;
  }

  let area = null;
  let avg = null;
  if (bedrooms === "room") notes.push("noteRoom");
  else if (!rents) notes.push("noteNoRents");
  else {
    area = detectArea(address, eircode);
    avg = area ? rents.rows.find((r) => r.location === area.location && r.bedrooms === bedrooms) : null;
    if (!avg) notes.push("noteNoMatch");
  }
  if (agency) notes.push("noteAgency");

  const diff = avg ? ((monthly - avg.rent) / avg.rent) * 100 : null;
  const { score, level, reasons } = scoreListing(diff, ticked);

  lastCheck = { level, score, reasons, area, avg, diff, monthly, bedrooms, notes, eircode, address, agency };
  render(lastCheck, true);
  $("status").textContent = "";
  btn.disabled = false;
  showMap(eircode, address, area);
});

// fresh = a new check (scroll to it, animate the score); otherwise just redraw in another language.
function render(c, fresh) {
  const steps = [t("step_pay"), t("step_rtb", { eircode: c.eircode })];
  if (c.level !== "Low") steps.push(t("step_view"));

  const found = [];
  if (c.avg) {
    const pct = Math.abs(Math.round(c.diff));
    found.push(
      escapeHtml(
        t("priceLine", {
          price: formatNumber(Math.round(c.monthly)),
          avg: formatNumber(Math.round(c.avg.rent)),
          size: t(SIZE_KEYS[c.bedrooms]),
          area: c.area.location,
          quarter: quarterName(c.avg.quarter),
          diff: t(c.diff < 0 ? "diffBelow" : "diffAbove", { pct }),
          how: t(c.area.how),
        })
      )
    );
  }
  c.reasons.forEach((r) => found.push(`${escapeHtml(t(r.key))} <span class="pts-inline">+${r.points}</span>`));

  resultEl.innerHTML = `
    <div class="result-top">
      <div class="badge badge-${c.level.toLowerCase()}">${escapeHtml(t(`risk${c.level}`))}</div>
      <div class="score"><b id="score-num">${fresh ? 0 : c.score}</b><span>/100</span></div>
    </div>
    <div class="meter meter-${c.level.toLowerCase()}"><span id="score-bar"></span></div>
    <p class="explanation">${escapeHtml(t(`sum${c.level}`))}</p>
    <h4>${escapeHtml(t("found"))}</h4>
    ${found.length ? `<ul>${found.map((f) => `<li>${f}</li>`).join("")}</ul>` : `<p>${escapeHtml(t("noneFound"))}</p>`}
    ${c.notes.map((n) => `<p class="warning">${escapeHtml(t(n))}</p>`).join("")}
    <h4>${escapeHtml(t("where"))}</h4>
    <div class="map" id="map"></div>
    <p class="map-note" id="map-note">${escapeHtml(t("mapFinding"))}</p>
    <h4>${escapeHtml(t("next"))}</h4>
    <ul>${steps.map((s) => `<li>${escapeHtml(s)}</li>`).join("")}</ul>
    <div class="actions">
      <a class="btn" href="${RTB_REGISTER_URL}" target="_blank" rel="noopener">${escapeHtml(t("checkRtb", { eircode: c.eircode }))}</a>
      <button type="button" class="btn secondary" id="copy-eircode">${escapeHtml(t("copyEircode"))}</button>
      ${c.agency ? `<a class="btn secondary" href="${PSRA_REGISTER_URL}" target="_blank" rel="noopener">${escapeHtml(t("openPsra"))}</a>` : ""}
    </div>
    <p class="small">${escapeHtml(t("disclaimer"))}</p>`;
  resultEl.hidden = false;

  const bar = $("score-bar");
  if (fresh) {
    resultEl.scrollIntoView({ behavior: "smooth", block: "start" });
    countUp($("score-num"), c.score, 1100);
    void bar.offsetWidth; // read the width once so the bar animates from 0 instead of jumping
  } else {
    bar.style.transition = "none";
  }
  bar.style.width = `${c.score}%`;

  const copyBtn = $("copy-eircode");
  copyBtn.addEventListener("click", () => {
    navigator.clipboard.writeText(c.eircode).then(
      () => (copyBtn.textContent = t("copied")),
      () => toast(t("copyFailed", { eircode: c.eircode }))
    );
  });
}

// 3D map of the area around the property

let map = null;
let spin = 0;
const placeCache = new Map();

async function searchPlace(q) {
  const res = await fetch(`${GEOCODER}?q=${encodeURIComponent(q)}&limit=1&bbox=${IRELAND_BOX}`);
  const hit = (await res.json()).features[0];
  return hit && hit.properties.countrycode === "IE" ? hit : null;
}

// OpenStreetMap only knows some Eircodes, so try the Eircode, then the address, then the area we compared with.
async function locate(eircode, address, area) {
  const byCode = await searchPlace(eircode);
  if (byCode && byCode.properties.osm_value === "postcode" && compact(byCode.properties.name || "") === compact(eircode)) {
    return { coords: byCode.geometry.coordinates, zoom: 17, note: "mapFound", vars: { eircode } };
  }
  const byAddress = await searchPlace(`${address}, Ireland`);
  if (byAddress) {
    const exact = ["house", "street"].includes(byAddress.properties.type);
    return { coords: byAddress.geometry.coordinates, zoom: exact ? 16.5 : 15, note: "mapAddress", vars: { eircode } };
  }
  if (area) {
    const byArea = await searchPlace(`${area.location}, Ireland`);
    if (byArea) return { coords: byArea.geometry.coordinates, zoom: 14.5, note: "mapArea", vars: { area: area.location } };
  }
  return null;
}

async function showMap(eircode, address, area) {
  const box = $("map");
  const note = $("map-note");
  cancelAnimationFrame(spin);
  if (map) {
    map.remove();
    map = null;
  }
  const fail = (key) => {
    box.remove();
    note.textContent = t(key);
  };
  if (!window.maplibregl) return fail("mapNoLib");

  const cacheKey = `${eircode}|${address}`;
  let place = placeCache.get(cacheKey);
  if (place === undefined) {
    try {
      place = await locate(eircode, address, area);
      placeCache.set(cacheKey, place);
    } catch {
      return fail("mapNoAnswer");
    }
  }
  if (!box.isConnected) return; // a newer check or language change has replaced this result
  if (!place) return fail("mapNotFound");

  try {
    map = new maplibregl.Map({
      container: box,
      style: MAP_STYLE,
      center: place.coords,
      zoom: place.zoom,
      pitch: 60,
      bearing: -20,
      attributionControl: { compact: true },
    });
  } catch {
    return fail("mapNoGL");
  }
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");
  new maplibregl.Marker({ color: "#2d4f86" }).setLngLat(place.coords).addTo(map);
  note.textContent = t(place.note, place.vars);

  // Slowly circle the spot until the user grabs the map.
  const stop = () => cancelAnimationFrame(spin);
  ["mousedown", "touchstart", "wheel"].forEach((ev) => map.getCanvasContainer().addEventListener(ev, stop, { once: true }));
  if (!matchMedia("(prefers-reduced-motion: reduce)").matches) {
    const turning = map;
    map.once("load", () => {
      const turn = () => {
        turning.setBearing(turning.getBearing() + 0.08);
        spin = requestAnimationFrame(turn);
      };
      spin = requestAnimationFrame(turn);
    });
  }
}

// Live fraud figures: reports to Gardaí per Garda division (CSO table CJQ11)

function parseFraud(ds) {
  const kQ = ds.id.findIndex((id) => /^TLIST/.test(id));
  const kA = ds.id.findIndex((id, k) => k !== kQ && id !== "STATISTIC");
  const quarters = labelsOf(ds, ds.id[kQ]);
  const stride = ds.size.map((_, k) => ds.size.slice(k + 1).reduce((p, s) => p * s, 1));
  const areas = {};
  labelsOf(ds, ds.id[kA]).forEach((label, a) => {
    const name = label === "State" ? "Ireland" : label.replace(/ Garda Division$/, "");
    areas[name] = quarters.map((_, q) => ds.value[q * stride[kQ] + a * stride[kA]]);
  });
  return { quarters, areas, updated: ds.updated };
}

async function loadFraud() {
  const select = $("fraud-area");
  try {
    const res = await fetch(`${CSO_REST}/CJQ11/JSON-stat/2.0/en`);
    if (!res.ok) throw new Error(res.status);
    fraud = parseFraud(await res.json());
  } catch {
    fraudState = "error";
    paintFraud();
    return;
  }

  select.innerHTML = "";
  select.add(new Option("", "Ireland"));
  Object.keys(fraud.areas)
    .filter((n) => n !== "Ireland")
    .sort()
    .forEach((n) => select.add(new Option(n, n)));
  const saved = readStore(AREA_KEY);
  select.value = saved && fraud.areas[saved] ? saved : "Ireland";
  select.disabled = false;
  fraudState = "ok";
  paintFraud(true);
}

function paintFraud(animate = false) {
  const select = $("fraud-area");
  $("live-badge").classList.toggle("off", fraudState === "error");
  $("live-text").textContent = t(fraudState === "error" ? "offline" : "live");
  select.options[0].text = t(fraudState === "ok" ? "allIreland" : "ireland");
  if (fraudState === "ok") return showFraud(select.value, animate);
  $("fraud-cap").textContent = t("fraudCapShort");
  $("fraud-trend").textContent = t(fraudState === "error" ? "fraudError" : "loadingFigures");
}

function showFraud(name, animate) {
  const series = fraud.areas[name];
  let last = series.length - 1;
  while (last >= 0 && series[last] == null) last--;
  if (last < 0) return;

  if (animate) countUp($("fraud-num"), series[last], 1200);
  else $("fraud-num").textContent = formatNumber(series[last]);
  const place = name === "Ireland" ? t("ireland") : name.startsWith("D.M.R.") ? `Dublin (${name.replace("D.M.R. ", "")})` : name;
  $("fraud-cap").textContent = t("fraudCap", { place, quarter: quarterName(fraud.quarters[last]) });

  const parts = [];
  const yearAgo = series[last - 4];
  if (yearAgo) {
    const pct = Math.round(((series[last] - yearAgo) / yearAgo) * 100);
    const shown = `<b class="${pct > 0 ? "up" : "down"}">${pct > 0 ? "+" : ""}${pct}%</b>`;
    parts.push(pct === 0 ? escapeHtml(t("sameYear")) : escapeHtml(t("trend", { pct: "{pct}" })).replace("{pct}", shown));
  }
  if (fraud.updated) {
    const date = new Date(fraud.updated).toLocaleDateString(locale(), { day: "numeric", month: "short", year: "numeric" });
    parts.push(escapeHtml(t("csoUpdated", { date })));
  }
  $("fraud-trend").innerHTML = parts.join(" · ");
  drawSpark($("fraud-spark"), series.slice(Math.max(0, last - 7), last + 1));
}

function drawSpark(el, values) {
  const nums = values.filter((v) => v != null);
  if (nums.length < 2) return (el.innerHTML = "");
  const w = el.clientWidth || 300;
  const h = el.clientHeight || 58;
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const pad = 6;
  const pts = nums.map((v, i) => [(i / (nums.length - 1)) * (w - pad * 2) + pad, h - pad - ((v - min) / (max - min || 1)) * (h - pad * 2)]);
  const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const area = `${line} L${pts[pts.length - 1][0].toFixed(1)},${h} L${pts[0][0].toFixed(1)},${h} Z`;
  const [lx, ly] = pts[pts.length - 1];
  el.innerHTML = `
    <svg viewBox="0 0 ${w} ${h}" role="img">
      <defs><linearGradient id="spark-fill" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#8fb0ff" stop-opacity=".35"/><stop offset="1" stop-color="#8fb0ff" stop-opacity="0"/>
      </linearGradient></defs>
      <path d="${area}" fill="url(#spark-fill)"/>
      <path class="line" d="${line}" pathLength="600" fill="none" stroke="#8fb0ff" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
      <circle cx="${lx}" cy="${ly}" r="4" fill="#fff" stroke="#8fb0ff" stroke-width="2"/>
    </svg>`;
}

$("fraud-area").addEventListener("change", (e) => {
  writeStore(AREA_KEY, e.target.value);
  showFraud(e.target.value, true);
});

let resizeTimer;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => fraudState === "ok" && showFraud($("fraud-area").value, false), 200);
});

// Ask a friend, contact

$("share-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const box = $("share-text");
  const text = box.value.trim();
  if (!text) {
    replay(box, "shake");
    box.focus();
    return toast(t("shareEmpty"));
  }
  const body = `${t("shareBody")}\n\n${text}`;
  if (navigator.share) {
    try {
      await navigator.share({ title: t("shareSubject"), text: body });
    } catch {
      // share sheet closed
    }
    return;
  }
  location.href = `mailto:?subject=${encodeURIComponent(t("shareSubject"))}&body=${encodeURIComponent(body)}`;
});

$("contact-form").addEventListener("submit", (e) => {
  e.preventDefault();
  if (!validateAll([...e.target.querySelectorAll("[data-rule]")])) return;
  const from = $("contact-email").value.trim();
  const msg = $("contact-msg").value.trim();
  location.href = `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent("rentCheck")}&body=${encodeURIComponent(`${msg}\n\n${from}`)}`;
  toast(t("openingEmail"));
});

// Small helpers

function countUp(el, to, ms) {
  const start = performance.now();
  const step = (now) => {
    const p = Math.min(1, (now - start) / ms);
    el.textContent = formatNumber(Math.round(to * (1 - Math.pow(1 - p, 3))));
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// Restart a CSS animation class on an element.
function replay(el, cls) {
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
}

let toastTimer;
function toast(text) {
  const box = $("toast");
  box.textContent = text;
  box.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => box.classList.remove("show"), 2600);
}

function readStore(key) {
  try {
    return JSON.parse(localStorage.getItem(key));
  } catch {
    return null;
  }
}

function writeStore(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage blocked or full: nothing is remembered, everything still works
  }
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// Page motion

document.addEventListener("pointerdown", (e) => {
  const btn = e.target.closest(".btn");
  if (!btn) return;
  const r = btn.getBoundingClientRect();
  const size = Math.max(r.width, r.height) / 2;
  const dot = document.createElement("span");
  dot.className = "ripple";
  dot.style.cssText = `width:${size}px;height:${size}px;left:${e.clientX - r.left - size / 2}px;top:${e.clientY - r.top - size / 2}px`;
  btn.appendChild(dot);
  dot.addEventListener("animationend", () => dot.remove());
});

const head = document.querySelector(".site-head");
const onScroll = () => head.classList.toggle("scrolled", window.scrollY > 8);
window.addEventListener("scroll", onScroll, { passive: true });

if ("IntersectionObserver" in window) {
  const seen = new IntersectionObserver(
    (entries) =>
      entries.forEach((en) => {
        if (!en.isIntersecting) return;
        en.target.classList.add("in");
        seen.unobserve(en.target);
      }),
    { threshold: 0.1 }
  );
  document.querySelectorAll(".reveal").forEach((el, i) => {
    el.style.transitionDelay = `${(i % 3) * 80}ms`;
    seen.observe(el);
  });

  const links = [...document.querySelectorAll(".nav a")];
  const spy = new IntersectionObserver(
    (entries) =>
      entries.forEach((en) => {
        if (!en.isIntersecting) return;
        links.forEach((a) => a.classList.toggle("is-active", a.getAttribute("href") === `#${en.target.id}`));
      }),
    { rootMargin: "-40% 0px -55% 0px" }
  );
  links.forEach((a) => {
    const target = document.querySelector(a.getAttribute("href"));
    if (target) spy.observe(target);
  });
} else {
  document.documentElement.classList.add("no-observer");
}

// Start

applyLanguage(pickLanguage());
onScroll();
loadFraud();
rentsReady = loadRents().then((data) => {
  rents = data;
  rentsLoaded = true;
  paintDataNote();
});
