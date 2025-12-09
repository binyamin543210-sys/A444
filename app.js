// BNAPP V3.5 – לוגיקה ראשית
// קובץ זה מניח טעינה של:
// - hebcal.min.js ליום עברי וחגים
// - Chart.js לסטטיסטיקות
// - firebase-config.js שמייצא firebaseApp, db

import {
  ref,
  onValue,
  set,
  push,
  update,
  remove
} from "https://www.gstatic.com/firebasejs/9.22.2/firebase-database.js";

import { db } from "./firebase-config.js";

// --- STATE ---
const state = {
  currentUser: "binyamin",
  currentDate: new Date(),
  settings: {
    city: null,
    cityLat: null,
    cityLon: null,
    cityTz: null
  },
  cache: {
    events: {},
    tasks: {},
    shopping: {},
    holidays: {},
    holidaysLoadedYear: null,
    shabbat: {}
  },
  ui: {
    darkMode: false,
    notificationsGranted: false
  }
};

const el = (id) => document.getElementById(id);
const qs = (sel, root = document) => root.querySelector(sel);
const qsa = (sel, root = document) => Array.from(root.querySelectorAll(sel));

// --- DATE HELPERS ---
function dateKeyFromDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function parseDateKey(key) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
}

// ✔️ תיקון סוגריים + פונקציות עברית תקינות לחלוטין
function formatHebrewDate(date) {
  try {
    const hd = new Hebcal.HDate(date);
    return hd.renderGematriya ? hd.renderGematriya() : hd.toString("h");
  } catch (e) {
    return "";
  }
}

