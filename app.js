const STORAGE_KEY = "clinical-memory-assistant-v1";
const SUPABASE_SESSION_KEY = "clinical-memory-supabase-session-v1";
const LOCAL_CONFIG = window.CMA_CONFIG || {};
const DEFAULT_SUPABASE_URL = LOCAL_CONFIG.supabaseUrl || "https://mwwbqzdpnvnrvcdfxflh.supabase.co";
const DEFAULT_SUPABASE_ANON_KEY = LOCAL_CONFIG.supabaseAnonKey || "";

const todayISO = () => new Date().toISOString().slice(0, 10);
const nowTime = () => new Date().toTimeString().slice(0, 5);
const uid = (prefix) => `${prefix}_${Math.random().toString(36).slice(2, 9)}`;

const DEFAULT_TERMS = [
  ["해피", "HEP", "home exercise program", "exercise"],
  ["홈 엑서사이즈", "HEP", "home exercise program", "exercise"],
  ["발거스", "valgus", "dynamic knee valgus", "movement"],
  ["밸거스", "valgus", "dynamic knee valgus", "movement"],
  ["싱글렉", "single-leg", "single-leg control", "movement"],
  ["싱글 레그", "single-leg", "single-leg control", "movement"],
  ["스텝 다운", "step-down", "step-down control", "movement"],
  ["스텝다운", "step-down", "step-down control", "movement"],
  ["럼바", "lumbar", "lumbar compensation", "compensation"],
  ["컴펜세이션", "compensation", "compensation pattern", "compensation"],
  ["힙힌지", "hip hinge", "hip hinge pattern", "movement"],
  ["글루트 미드", "glute med", "gluteus medius activation", "exercise"],
  ["고관절 외전", "hip abduction", "hip abduction control", "exercise"],
  ["페인", "pain", "pain response", "symptom"],
  ["피어 어보이던스", "fear avoidance", "fear avoidance behavior", "behavior"],
].map(([from, to, chart, category]) => ({
  id: uid("term"),
  from,
  to,
  chart,
  category,
}));

const SEED_STATE = {
  patients: [
    {
      id: "patient_seed_1",
      code: "P001",
      name: "김OO",
      sex: "F",
      age: "42",
      region: "Rt knee",
      flags: "stair pain, valgus",
      createdAt: new Date().toISOString(),
    },
  ],
  scheduleItems: [
    {
      id: "sch_seed_1",
      date: todayISO(),
      time: "09:30",
      patientName: "김OO",
      patientCode: "P001",
      visitType: "재진",
      note: "Rt knee / stair pain",
      sourceFile: "sample",
      matchedVisitId: null,
      status: "scheduled",
    },
  ],
  rawInbox: [
    {
      id: "inbox_seed_1",
      type: "transcript",
      fileName: "sample_whisper_transcript.txt",
      createdAt: new Date().toISOString(),
      recordedDate: todayISO(),
      recordedTime: "09:36",
      patientHint: "김OO",
      visitType: "재진",
      text:
        "김OO님 재진 오른쪽 무릎. 계단 통증은 6에서 3 정도로 줄었고 해피는 주 3회 했다고 함. 스쿼트 시 발거스 남아 있고 럼바 컴펜세이션 약간 있음. 오늘 글루트 미드 활성화, 스텝다운 컨트롤 진행. 다음에는 싱글렉 안정성 확인.",
      correctedText:
        "김OO님 재진 오른쪽 무릎. 계단 통증은 6에서 3 정도로 줄었고 HEP는 주 3회 했다고 함. 스쿼트 시 valgus 남아 있고 lumbar compensation 약간 있음. 오늘 glute med 활성화, step-down 컨트롤 진행. 다음에는 single-leg 안정성 확인.",
      status: "new",
      matchedVisitId: null,
    },
  ],
  visits: [],
  terms: DEFAULT_TERMS,
  correctionHistory: [],
  settings: {
    supabaseUrl: DEFAULT_SUPABASE_URL,
    supabaseAnonKey: DEFAULT_SUPABASE_ANON_KEY,
    defaultChartStyle: "SOAP-lite",
    transcriptSource: "Whisper Memos iCloud export",
  },
};

let state = loadState();
let supabaseSession = loadSupabaseSession();
let currentView = "dashboard";
let selectedPatientId = state.patients[0]?.id || null;
let selectedVisitId = null;
let dashboardWeekStart = getWeekStartISO(todayISO());
let selectedScheduleId = state.scheduleItems[0]?.id || null;
let importLanes = {
  todaySchedule: makeImportLane("todaySchedule"),
  tomorrowSchedule: makeImportLane("tomorrowSchedule"),
  doctorChart: makeImportLane("doctorChart"),
};
let learningDraft = {
  from: "",
  to: "",
  chart: "",
  category: "movement",
  fieldId: "",
};

function makeImportLane(key) {
  const defaults = {
    todaySchedule: {
      kind: "schedule",
      title: "당일 스케줄",
      date: todayISO(),
      therapist: "백한솔",
      patientHint: "",
      sourceFile: "smart crm today schedule",
    },
    tomorrowSchedule: {
      kind: "schedule",
      title: "내일 스케줄",
      date: addDays(todayISO(), 1),
      therapist: "백한솔",
      patientHint: "",
      sourceFile: "smart crm tomorrow schedule",
    },
    doctorChart: {
      kind: "doctor_chart",
      title: "초진 차트",
      date: todayISO(),
      therapist: "",
      patientHint: "",
      sourceFile: "doctor chart paste",
    },
  }[key];

  return {
    ...defaults,
    key,
    text: "",
    imageName: "",
    imagePreview: "",
    ocrStatus: "",
    screenshotCount: 0,
  };
}

function loadState() {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (!saved) return ensureStateShape(structuredClone(SEED_STATE));
  try {
    return ensureStateShape(JSON.parse(saved));
  } catch {
    return ensureStateShape(structuredClone(SEED_STATE));
  }
}

function ensureStateShape(loaded) {
  const next = {
    ...structuredClone(SEED_STATE),
    ...loaded,
    settings: {
      ...SEED_STATE.settings,
      ...(loaded.settings || {}),
    },
  };
  if (!next.settings.supabaseUrl) next.settings.supabaseUrl = DEFAULT_SUPABASE_URL;
  if (!next.settings.supabaseAnonKey) next.settings.supabaseAnonKey = DEFAULT_SUPABASE_ANON_KEY;
  return next;
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function loadSupabaseSession() {
  const saved = localStorage.getItem(SUPABASE_SESSION_KEY);
  if (!saved) return null;
  try {
    return JSON.parse(saved);
  } catch {
    return null;
  }
}

function saveSupabaseSession(session) {
  supabaseSession = session;
  if (session) {
    localStorage.setItem(SUPABASE_SESSION_KEY, JSON.stringify(session));
  } else {
    localStorage.removeItem(SUPABASE_SESSION_KEY);
  }
}

function getSupabaseConfig() {
  return {
    url: (state.settings.supabaseUrl || DEFAULT_SUPABASE_URL).replace(/\/$/, ""),
    key: state.settings.supabaseAnonKey || DEFAULT_SUPABASE_ANON_KEY,
  };
}

function setView(view) {
  currentView = view;
  document.querySelectorAll(".nav-item").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === view);
  });
  document.querySelectorAll(".view").forEach((section) => {
    section.classList.toggle("active", section.id === `${view}View`);
  });

  const copy = {
    dashboard: ["오늘", "스케줄, 녹음, 차트 초안을 한 번에 확인합니다."],
    inbox: ["Import Inbox", "녹음 전사, 스케줄 캡쳐, 의사 차트 캡쳐를 처리합니다."],
    patients: ["환자", "환자 코드와 추적 변수를 관리합니다."],
    visits: ["방문 기록", "재진 브리핑과 차트 초안을 편집합니다."],
    terms: ["용어 사전", "한국어 전사 오류와 임상 표현을 보정합니다."],
    settings: ["설정", "자동화 연결 지점을 정리합니다."],
  }[view];
  document.getElementById("viewTitle").textContent = copy[0];
  document.getElementById("viewSubtitle").textContent = copy[1];
  render();
}

function toast(message) {
  const node = document.getElementById("toast");
  node.textContent = message;
  node.classList.add("show");
  window.setTimeout(() => node.classList.remove("show"), 2400);
}