function formatHebrewDayLetters(date) {
  try {
    const hd = new Hebcal.HDate(date);
    const str = hd.toString("h");
    const first = (str.split(" ")[0] || "").replace(/["׳״]/g, "");
    return first;
  } catch (e) {
    return "";
  }
}

function getHebrewMonthYearLabel(date) {
  try {
    const hd = new Hebcal.HDate(date);
    const parts = hd.toString("h").split(" ");
    if (parts.length >= 2) return parts.slice(1).join(" ");
    return hd.toString("h");
  } catch (e) {
    return "";
  }
}

function getCity() {
  return state.settings.city || "ירושלים";
}

// --- WEATHER: Open-Meteo ---
async function geocodeCity(name) {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(
    name
  )}&count=1&language=he&format=json`;

  const resp = await fetch(url);
  const data = await resp.json();

  if (!data.results || !data.results.length) throw new Error("עיר לא נמצאה");

  const r = data.results[0];
  state.settings.cityLat = r.latitude;
  state.settings.cityLon = r.longitude;
  state.settings.cityTz = r.timezone;

  try {
    const settingsRef = ref(db, "settings");
    update(settingsRef, {
      cityLat: r.latitude,
      cityLon: r.longitude,
      cityTz: r.timezone
    });
  } catch (e) {}
}

async function ensureCityCoords() {
  if (state.settings.cityLat && state.settings.cityLon && state.settings.cityTz) return;
  await geocodeCity(getCity());
}

// מפה של קוד → אימוג'י + תיאור
function mapOpenMeteoWeather(code) {
  if (code === 0) return { label: "שמים בהירים", emoji: "☀️" };
  if ([1, 2, 3].includes(code)) return { label: "מעונן חלקית", emoji: "🌤️" };
  if ([45, 48].includes(code)) return { label: "ערפל", emoji: "🌫️" };
  if ([51, 53, 55].includes(code)) return { label: "טיפטוף", emoji: "🌦️" };
  if ([61, 63, 65].includes(code)) return { label: "גשם", emoji: "🌧️" };
  if ([71, 73, 75, 77].includes(code)) return { label: "שלג", emoji: "❄️" };
  if ([80, 81, 82].includes(code)) return { label: "ממטרים", emoji: "🌧️" };
  if ([95, 96, 99].includes(code)) return { label: "סופות רעמים", emoji: "⛈️" };
  return { label: "מזג אוויר", emoji: "🌦️" };
}

// --- HOLIDAYS ---
function hebrewHolidayForDate(date) {
  try {
    const ev = Hebcal.holidays(date, { il: true });
    if (!ev || !ev.length) return null;
    const e = ev[0];
    return e.render ? e.render("he") : e.desc || null;
  } catch (e) {
    return null;
  }
}

function ensureYearHolidays(year) {
  if (state.cache.holidaysLoadedYear === year) return;

  state.cache.holidaysLoadedYear = year;

  const start = new Date(year, 0, 1);
  const end = new Date(year, 11, 31);

  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const k = dateKeyFromDate(d);
    const name = hebrewHolidayForDate(new Date(d));
    if (name) state.cache.holidays[k] = { name };
  }
}

// --- Shabbat ---
function isFriday(date) {
  return date.getDay() === 5;
}
function isShabbat(date) {
  return date.getDay() === 6;
}

async function ensureShabbatForWeek(friday) {
  const key = dateKeyFromDate(friday);

  if (state.cache.shabbat[key]) return state.cache.shabbat[key];
  if (!state.settings.cityLat || !state.settings.cityLon) return null;

  const y = friday.getFullYear();
  const m = String(friday.getMonth() + 1).padStart(2, "0");
  const d = String(friday.getDate()).padStart(2, "0");

  const url = `https://www.hebcal.com/shabbat?cfg=json&latitude=${state.settings.cityLat}&longitude=${state.settings.cityLon}&tzid=${encodeURIComponent(
    state.settings.cityTz || "Asia/Jerusalem"
  )}&start=${y}-${m}-${d}&end=${y}-${m}-${d}`;

  try {
    const resp = await fetch(url);
    const data = await resp.json();

    const candles = (data.items || []).find((i) => i.category === "candles");
    const havdalah = (data.items || []).find((i) => i.category === "havdalah");

    const val = {
      candle: candles ? new Date(candles.date) : null,
      havdalah: havdalah ? new Date(havdalah.date) : null
    };

    state.cache.shabbat[key] = val;
    return val;
  } catch (e) {
    console.error("Shabbat fetch failed", e);
    return null;
  }
}

function formatTimeHM(d) {
  if (!d) return "";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// --- GIHARI VOICE & HUMOR ---
let gihariVoice = null;

function loadVoices() {
  if (!("speechSynthesis" in window)) return;
  const voices = speechSynthesis.getVoices();
  gihariVoice =
    voices.find((v) => v.lang === "he-IL" && v.name.includes("Google")) ||
    voices.find((v) => v.lang === "he-IL") ||
    voices[0] ||
    null;
}
if ("speechSynthesis" in window) {
  window.speechSynthesis.onvoiceschanged = loadVoices;
}

function gihariSpeak(text) {
  if (!("speechSynthesis" in window)) return;
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "he-IL";
  u.rate = 1.05;
  if (gihariVoice) u.voice = gihariVoice;
  speechSynthesis.speak(u);
}

function wrapGihariHumor(html) {
  const clean = html.replace(/<[^>]+>/g, "");
  const jokes = [
    "יאללה גבר, סידרתי לך את זה. 😎",
    "עובד על זה כמו עבד יא מלך 🤣",
    "שנייה, מחדד את המוח… 🧠",
    "חכה חכה… אני יותר חכם ממך 😉"
  ];
  const line = jokes[Math.floor(Math.random() * jokes.length)];
  return line + "<br>" + html;
}

// --- CALENDAR RENDER ---
function isSameDay(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function renderCalendar() {
  const grid = el("calendarGrid");
  grid.innerHTML = "";

  const d0 = state.currentDate;
  const y = d0.getFullYear();
  const m = d0.getMonth();

  ensureYearHolidays(y);

  const first = new Date(y, m, 1);
  const days = new Date(y, m + 1, 0).getDate();

  el("gregMonthLabel").textContent = first.toLocaleDateString("he-IL", {
    month: "long",
    year: "numeric"
  });
  el("hebrewMonthLabel").textContent = getHebrewMonthYearLabel(first);

  const startDay = (first.getDay() + 1) % 7;
  const prevDays = new Date(y, m, 0).getDate();

  const today = new Date();

  for (let i = 0; i < 42; i++) {
    const cell = document.createElement("button");
    cell.className = "day-cell";

    let dayNum;
    let d;
    let outside = false;

    if (i < startDay) {
      dayNum = prevDays - startDay + i + 1;
      d = new Date(y, m - 1, dayNum);
      outside = true;
    } else if (i >= startDay + days) {
      dayNum = i - startDay - days + 1;
      d = new Date(y, m + 1, dayNum);
      outside = true;
    } else {
      dayNum = i - startDay + 1;
      d = new Date(y, m, dayNum);
    }

    const dk = dateKeyFromDate(d);

    // HEADER
    const head = document.createElement("div");
    head.className = "day-header";

    const dn = document.createElement("div");
    dn.className = "day-num";
    dn.textContent = dayNum;

    const dh = document.createElement("div");
    dh.className = "day-hebrew";
    dh.textContent = formatHebrewDayLetters(d);

    head.appendChild(dn);
    head.appendChild(dh);
    cell.appendChild(head);

    // HOLIDAY
    if (state.cache.holidays[dk]) {
      const h = document.createElement("div");
      h.className = "day-holiday";
      h.textContent = state.cache.holidays[dk].name;
      cell.appendChild(h);
    }

    // SHABBAT
    let shLabel = null;
    let fri = null;

    if (isFriday(d)) {
      shLabel = "🕯️ ערב שבת";
      fri = new Date(d);
    } else if (isShabbat(d)) {
      shLabel = "✨ שבת";
      fri = new Date(d);
      fri.setDate(fri.getDate() - 1);
    }

    if (shLabel && fri) {
      const wrap = document.createElement("div");
      wrap.className = "day-shabbat-block";

      const t1 = document.createElement("div");
      t1.className = "day-shabbat-title";
      t1.textContent = shLabel;

      const t2 = document.createElement("div");
      t2.className = "day-shabbat-time";
      t2.textContent = "טוען…";

      wrap.appendChild(t1);
      wrap.appendChild(t2);
      cell.appendChild(wrap);

      ensureShabbatForWeek(fri).then((info) => {
        if (!info) {
          t2.textContent = "";
          return;
        }
        if (isFriday(d) && info.candle) {
          t2.textContent = "כניסת שבת: " + formatTimeHM(info.candle);
        } else if (isShabbat(d) && info.havdalah) {
          t2.textContent = "צאת שבת: " + formatTimeHM(info.havdalah);
        } else {
          t2.textContent = "";
        }
      });
    }

    // EVENTS DOTS
    const events = state.cache.events[dk] || {};
    let count = 0;
    const row = document.createElement("div");
    row.className = "day-points";

    Object.values(events).forEach((ev) => {
      const dot = document.createElement("div");
      dot.className = "event-dot";
      if (ev.type === "task") dot.classList.add("task");
      if (ev.owner) dot.classList.add(`owner-${ev.owner}`);
      row.appendChild(dot);
      count++;
    });

    if (count > 0) cell.appendChild(row);
    if (count >= 2) cell.classList.add("day-border-glow");
    if (outside) cell.classList.add("outside");
    if (isSameDay(d, today)) cell.classList.add("day-cell-today");

    cell.addEventListener("click", () => openDayModal(d));

    grid.appendChild(cell);
  }
}

// --- TASKS ---
function renderTasks(filter = "undated") {
  const list = el("tasksList");
  list.innerHTML = "";

  const all = [];

  Object.entries(state.cache.events).forEach(([dk, items]) => {
    Object.entries(items).forEach(([id, ev]) => {
      if (ev.type === "task") all.push({ id, dateKey: dk, ...ev });
    });
  });

  all.sort((a, b) => {
    if (!a.dateKey && b.dateKey) return -1;
    if (a.dateKey && !b.dateKey) return 1;
    if (a.dateKey && b.dateKey) return a.dateKey.localeCompare(b.dateKey);
    return 0;
  });

  const filtered = all.filter((t) => {
    const has = !!t.dateKey && t.dateKey !== "undated";
    const rec = t.recurring && t.recurring !== "none";
    if (filter === "undated") return !has;
    if (filter === "dated") return has && !rec;
    if (filter === "recurring") return rec;
    return true;
  });

  filtered.forEach((t) => {
    const item = document.createElement("div");
    item.className = "task-item";

    const head = document.createElement("div");
    head.className = "task-item-header";

    const title = document.createElement("div");
    title.className = "task-title";
    title.textContent = t.title;

    const ob = document.createElement("span");
    ob.className = "badge";
    ob.textContent =
      t.owner === "shared" ? "משותף" : t.owner === "binyamin" ? "בנימין" : "ננה";
    ob.classList.add(`badge-owner-${t.owner}`);

    head.appendChild(title);
    head.appendChild(ob);

    const meta = document.createElement("div");
    meta.className = "task-meta";

    const parts = [];
    if (t.dateKey && t.dateKey !== "undated") {
      const d = parseDateKey(t.dateKey);
      parts.push(
        d.toLocaleDateString("he-IL", {
          weekday: "short",
          day: "2-digit",
          month: "2-digit"
        })
      );
    } else {
      parts.push("ללא תאריך");
    }

    if (t.duration) parts.push(`${t.duration} דק'`);

    if (t.urgency) {
      const map = {
        today: "היום",
        week: "השבוע",
        month: "החודש",
        none: "לא דחוף"
      };
      meta.textContent = parts.join(" • ");
      const b = document.createElement("span");
      b.className = "badge";
      b.classList.add(`badge-urgency-${t.urgency}`);
      b.textContent = map[t.urgency] || t.urgency;
      item.appendChild(head);
      item.appendChild(meta);
      item.appendChild(b);
    } else {
      meta.textContent = parts.join(" • ");
      item.appendChild(head);
      item.appendChild(meta);
    }

    list.appendChild(item);
  });
}