function escapeHTML(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function normalizeTime(value) {
  if (!value) return "";
  const raw = String(value).trim().replace(/[Oo]/g, "0").replace("시", ":").replace(/\s/g, "");
  const match = raw.match(/(\d{1,2})(?::?(\d{2}))?/);
  if (!match) return "";
  const hour = match[1].padStart(2, "0");
  const minute = (match[2] || "00").padStart(2, "0");
  return `${hour}:${minute}`;
}

function minutesOf(time) {
  if (!time) return null;
  const [h, m] = time.split(":").map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
}

function parseISODate(dateISO) {
  const [year, month, day] = dateISO.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function toISODate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function addDays(dateISO, days) {
  const date = parseISODate(dateISO);
  date.setDate(date.getDate() + days);
  return toISODate(date);
}

function getWeekStartISO(dateISO) {
  const date = parseISODate(dateISO);
  const mondayOffset = (date.getDay() + 6) % 7;
  date.setDate(date.getDate() - mondayOffset);
  return toISODate(date);
}

function getWeekDates(weekStartISO) {
  return Array.from({ length: 7 }, (_, index) => addDays(weekStartISO, index));
}

function formatWeekRange(weekDates) {
  return `${formatKoreanDate(weekDates[0])} - ${formatKoreanDate(weekDates[6])}`;
}

function formatKoreanDate(dateISO) {
  const date = parseISODate(dateISO);
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

function formatWeekday(dateISO) {
  const date = parseISODate(dateISO);
  return ["일", "월", "화", "수", "목", "금", "토"][date.getDay()];
}

function makeTimeSlots() {
  const slots = [];
  for (let total = 9 * 60; total <= 22 * 60; total += 30) {
    slots.push(minutesToTime(total));
  }
  return slots;
}

function minutesToTime(total) {
  const hour = String(Math.floor(total / 60)).padStart(2, "0");
  const minute = String(total % 60).padStart(2, "0");
  return `${hour}:${minute}`;
}

function slotFromTime(time) {
  const minutes = minutesOf(time);
  if (minutes === null) return "";
  const clamped = Math.max(9 * 60, Math.min(22 * 60, minutes));
  return minutesToTime(Math.floor(clamped / 30) * 30);
}

function applyTerms(text) {
  return state.terms.reduce((memo, term) => {
    if (!term.from || !term.to) return memo;
    return memo.replaceAll(term.from, term.to);
  }, text || "");
}

function findLearnedTerm(from, to) {
  const normalizedFrom = from.trim().toLowerCase();
  const normalizedTo = to.trim().toLowerCase();
  return state.terms.find((term) => {
    return term.from.trim().toLowerCase() === normalizedFrom && term.to.trim().toLowerCase() === normalizedTo;
  });
}

function rememberCorrection({ from, to, chart, category, visitId, fieldId }) {
  const source = (from || "").trim();
  const target = (to || "").trim();
  if (!source || !target) return false;

  const existing = findLearnedTerm(source, target);
  if (existing) {
    existing.chart = chart || existing.chart || target;
    existing.category = category || existing.category || "learned";
    existing.count = Number(existing.count || 1) + 1;
    existing.lastSeenAt = new Date().toISOString();
  } else {
    state.terms.unshift({
      id: uid("term"),
      from: source,
      to: target,
      chart: chart || target,
      category: category || "learned",
      count: 1,
      lastSeenAt: new Date().toISOString(),
    });
  }

  state.correctionHistory.unshift({
    id: uid("corr"),
    from: source,
    to: target,
    chart: chart || target,
    category: category || "learned",
    visitId: visitId || null,
    fieldId: fieldId || "",
    createdAt: new Date().toISOString(),
  });
  return true;
}

function parseScheduleText(text, date, sourceFile = "manual paste") {
  const lines = text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);

  return lines
    .map((line) => {
      const timeMatch = line.match(/(\d{1,2}[:시]\s?\d{0,2})/);
      const time = normalizeTime(timeMatch?.[1]);
      if (!time) return null;

      const visitType = /초진|신규|new/i.test(line) ? "초진" : "재진";
      const cleaned = line
        .replace(timeMatch[0], "")
        .replace(/초진|신규|재진|예약|치료|도수|물리치료|new|follow[- ]?up/gi, "")
        .replace(/[|,/\-]+/g, " ")
        .trim();
      const parts = cleaned.split(/\s+/).filter(Boolean);
      const patientName = parts[0] || "이름 미상";
      const note = parts.slice(1).join(" ");

      return {
        id: uid("sch"),
        date,
        time,
        patientName,
        patientCode: "",
        visitType,
        note,
        sourceFile,
        matchedVisitId: null,
        status: "scheduled",
      };
    })
    .filter(Boolean);
}

function parseSmartCrmScheduleText(text, date, therapistName = "백한솔", sourceFile = "smart crm paste") {
  const normalizedText = normalizeSmartCrmOcrText(text || "");
  const listItems = parseSmartCrmListText(normalizedText, date, therapistName, sourceFile);
  if (listItems.length) return dedupeScheduleItems(listItems);

  const normalized = normalizedText
    .replace(/\r/g, "\n")
    .replace(/[|]+/g, " ")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);

  const therapistLines = normalized.filter((line) => {
    return !therapistName || line.includes(therapistName);
  });
  const lines = therapistLines.length ? therapistLines : normalized;

  return lines
    .flatMap((line) => extractScheduleItemsFromLine(line, date, therapistName, sourceFile))
    .filter(Boolean);
}

function normalizeSmartCrmOcrText(text) {
  return String(text || "")
    .replace(/\r/g, "\n")
    .replace(/[［【]/g, "[")
    .replace(/[］】]/g, "]")
    .replace(/[（]/g, "(")
    .replace(/[）]/g, ")")
    .replace(/[：]/g, ":")
    .replace(/[|]+/g, " ")
    .replace(/\t/g, " ")
    .replace(/([0O]?\d|1\d|2[0-3])\s*[:시]\s*([0-5O]\d|[0-5O])/g, (full, hour, minute) => {
      return `${hour.replace(/[Oo]/g, "0")}:${minute.replace(/[Oo]/g, "0").padStart(2, "0")}`;
    });
}

function parseSmartCrmListText(text, defaultDate, therapistName, sourceFile) {
  const lines = text
    .split(/\n+/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  if (!lines.length) return [];

  const blocks = splitSmartCrmCalendarBlocks(lines, defaultDate);
  const items = blocks.flatMap((block) => {
    return splitSmartCrmAppointmentSegments(block.text).map((segment) => {
      const time = normalizeKoreanTime(segment.timeText);
      if (!time) return null;

      const patientName = inferSmartCrmPatientName(segment.text, therapistName);
      if (!patientName) return null;

      const smartCrmStatus = inferSmartCrmStatus(segment.text);
      if (smartCrmStatus === "cancelled") return null;

      const visitType = smartCrmStatus === "new" || /초진|신규|new/i.test(segment.text) ? "초진" : "재진";
      const note = cleanSmartCrmScheduleNote(segment.text, segment.timeText, patientName);
      return {
        id: uid("sch"),
        date: block.date || defaultDate,
        time,
        patientName,
        patientCode: "",
        visitType,
        note,
        sourceFile,
        matchedVisitId: null,
        status: smartCrmStatus === "completed" ? "completed" : "scheduled",
      };
    });
  }).filter(Boolean);

  const therapistMatches = items.filter((item) => {
    return therapistName && item.note.includes(therapistName);
  });
  return therapistMatches.length ? therapistMatches : items;
}

function splitSmartCrmCalendarBlocks(lines, defaultDate) {
  const blocks = [];
  let currentDate = defaultDate;
  let currentLines = [];

  const flush = () => {
    if (!currentLines.length) return;
    blocks.push({
      date: currentDate,
      text: currentLines.join("\n"),
    });
    currentLines = [];
  };

  lines.forEach((line) => {
    const dayHit = detectSmartCrmDayMarker(line, defaultDate);
    if (dayHit) {
      flush();
      currentDate = dayHit.date;
      if (dayHit.rest) currentLines.push(dayHit.rest);
      return;
    }
    currentLines.push(line);
  });
  flush();

  return blocks.length ? blocks : [{ date: defaultDate, text: lines.join("\n") }];
}

function detectSmartCrmDayMarker(line, defaultDate) {
  const defaultParts = defaultDate.split("-").map(Number);
  if (defaultParts.length !== 3 || defaultParts.some(Number.isNaN)) return null;
  const [year, month] = defaultParts;

  const trimmed = line.trim();
  const compact = trimmed.replace(/\s+/g, "");
  const dateMatch = compact.match(/(?:20\d{2})[-./년]?(0?\d{1,2})[-./월]?(0?\d{1,2})/);
  if (dateMatch && !findSmartCrmTimeMatches(trimmed).length) {
    return {
      date: `${year}-${String(Number(dateMatch[1])).padStart(2, "0")}-${String(Number(dateMatch[2])).padStart(2, "0")}`,
      rest: "",
    };
  }

  const dayLine = trimmed.match(/^(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat|일|월|화|수|목|금|토)?\s*(\d{1,2})(?:\s|일|$)(.*)$/i);
  if (!dayLine) return null;
  const day = Number(dayLine[1]);
  const rest = (dayLine[2] || "").trim();
  if (day < 1 || day > 31) return null;
  if (findSmartCrmTimeMatches(rest).length && trimmed.length > 8) {
    return {
      date: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
      rest,
    };
  }
  if (rest && /[가-힣A-Za-z]{2,}/.test(rest)) return null;
  if (trimmed.length > 12) return null;
  return {
    date: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
    rest: "",
  };
}

function splitSmartCrmAppointmentSegments(text) {
  const matches = findSmartCrmTimeMatches(text);
  return matches.map((match, index) => {
    const next = matches[index + 1];
    return {
      timeText: match[0],
      text: text.slice(match.index, next?.index || text.length).trim(),
    };
  });
}

function findSmartCrmTimeMatches(text) {
  return [...String(text || "").matchAll(/(?:오전|오후)?\s*([0O]?\d|1\d|2[0-3])\s*[:시]\s*([0-5O]\d|[0-5O])/g)];
}

function inferSmartCrmPatientName(segment, therapistName) {
  const stopWords = new Set([
    "도수",
    "운동",
    "치료",
    "도수치료",
    "재진",
    "초진",
    "신규",
    "예약",
    "정상예약",
    "방문",
    "예약취소",
    "상태",
    "완료",
    "진료",
    "진료중",
    "진료완료",
    "여진",
    "남",
    "녀",
    "전체",
    "조회",
    "새로고침",
    "기본크기",
    "월별예약리스트",
    "일일현황리스트",
  ]);

  const cleaned = String(segment || "")
    .replace(/(?:오전|오후)?\s*([0O]?\d|1\d|2[0-3])\s*[:시]\s*([0-5O]\d|[0-5O])/g, " ")
    .replace(/\[[^\]]*]/g, " ")
    .replace(/\([^)]*\)/g, " ")
    .replace(therapistName || "", " ")
    .replace(/도수치료\d*|운동\d*|TRM|MPT|CFO|F\/U|ok|OK|패키지|연락|변경|상담|재상담/gi, " ")
    .replace(/[0-9]+(?:회|분|세|년|월|일)?/g, " ")
    .replace(/[()[\]{}.,/\\|:;~+_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const parts = cleaned.split(" ").map((part) => part.replace(/님$/, "")).filter(Boolean);
  return parts.find((part) => {
    if (stopWords.has(part)) return false;
    if (part.length < 2 || part.length > 8) return false;
    if (!/[가-힣]/.test(part)) return false;
    if (!/^[가-힣A-Za-z]+$/.test(part)) return false;
    if (/도수|치료|운동|예약|방문|여진|상담/.test(part)) return false;
    return true;
  }) || "";
}

function cleanSmartCrmScheduleNote(segment, timeText, patientName) {
  return String(segment || "")
    .replace(timeText || "", "")
    .replace(patientName || "", "")
    .replace(/\[상태:[^\]]+]/g, "")
    .replace(/\s+/g, " ")
    .replace(/\s+([/\]])/g, "$1")
    .trim();
}

function inferSmartCrmStatus(segment) {
  const value = String(segment || "");
  if (/\[상태:\s*취소]|예약취소|취소/.test(value)) return "cancelled";
  if (/\[상태:\s*신규]|초진|신규/.test(value)) return "new";
  if (/\[상태:\s*완료]|방문|치료완료|내원/.test(value)) return "completed";
  if (/\[상태:\s*예약]|정상예약/.test(value)) return "scheduled";
  return "scheduled";
}