// --- AUTO BLOCKS ---
function renderAutoBlocks(date) {
  const box = el("dayAutoBlocks");
  box.innerHTML = "";

  const blocks = [];
  const day = date.getDay();
  const dk = dateKeyFromDate(date);

  blocks.push({ label: "שינה", range: "00:00–08:00", type: "sleep" });

  if (day >= 0 && day <= 4) {
    blocks.push({ label: "עבודה", range: "08:00–17:00", type: "work" });
    blocks.push({ label: "אוכל + מקלחת", range: "17:00–18:30", type: "meal" });
  }

  const autoRef = ref(db, `days/${dk}/holiday`);
  onValue(
    autoRef,
    (snap) => {
      const isH = !!snap.val();
      box.innerHTML = "";
      const finals = [];

      if (isH) {
        finals.push({
          label: "יום חופש",
          range: "ללא עבודה/ארוחות",
          type: "holiday"
        });
      } else {
        finals.push(...blocks);
      }

      finals.forEach((b) => {
        const row = document.createElement("div");
        row.className = "auto-block";
        if (b.type === "holiday") row.classList.add("auto-holiday");

        const la = document.createElement("div");
        la.className = "auto-block-label";
        la.textContent = b.label;

        const ra = document.createElement("div");
        ra.className = "auto-block-range";
        ra.textContent = b.range;

        row.appendChild(la);
        row.appendChild(ra);
        box.appendChild(row);
      });
    },
    { onlyOnce: true }
  );
}