function dedupeScheduleItems(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = `${item.date}|${item.time}|${item.patientName}|${item.note}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function extractScheduleItemsFromLine(line, date, therapistName, sourceFile) {
  const items = [];
  const timeMatches = findSmartCrmTimeMatches(line);
  if (!timeMatches.length) return [];

  timeMatches.forEach((match, index) => {
    const nextMatch = timeMatches[index + 1];
    const segment = line.slice(match.index, nextMatch?.index || line.length);
    const time = normalizeKoreanTime(match[0]);
    if (!time) return;

    const visitType = /초진|신규|new/i.test(segment) ? "초진" : "재진";
    const patientName = inferSchedulePatientName(segment, therapistName);
    const note = segment
      .replace(match[0], "")
      .replace(therapistName || "", "")
      .replace(patientName || "", "")
      .replace(/초진|신규|재진|예약|치료|도수|물리치료|완료|내원|취소|대기/gi, "")
      .replace(/\s+/g, " ")
      .trim();

    if (!patientName) return;
    items.push({
      id: uid("sch"),
      date,
      time,
      patientName,
      patientCode: "",
      visitType,
      note,
      sourceFile,
      matchedVisitId: null,
      status: "scheduled",
    });
  });

  return items;
}

function normalizeKoreanTime(value) {
  if (!value) return "";
  const isPM = value.includes("오후");
  const isAM = value.includes("오전");
  const normalized = String(value).replace(/[Oo]/g, "0");
  const match = normalized.match(/(\d{1,2})[:시]\s?(\d{0,2})/);
  if (!match) return "";
  let hour = Number(match[1]);
  const minute = (match[2] || "00").padStart(2, "0");
  if (isPM && hour < 12) hour += 12;
  if (isAM && hour === 12) hour = 0;
  return `${String(hour).padStart(2, "0")}:${minute}`;
}

function inferSchedulePatientName(segment, therapistName) {
  const cleaned = segment
    .replace(/(?:오전|오후)?\s*\d{1,2}[:시]\s?\d{0,2}/g, " ")
    .replace(therapistName || "", " ")
    .replace(/초진|신규|재진|예약|치료|도수|물리치료|완료|내원|취소|대기|남|여|\d+세/gi, " ")
    .replace(/[()[\]{}.,/\\|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const parts = cleaned.split(" ").filter(Boolean);
  return parts.find((part) => /^[가-힣A-Za-z]{2,12}(?:OO|님)?$/.test(part))?.replace("님", "") || "";
}

function parseTranscriptMeta(text, fileName, recordedDate, recordedTime) {
  const firstLine = (text || "").split(/\n/).find(Boolean) || "";
  const correctedText = applyTerms(text || "");
  const timeHint = normalizeTime(firstLine.match(/(\d{1,2}[:시]\s?\d{0,2})/)?.[1]) || recordedTime;
  const visitType = /초진|신규/i.test(firstLine) ? "초진" : "재진";
  const nameMatch = firstLine.match(/([가-힣A-Za-z]{1,12}(?:OO|님)?)/);
  const patientHint = nameMatch?.[1]?.replace("님", "") || "";

  return {
    id: uid("inbox"),
    type: "transcript",
    fileName: fileName || "manual_transcript.txt",
    createdAt: new Date().toISOString(),
    recordedDate,
    recordedTime: timeHint || nowTime(),
    patientHint,
    visitType,
    text,
    correctedText,
    status: "new",
    matchedVisitId: null,
  };
}

function findPatientByNameOrCode(name, code) {
  const normalizedName = (name || "").trim();
  const normalizedCode = (code || "").trim();
  return state.patients.find((patient) => {
    return (
      (normalizedCode && patient.code === normalizedCode) ||
      (normalizedName && patient.name === normalizedName)
    );
  });
}

function findBestScheduleForInbox(inbox) {
  const inboxMinutes = minutesOf(inbox.recordedTime);
  if (inboxMinutes === null) return null;

  const sameDate = state.scheduleItems.filter((item) => {
    return item.date === inbox.recordedDate && !item.matchedVisitId;
  });

  let best = null;
  for (const item of sameDate) {
    const itemMinutes = minutesOf(item.time);
    if (itemMinutes === null) continue;
    const delta = Math.abs(itemMinutes - inboxMinutes);
    const nameScore =
      inbox.patientHint && item.patientName.includes(inbox.patientHint.replace("OO", ""))
        ? 25
        : 0;
    const typeScore = inbox.visitType === item.visitType ? 10 : 0;
    const score = Math.min(100, Math.max(0, 100 - delta * 2 + nameScore + typeScore));
    if (!best || score > best.score) best = { item, score, delta };
  }
  return best;
}

function createVisitFromInbox(inboxId, scheduleId = null) {
  const inbox = state.rawInbox.find((entry) => entry.id === inboxId);
  if (!inbox) return;

  const schedule = scheduleId
    ? state.scheduleItems.find((item) => item.id === scheduleId)
    : findBestScheduleForInbox(inbox)?.item;

  let patient = findPatientByNameOrCode(schedule?.patientName || inbox.patientHint, schedule?.patientCode);
  if (!patient) {
    const nextNumber = String(state.patients.length + 1).padStart(3, "0");
    patient = {
      id: uid("patient"),
      code: `P${nextNumber}`,
      name: schedule?.patientName || inbox.patientHint || "신규 환자",
      sex: "",
      age: "",
      region: schedule?.note || "",
      flags: "",
      createdAt: new Date().toISOString(),
    };
    state.patients.push(patient);
  }

  const text = inbox.correctedText || inbox.text || "";
  const visit = {
    id: uid("visit"),
    patientId: patient.id,
    date: inbox.recordedDate || schedule?.date || todayISO(),
    time: inbox.recordedTime || schedule?.time || nowTime(),
    visitType: schedule?.visitType || inbox.visitType || "재진",
    sourceInboxId: inbox.id,
    transcript: text,
    signals: extractSignals(text).signals,
    secondarySignals: extractSignals(text).secondary,
    noise: "",
    tracking: inferTracking(text),
    treatment: extractSection(text, ["오늘", "치료", "진행"]),
    hep: extractSection(text, ["HEP", "숙제", "운동"]),
    homework: extractSection(text, ["숙제", "HEP", "다음"]),
    nextFocus: extractSection(text, ["다음", "확인", "progression"]),
    draft: "",
    confirmed: false,
    summary: summarizeTranscript(text),
    createdAt: new Date().toISOString(),
  };
  visit.draft = generateDraft(visit, patient);

  state.visits.unshift(visit);
  inbox.status = "matched";
  inbox.matchedVisitId = visit.id;
  if (schedule) {
    schedule.matchedVisitId = visit.id;
    schedule.status = "matched";
    if (!schedule.patientCode) schedule.patientCode = patient.code;
  }
  if (inbox.cloudId) {
    updateSupabaseInboxStatus(inbox.cloudId, "matched");
  }
  selectedPatientId = patient.id;
  selectedVisitId = visit.id;
  saveState();
  toast("방문 기록과 차트 초안을 만들었습니다.");
  setView("visits");
}

function extractSignals(text) {
  const signals = [];
  const secondary = [];
  const candidates = [
    ["계단", "stair pain"],
    ["앉", "sitting tolerance"],
    ["보행", "gait quality"],
    ["walk", "walking tolerance"],
    ["valgus", "dynamic knee valgus"],
    ["lumbar", "lumbar compensation"],
    ["HEP", "HEP adherence"],
    ["통증", "pain response"],
    ["불안", "movement confidence"],
    ["fear", "fear avoidance"],
    ["ROM", "ROM"],
    ["single-leg", "single-leg stability"],
  ];
  candidates.forEach(([needle, label]) => {
    if (text.toLowerCase().includes(needle.toLowerCase())) signals.push(label);
  });
  if (text.includes("가끔") || text.includes("약간")) secondary.push("mild or intermittent finding");
  return { signals: [...new Set(signals)], secondary: [...new Set(secondary)] };
}

function inferTracking(text) {
  const tracking = [];
  const map = [
    ["계단", "stair pain"],
    ["앉", "sitting tolerance"],
    ["보행", "gait quality"],
    ["valgus", "dynamic knee valgus"],
    ["lumbar", "lumbar compensation"],
    ["HEP", "HEP adherence"],
    ["single-leg", "single-leg stability"],
    ["통증", "pain intensity"],
  ];

  map.forEach(([needle, name]) => {
    if (text.toLowerCase().includes(needle.toLowerCase())) {
      const intensity = text.match(/(\d{1,2})\s*(?:에서|->|→)\s*(\d{1,2})/);
      tracking.push({
        id: uid("track"),
        name,
        value: intensity ? `${intensity[1]} -> ${intensity[2]}` : "mentioned",
        trend: intensity && Number(intensity[2]) < Number(intensity[1]) ? "improved" : "check",
      });
    }
  });
  return tracking;
}

function extractSection(text, keywords) {
  const sentences = text
    .split(/[.。!?]\s*|\n+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  return sentences.filter((sentence) => keywords.some((keyword) => sentence.includes(keyword))).join(". ");
}

function summarizeTranscript(text) {
  const sentences = text
    .split(/[.。!?]\s*|\n+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  return sentences.slice(0, 3).join(". ");
}

function generateDraft(visit, patient) {
  const tracking = visit.tracking.map((item) => `${item.name}: ${item.value}`).join("; ");
  const signals = visit.signals.join(", ") || "key symptom and movement response checked";
  const treatment = visit.treatment || "manual therapy / exercise intervention performed as tolerated";
  const hep = visit.homework || visit.hep || "HEP reviewed and adjusted";
  const next = visit.nextFocus || "reassess tracking variables next visit";

  if (visit.visitType === "초진") {
    return [
      `[${patient.code}] Initial PT note`,
      `S: ${visit.summary || "Initial interview completed."}`,
      `O: Key signals - ${signals}. Tracking variables - ${tracking || "to be established"}.`,
      `A: Candidate hypothesis to confirm: load tolerance / motor control / movement compensation pattern.`,
      `P: ${treatment}. HEP: ${hep}. Next: ${next}.`,
    ].join("\n");
  }

  return [
    `[${patient.code}] Follow-up PT note`,
    `S: ${visit.summary || "Follow-up status checked."}`,
    `O: Tracking - ${tracking || "no structured tracking update captured"}.`,
    `A: ${signals}. Response monitored; progression adjusted based on symptom and movement quality.`,
    `P: ${treatment}. HEP: ${hep}. Next: ${next}.`,
  ].join("\n");
}

function render() {
  const query = document.getElementById("globalSearch").value.trim().toLowerCase();
  if (currentView === "dashboard") renderDashboard(query);
  if (currentView === "inbox") renderInbox();
  if (currentView === "patients") renderPatients(query);
  if (currentView === "visits") renderVisits(query);
  if (currentView === "terms") renderTerms();
  if (currentView === "settings") renderSettings();
}

function renderDashboard(query = "") {
  const container = document.getElementById("dashboardView");
  const today = todayISO();
  const weekDates = getWeekDates(dashboardWeekStart);
  const scheduleWeek = state.scheduleItems
    .filter((item) => weekDates.includes(item.date))
    .filter((item) => !query || JSON.stringify(item).toLowerCase().includes(query))
    .sort((a, b) => a.time.localeCompare(b.time));
  const scheduleToday = scheduleWeek.filter((item) => item.date === today);
  const inbox = state.rawInbox.filter((item) => item.status === "new");
  const visitsToday = state.visits.filter((visit) => visit.date === today);
  const selectedSchedule = scheduleWeek.find((item) => item.id === selectedScheduleId) || scheduleWeek[0] || null;
  if (selectedSchedule) selectedScheduleId = selectedSchedule.id;

  container.innerHTML = `
    ${renderWorkflowImportLanes()}
    <div class="dashboard-layout">
      <section class="panel weekly-panel">
        <div class="panel-header">
          <div>
            <h2>주간 예약</h2>
            <p class="note">${formatWeekRange(weekDates)} · 오전 9시부터 오후 10시</p>
          </div>
          <div class="row wrap">
            <button class="small-button" data-action="prev-week">이전 주</button>
            <button class="small-button" data-action="this-week">이번 주</button>
            <button class="small-button" data-action="next-week">다음 주</button>
          </div>
        </div>
        <div class="panel-body">
          ${renderWeeklyCalendar(weekDates, scheduleWeek)}
        </div>
      </section>

      <div class="dashboard-side">
        ${renderScheduleHistoryPanel(selectedSchedule)}
        <section class="panel">
          <div class="panel-header">
            <h2>매칭 대기</h2>
            <button class="small-button" data-action="go-inbox">Inbox</button>
          </div>
          <div class="panel-body">
            <div class="list compact-list">
              ${
                inbox.length
                  ? inbox.slice(0, 4).map(renderInboxMatchCard).join("")
                  : emptyState("대기 항목 없음", "새 transcript나 캡쳐가 들어오면 여기에 표시됩니다.")
              }
            </div>
          </div>
        </section>
      </div>
    </div>
  `;
}

function metric(value, label) {
  return `<div class="metric"><strong>${value}</strong><span>${label}</span></div>`;
}

function renderWorkflowImportLanes() {
  return `
    <section class="workflow-import">
      ${renderImportLane(importLanes.todaySchedule)}
      ${renderImportLane(importLanes.tomorrowSchedule)}
      ${renderImportLane(importLanes.doctorChart)}
    </section>
  `;
}

function renderImportLane(lane) {
  const isSchedule = lane.kind === "schedule";
  const defaultStatus = isSchedule ? "Smart CRM · 여러 장 붙여넣기" : "초진 차트 · Ctrl/Cmd+V";
  const placeholder = isSchedule ? "여러 장 붙여넣기" : "여기에 붙여넣기";
  return `
    <article class="paste-lane" data-lane="${lane.key}" tabindex="0" aria-label="${escapeHTML(lane.title)} 붙여넣기">
      <div class="paste-lane-head">
        <div>
          <h2>${escapeHTML(lane.title)}</h2>
          <p class="note">${escapeHTML(lane.ocrStatus || defaultStatus)}</p>
        </div>
        <span class="badge ${isSchedule ? "follow" : "new"}">${isSchedule ? escapeHTML(lane.therapist || "담당자") : "신환"}</span>
      </div>

      <div class="paste-lane-controls">
        ${
          isSchedule
            ? `<input id="laneDate-${lane.key}" type="date" value="${escapeHTML(lane.date)}" />`
            : `<input id="lanePatient-${lane.key}" value="${escapeHTML(lane.patientHint)}" placeholder="환자명/코드" />`
        }
      </div>

      <div class="paste-lane-drop ${lane.text || lane.imagePreview ? "has-content" : ""}">
        ${
          lane.imagePreview
            ? `<div class="lane-image-preview"><img src="${lane.imagePreview}" alt="붙여넣은 이미지 미리보기" /><span>${escapeHTML(lane.imageName || "pasted image")}</span></div>`
            : `<div class="lane-placeholder">${escapeHTML(placeholder)}</div>`
        }
        <textarea id="laneText-${lane.key}" placeholder="${isSchedule ? "OCR 텍스트 또는 스케줄 텍스트" : "OCR 텍스트 또는 초진 차트 텍스트"}">${escapeHTML(lane.text)}</textarea>
      </div>

      <div class="paste-lane-actions">
        <button class="primary-button" data-action="lane-process" data-lane="${lane.key}">반영</button>
        <button class="ghost-button" data-action="lane-clear" data-lane="${lane.key}">비우기</button>
      </div>
    </article>
  `;
}

function renderWeeklyCalendar(weekDates, scheduleItems) {
  const slots = makeTimeSlots();
  const bySlot = new Map();
  scheduleItems.forEach((item) => {
    const slot = slotFromTime(item.time);
    const key = `${item.date}|${slot}`;
    const items = bySlot.get(key) || [];
    items.push(item);
    bySlot.set(key, items);
  });

  return `
    <div class="weekly-calendar-wrap">
      <div class="weekly-calendar">
        <div class="calendar-header">
          <div class="calendar-corner">시간</div>
          ${weekDates.map((date) => `
            <div class="calendar-day ${date === todayISO() ? "today" : ""}">
              <strong>${formatWeekday(date)}</strong>
              <span>${formatKoreanDate(date)}</span>
            </div>
          `).join("")}
        </div>
        ${slots.map((slot) => `
          <div class="calendar-row">
            <div class="calendar-time">${slot}</div>
            ${weekDates.map((date) => {
              const items = bySlot.get(`${date}|${slot}`) || [];
              return `
                <div class="calendar-cell">
                  ${items.map(renderCalendarAppointment).join("")}
                </div>
              `;
            }).join("")}
          </div>
        `).join("")}
      </div>
    </div>
  `;
}

function renderCalendarAppointment(item) {
  const patient = findPatientByNameOrCode(item.patientName, item.patientCode);
  return `
    <button class="appointment-button ${item.id === selectedScheduleId ? "selected" : ""} ${item.visitType === "초진" ? "initial" : "followup"}" data-action="select-schedule" data-id="${item.id}">
      <span>${escapeHTML(item.time)} · ${escapeHTML(item.patientName)}</span>
      <small>${escapeHTML(item.patientCode || patient?.code || item.visitType)} · ${escapeHTML(item.note || item.visitType)}</small>
    </button>
  `;
}

function renderScheduleHistoryPanel(scheduleItem) {
  if (!scheduleItem) {
    return `
      <section class="panel">
        <div class="panel-header"><h2>환자 히스토리</h2></div>
        <div class="panel-body">${emptyState("선택된 예약 없음", "주간 예약표에서 환자를 누르면 과거 차트가 표시됩니다.")}</div>
      </section>
    `;
  }

  const patient = findPatientByNameOrCode(scheduleItem.patientName, scheduleItem.patientCode);
  const visits = patient
    ? state.visits
        .filter((visit) => visit.patientId === patient.id)
        .sort((a, b) => `${b.date} ${b.time}`.localeCompare(`${a.date} ${a.time}`))
    : [];

  return `
    <section class="panel history-panel">
      <div class="panel-header">
        <div>
          <h2>${escapeHTML(scheduleItem.patientName)}</h2>
          <p class="note">${escapeHTML(scheduleItem.date)} ${escapeHTML(scheduleItem.time)} · ${escapeHTML(scheduleItem.visitType)} · ${escapeHTML(scheduleItem.note || "메모 없음")}</p>
        </div>
        <span class="badge ${scheduleItem.visitType === "초진" ? "new" : "follow"}">${escapeHTML(patient?.code || "신규")}</span>
      </div>
      <div class="panel-body">
        ${
          patient
            ? `
              <div class="patient-brief">
                <div><span>부위</span><strong>${escapeHTML(patient.region || "미정")}</strong></div>
                <div><span>Flags</span><strong>${escapeHTML(patient.flags || "없음")}</strong></div>
              </div>
              <div class="split-actions">
                <button class="small-button" data-action="select-patient" data-id="${patient.id}">환자 정보</button>
                <button class="small-button" data-action="open-patient-visits" data-id="${patient.id}">방문 기록</button>
                ${scheduleItem.matchedVisitId ? `<button class="small-button" data-action="open-visit" data-id="${scheduleItem.matchedVisitId}">오늘 기록</button>` : ""}
              </div>
              <div class="history-list">
                ${
                  visits.length
                    ? visits.map(renderHistoryVisit).join("")
                    : emptyState("과거 차트 없음", "방문 기록이 생기면 이 영역에 시간순으로 쌓입니다.")
                }
              </div>
            `
            : `
              ${emptyState("등록되지 않은 환자", "신규 환자면 초진 후 환자 정보와 방문 기록을 생성하세요.")}
              <div class="split-actions">
                <button class="small-button" data-action="go-inbox">초진 정보 업로드</button>
              </div>
            `
        }
      </div>
    </section>
  `;
}

function renderHistoryVisit(visit) {
  const tracking = visit.tracking?.map((item) => `${item.name}: ${item.value}`).join("; ") || "";
  return `
    <article class="history-visit">
      <div class="item-top">
        <div>
          <h3>${escapeHTML(visit.date)} ${escapeHTML(visit.time)} · ${escapeHTML(visit.visitType)}</h3>
          <div class="meta">${escapeHTML(visit.summary || "요약 없음")}</div>
        </div>
        <button class="small-button" data-action="open-visit" data-id="${visit.id}">열기</button>
      </div>
      ${tracking ? `<p class="note">${escapeHTML(tracking)}</p>` : ""}
      <div class="draft-box mini">${escapeHTML(visit.draft || "차트 초안 없음")}</div>
    </article>
  `;
}

function renderScheduleItem(item) {
  const patient = findPatientByNameOrCode(item.patientName, item.patientCode);
  return `
    <article class="item">
      <div class="item-top">
        <div>
          <h3>${escapeHTML(item.time)} · ${escapeHTML(item.patientName)}</h3>
          <div class="meta">${escapeHTML(item.patientCode || patient?.code || "코드 없음")} · ${escapeHTML(item.note || "메모 없음")}</div>
        </div>
        <span class="badge ${item.visitType === "초진" ? "new" : "follow"}">${escapeHTML(item.visitType)}</span>
      </div>
      <div class="badge-row">
        <span class="badge ${item.status === "matched" ? "follow" : "warn"}">${item.status === "matched" ? "matched" : "pending"}</span>
        ${item.matchedVisitId ? `<button class="small-button" data-action="open-visit" data-id="${item.matchedVisitId}">기록</button>` : ""}
      </div>
    </article>
  `;
}

function renderInboxMatchCard(item) {
  const match = item.type === "transcript" ? findBestScheduleForInbox(item) : null;
  return `
    <article class="item">
      <div class="item-top">
        <div>
          <h3>${escapeHTML(item.fileName)}</h3>
          <div class="meta">${escapeHTML(item.recordedDate || item.createdAt.slice(0, 10))} ${escapeHTML(item.recordedTime || "")} · ${escapeHTML(item.patientHint || "환자 힌트 없음")}</div>
        </div>
        <span class="badge">${escapeHTML(item.type)}</span>
      </div>
      ${
        match
          ? `<div class="badge-row"><span class="badge follow">후보 ${escapeHTML(match.item.time)} ${escapeHTML(match.item.patientName)}</span><span class="badge warn">score <span class="match-score">${Math.round(match.score)}</span></span></div>`
          : `<p class="note">자동 후보가 없습니다.</p>`
      }
      <div class="split-actions">
        <button class="small-button" data-action="preview-inbox" data-id="${item.id}">보기</button>
        ${
          item.type === "transcript"
            ? `<button class="primary-button" data-action="create-visit" data-id="${item.id}" data-schedule="${match?.item.id || ""}">방문 기록 생성</button>`
            : ""
        }
      </div>
    </article>
  `;
}

function renderInbox() {
  const container = document.getElementById("inboxView");
  const newItems = state.rawInbox.filter((item) => item.status === "new");
  const processed = state.rawInbox.filter((item) => item.status !== "new");

  container.innerHTML = `
    ${renderWorkflowImportLanes()}
    <div class="grid two">
      <section class="panel">
        <div class="panel-header">
          <h2>처리 대기</h2>
          <span class="badge warn">${newItems.length}</span>
        </div>
        <div class="panel-body">
          <div class="list compact-list">
            ${newItems.length ? newItems.map(renderInboxMatchCard).join("") : emptyState("대기 항목 없음", "Whisper transcript나 초진 차트가 여기에 쌓입니다.")}
          </div>
        </div>
      </section>

      <section class="panel">
        <div class="panel-header">
          <h2>처리 완료</h2>
          <span class="badge">${processed.length}</span>
        </div>
        <div class="panel-body">
          <div class="list compact-list">
            ${processed.length ? processed.map(renderProcessedInbox).join("") : emptyState("처리 완료 없음", "방문 기록으로 변환된 항목이 표시됩니다.")}
          </div>
        </div>
      </section>
    </div>
  `;
}

function renderProcessedInbox(item) {
  return `
    <article class="item">
      <div class="item-top">
        <div>
          <h3>${escapeHTML(item.fileName)}</h3>
          <div class="meta">${escapeHTML(item.status)} · ${escapeHTML(item.createdAt.slice(0, 10))}</div>
        </div>
        ${item.matchedVisitId ? `<button class="small-button" data-action="open-visit" data-id="${item.matchedVisitId}">방문 기록</button>` : ""}
      </div>
    </article>
  `;
}

function renderPatients(query = "") {
  const container = document.getElementById("patientsView");
  const patients = state.patients.filter((patient) => {
    return !query || JSON.stringify(patient).toLowerCase().includes(query);
  });
  const selected = state.patients.find((patient) => patient.id === selectedPatientId) || patients[0];
  if (selected && !selectedPatientId) selectedPatientId = selected.id;

  container.innerHTML = `
    <div class="grid two">
      <section class="panel">
        <div class="panel-header">
          <h2>환자 목록</h2>
          <button class="small-button" data-action="new-patient">신규</button>
        </div>
        <div class="panel-body">
          <div class="list">
            ${patients.length ? patients.map(renderPatientItem).join("") : emptyState("환자 없음", "신규 환자를 추가하세요.")}
          </div>
        </div>
      </section>

      <section class="panel">
        <div class="panel-header">
          <h2>환자 정보</h2>
          ${selected ? `<button class="small-button" data-action="open-patient-visits" data-id="${selected.id}">방문</button>` : ""}
        </div>
        <div class="panel-body">
          ${selected ? renderPatientForm(selected) : emptyState("선택된 환자 없음", "왼쪽 목록에서 환자를 선택하세요.")}
        </div>
      </section>
    </div>
  `;
}

function renderPatientItem(patient) {
  const visits = state.visits.filter((visit) => visit.patientId === patient.id);
  return `
    <article class="item ${patient.id === selectedPatientId ? "selected" : ""}" data-action="select-patient" data-id="${patient.id}">
      <div class="item-top">
        <div>
          <h3>${escapeHTML(patient.code)} · ${escapeHTML(patient.name)}</h3>
          <div class="meta">${escapeHTML(patient.age || "?")}세 · ${escapeHTML(patient.sex || "?")} · ${escapeHTML(patient.region || "region 없음")}</div>
        </div>
        <span class="badge">${visits.length} visits</span>
      </div>
      <div class="badge-row">${(patient.flags || "").split(",").filter(Boolean).map((flag) => `<span class="badge">${escapeHTML(flag.trim())}</span>`).join("")}</div>
    </article>
  `;
}

function renderPatientForm(patient) {
  return `
    <form class="stack" id="patientForm" data-id="${patient.id}">
      <div class="field-grid">
        <div class="field">
          <label for="patientCode">코드</label>
          <input id="patientCode" value="${escapeHTML(patient.code)}" />
        </div>
        <div class="field">
          <label for="patientName">이름</label>
          <input id="patientName" value="${escapeHTML(patient.name)}" />
        </div>
      </div>
      <div class="field-grid three">
        <div class="field">
          <label for="patientAge">나이</label>
          <input id="patientAge" value="${escapeHTML(patient.age)}" />
        </div>
        <div class="field">
          <label for="patientSex">성별</label>
          <select id="patientSex">
            ${["", "F", "M"].map((value) => `<option value="${value}" ${patient.sex === value ? "selected" : ""}>${value || "미지정"}</option>`).join("")}
          </select>
        </div>
        <div class="field">
          <label for="patientRegion">부위</label>
          <input id="patientRegion" value="${escapeHTML(patient.region)}" />
        </div>
      </div>
      <div class="field">
        <label for="patientFlags">Flags</label>
        <input id="patientFlags" value="${escapeHTML(patient.flags)}" />
      </div>
      <button class="primary-button" type="submit">저장</button>
    </form>
  `;
}

function renderVisits(query = "") {
  const container = document.getElementById("visitsView");
  const visits = state.visits.filter((visit) => {
    const patient = state.patients.find((item) => item.id === visit.patientId);
    return !query || `${JSON.stringify(visit)} ${JSON.stringify(patient)}`.toLowerCase().includes(query);
  });
  const selected = state.visits.find((visit) => visit.id === selectedVisitId) || visits[0];
  if (selected && !selectedVisitId) selectedVisitId = selected.id;

  container.innerHTML = `
    <div class="grid two">
      <section class="panel">
        <div class="panel-header">
          <h2>방문 타임라인</h2>
          <button class="small-button" data-action="new-manual-visit">수동 추가</button>
        </div>
        <div class="panel-body">
          <div class="list">
            ${visits.length ? visits.map(renderVisitItem).join("") : emptyState("방문 기록 없음", "Import Inbox에서 transcript를 방문 기록으로 변환하세요.")}
          </div>
        </div>
      </section>

      <section class="panel">
        <div class="panel-header">
          <h2>브리핑 / 차트 초안</h2>
          ${selected ? `<button class="small-button" data-action="regenerate-draft" data-id="${selected.id}">재생성</button>` : ""}
        </div>
        <div class="panel-body">
          ${selected ? renderVisitEditor(selected) : emptyState("선택된 방문 없음", "방문 기록을 선택하세요.")}
        </div>
      </section>
    </div>
  `;
}

function renderVisitItem(visit) {
  const patient = state.patients.find((item) => item.id === visit.patientId);
  return `
    <article class="item ${visit.id === selectedVisitId ? "selected" : ""}" data-action="select-visit" data-id="${visit.id}">
      <div class="item-top">
        <div>
          <h3>${escapeHTML(visit.date)} ${escapeHTML(visit.time)} · ${escapeHTML(patient?.name || "환자 없음")}</h3>
          <div class="meta">${escapeHTML(patient?.code || "")} · ${escapeHTML(visit.visitType)}</div>
        </div>
        <span class="badge ${visit.confirmed ? "follow" : "warn"}">${visit.confirmed ? "confirmed" : "draft"}</span>
      </div>
      <p class="note">${escapeHTML(visit.summary || "summary 없음")}</p>
      <div class="badge-row">${visit.tracking.slice(0, 4).map((item) => `<span class="badge">${escapeHTML(item.name)}</span>`).join("")}</div>
    </article>
  `;
}

function renderVisitEditor(visit) {
  const patient = state.patients.find((item) => item.id === visit.patientId);
  return `
    <form class="stack" id="visitForm" data-id="${visit.id}">
      <div class="field-grid three">
        <div class="field">
          <label>환자</label>
          <input value="${escapeHTML(patient?.code || "")} · ${escapeHTML(patient?.name || "")}" disabled />
        </div>
        <div class="field">
          <label for="visitDate">날짜</label>
          <input id="visitDate" type="date" value="${escapeHTML(visit.date)}" />
        </div>
        <div class="field">
          <label for="visitTime">시간</label>
          <input id="visitTime" type="time" value="${escapeHTML(visit.time)}" />
        </div>
      </div>

      <div class="field">
        <label for="visitSummary">요약</label>
        <textarea id="visitSummary" data-learnable="true">${escapeHTML(visit.summary)}</textarea>
      </div>

      <div class="field-grid">
        <div class="field">
          <label for="visitSignals">Signal</label>
          <textarea id="visitSignals" data-learnable="true">${escapeHTML(visit.signals.join("\n"))}</textarea>
        </div>
        <div class="field">
          <label for="visitTracking">Tracking variables</label>
          <textarea id="visitTracking" data-learnable="true">${escapeHTML(visit.tracking.map((item) => `${item.name}: ${item.value}`).join("\n"))}</textarea>
        </div>
      </div>

      <div class="field-grid">
        <div class="field">
          <label for="visitTreatment">치료</label>
          <textarea id="visitTreatment" data-learnable="true">${escapeHTML(visit.treatment)}</textarea>
        </div>
        <div class="field">
          <label for="visitHomework">HEP / 숙제</label>
          <textarea id="visitHomework" data-learnable="true">${escapeHTML(visit.homework)}</textarea>
        </div>
      </div>

      <div class="field">
        <label for="visitNext">다음 확인</label>
        <textarea id="visitNext" data-learnable="true">${escapeHTML(visit.nextFocus)}</textarea>
      </div>

      <div class="field">
        <label for="visitDraft">차트 초안</label>
        <textarea id="visitDraft" data-learnable="true">${escapeHTML(visit.draft)}</textarea>
      </div>

      ${renderLearningPanel(visit)}

      <div class="split-actions">
        <button class="ghost-button" type="button" data-action="copy-draft" data-id="${visit.id}">복사</button>
        <button class="primary-button" type="submit">저장</button>
      </div>
    </form>

    <div class="panel" style="box-shadow:none;margin-top:14px;">
      <div class="panel-header"><h3>원문 transcript</h3></div>
      <div class="panel-body"><div class="transcript">${escapeHTML(visit.transcript || "원문 없음")}</div></div>
    </div>
  `;
}

function renderLearningPanel(visit) {
  return `
    <section class="learning-panel">
      <div class="learning-head">
        <div>
          <strong>표현 기억</strong>
          <span>텍스트를 선택하거나 원문/표준 표현을 입력해서 사전에 쌓습니다.</span>
        </div>
        <button class="small-button" type="button" data-action="capture-selection">선택 표현 가져오기</button>
      </div>
      <div class="learning-grid">
        <input id="learnFrom" value="${escapeHTML(learningDraft.from)}" placeholder="원본: 발구수 / 버그스 / 바스" />
        <input id="learnTo" value="${escapeHTML(learningDraft.to)}" placeholder="표준: valgus / VAS / HEP" />
        <input id="learnChart" value="${escapeHTML(learningDraft.chart)}" placeholder="차트 표현: dynamic knee valgus" />
        <select id="learnCategory">
          ${["movement", "symptom", "exercise", "compensation", "behavior", "chart"].map((value) => `<option value="${value}" ${learningDraft.category === value ? "selected" : ""}>${value}</option>`).join("")}
        </select>
        <button class="primary-button" type="button" data-action="remember-correction" data-id="${visit.id}">기억</button>
      </div>
      <div class="learned-suggestions">
        ${renderCorrectionSuggestions(visit)}
      </div>
    </section>
  `;
}

function renderCorrectionSuggestions(visit) {
  const transcript = visit.transcript || "";
  const suggestions = state.terms
    .filter((term) => term.from && transcript.includes(term.from))
    .slice(0, 6);
  if (!suggestions.length) {
    return `<span class="note">예: 발거스, 발구수, 버그스처럼 여러 원본을 모두 valgus로 기억시킬 수 있습니다.</span>`;
  }
  return suggestions
    .map((term) => `<span class="badge">${escapeHTML(term.from)} → ${escapeHTML(term.to)}</span>`)
    .join("");
}

function renderTerms() {
  const container = document.getElementById("termsView");
  container.innerHTML = `
    <div class="grid two">
      <section class="panel">
        <div class="panel-header">
          <h2>보정 추가</h2>
        </div>
        <div class="panel-body">
          <form class="stack" id="termForm">
            <div class="field-grid">
              <div class="field">
                <label for="termFrom">들리는 표현</label>
                <input id="termFrom" placeholder="발거스" required />
              </div>
              <div class="field">
                <label for="termTo">표준 표현</label>
                <input id="termTo" placeholder="valgus" required />
              </div>
            </div>
            <div class="field-grid">
              <div class="field">
                <label for="termChart">차트 표현</label>
                <input id="termChart" placeholder="dynamic knee valgus" />
              </div>
              <div class="field">
                <label for="termCategory">분류</label>
                <input id="termCategory" placeholder="movement" />
              </div>
            </div>
            <button class="primary-button" type="submit">추가</button>
          </form>
        </div>
      </section>

      <section class="panel">
        <div class="panel-header">
          <h2>전사 보정 테스트</h2>
        </div>
        <div class="panel-body">
          <div class="stack">
            <textarea id="termTestInput" placeholder="해피 못했고 발거스 남음"></textarea>
            <button class="ghost-button" data-action="test-terms">보정 적용</button>
            <div class="draft-box" id="termTestOutput"></div>
          </div>
        </div>
      </section>
    </div>

    <section class="panel" style="margin-top:14px;">
      <div class="panel-header">
        <div>
          <h2>용어 목록</h2>
          <p class="note">수정 이력 ${state.correctionHistory.length}개</p>
        </div>
        <span class="badge">${state.terms.length}</span>
      </div>
      <div class="panel-body">
        <table class="table">
          <thead><tr><th>들리는 표현</th><th>표준</th><th>차트 표현</th><th>분류</th><th>횟수</th><th></th></tr></thead>
          <tbody>
            ${state.terms.map((term) => `
              <tr>
                <td>${escapeHTML(term.from)}</td>
                <td>${escapeHTML(term.to)}</td>
                <td>${escapeHTML(term.chart)}</td>
                <td>${escapeHTML(term.category)}</td>
                <td>${escapeHTML(term.count || "")}</td>
                <td><button class="small-button" data-action="delete-term" data-id="${term.id}">삭제</button></td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

function renderSettings() {
  const container = document.getElementById("settingsView");
  const hasKey = Boolean(getSupabaseConfig().key);
  const signedIn = Boolean(supabaseSession?.access_token);
  container.innerHTML = `
    <div class="grid two">
      <section class="panel">
        <div class="panel-header">
          <h2>Supabase 연결</h2>
          <span class="badge ${signedIn ? "follow" : hasKey ? "warn" : "stop"}">${signedIn ? "signed in" : hasKey ? "key ready" : "key needed"}</span>
        </div>
        <div class="panel-body">
          <form class="stack" id="settingsForm">
            <p class="note">Project URL과 publishable key를 로컬 설정으로 읽습니다. service_role key는 여기에 넣지 않습니다.</p>
            <div class="field">
              <label for="supabaseUrl">Project URL</label>
              <input id="supabaseUrl" value="${escapeHTML(state.settings.supabaseUrl)}" placeholder="https://xxxxx.supabase.co" />
            </div>
            <div class="field">
              <label for="supabaseAnonKey">Anon key</label>
              <input id="supabaseAnonKey" value="${escapeHTML(state.settings.supabaseAnonKey)}" placeholder="나중에 연결" />
            </div>
            <div class="field">
              <label for="defaultChartStyle">차트 스타일</label>
              <select id="defaultChartStyle">
                ${["SOAP-lite", "간결한 한국어", "혼합 영어 용어"].map((value) => `<option value="${value}" ${state.settings.defaultChartStyle === value ? "selected" : ""}>${value}</option>`).join("")}
              </select>
            </div>
            <button class="primary-button" type="submit">저장</button>
          </form>
        </div>
      </section>

      <section class="panel">
        <div class="panel-header">
          <h2>로그인 / 동기화</h2>
          <span class="badge">${signedIn ? escapeHTML(supabaseSession.user?.email || "user") : "local only"}</span>
        </div>
        <div class="panel-body">
          <form class="stack" id="supabaseAuthForm">
            <p class="note">Supabase SQL Editor에서 <span class="code">supabase-schema.sql</span>을 먼저 실행한 뒤 사용하세요. 로그인하면 RLS 정책이 내 데이터만 읽고 쓰게 합니다.</p>
            <div class="field-grid">
              <div class="field">
                <label for="supabaseEmail">Email</label>
                <input id="supabaseEmail" type="email" placeholder="you@example.com" autocomplete="email" />
              </div>
              <div class="field">
                <label for="supabasePassword">Password</label>
                <input id="supabasePassword" type="password" placeholder="8자 이상 권장" autocomplete="current-password" />
              </div>
            </div>
            <div class="row wrap">
              <button class="primary-button" type="submit">로그인</button>
              <button class="ghost-button" type="button" data-action="supabase-signup">계정 만들기</button>
              <button class="ghost-button" type="button" data-action="supabase-upload">클라우드 저장</button>
              <button class="ghost-button" type="button" data-action="supabase-download">최신 데이터 불러오기</button>
              <button class="ghost-button" type="button" data-action="supabase-import-inbox">클라우드 Inbox 가져오기</button>
              <button class="danger-button" type="button" data-action="supabase-signout">로그아웃</button>
            </div>
          </form>
        </div>
      </section>
    </div>

    <div class="grid two" style="margin-top:14px;">
      <section class="panel">
        <div class="panel-header">
          <h2>자동화 파이프라인</h2>
        </div>
        <div class="panel-body">
          <div class="list">
            ${pipelineStep("1", "Whisper Memos", "Apple Watch/iPhone 녹음 후 iCloud transcript export")}
            ${pipelineStep("2", "MacBook watcher", "iCloud 텍스트 파일을 감시해서 raw_inbox로 업로드")}
            ${pipelineStep("3", "Schedule OCR", "스케줄 캡쳐에서 시간/환자/초진 여부 추출")}
            ${pipelineStep("4", "Match engine", "녹음 시간 + 환자 힌트 + 예약표로 방문 후보 매칭")}
            ${pipelineStep("5", "Review Inbox", "최종 확정 전 차트 초안 확인")}
          </div>
        </div>
      </section>

      <section class="panel">
        <div class="panel-header">
          <h2>현재 전략</h2>
          <span class="badge">snapshot sync</span>
        </div>
        <div class="panel-body">
          <div class="list">
            ${pipelineStep("A", "지금", "localStorage 앱 상태를 Supabase app_snapshots 테이블에 통째로 백업/복원")}
            ${pipelineStep("B", "다음", "환자/방문/용어 테이블을 개별 upsert 방식으로 전환")}
            ${pipelineStep("C", "이후", "Whisper Memos iCloud watcher가 raw_inbox로 자동 업로드")}
          </div>
        </div>
      </section>
    </div>
  `;
}

function pipelineStep(number, title, body) {
  return `
    <article class="item">
      <div class="item-top">
        <div>
          <h3><span class="code">${number}</span> ${escapeHTML(title)}</h3>
          <div class="meta">${escapeHTML(body)}</div>
        </div>
      </div>
    </article>
  `;
}

function emptyState(title, body) {
  return `<div class="empty-state"><strong>${escapeHTML(title)}</strong><span>${escapeHTML(body)}</span></div>`;
}

function attachEvents() {
  document.querySelectorAll(".nav-item").forEach((button) => {
    button.addEventListener("click", () => setView(button.dataset.view));
  });

  document.getElementById("globalSearch").addEventListener("input", render);

  document.body.addEventListener("click", async (event) => {
    const target = event.target.closest("[data-action]");
    if (!target) return;
    const action = target.dataset.action;
    const id = target.dataset.id;

    if (action === "go-inbox") setView("inbox");
    if (action === "lane-clear") clearImportLane(target.dataset.lane);
    if (action === "lane-process") processImportLane(target.dataset.lane);
    if (action === "capture-selection") captureLearningSelection();
    if (action === "remember-correction") handleRememberCorrection(id);
    if (action === "prev-week") {
      dashboardWeekStart = addDays(dashboardWeekStart, -7);
      render();
    }
    if (action === "this-week") {
      dashboardWeekStart = getWeekStartISO(todayISO());
      render();
    }
    if (action === "next-week") {
      dashboardWeekStart = addDays(dashboardWeekStart, 7);
      render();
    }
    if (action === "select-schedule") {
      selectedScheduleId = id;
      const scheduleItem = state.scheduleItems.find((item) => item.id === id);
      const patient = scheduleItem ? findPatientByNameOrCode(scheduleItem.patientName, scheduleItem.patientCode) : null;
      if (patient) selectedPatientId = patient.id;
      render();
    }
    if (action === "select-patient") {
      selectedPatientId = id;
      if (currentView === "patients") {
        render();
      } else {
        setView("patients");
      }
    }
    if (action === "select-visit") {
      selectedVisitId = id;
      render();
    }
    if (action === "open-visit") {
      selectedVisitId = id;
      setView("visits");
    }
    if (action === "open-patient-visits") {
      selectedPatientId = id;
      setView("visits");
    }
    if (action === "new-patient") {
      const nextNumber = String(state.patients.length + 1).padStart(3, "0");
      const patient = {
        id: uid("patient"),
        code: `P${nextNumber}`,
        name: "신규 환자",
        sex: "",
        age: "",
        region: "",
        flags: "",
        createdAt: new Date().toISOString(),
      };
      state.patients.push(patient);
      selectedPatientId = patient.id;
      saveState();
      render();
    }
    if (action === "create-visit") createVisitFromInbox(id, target.dataset.schedule || null);
    if (action === "preview-inbox") {
      const item = state.rawInbox.find((entry) => entry.id === id);
      if (item) {
        alert(`${item.fileName}\n\n${item.correctedText || item.text || item.ocrText || ""}`);
      }
    }
    if (action === "regenerate-draft") {
      const visit = state.visits.find((entry) => entry.id === id);
      const patient = state.patients.find((entry) => entry.id === visit?.patientId);
      if (visit && patient) {
        visit.draft = generateDraft(visit, patient);
        saveState();
        render();
        toast("차트 초안을 다시 만들었습니다.");
      }
    }
    if (action === "copy-draft") {
      const visit = state.visits.find((entry) => entry.id === id);
      if (visit) {
        await navigator.clipboard.writeText(visit.draft);
        toast("차트 초안을 복사했습니다.");
      }
    }
    if (action === "test-terms") {
      const input = document.getElementById("termTestInput").value;
      document.getElementById("termTestOutput").textContent = applyTerms(input);
    }
    if (action === "delete-term") {
      state.terms = state.terms.filter((term) => term.id !== id);
      saveState();
      render();
    }
    if (action === "new-manual-visit") {
      const patient = state.patients.find((entry) => entry.id === selectedPatientId) || state.patients[0];
      if (!patient) return;
      const visit = {
        id: uid("visit"),
        patientId: patient.id,
        date: todayISO(),
        time: nowTime(),
        visitType: "재진",
        sourceInboxId: null,
        transcript: "",
        signals: [],
        secondarySignals: [],
        noise: "",
        tracking: [],
        treatment: "",
        hep: "",
        homework: "",
        nextFocus: "",
        draft: "",
        confirmed: false,
        summary: "",
        createdAt: new Date().toISOString(),
      };
      visit.draft = generateDraft(visit, patient);
      state.visits.unshift(visit);
      selectedVisitId = visit.id;
      saveState();
      render();
    }
    if (action === "supabase-signup") await handleSupabaseSignup();
    if (action === "supabase-signout") {
      saveSupabaseSession(null);
      toast("Supabase에서 로그아웃했습니다.");
      render();
    }
    if (action === "supabase-upload") await uploadSupabaseSnapshot();
    if (action === "supabase-download") await downloadLatestSupabaseSnapshot();
    if (action === "supabase-import-inbox") await importSupabaseInbox();
  });

  document.body.addEventListener("paste", handleImportLanePaste);

  document.body.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.target;
    if (form.id === "transcriptForm") await handleTranscriptForm(form);
    if (form.id === "scheduleForm") await handleScheduleForm(form);
    if (form.id === "doctorChartForm") await handleDoctorChartForm(form);
    if (form.id === "patientForm") handlePatientForm(form);
    if (form.id === "visitForm") handleVisitForm(form);
    if (form.id === "termForm") handleTermForm(form);
    if (form.id === "settingsForm") handleSettingsForm(form);
    if (form.id === "supabaseAuthForm") await handleSupabaseLogin(form);
  });

  document.getElementById("exportDataButton").addEventListener("click", exportData);
  document.getElementById("importDataInput").addEventListener("change", importData);
}

function updateImportLaneFromDOM(laneKey) {
  const lane = importLanes[laneKey];
  if (!lane) return;
  const date = document.getElementById(`laneDate-${laneKey}`)?.value;
  const therapist = document.getElementById(`laneTherapist-${laneKey}`)?.value.trim();
  const patientHint = document.getElementById(`lanePatient-${laneKey}`)?.value.trim();
  const text = document.getElementById(`laneText-${laneKey}`)?.value;
  if (date) lane.date = date;
  if (therapist !== undefined) lane.therapist = therapist;
  if (patientHint !== undefined) lane.patientHint = patientHint;
  if (text !== undefined) lane.text = text;
}

function updateAllImportLanesFromDOM() {
  Object.keys(importLanes).forEach(updateImportLaneFromDOM);
}

async function handleImportLanePaste(event) {
  if (!["dashboard", "inbox"].includes(currentView)) return;
  const laneNode = event.target.closest?.(".paste-lane");
  if (!laneNode) return;
  const laneKey = laneNode.dataset.lane;
  const lane = importLanes[laneKey];
  if (!lane) return;

  const active = document.activeElement;
  const isTypingField =
    active?.matches?.("input, textarea, select") && active.id !== `laneText-${laneKey}`;
  if (isTypingField) return;

  const clipboard = event.clipboardData;
  if (!clipboard) return;

  let changed = false;
  const text = clipboard.getData("text/plain");
  if (text) {
    updateImportLaneFromDOM(laneKey);
    lane.text = [lane.text, text].filter(Boolean).join("\n").trim();
    changed = true;
  }

  const imageItem = [...clipboard.items].find((item) => item.type.startsWith("image/"));
  if (imageItem) {
    const file = imageItem.getAsFile();
    if (file) {
      const preview = await fileToDataURL(file);
      updateImportLaneFromDOM(laneKey);
      lane.imageName = file.name || `pasted-${new Date().toISOString()}.png`;
      lane.imagePreview = preview;
      lane.screenshotCount = (lane.screenshotCount || 0) + 1;
      lane.ocrStatus = "OCR 읽는 중...";
      changed = true;
    }
  }

  if (changed) {
    event.preventDefault();
    toast(imageItem ? "이미지를 읽고 있습니다." : "붙여넣었습니다. 텍스트가 있으면 바로 반영할 수 있습니다.");
    render();
    if (imageItem) await runLaneOcr(laneKey);
  }
}

function clearImportLane(laneKey) {
  const lane = importLanes[laneKey];
  if (!lane) return;
  importLanes[laneKey] = {
    ...makeImportLane(laneKey),
    date: lane.date,
    therapist: lane.therapist,
  };
  render();
}

async function runLaneOcr(laneKey) {
  const lane = importLanes[laneKey];
  if (!lane?.imagePreview) return;
  if (!window.Tesseract?.recognize) {
    lane.ocrStatus = "OCR 엔진 로딩 실패. 텍스트를 붙여넣어 주세요.";
    render();
    return;
  }

  try {
    const result = await window.Tesseract.recognize(lane.imagePreview, "kor+eng", {
      logger: (message) => {
        if (message.status === "recognizing text" && typeof message.progress === "number") {
          lane.ocrStatus = `OCR ${Math.round(message.progress * 100)}%`;
          render();
        }
      },
    });
    const rawText = result?.data?.text?.trim() || "";
    const text =
      lane.kind === "schedule"
        ? (await buildSmartCrmTaggedOcrText(lane.imagePreview, result?.data)) || rawText
        : rawText;
    if (!text) {
      lane.ocrStatus = "OCR 결과 없음. 텍스트를 붙여넣어 주세요.";
      render();
      return;
    }
    lane.text = [lane.text, text].filter(Boolean).join("\n").trim();
    if (lane.kind === "schedule") {
      lane.imageName = "";
      lane.imagePreview = "";
      lane.ocrStatus = `OCR ${lane.screenshotCount || 1}장 누적 · 더 붙여넣거나 반영`;
      render();
      return;
    }
    lane.ocrStatus = "OCR 완료, 자동 반영 중";
    render();
    processImportLane(laneKey, { auto: true });
  } catch (error) {
    lane.ocrStatus = "OCR 실패. 텍스트를 붙여넣어 주세요.";
    toast(`OCR 실패: ${error.message}`);
    render();
  }
}

async function buildSmartCrmTaggedOcrText(imageSrc, ocrData) {
  const lines = collectOcrLines(ocrData);
  if (!imageSrc || !lines.length) return "";

  try {
    const image = await loadImageElement(imageSrc);
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth || image.width;
    canvas.height = image.naturalHeight || image.height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return "";
    context.drawImage(image, 0, 0, canvas.width, canvas.height);

    return lines
      .map((line) => {
        const text = line.text.trim();
        if (!text) return "";
        const status = classifySmartCrmLineStatus(context, line);
        return status ? `${text} [상태:${status}]` : text;
      })
      .filter(Boolean)
      .join("\n");
  } catch {
    return "";
  }
}

function collectOcrLines(ocrData) {
  const directLines = Array.isArray(ocrData?.lines) ? ocrData.lines : [];
  const nestedLines = Array.isArray(ocrData?.blocks)
    ? ocrData.blocks.flatMap((block) => {
        return (block.paragraphs || []).flatMap((paragraph) => paragraph.lines || []);
      })
    : [];
  const lines = [...directLines, ...nestedLines]
    .map((line) => {
      const words = collectOcrWords(line);
      return {
        text: getOcrEntityText(line) || words.map(getOcrEntityText).filter(Boolean).join(" "),
        words,
        bbox: normalizeOcrBbox(line.bbox),
      };
    })
    .filter((line) => line.text.trim());

  if (lines.length) return dedupeOcrLines(lines);

  const words = collectOcrWords(ocrData).filter((word) => getOcrEntityText(word));
  if (!words.length) return [];
  const sorted = words.sort((a, b) => {
    const abox = normalizeOcrBbox(a.bbox);
    const bbox = normalizeOcrBbox(b.bbox);
    return centerOfBox(abox).y - centerOfBox(bbox).y || centerOfBox(abox).x - centerOfBox(bbox).x;
  });
  const grouped = [];
  sorted.forEach((word) => {
    const box = normalizeOcrBbox(word.bbox);
    const center = centerOfBox(box);
    const line = grouped.find((candidate) => Math.abs(candidate.centerY - center.y) < 12);
    if (line) {
      line.words.push(word);
      line.centerY = (line.centerY + center.y) / 2;
    } else {
      grouped.push({ centerY: center.y, words: [word] });
    }
  });

  return grouped.map((line) => {
    const lineWords = line.words.sort((a, b) => centerOfBox(normalizeOcrBbox(a.bbox)).x - centerOfBox(normalizeOcrBbox(b.bbox)).x);
    return {
      text: lineWords.map(getOcrEntityText).filter(Boolean).join(" "),
      words: lineWords,
      bbox: mergeOcrBoxes(lineWords.map((word) => normalizeOcrBbox(word.bbox))),
    };
  });
}

function dedupeOcrLines(lines) {
  const seen = new Set();
  return lines.filter((line) => {
    const box = line.bbox;
    const key = `${line.text}|${Math.round(box.x0)}|${Math.round(box.y0)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function collectOcrWords(entity) {
  if (!entity) return [];
  if (Array.isArray(entity.words)) return entity.words;
  if (Array.isArray(entity.symbols)) return entity.symbols;
  if (Array.isArray(entity.blocks)) {
    return entity.blocks.flatMap(collectOcrWords);
  }
  if (Array.isArray(entity.paragraphs)) {
    return entity.paragraphs.flatMap(collectOcrWords);
  }
  if (Array.isArray(entity.lines)) {
    return entity.lines.flatMap(collectOcrWords);
  }
  return [];
}

function getOcrEntityText(entity) {
  return String(entity?.text || entity?.symbol || "").trim();
}

function normalizeOcrBbox(bbox) {
  if (!bbox) return { x0: 0, y0: 0, x1: 0, y1: 0 };
  return {
    x0: Number(bbox.x0 ?? bbox.left ?? bbox.x ?? 0),
    y0: Number(bbox.y0 ?? bbox.top ?? bbox.y ?? 0),
    x1: Number(bbox.x1 ?? (bbox.left ?? bbox.x ?? 0) + (bbox.width ?? 0)),
    y1: Number(bbox.y1 ?? (bbox.top ?? bbox.y ?? 0) + (bbox.height ?? 0)),
  };
}

function mergeOcrBoxes(boxes) {
  const valid = boxes.filter((box) => box.x1 > box.x0 && box.y1 > box.y0);
  if (!valid.length) return { x0: 0, y0: 0, x1: 0, y1: 0 };
  return {
    x0: Math.min(...valid.map((box) => box.x0)),
    y0: Math.min(...valid.map((box) => box.y0)),
    x1: Math.max(...valid.map((box) => box.x1)),
    y1: Math.max(...valid.map((box) => box.y1)),
  };
}

function centerOfBox(box) {
  return {
    x: (box.x0 + box.x1) / 2,
    y: (box.y0 + box.y1) / 2,
  };
}

function classifySmartCrmLineStatus(context, line) {
  const timeWord = (line.words || []).find((word) => findSmartCrmTimeMatches(getOcrEntityText(word)).length);
  if (!timeWord) return "";
  const box = normalizeOcrBbox(timeWord.bbox || line.bbox);
  const color = sampleSmartCrmBackground(context, box);
  return classifySmartCrmColor(color);
}

function sampleSmartCrmBackground(context, box) {
  const canvas = context.canvas;
  const x0 = Math.max(0, Math.floor(box.x0 - 10));
  const y0 = Math.max(0, Math.floor(box.y0 - 6));
  const x1 = Math.min(canvas.width, Math.ceil(box.x1 + 80));
  const y1 = Math.min(canvas.height, Math.ceil(box.y1 + 8));
  const width = Math.max(1, x1 - x0);
  const height = Math.max(1, y1 - y0);
  const pixels = context.getImageData(x0, y0, width, height).data;
  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;

  for (let index = 0; index < pixels.length; index += 4) {
    const red = pixels[index];
    const green = pixels[index + 1];
    const blue = pixels[index + 2];
    const max = Math.max(red, green, blue);
    const min = Math.min(red, green, blue);
    const brightness = (red + green + blue) / 3;
    const saturation = max ? (max - min) / max : 0;
    if (brightness < 80 || brightness > 248 || saturation < 0.08) continue;
    r += red;
    g += green;
    b += blue;
    count += 1;
  }

  if (!count) return null;
  return {
    r: r / count,
    g: g / count,
    b: b / count,
  };
}

function classifySmartCrmColor(color) {
  if (!color) return "";
  const { r, g, b } = color;
  if (r > 190 && g > 165 && b < 165) return "신규";
  if (g > r + 25 && g > b + 15) return "예약";
  if (b > r + 18 && b > g + 8) return "완료";
  if (r > g + 25 && r > b + 8) return "취소";
  return "";
}

function loadImageElement(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = src;
  });
}

function captureLearningSelection() {
  const active = document.activeElement;
  if (!active?.matches?.("textarea[data-learnable='true'], input[data-learnable='true']")) {
    toast("수정할 텍스트를 먼저 선택하세요.");
    return;
  }
  const selected = active.value.slice(active.selectionStart, active.selectionEnd).trim();
  if (!selected) {
    toast("선택된 표현이 없습니다.");
    return;
  }
  learningDraft = {
    ...learningDraft,
    from: selected,
    to: learningDraft.to || "",
    chart: learningDraft.chart || "",
    fieldId: active.id,
  };
  render();
  toast("선택 표현을 가져왔습니다.");
}

function readLearningInputs() {
  return {
    from: document.getElementById("learnFrom")?.value.trim() || "",
    to: document.getElementById("learnTo")?.value.trim() || "",
    chart: document.getElementById("learnChart")?.value.trim() || "",
    category: document.getElementById("learnCategory")?.value || "learned",
  };
}

function handleRememberCorrection(visitId) {
  const values = readLearningInputs();
  if (!values.from || !values.to) {
    toast("원본 표현과 표준 표현이 필요합니다.");
    return;
  }

  const didRemember = rememberCorrection({
    ...values,
    visitId,
    fieldId: learningDraft.fieldId,
  });
  if (!didRemember) return;

  applyLearnedCorrectionToOpenFields(values.from, values.to);
  learningDraft = {
    from: "",
    to: "",
    chart: "",
    category: values.category,
    fieldId: "",
  };
  saveState();
  toast(`기억했습니다: ${values.from} → ${values.to}`);
  render();
}

function applyLearnedCorrectionToOpenFields(from, to) {
  document.querySelectorAll("textarea[data-learnable='true']").forEach((field) => {
    if (field.value.includes(from)) {
      field.value = field.value.replaceAll(from, to);
    }
  });
}

function fileToDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function processImportLane(laneKey, options = {}) {
  const auto = Boolean(options.auto);
  updateAllImportLanesFromDOM();
  const lane = importLanes[laneKey];
  if (!lane) return;

  if (lane.kind === "schedule") {
    const sourceFile = lane.sourceFile;
    const items = parseSmartCrmScheduleText(
      lane.text,
      lane.date,
      lane.therapist,
      sourceFile,
    );

    if (!items.length) {
      toast(
        lane.imagePreview
          ? "OCR은 끝났지만 스케줄 시간/환자명을 읽지 못했습니다. 텍스트를 확인해 주세요."
          : "스케줄로 읽을 수 있는 시간/환자명이 없습니다.",
      );
      lane.ocrStatus = "반영 실패, 텍스트 확인 필요";
      render();
      return;
    }

    const parsedDates = new Set(items.map((item) => item.date || lane.date));
    state.scheduleItems = [
      ...items,
      ...state.scheduleItems.filter((item) => {
        const managedSource = ["smart crm paste", "smart crm quick import", sourceFile].includes(item.sourceFile);
        return !parsedDates.has(item.date) || !managedSource;
      }),
    ];
    dashboardWeekStart = getWeekStartISO(items[0]?.date || lane.date);
    selectedScheduleId = items[0]?.id || selectedScheduleId;
    lane.text = "";
    lane.imageName = "";
    lane.imagePreview = "";
    lane.screenshotCount = 0;
    lane.ocrStatus = auto ? "OCR 자동 반영 완료" : "";
    saveState();
    toast(`${lane.title}: ${items.length}개 예약을 반영했습니다.`);
    render();
    return;
  }

  if (lane.kind === "doctor_chart") {
    if (!lane.text.trim()) {
      toast(
        lane.imagePreview
          ? "OCR은 끝났지만 초진 차트 텍스트가 비어 있습니다. 텍스트를 확인해 주세요."
          : "초진 차트 텍스트가 필요합니다.",
      );
      lane.ocrStatus = "반영 실패, 텍스트 확인 필요";
      render();
      return;
    }

    let patient = findPatientByNameOrCode(lane.patientHint, lane.patientHint);
    if (!patient && lane.patientHint) {
      const nextNumber = String(state.patients.length + 1).padStart(3, "0");
      patient = {
        id: uid("patient"),
        code: lane.patientHint.startsWith("P") ? lane.patientHint : `P${nextNumber}`,
        name: lane.patientHint.startsWith("P") ? "신규 환자" : lane.patientHint,
        sex: "",
        age: "",
        region: inferRegion(lane.text),
        flags: "doctor chart imported",
        createdAt: new Date().toISOString(),
      };
      state.patients.push(patient);
    }

    state.rawInbox.unshift({
      id: uid("inbox"),
      type: "doctor_chart",
      fileName: lane.imageName || "doctor_chart_paste",
      createdAt: new Date().toISOString(),
      recordedDate: lane.date,
      patientHint: lane.patientHint,
      patientId: patient?.id || null,
      ocrText: lane.text,
      status: "uploaded",
      matchedVisitId: null,
    });

    lane.text = "";
    lane.patientHint = "";
    lane.imageName = "";
    lane.imagePreview = "";
    lane.ocrStatus = auto ? "OCR 자동 반영 완료" : "";
    saveState();
    toast("초진 차트 정보를 Inbox에 반영했습니다.");
    render();
  }
}

async function handleTranscriptForm(form) {
  const date = form.querySelector("#transcriptDate").value;
  const time = form.querySelector("#transcriptTime").value;
  const file = form.querySelector("#transcriptFile").files[0];
  let text = form.querySelector("#transcriptText").value.trim();
  let fileName = "manual_transcript.txt";

  if (file) {
    text = await file.text();
    fileName = file.name;
  }
  if (!text) {
    toast("전사 텍스트가 필요합니다.");
    return;
  }
  state.rawInbox.unshift(parseTranscriptMeta(text, fileName, date, time));
  saveState();
  form.reset();
  toast("Transcript를 Inbox에 추가했습니다.");
  render();
}

async function handleScheduleForm(form) {
  const date = form.querySelector("#scheduleDate").value;
  const file = form.querySelector("#scheduleImage").files[0];
  const text = form.querySelector("#scheduleText").value.trim();
  const sourceFile = file?.name || "manual schedule";
  const items = parseScheduleText(text, date, sourceFile);

  if (file) {
    state.rawInbox.unshift({
      id: uid("inbox"),
      type: "schedule_capture",
      fileName: file.name,
      createdAt: new Date().toISOString(),
      recordedDate: date,
      ocrText: text,
      status: "uploaded",
      matchedVisitId: null,
    });
  }
  if (items.length) {
    state.scheduleItems = [
      ...items,
      ...state.scheduleItems.filter((item) => item.date !== date || item.sourceFile !== sourceFile),
    ];
  }
  saveState();
  form.reset();
  toast(`${items.length}개 스케줄을 반영했습니다.`);
  render();
}

async function handleDoctorChartForm(form) {
  const patientQuery = form.querySelector("#doctorChartPatient").value.trim();
  const file = form.querySelector("#doctorChartImage").files[0];
  const text = form.querySelector("#doctorChartText").value.trim();
  let patient = findPatientByNameOrCode(patientQuery, patientQuery);

  if (!patient && patientQuery) {
    const nextNumber = String(state.patients.length + 1).padStart(3, "0");
    patient = {
      id: uid("patient"),
      code: patientQuery.startsWith("P") ? patientQuery : `P${nextNumber}`,
      name: patientQuery.startsWith("P") ? "신규 환자" : patientQuery,
      sex: "",
      age: "",
      region: "",
      flags: "",
      createdAt: new Date().toISOString(),
    };
    state.patients.push(patient);
  }

  state.rawInbox.unshift({
    id: uid("inbox"),
    type: "doctor_chart",
    fileName: file?.name || "doctor_chart_capture",
    createdAt: new Date().toISOString(),
    recordedDate: todayISO(),
    patientHint: patientQuery,
    patientId: patient?.id || null,
    ocrText: text,
    status: "uploaded",
    matchedVisitId: null,
  });

  if (patient && text) {
    patient.flags = [patient.flags, "doctor chart imported"].filter(Boolean).join(", ");
    if (!patient.region) patient.region = inferRegion(text);
  }
  saveState();
  form.reset();
  toast("초진 차트 캡쳐 정보를 저장했습니다.");
  render();
}

function inferRegion(text) {
  const regions = ["knee", "shoulder", "neck", "back", "lumbar", "ankle", "hip", "elbow", "wrist"];
  const lower = text.toLowerCase();
  return regions.find((region) => lower.includes(region)) || "";
}

function handlePatientForm(form) {
  const patient = state.patients.find((entry) => entry.id === form.dataset.id);
  if (!patient) return;
  patient.code = form.querySelector("#patientCode").value.trim();
  patient.name = form.querySelector("#patientName").value.trim();
  patient.age = form.querySelector("#patientAge").value.trim();
  patient.sex = form.querySelector("#patientSex").value;
  patient.region = form.querySelector("#patientRegion").value.trim();
  patient.flags = form.querySelector("#patientFlags").value.trim();
  saveState();
  toast("환자 정보를 저장했습니다.");
  render();
}

function handleVisitForm(form) {
  const visit = state.visits.find((entry) => entry.id === form.dataset.id);
  if (!visit) return;
  visit.date = form.querySelector("#visitDate").value;
  visit.time = form.querySelector("#visitTime").value;
  visit.summary = form.querySelector("#visitSummary").value.trim();
  visit.signals = form
    .querySelector("#visitSignals")
    .value.split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  visit.tracking = form
    .querySelector("#visitTracking")
    .value.split(/\n+/)
    .map((line) => {
      const [name, ...rest] = line.split(":");
      return {
        id: uid("track"),
        name: name?.trim() || "tracking",
        value: rest.join(":").trim() || "mentioned",
        trend: "check",
      };
    })
    .filter((item) => item.name);
  visit.treatment = form.querySelector("#visitTreatment").value.trim();
  visit.homework = form.querySelector("#visitHomework").value.trim();
  visit.nextFocus = form.querySelector("#visitNext").value.trim();
  visit.draft = form.querySelector("#visitDraft").value.trim();
  visit.confirmed = true;
  saveState();
  toast("방문 기록을 저장했습니다.");
  render();
}

function handleTermForm(form) {
  state.terms.unshift({
    id: uid("term"),
    from: form.querySelector("#termFrom").value.trim(),
    to: form.querySelector("#termTo").value.trim(),
    chart: form.querySelector("#termChart").value.trim(),
    category: form.querySelector("#termCategory").value.trim(),
  });
  saveState();
  form.reset();
  toast("용어 보정을 추가했습니다.");
  render();
}

function handleSettingsForm(form) {
  state.settings.supabaseUrl = form.querySelector("#supabaseUrl").value.trim();
  state.settings.supabaseAnonKey = form.querySelector("#supabaseAnonKey").value.trim();
  state.settings.defaultChartStyle = form.querySelector("#defaultChartStyle").value;
  saveState();
  toast("설정을 저장했습니다.");
  render();
}

function getAuthFormValues() {
  const form = document.getElementById("supabaseAuthForm");
  return {
    email: form?.querySelector("#supabaseEmail").value.trim() || "",
    password: form?.querySelector("#supabasePassword").value || "",
  };
}

async function handleSupabaseSignup() {
  const { email, password } = getAuthFormValues();
  if (!email || !password) {
    toast("이메일과 비밀번호를 입력하세요.");
    return;
  }
  try {
    const data = await supabaseRequest("/auth/v1/signup", {
      method: "POST",
      body: { email, password },
      auth: false,
    });
    if (data?.access_token) saveSupabaseSession(normalizeSupabaseSession(data));
    toast(data?.access_token ? "계정을 만들고 로그인했습니다." : "계정을 만들었습니다. 이메일 확인 후 로그인하세요.");
    render();
  } catch (error) {
    toast(`계정 생성 실패: ${error.message}`);
  }
}

async function handleSupabaseLogin(form) {
  const email = form.querySelector("#supabaseEmail").value.trim();
  const password = form.querySelector("#supabasePassword").value;
  if (!email || !password) {
    toast("이메일과 비밀번호를 입력하세요.");
    return;
  }
  try {
    const data = await supabaseRequest("/auth/v1/token?grant_type=password", {
      method: "POST",
      body: { email, password },
      auth: false,
    });
    saveSupabaseSession(normalizeSupabaseSession(data));
    toast("Supabase에 로그인했습니다.");
    render();
  } catch (error) {
    toast(`로그인 실패: ${error.message}`);
  }
}

function normalizeSupabaseSession(data) {
  const expiresIn = Number(data.expires_in || 3600);
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Math.floor(Date.now() / 1000) + expiresIn,
    user: data.user || null,
  };
}

async function ensureSupabaseSession() {
  if (!supabaseSession?.access_token) {
    throw new Error("먼저 Supabase에 로그인하세요.");
  }
  const expiresSoon = supabaseSession.expires_at && supabaseSession.expires_at - 60 < Math.floor(Date.now() / 1000);
  if (!expiresSoon || !supabaseSession.refresh_token) return supabaseSession;

  const data = await supabaseRequest("/auth/v1/token?grant_type=refresh_token", {
    method: "POST",
    body: { refresh_token: supabaseSession.refresh_token },
    auth: false,
  });
  saveSupabaseSession(normalizeSupabaseSession(data));
  return supabaseSession;
}

async function supabaseRequest(path, options = {}) {
  const { url, key } = getSupabaseConfig();
  if (!url || !key) throw new Error("Supabase URL/key가 필요합니다.");
  const session = options.auth === false ? null : await ensureSupabaseSession();
  const headers = {
    apikey: key,
    "Content-Type": "application/json",
    ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
    ...(options.headers || {}),
  };

  const response = await fetch(`${url}${path}`, {
    method: options.method || "GET",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  const data = text ? safeJSON(text) : null;
  if (!response.ok) {
    throw new Error(data?.message || data?.error_description || data?.error || response.statusText);
  }
  return data;
}

function safeJSON(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function makeCloudSnapshot() {
  return {
    ...state,
    settings: {
      ...state.settings,
      supabaseAnonKey: "",
    },
  };
}

async function uploadSupabaseSnapshot() {
  try {
    await supabaseRequest("/rest/v1/app_snapshots", {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: {
        label: `manual ${new Date().toISOString()}`,
        data: makeCloudSnapshot(),
      },
    });
    toast("Supabase에 현재 데이터를 저장했습니다.");
  } catch (error) {
    toast(`클라우드 저장 실패: ${error.message}`);
  }
}

async function downloadLatestSupabaseSnapshot() {
  try {
    const rows = await supabaseRequest(
      "/rest/v1/app_snapshots?select=label,created_at,data&order=created_at.desc&limit=1",
    );
    if (!Array.isArray(rows) || rows.length === 0) {
      toast("불러올 클라우드 데이터가 없습니다.");
      return;
    }
    const currentSettings = state.settings;
    state = ensureStateShape(rows[0].data);
    state.settings = {
      ...state.settings,
      supabaseUrl: currentSettings.supabaseUrl,
      supabaseAnonKey: currentSettings.supabaseAnonKey,
    };
    saveState();
    toast("Supabase 최신 데이터를 불러왔습니다.");
    render();
  } catch (error) {
    toast(`불러오기 실패: ${error.message}`);
  }
}

async function importSupabaseInbox(options = {}) {
  const silent = Boolean(options.silent);
  try {
    const rows = await supabaseRequest(
      "/rest/v1/raw_inbox?select=*&status=eq.new&order=created_at.desc&limit=50",
    );
    if (!Array.isArray(rows)) return;

    let added = 0;
    rows.reverse().forEach((row) => {
      const exists = state.rawInbox.some((entry) => entry.cloudId === row.id || entry.localId === row.local_id);
      if (exists) return;
      state.rawInbox.unshift(mapCloudInboxRow(row));
      added += 1;
    });

    if (added > 0) {
      saveState();
      render();
      toast(`클라우드 Inbox ${added}개를 가져왔습니다.`);
    } else if (!silent) {
      toast("새 클라우드 Inbox가 없습니다.");
    }
  } catch (error) {
    if (!silent) toast(`클라우드 Inbox 가져오기 실패: ${error.message}`);
  }
}

function mapCloudInboxRow(row) {
  return {
    id: row.local_id || `cloud_${row.id}`,
    cloudId: row.id,
    localId: row.local_id,
    type: row.type || "transcript",
    fileName: row.file_name || "cloud_transcript.txt",
    createdAt: row.created_at || new Date().toISOString(),
    recordedDate: row.recorded_date || todayISO(),
    recordedTime: normalizeCloudTime(row.recorded_time),
    patientHint: row.patient_hint || "",
    visitType: row.visit_type || "재진",
    text: row.raw_text || row.ocr_text || "",
    correctedText: row.corrected_text || row.raw_text || row.ocr_text || "",
    status: "new",
    matchedVisitId: null,
  };
}

function normalizeCloudTime(value) {
  if (!value) return "";
  return String(value).slice(0, 5);
}

async function updateSupabaseInboxStatus(cloudId, status) {
  try {
    await supabaseRequest(`/rest/v1/raw_inbox?id=eq.${cloudId}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: { status },
    });
  } catch {
    // Local visit creation should not fail just because cloud status update failed.
  }
}

function exportData() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `clinical-memory-${todayISO()}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

async function importData(event) {
  const file = event.target.files[0];
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text());
    state = parsed;
    saveState();
    toast("데이터를 가져왔습니다.");
    render();
  } catch {
    toast("JSON 파일을 읽지 못했습니다.");
  } finally {
    event.target.value = "";
  }
}

attachEvents();
setView("dashboard");

window.setInterval(() => {
  if (supabaseSession?.access_token) {
    importSupabaseInbox({ silent: true });
  }
}, 30000);