// --- DAY MODAL ---
function openDayModal(date) {
  const modal = el("dayModal");
  modal.classList.remove("hidden");

  el("dayModalGreg").textContent = date.toLocaleDateString("he-IL", {
    weekday: "long",
    day: "2-digit",
    month: "2-digit",
    year: "numeric"
  });

  el("dayModalHeb").textContent = formatHebrewDate(date);

  const dk = dateKeyFromDate(date);

  renderDayEvents(dk);
  renderAutoBlocks(date);

  const weatherCard = el("dayWeatherContainer");
  if (!hasEventsOnDate(dk)) {
    fetchWeatherForDate(date, true);
  } else {
    weatherCard.classList.add("hidden");
  }

  el("btnAddFromDay").onclick = () => openEditModal({ dateKey: dk });
  el("btnToggleDayWeather").onclick = () => fetchWeatherForDate(date, false);

  qsa("[data-close-modal]", modal).forEach((b) => {
    b.onclick = () => modal.classList.add("hidden");
  });
  qs(".modal-backdrop", modal).onclick = () => modal.classList.add("hidden");
}

function hasEventsOnDate(k) {
  return Object.keys(state.cache.events[k] || {}).length > 0;
}

// --- RENDER EVENTS FOR DAY ---
function renderDayEvents(dk) {
  const box = el("dayEventsContainer");
  box.innerHTML = "";

  const list = Object.entries(state.cache.events[dk] || {})
    .map(([id, ev]) => ({ id, ...ev }))
    .sort((a, b) => {
      if (!a.startTime && b.startTime) return 1;
      if (a.startTime && !b.startTime) return -1;
      if (!a.startTime && !b.startTime) return 0;
      return a.startTime.localeCompare(b.startTime);
    });

  list.forEach((ev) => {
    const card = document.createElement("div");
    card.className = "card";
    if (ev.owner) card.classList.add(`owner-${ev.owner}`);

    const head = document.createElement("div");
    head.className = "task-item-header";

    const title = document.createElement("div");
    title.className = "task-title";
    title.textContent = ev.title;

    const ob = document.createElement("span");
    ob.className = "badge";
    ob.classList.add(`badge-owner-${ev.owner}`);
    ob.textContent =
      ev.owner === "shared" ? "משותף" : ev.owner === "binyamin" ? "בנימין" : "ננה";

    head.appendChild(title);
    head.appendChild(ob);

    const meta = document.createElement("div");
    meta.className = "task-meta";

    const parts = [];
    if (ev.startTime) parts.push(`${ev.startTime}${ev.endTime ? `–${ev.endTime}` : ""}`);
    if (ev.duration) parts.push(`${ev.duration} דק'`);
    parts.push(ev.type === "task" ? "משימה" : "אירוע");

    meta.textContent = parts.join(" • ");

    const desc = document.createElement("div");
    desc.className = "task-meta";
    desc.textContent = ev.description || "";

    const act = document.createElement("div");
    act.className = "task-actions";

    const editBtn = document.createElement("button");
    editBtn.className = "ghost-pill small";
    editBtn.textContent = "עריכה";
    editBtn.onclick = () => openEditModal({ dateKey: dk, id: ev.id || ev._id });

    const delBtn = document.createElement("button");
    delBtn.className = "ghost-pill small";
    delBtn.textContent = "מחיקה";
    delBtn.onclick = () => {
      const refPath = ref(db, `events/${dk}/${ev.id || ev._id}`);
      remove(refPath);
    };

    const wazeBtn = document.createElement("button");
    wazeBtn.className = "ghost-pill small";
    wazeBtn.textContent = "Waze";
    if (ev.address) {
      wazeBtn.onclick = () => {
        window.open(`https://waze.com/ul?q=${encodeURIComponent(ev.address)}`, "_blank");
      };
    } else {
      wazeBtn.disabled = true;
    }

    act.appendChild(editBtn);
    act.appendChild(delBtn);
    act.appendChild(wazeBtn);

    card.appendChild(head);
    card.appendChild(meta);
    if (ev.description) card.appendChild(desc);
    card.appendChild(act);
    box.appendChild(card);
  });
}

// --- EDIT MODAL ---
function openEditModal({ dateKey, id } = {}) {
  const modal = el("editModal");
  modal.classList.remove("hidden");

  const form = el("editForm");
  form.reset();

  form.elements["date"].value = dateKey || dateKeyFromDate(state.currentDate);

  form.dataset.editDateKey = dateKey || "";
  form.dataset.editId = id || "";

  qsa("[data-close-modal]", modal).forEach((b) => {
    b.onclick = () => modal.classList.add("hidden");
  });
  qs(".modal-backdrop", modal).onclick = () => modal.classList.add("hidden");
}

function handleEditFormSubmit(e) {
  e.preventDefault();

  const form = e.target;
  const data = Object.fromEntries(new FormData(form).entries());

  const obj = {
    type: data.type,
    owner: data.owner,
    title: data.title,
    description: data.description || "",
    dateKey: data.date || "undated",
    startTime: data.startTime || null,
    endTime: data.endTime || null,
    duration: data.duration ? Number(data.duration) : null,
    address: data.address || "",
    reminderMinutes: data.reminderMinutes ? Number(data.reminderMinutes) : null,
    recurring: data.recurring || "none",
    urgency: data.urgency || "none"
  };

  const dk = obj.dateKey;
  const id = form.dataset.editId;

  if (id) {
    update(ref(db, `events/${dk}/${id}`), obj);
  } else {
    const newRef = push(ref(db, `events/${dk}`));
    set(newRef, { ...obj, _id: newRef.key });
  }

  scheduleLocalReminder(obj);

  el("editModal").classList.add("hidden");
}

// --- WAZE ---
function openWazeFromForm() {
  const address = el("editForm").elements["address"].value;
  if (!address) return;
  window.open(`https://waze.com/ul?q=${encodeURIComponent(address)}`, "_blank");
}

// --- WEATHER FETCH ---
async function fetchWeatherForDate(date, autoHideIfEmpty) {
  const card = el("dayWeatherContainer");
  const city = getCity();
  if (!city) return card.classList.add("hidden");

  try {
    await ensureCityCoords();
  } catch (e) {
    el("dayWeatherTemp").textContent = "שגיאה בעיר";
    el("dayWeatherDesc").textContent = "";
    el("dayWeatherExtra").textContent = "";
    card.classList.remove("hidden");
    return;
  }

  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");

  const url = `https://api.open-meteo.com/v1/forecast?latitude=${
    state.settings.cityLat
  }&longitude=${state.settings.cityLon}&hourly=temperature_2m,precipitation_probability,weather_code&timezone=${
    state.settings.cityTz
  }&start_date=${y}-${m}-${d}&end_date=${y}-${m}-${d}`;

  try {
    const resp = await fetch(url);
    const data = await resp.json();

    if (!data.hourly || !data.hourly.temperature_2m || !data.hourly.temperature_2m.length) {
      if (autoHideIfEmpty) return card.classList.add("hidden");
      return;
    }

    let idx = data.hourly.time.findIndex((t) => t.endsWith("12:00"));
    if (idx < 0) idx = 0;

    const temp = Math.round(data.hourly.temperature_2m[idx]);
    const rain = data.hourly.precipitation_probability[idx];
    const code = data.hourly.weather_code[idx];

    const mapped = mapOpenMeteoWeather(code);

    el("dayWeatherTemp").textContent = `${temp}°C`;
    el("dayWeatherDesc").textContent = `${mapped.emoji} ${mapped.label}`;
    el("dayWeatherExtra").textContent = `סיכוי למשקעים: ${rain}%`;

    card.classList.remove("hidden");
  } catch (e) {
    el("dayWeatherTemp").textContent = "שגיאה במזג אוויר";
    el("dayWeatherDesc").textContent = "";
    el("dayWeatherExtra").textContent = "";
    card.classList.remove("hidden");
  }
}

// --- GIHARI TOOLS ---
function appendGihariLog(html) {
  const enhanced = wrapGihariHumor(html);
  const log = el("gihariLog");

  const div = document.createElement("div");
  div.className = "gihari-msg";
  div.innerHTML = enhanced;
  log.appendChild(div);

  const clean = enhanced.replace(/<[^>]+>/g, "");
  gihariSpeak(clean);
}

function logGihariCommand(text) {
  try {
    const newRef = push(ref(db, "gihariLogs"));
    set(newRef, { text, ts: Date.now() });
  } catch (e) {}
}

function computeLoadAndFreeSlots(date) {
  const dk = dateKeyFromDate(date);
  const events = state.cache.events[dk] || [];

  const busy = [];

  Object.values(events).forEach((ev) => {
    if (ev.owner && ev.owner !== state.currentUser && ev.owner !== "shared") return;
    if (!ev.startTime || !ev.endTime) return;

    const [sh, sm] = ev.startTime.split(":").map(Number);
    const [eh, em] = ev.endTime.split(":").map(Number);

    const s = sh * 60 + sm;
    const e = eh * 60 + em;
    busy.push([s, e]);
  });

  busy.sort((a, b) => a[0] - b[0]);

  const merged = [];
  busy.forEach((seg) => {
    if (!merged.length) merged.push(seg);
    else {
      const last = merged[merged.length - 1];
      if (seg[0] <= last[1]) last[1] = Math.max(last[1], seg[1]);
      else merged.push(seg);
    }
  });

  let totalBusy = 0;
  merged.forEach((s) => (totalBusy += s[1] - s[0]));

  const free = [];
  let cursor = 8 * 60;
  const end = 22 * 60;

  merged.forEach((seg) => {
    if (seg[0] - cursor >= 30) free.push([cursor, seg[0]]);
    cursor = Math.max(cursor, seg[1]);
  });
  if (end - cursor >= 30) free.push([cursor, end]);

  return {
    dailyLoadMinutes: totalBusy,
    freeSlots: free
  };
}

function formatMinutesRange(s, e) {
  const sh = String(Math.floor(s / 60)).padStart(2, "0");
  const sm = String(s % 60).padStart(2, "0");
  const eh = String(Math.floor(e / 60)).padStart(2, "0");
  const em = String(e % 60).padStart(2, "0");
  return `${sh}:${sm}–${eh}:${em}`;
}

function showFreeTimeForToday() {
  const { freeSlots } = computeLoadAndFreeSlots(new Date());

  if (!freeSlots.length) {
    appendGihariLog("להיום אין כמעט חורים – אתה עמוס כמו מעלית בבניין ישן 😅");
    return;
  }

  let msg = "הזמנים הפנויים שלך היום:<br>";
  freeSlots.forEach(([s, e]) => {
    msg += `• ${formatMinutesRange(s, e)}<br>`;
  });

  appendGihariLog(msg);
}

// ✔️ FIX — template string תקין, בלי שבירה
function gihariSuggestNow() {
  const today = new Date();
  const dk = dateKeyFromDate(today);

  const list = [];

  Object.entries(state.cache.events).forEach(([key, items]) => {
    Object.entries(items).forEach(([id, ev]) => {
      if (ev.type !== "task") return;
      if (ev.dateKey !== dk) return;
      list.push({ id, dateKey: dk, ...ev });
    });
  });

  if (!list.length) {
    appendGihariLog("אין לך משימות להיום 🙌");
    return;
  }

  const urgScore = { today: 3, week: 2, month: 1, none: 0 };

  list.sort((a, b) => (urgScore[b.urgency] || 0) - (urgScore[a.urgency] || 0));

  const top = list[0];
  appendGihariLog(
    `ממליץ עכשיו לטפל ב־"<strong>${top.title}</strong>" (דחיפות: ${
      top.urgency || "לא דחוף"
    })`
  );
}

function gihariPlaceUndatedTasks() {
  appendGihariLog("הפיצ'ר בבנייה… 😉");
}

// --- COMMAND PARSER ---
function handleGihariVoiceCommand(text) {
  if (!text) return;

  logGihariCommand(text);

  text = text.replace(/[.,]/g, " ");

  if (text.includes("תוסיף לי")) {
    createEventFromGihari(text);
    return;
  }

  if (text.includes("מתי יש לי זמן")) {
    showFreeTimeForToday();
    return;
  }

  appendGihariLog("לא לגמרי הבנתי, נסה לנסח שוב 😅");
}

function parseCommandTargetDate(text) {
  const d = new Date();
  if (text.includes("מחר")) {
    d.setDate(d.getDate() + 1);
  } else if (text.includes("בעוד שבוע")) {
    d.setDate(d.getDate() + 7);
  }
  return d;
}

function parseCommandHour(text) {
  const m = text.match(/בשעה\s*([0-9]{1,2})/);
  if (m) return Number(m[1]);
  return 17;
}

function createEventFromGihari(text) {
  const date = parseCommandTargetDate(text);

  const hour = parseCommandHour(text);
  const startH = String(hour).padStart(2, "0");
  const endH = String(Math.min(hour + 2, 23)).padStart(2, "0");

  let title = "אירוע";
  let address = "";

  const idx = text.indexOf("תוסיף לי");
  if (idx >= 0) {
    let after = text.slice(idx + "תוסיף לי".length).trim();
    const bIdx = after.indexOf(" ב");
    if (bIdx >= 0) {
      title = after.slice(0, bIdx).trim();
      address = after.slice(bIdx + 1).trim();
    } else {
      title = after.trim();
    }
  }

  const dk = dateKeyFromDate(date);
  const refPath = ref(db, `events/${dk}`);
  const newRef = push(refPath);

  set(newRef, {
    type: "event",
    owner: state.currentUser,
    title,
    dateKey: dk,
    startTime: `${startH}:00`,
    endTime: `${endH}:00`,
    duration: (endH - startH) * 60,
    address,
    urgency: "none",
    recurring: "none",
    _id: newRef.key
  });

  appendGihariLog(
    `קבעתי אירוע "<strong>${title}</strong>" ב־${dk} בשעה ${startH}:00`
  );
}

// --- CHARTS ---
let workFreeChart, tasksChart;

function updateStats() {
  const today = new Date();
  const { dailyLoadMinutes } = computeLoadAndFreeSlots(today);
  const workHours = dailyLoadMinutes / 60;
  const freeHours = Math.max(0, 14 - workHours);

  const ctx1 = el("workFreeChart").getContext("2d");

  if (!workFreeChart) {
    workFreeChart = new Chart(ctx1, {
      type: "doughnut",
      data: {
        labels: ["עבודה/משימות", "זמן פנוי"],
        datasets: [
          {
            data: [workHours, freeHours]
          }
        ]
      }
    });
  } else {
    workFreeChart.data.datasets[0].data = [workHours, freeHours];
    workFreeChart.update();
  }

  const arr = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const { dailyLoadMinutes } = computeLoadAndFreeSlots(d);
    arr.push({ label: d.getDate(), hours: dailyLoadMinutes / 60 });
  }

  const ctx2 = el("tasksChart").getContext("2d");

  if (!tasksChart) {
    tasksChart = new Chart(ctx2, {
      type: "bar",
      data: {
        labels: arr.map((x) => x.label),
        datasets: [
          {
            label: "עומס יומי (שעות)",
            data: arr.map((x) => x.hours)
          }
        ]
      }
    });
  } else {
    tasksChart.data.labels = arr.map((x) => x.label);
    tasksChart.data.datasets[0].data = arr.map((x) => x.hours);
    tasksChart.update();
  }
}

// --- THEME ---
function applyTheme(dark) {
  state.ui.darkMode = !!dark;
  document.body.classList.toggle("dark", dark);
  localStorage.setItem("bnappDarkMode", dark ? "1" : "0");
}

function toggleTheme() {
  applyTheme(!state.ui.darkMode);
}

function initTheme() {
  const saved = localStorage.getItem("bnappDarkMode");
  if (saved === "1") applyTheme(true);
  else if (saved === "0") applyTheme(false);
  else applyTheme(window.matchMedia("(prefers-color-scheme: dark)").matches);
}

// --- CITY SETTINGS ---
async function saveCitySettings() {
  const city = el("settingsCityInput").value.trim();
  state.settings.city = city || null;
  el("cityLabel").textContent = city || "לא נבחרה";

  const settingsRef = ref(db, "settings");

  try {
    if (city) await geocodeCity(city);
    update(settingsRef, {
      city,
      cityLat: state.settings.cityLat || null,
      cityLon: state.settings.cityLon || null,
      cityTz: state.settings.cityTz || null
    });
  } catch (e) {
    update(settingsRef, { city });
  }
}

// --- SHOPPING ---
function initShopping() {
  const tabs = qsa("#shoppingSection .segmented-btn");

  tabs.forEach((btn) => {
    btn.onclick = () => {
      tabs.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      renderShoppingList();
    };
  });

  el("btnAddShopping").onclick = addShoppingItem;
}

function getCurrentShoppingListKey() {
  const act = qs("#shoppingSection .segmented-btn.active");
  return act ? act.dataset.list : "default";
}

function addShoppingItem() {
  const input = el("shoppingInput");
  const text = input.value.trim();
  if (!text) return;

  const key = getCurrentShoppingListKey();
  const r = push(ref(db, `shopping/${key}`));
  set(r, {
    text,
    completed: false
  });

  input.value = "";
}

function renderShoppingList() {
  const ul = el("shoppingList");
  ul.innerHTML = "";

  const key = getCurrentShoppingListKey();
  const items = state.cache.shopping[key] || {};

  Object.entries(items).forEach(([id, item]) => {
    const li = document.createElement("li");
    li.className = "shopping-item";
    if (item.completed) li.classList.add("completed");

    const label = document.createElement("span");
    label.textContent = item.text;

    const checkBtn = document.createElement("button");
    checkBtn.className = "ghost-pill small";
    checkBtn.textContent = item.completed ? "בטל ✔" : "✔";
    checkBtn.onclick = () => {
      update(ref(db, `shopping/${key}/${id}`), { completed: !item.completed });
    };

    const del = document.createElement("button");
    del.className = "ghost-pill small";
    del.textContent = "🗑";
    del.onclick = () => remove(ref(db, `shopping/${key}/${id}`));

    li.appendChild(label);
    li.appendChild(checkBtn);
    li.appendChild(del);

    ul.appendChild(li);
  });
}

// --- FIREBASE LISTENERS ---
function initFirebaseListeners() {
  onValue(ref(db, "events"), (snap) => {
    state.cache.events = snap.val() || {};
    renderCalendar();
    renderTasks();
    updateStats();
  });

  onValue(ref(db, "shopping"), (snap) => {
    state.cache.shopping = snap.val() || {};
    renderShoppingList();
  });

  onValue(ref(db, "settings"), (snap) => {
    const s = snap.val() || {};
    state.settings.city = s.city || null;
    state.settings.cityLat = s.cityLat || null;
    state.settings.cityLon = s.cityLon || null;
    state.settings.cityTz = s.cityTz || null;

    el("cityLabel").textContent = state.settings.city || "לא נבחרה";
    el("settingsCityInput").value = state.settings.city || "";
  });
}

// --- INIT APP ---
function initBottomNav() {
  const btns = qsa(".bottom-nav .nav-btn");
  btns.forEach((b) => {
    b.onclick = () => {
      btns.forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      const target = b.dataset.target;
      qsa(".screen").forEach((s) => s.classList.remove("active"));
      el(target).classList.add("active");
    };
  });
}

function initTasksFilters() {
  const btns = qsa("#tasksSection .segmented-btn");
  btns.forEach((b) => {
    b.onclick = () => {
      btns.forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      renderTasks(b.dataset.filter);
    };
  });
}

function requestNotifications() {
  if (!("Notification" in window)) return;
  Notification.requestPermission().then((p) => {
    state.ui.notificationsGranted = p === "granted";
  });
}

function toggleHolidayForToday() {
  const dk = dateKeyFromDate(new Date());
  const r = ref(db, `days/${dk}/holiday`);
  onValue(
    r,
    (snap) => {
      if (snap.val()) remove(r);
      else set(r, true);
    },
    { onlyOnce: true }
  );
}

function openGihariModal() {
  const modal = el("gihariModal");
  modal.classList.remove("hidden");

  const { dailyLoadMinutes, freeSlots } = computeLoadAndFreeSlots(new Date());
  const load =
    dailyLoadMinutes < 180 ? "יום קל" : dailyLoadMinutes < 360 ? "יום בינוני" : "יום עמוס";

  el("gihariSummary").innerHTML = `
    <p>עומס להיום: <strong>${Math.round(dailyLoadMinutes / 60)} שעות</strong> (${load})</p>
    <p>חלונות פנויים: ${freeSlots.length}</p>
  `;

  el("gihariLog").innerHTML = "";

  qsa("[data-close-modal]", modal).forEach((b) => {
    b.onclick = () => modal.classList.add("hidden");
  });
  qs(".modal-backdrop", modal).onclick = () => modal.classList.add("hidden");
}

function initGihari() {
  el("btnGihari").onclick = () => openGihariModal();
  el("btnGihariSuggestNow").onclick = () => gihariSuggestNow();
  el("btnGihariPlaceTasks").onclick = () => gihariPlaceUndatedTasks();

  const mic = el("gihariMicBtn");
  if (mic) {
    mic.onclick = () => {
      const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!SR) {
        alert("הדפדפן לא תומך בדיבור");
        return;
      }
      const r = new SR();
      r.lang = "he-IL";
      r.start();
      mic.disabled = true;
      mic.textContent = "מקשיב…";

      r.onresult = (ev) => {
        mic.disabled = false;
        mic.textContent = "🎤 דבר";
        const txt = (ev.results[0][0].transcript || "").trim();
        handleGihariVoiceCommand(txt);
      };
      r.onerror = () => {
        mic.disabled = false;
        mic.textContent = "🎤 דבר";
      };
      r.onend = () => {
        mic.disabled = false;
        mic.textContent = "🎤 דבר";
      };
    };
  }
}

function initApp() {
  initTheme();
  initBottomNav();
  initTasksFilters();
  initShopping();
  initFirebaseListeners();
  initGihari();

  el("btnPrevMonth").onclick = () => {
    state.currentDate.setMonth(state.currentDate.getMonth() - 1);
    renderCalendar();
  };
  el("btnNextMonth").onclick = () => {
    state.currentDate.setMonth(state.currentDate.getMonth() + 1);
    renderCalendar();
  };
  el("btnToday").onclick = () => {
    state.currentDate = new Date();
    renderCalendar();
  };

  // כפתור זמן חופשי (נוסף)
  el("btnFreeTimeHeader").onclick = () => showFreeTimeForToday();

  el("btnFabAdd").onclick = () => openEditModal({});
  el("btnAddTask").onclick = () => openEditModal({});
  el("btnCity").onclick = () => qs('[data-target="settingsSection"]').click();
  el("btnSaveCity").onclick = saveCitySettings;
  el("btnToggleHoliday").onclick = toggleHolidayForToday;
  el("btnThemeToggle").onclick = toggleTheme;
  el("btnRequestNotifications").onclick = requestNotifications;
  el("btnOpenWaze").onclick = openWazeFromForm;

  el("editForm").addEventListener("submit", handleEditFormSubmit);

  renderCalendar();
  renderTasks();
  renderShoppingList();
}

document.addEventListener("DOMContentLoaded", initApp);

// END OF FILE
