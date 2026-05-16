const STORAGE_KEY = "clinical-memory-assistant-v1";
const SUPABASE_SESSION_KEY = "clinical-memory-supabase-session-v1";
const LAST_CLOUD_SNAPSHOT_KEY = "clinical-memory-last-cloud-snapshot-at";
const LOCAL_CONFIG = window.CMA_CONFIG || {};
const DEFAULT_SUPABASE_URL = LOCAL_CONFIG.supabaseUrl || "https://mwwbqzdpnvnrvcdfxflh.supabase.co";
const DEFAULT_SUPABASE_ANON_KEY = LOCAL_CONFIG.supabaseAnonKey || "";

const todayISO = () => new Date().toISOString().slice(0, 10);
const nowTime = () => new Date().toTimeString().slice(0, 5);
const uid = (prefix) => `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
const PROMPT_TEMPLATES = window.promptTemplates || window.CMA_PROMPT_TEMPLATES || {};

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

const SEED_APPOINTMENTS = [
  {
    id: "appt_seed_1",
    recordKind: "appointment",
    date: todayISO(),
    time: "09:30",
    patientId: "patient_seed_1",
    patientName: "김OO",
    patientNameText: "김OO",
    patientCode: "P001",
    chartNumber: "P001",
    visitType: "재진",
    note: "Rt knee / stair pain",
    durationMinutes: 60,
    sourceFile: "sample",
    matchedVisitId: null,
    status: "scheduled",
    matchStatus: "unlinked",
    needsReview: false,
    createdAt: new Date().toISOString(),
  },
];

/*
MVP data relationship:
- patients: stable clinical identity. chartNumber/code should win over name when available.
- appointments: tomorrow or future planned schedule. Used for briefing, can later link to a visit.
- visits: actual treated/finalized day record. OCR schedule provides the time/name/duration spine.
- rawInbox: unlinked transcript, OCR text, or external AI output waiting for user confirmation.
- matchingCandidates: suggested links only. User confirmation writes patientId/appointmentId/visitId.
*/
const SEED_STATE = {
  patients: [
    {
      id: "patient_seed_1",
      code: "P001",
      chartNumber: "P001",
      name: "김OO",
      sex: "F",
      age: "42",
      region: "Rt knee",
      flags: "stair pain, valgus",
      createdAt: new Date().toISOString(),
    },
  ],
  appointments: SEED_APPOINTMENTS,
  scheduleItems: SEED_APPOINTMENTS,
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
  matchingCandidates: [],
  terms: DEFAULT_TERMS,
  correctionHistory: [],
  ui: {
    calendarViewMode: "split",
  },
  settings: {
    supabaseUrl: DEFAULT_SUPABASE_URL,
    supabaseAnonKey: DEFAULT_SUPABASE_ANON_KEY,
    defaultChartStyle: "SOAP-lite",
    transcriptSource: "Whisper Memos iCloud export",
  },
};

let state = loadState();
let supabaseSession = loadSupabaseSession();
let lastCloudSnapshotAt = localStorage.getItem(LAST_CLOUD_SNAPSHOT_KEY) || "";
let autoSyncTimer = null;
let syncStatus = {
  state: supabaseSession?.access_token ? "ready" : "local",
  message: supabaseSession?.access_token ? "클라우드 연결됨" : "Supabase 로그인 필요",
  lastAt: lastCloudSnapshotAt,
};
let currentView = "dashboard";
let selectedPatientId = state.patients[0]?.id || null;
let selectedVisitId = null;
let dashboardWeekStart = getWeekStartISO(todayISO());
let selectedCalendarKind = getAppointments()[0]?.id ? "appointment" : "visit";
let selectedScheduleId = getAppointments()[0]?.id || state.visits[0]?.id || null;
let importLanes = {
  combinedSchedule: makeImportLane("combinedSchedule"),
  transcriptCleanup: makeImportLane("transcriptCleanup"),
  doctorChart: makeImportLane("doctorChart"),
};
let gptWindow = null;
let aiWorkspaceWindow = null;
let isGptOpen = false;
let learningDraft = {
  from: "",
  to: "",
  chart: "",
  category: "movement",
  fieldId: "",
};

function makeImportLane(key) {
  const defaults = {
    combinedSchedule: {
      kind: "combined_schedule",
      title: "스케줄 통합 Import",
      date: todayISO(),
      appointmentDate: addDays(todayISO(), 1),
      therapist: "백한솔",
      patientHint: "",
      sourceFile: "smart crm combined schedule",
    },
    transcriptCleanup: {
      kind: "transcript_cleanup",
      title: "Transcript 정리 결과",
      date: todayISO(),
      therapist: "백한솔",
      patientHint: "",
      sourceFile: "external ai transcript cleanup",
    },
    doctorChart: {
      kind: "doctor_chart",
      title: "초진 차트 정리 결과",
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

function ensureStateShape(loaded = {}) {
  const incomingAppointments = loaded.appointments || loaded.scheduleItems || SEED_STATE.appointments;
  const next = {
    ...structuredClone(SEED_STATE),
    ...loaded,
    patients: (loaded.patients || SEED_STATE.patients).map(normalizePatientRecord),
    appointments: incomingAppointments.map(normalizeAppointmentRecord),
    visits: (loaded.visits || []).map(normalizeVisitRecord),
    rawInbox: (loaded.rawInbox || SEED_STATE.rawInbox).map(normalizeRawInboxRecord),
    matchingCandidates: loaded.matchingCandidates || [],
    ui: {
      ...SEED_STATE.ui,
      ...(loaded.ui || {}),
    },
    settings: {
      ...SEED_STATE.settings,
      ...(loaded.settings || {}),
    },
  };
  next.scheduleItems = next.appointments;
  if (!next.settings.supabaseUrl) next.settings.supabaseUrl = DEFAULT_SUPABASE_URL;
  if (!next.settings.supabaseAnonKey) next.settings.supabaseAnonKey = DEFAULT_SUPABASE_ANON_KEY;
  return next;
}

function normalizePatientRecord(patient) {
  const code = patient.code || patient.chartNumber || "";
  return {
    ...patient,
    code,
    chartNumber: patient.chartNumber || code,
    name: patient.name || "이름 미상",
  };
}

function normalizeAppointmentRecord(item) {
  const patientName = item.patientName || item.patientNameText || "";
  const chartNumber = item.chartNumber || item.patientCode || "";
  return {
    ...item,
    id: item.id || uid("appt"),
    recordKind: "appointment",
    patientId: item.patientId || null,
    patientName,
    patientNameText: item.patientNameText || patientName,
    patientCode: item.patientCode || chartNumber,
    chartNumber,
    durationMinutes: normalizeTreatmentMinutes(item.durationMinutes || item.note || ""),
    matchStatus: item.matchStatus || (item.matchedVisitId ? "confirmed" : "unlinked"),
    needsReview: Boolean(item.needsReview),
    status: item.status || "scheduled",
    createdAt: item.createdAt || new Date().toISOString(),
  };
}

function normalizeVisitRecord(visit) {
  const patientNameText = visit.patientNameText || visit.patientName || "";
  return {
    ...visit,
    id: visit.id || uid("visit"),
    recordKind: "visit",
    patientId: visit.patientId || null,
    patientNameText,
    appointmentId: visit.appointmentId || null,
    durationMinutes: normalizeTreatmentMinutes(visit.durationMinutes || visit.note || ""),
    transcriptInboxIds: Array.isArray(visit.transcriptInboxIds)
      ? visit.transcriptInboxIds
      : visit.sourceInboxId
        ? [visit.sourceInboxId]
        : [],
    signals: Array.isArray(visit.signals) ? visit.signals : [],
    secondarySignals: Array.isArray(visit.secondarySignals) ? visit.secondarySignals : [],
    tracking: Array.isArray(visit.tracking) ? visit.tracking : [],
    matchStatus: visit.matchStatus || (visit.sourceInboxId ? "confirmed" : "unlinked"),
    needsReview: Boolean(visit.needsReview),
    createdAt: visit.createdAt || new Date().toISOString(),
  };
}

function normalizeRawInboxRecord(item) {
  return {
    ...item,
    patientId: item.patientId || null,
    appointmentId: item.appointmentId || null,
    matchedVisitId: item.matchedVisitId || item.visitId || null,
    matchStatus: item.matchStatus || (item.matchedVisitId ? "confirmed" : "suggested"),
  };
}

function getAppointments() {
  if (!Array.isArray(state?.appointments)) state.appointments = [];
  return state.appointments;
}

function setAppointments(items) {
  state.appointments = items.map(normalizeAppointmentRecord);
  state.scheduleItems = state.appointments;
}

function getCalendarViewMode() {
  return state.ui?.calendarViewMode || "split";
}

function setCalendarViewMode(mode) {
  state.ui = {
    ...(state.ui || {}),
    calendarViewMode: ["appointments", "visits", "split"].includes(mode) ? mode : "split",
  };
}

function saveState(options = {}) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  if (!options.skipAutoSync) scheduleAutoCloudSave();
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
    setSyncStatus("ready", `로그인됨 ${session.user?.email || "user"}`);
  } else {
    localStorage.removeItem(SUPABASE_SESSION_KEY);
    setSyncStatus("local", "Supabase 로그인 필요");
  }
}

function scheduleAutoCloudSave() {
  if (!supabaseSession?.access_token) return;
  window.clearTimeout(autoSyncTimer);
  setSyncStatus("pending", "자동 저장 대기");
  autoSyncTimer = window.setTimeout(() => {
    uploadSupabaseSnapshot({ silent: true, labelPrefix: "auto" });
  }, 1400);
}

function setSyncStatus(stateName, message, lastAt = syncStatus?.lastAt || lastCloudSnapshotAt) {
  syncStatus = {
    state: stateName,
    message,
    lastAt,
  };
  renderSyncStatus();
}

function rememberCloudSnapshotAt(createdAt) {
  if (!createdAt) return;
  lastCloudSnapshotAt = createdAt;
  localStorage.setItem(LAST_CLOUD_SNAPSHOT_KEY, createdAt);
}

function renderSyncStatus() {
  const dot = document.getElementById("syncStatusDot");
  const mode = document.getElementById("syncModeLabel");
  const detail = document.getElementById("syncDetailLabel");
  const button = document.getElementById("sidebarAuthButton");
  if (!dot || !mode || !detail) return;

  const signedIn = Boolean(supabaseSession?.access_token);
  const stateName = signedIn ? syncStatus.state || "ready" : "local";
  dot.className = `status-dot ${stateName}`;
  mode.textContent = signedIn ? supabaseSession.user?.email || "Logged in" : "Logged out";
  detail.textContent = signedIn ? syncStatus.message || "클라우드 연결됨" : "로그인 필요";
  if (button) {
    button.textContent = signedIn ? "로그아웃" : "로그인";
    button.dataset.action = signedIn ? "supabase-signout" : "open-settings";
  }
}

function isEditingDataField() {
  const active = document.activeElement;
  return Boolean(
    active?.matches?.("input, textarea, select") &&
      !active.closest(".topbar-actions") &&
      !active.closest(".nav"),
  );
}

function formatSyncClock(isoString) {
  if (!isoString) return "";
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
  });
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
    inbox: ["Import Inbox", "스케줄 후보, 녹음 전사, 의사 차트 캡쳐를 확인합니다."],
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
  const match = raw.match(/(\d{1,2})(?:[:=.ㆍ·-]?(\d{2}))?/);
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
      const timeMatch = line.match(/(\d{1,2}[:시=.ㆍ·-]\s?\d{0,2})/);
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
  const candidates = parseSmartCrmScheduleCandidates(text, date, therapistName, sourceFile);
  return candidates
    .filter((candidate) => !candidate.needsReview)
    .map(scheduleCandidateToItem);
}

function parseSmartCrmScheduleCandidates(
  text,
  date,
  therapistName = "백한솔",
  sourceFile = "smart crm paste",
  targetRecordType = "appointment",
) {
  const normalizedText = normalizeSmartCrmOcrText(text || "");
  const lines = normalizedText
    .replace(/\r/g, "\n")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);

  const segments = splitSmartCrmAppointmentSegments(lines.join("\n"));
  return segments
    .map((segment) => parseSmartCrmScheduleCandidate(segment, date, therapistName, sourceFile, targetRecordType))
    .filter(Boolean);
}

function parseCombinedScheduleImport(text, options) {
  const sections = parseSectionedText(text);
  const visitText = getSectionText(sections, ["VISITS", "VISIT"]);
  const appointmentText = getSectionText(sections, ["APPOINTMENTS", "APPOINTMENT"]);
  const candidates = [
    ...parseSmartCrmScheduleCandidates(
      visitText,
      options.visitDate,
      options.therapist,
      `${options.sourceFile} visits`,
      "visit",
    ).map((candidate) => ({ ...candidate, sourceSection: "VISITS" })),
    ...parseSmartCrmScheduleCandidates(
      appointmentText,
      options.appointmentDate,
      options.therapist,
      `${options.sourceFile} appointments`,
      "appointment",
    ).map((candidate) => ({ ...candidate, sourceSection: "APPOINTMENTS" })),
  ];

  return {
    candidates,
    sections,
    unknownSections: collectUnknownSections(sections, ["VISITS", "VISIT", "APPOINTMENTS", "APPOINTMENT"]),
  };
}

function parseSectionedText(text) {
  const sections = [];
  let current = {
    name: "RAW",
    lines: [],
  };

  String(text || "")
    .replace(/\r/g, "\n")
    .split(/\n/)
    .forEach((line) => {
      const header = line.trim().match(/^\[([A-Za-z0-9_ /-]+)]$/);
      if (header) {
        if (current.lines.length || current.name !== "RAW") sections.push(current);
        current = {
          name: normalizeSectionKey(header[1]),
          lines: [],
        };
      } else {
        current.lines.push(line);
      }
    });

  if (current.lines.length || current.name !== "RAW") sections.push(current);
  return sections.map((section) => ({
    name: section.name,
    text: section.lines.join("\n").trim(),
  }));
}

function normalizeSectionKey(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[\s/-]+/g, "_");
}

function getSectionText(sections, names) {
  const wanted = new Set(names.map(normalizeSectionKey));
  return sections
    .filter((section) => wanted.has(section.name))
    .map((section) => section.text)
    .filter(Boolean)
    .join("\n")
    .trim();
}

function collectUnknownSections(sections, knownNames) {
  const known = new Set(knownNames.map(normalizeSectionKey));
  return sections.filter((section) => section.name !== "RAW" && !known.has(section.name) && section.text);
}

function parseSmartCrmScheduleCandidate(segment, date, therapistName, sourceFile, targetRecordType = "appointment") {
  const time = normalizeKoreanTime(segment.timeText);
  if (!time) return null;
  if (/예약\s*취소|예약취소|\[?\s*상태\s*[:：]?\s*취소|취소/.test(segment.text)) return null;

  const explicitDate = extractScheduleLineDate(segment.text);
  const patientName = inferSmartCrmPatientName(segment.text, therapistName);
  const treatment = extractSmartCrmTreatment(segment.text);
  const reviewReasons = [];
  if (!patientName) reviewReasons.push("환자명");
  if (!treatment.minutes) reviewReasons.push("치료시간");

  return {
    id: uid("schedcand"),
    type: "schedule_candidate",
    targetRecordType,
    fileName: "schedule candidate",
    createdAt: new Date().toISOString(),
    recordedDate: explicitDate || date,
    recordedTime: time,
    patientHint: patientName,
    durationMinutes: treatment.minutes || "",
    sourceFile,
    status: "new",
    matchStatus: "suggested",
    needsReview: reviewReasons.length > 0,
    reviewReason: reviewReasons.join(", "),
  };
}

function extractScheduleLineDate(text) {
  const raw = String(text || "");
  const isoMatch = raw.match(/\b(\d{4}-\d{1,2}-\d{1,2})\b/);
  if (isoMatch) return normalizeDateText(isoMatch[1]);
  const dottedMatch = raw.match(/\b(\d{4})[.\/년\s-]+(\d{1,2})[.\/월\s-]+(\d{1,2})\b/);
  if (dottedMatch) return normalizeDateText(`${dottedMatch[1]}-${dottedMatch[2]}-${dottedMatch[3]}`);
  return "";
}

function scheduleCandidateToItem(candidate) {
  return {
    id: uid("appt"),
    recordKind: "appointment",
    date: candidate.recordedDate || todayISO(),
    time: candidate.recordedTime,
    patientName: candidate.patientHint,
    patientNameText: candidate.patientHint,
    patientCode: "",
    chartNumber: "",
    visitType: "재진",
    note: candidate.durationMinutes ? `${candidate.durationMinutes}분` : "",
    durationMinutes: candidate.durationMinutes || "",
    sourceFile: candidate.sourceFile || "schedule candidate",
    matchedVisitId: null,
    status: "scheduled",
    matchStatus: "unlinked",
  };
}

function normalizeSmartCrmOcrText(text) {
  return String(text || "")
    .replace(/\r/g, "\n")
    .replace(/[＝]/g, "=")
    .replace(/[［【]/g, "[")
    .replace(/[］】]/g, "]")
    .replace(/[（]/g, "(")
    .replace(/[）]/g, ")")
    .replace(/[：]/g, ":")
    .replace(/[|]+/g, " ")
    .replace(/\t/g, " ")
    .replace(/\b([01]\d|2[0-3])[25]([0-5]\d)\b/g, "$1:$2")
    .replace(/\b([01]\d|2[0-3])([0-5]\d)\b/g, "$1:$2")
    .replace(/\b([1-9])([0-5]\d)\b/g, "0$1:$2")
    .replace(/([0O]?\d|1\d|2[0-3])\s*[:시=.ㆍ·-]\s*([0-5O]\d|[0-5O])/g, (full, hour, minute) => {
      return `${hour.replace(/[Oo]/g, "0")}:${minute.replace(/[Oo]/g, "0").padStart(2, "0")}`;
    });
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
  return [...String(text || "").matchAll(/(?:오전|오후)?\s*([0O]?\d|1\d|2[0-3])\s*[:시=.ㆍ·-]\s*([0-5O]\d|[0-5O])/g)];
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

  const directPatterns = [
    /\]\s*([가-힣]{2,4})\s*(?:님|닝)?/,
    /백한[솔술출][^\]가-힣]{0,8}\]?\s*([가-힣]{2,4})\s*(?:님|닝)?/,
    /도수[^\]가-힣]{0,8}\]?\s*([가-힣]{2,4})\s*(?:님|닝)?/,
  ];
  for (const pattern of directPatterns) {
    const hit = String(segment || "").match(pattern);
    const candidate = hit?.[1]?.replace(/[님닝]+$/, "");
    if (candidate && !stopWords.has(candidate) && /^[가-힣]{2,4}$/.test(candidate)) return candidate;
  }

  const cleaned = String(segment || "")
    .replace(/(?:오전|오후)?\s*([0O]?\d|1\d|2[0-3])\s*[:시=.ㆍ·-]\s*([0-5O]\d|[0-5O])/g, " ")
    .replace(/\[[^\]]*]/g, " ")
    .replace(/\([^)]*\)/g, " ")
    .replace(therapistName || "", " ")
    .replace(/도수치료\d*|운동\d*|TRM|MPT|CFO|F\/U|ok|OK|패키지|연락|변경|상담|재상담/gi, " ")
    .replace(/[0-9]+(?:회|분|세|년|월|일)?/g, " ")
    .replace(/[()[\]{}.,/\\|:;~+_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const parts = cleaned.split(" ").map((part) => part.replace(/[님닝]+$/, "")).filter(Boolean);
  return parts.find((part) => {
    if (stopWords.has(part)) return false;
    if (part.length < 2 || part.length > 8) return false;
    if (!/[가-힣]/.test(part)) return false;
    if (!/^[가-힣A-Za-z]+$/.test(part)) return false;
    if (/도수|치료|운동|예약|방문|여진|상담/.test(part)) return false;
    return true;
  }) || "";
}

function extractSmartCrmTreatment(segment) {
  const text = normalizeSmartCrmOcrText(segment || "")
    .replace(/도[추주]/g, "도수")
    .replace(/[E므][0-9]{1,3}/g, "")
    .replace(/\s+/g, " ");
  const bracketTexts = [...text.matchAll(/\[([^\]]+)]/g)].map((match) => match[1]).reverse();
  const withoutTime = text.replace(/(?:오전|오후)?\s*([0O]?\d|1\d|2[0-3])\s*[:시=.ㆍ·-]\s*([0-5O]\d|[0-5O])/g, " ");
  const candidates = [...bracketTexts, text, withoutTime];
  const patterns = [
    { pattern: /도수\s*치료\s*(\d{2,3})\s*분?/, prefix: "도수치료" },
    { pattern: /도수\s*(\d{2,3})\s*분/, prefix: "도수" },
    { pattern: /도수\s*(\d{2,3})\b/, prefix: "도수치료" },
    { pattern: /운동\s*치료\s*(\d{2,3})\s*분?/, prefix: "운동치료" },
    { pattern: /운동\s*(\d{2,3})\s*(?:패키지|치료|분)/, prefix: "운동치료" },
    { pattern: /(?:^|\s)(\d{2,3})\s*분?(?:\s|$)/, prefix: "" },
  ];

  for (const candidate of candidates) {
    for (const rule of patterns) {
      const hit = candidate.match(rule.pattern);
      const minutes = hit ? normalizeTreatmentMinutes(hit[1]) : "";
      if (minutes) {
        return {
          minutes,
          label: rule.prefix ? `${rule.prefix}${minutes}` : `${minutes}분`,
        };
      }
    }
  }
  return { minutes: "", label: "" };
}

function normalizeTreatmentMinutes(value) {
  const number = Number(String(value || "").replace(/\D/g, ""));
  if (!Number.isFinite(number) || number < 10 || number > 180) return "";
  return String(number);
}

function normalizeKoreanTime(value) {
  if (!value) return "";
  const isPM = value.includes("오후");
  const isAM = value.includes("오전");
  const normalized = String(value).replace(/[Oo]/g, "0");
  const match = normalized.match(/(\d{1,2})[:시=.ㆍ·-]\s?(\d{0,2})/);
  if (!match) return "";
  let hour = Number(match[1]);
  const minute = (match[2] || "00").padStart(2, "0");
  if (isPM && hour < 12) hour += 12;
  if (isAM && hour === 12) hour = 0;
  return `${String(hour).padStart(2, "0")}:${minute}`;
}

function parseTranscriptMeta(text, fileName, recordedDate, recordedTime) {
  const firstLine = (text || "").split(/\n/).find(Boolean) || "";
  const correctedText = applyTerms(text || "");
  const timeHint = normalizeTime(firstLine.match(/(\d{1,2}[:시=.ㆍ·-]\s?\d{0,2})/)?.[1]) || recordedTime;
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
  if (normalizedCode) {
    const byCode = state.patients.find((patient) => {
      return patient.code === normalizedCode || patient.chartNumber === normalizedCode;
    });
    if (byCode) return byCode;
  }
  if (!normalizedName) return null;
  const byName = state.patients.filter((patient) => patient.name === normalizedName);
  return byName.length === 1 ? byName[0] : null;
}

function findPatientMatches(name, code) {
  const normalizedName = (name || "").trim();
  const normalizedCode = (code || "").trim();
  if (normalizedCode) {
    const byCode = state.patients.filter((patient) => {
      return patient.code === normalizedCode || patient.chartNumber === normalizedCode;
    });
    if (byCode.length) return byCode;
  }
  if (!normalizedName) return [];
  return state.patients.filter((patient) => patient.name === normalizedName);
}

function makeTemporaryPatient(name, chartNumber = "") {
  const nextNumber = String(state.patients.length + 1).padStart(3, "0");
  const code = chartNumber || `P${nextNumber}`;
  const patient = {
    id: uid("patient"),
    code,
    chartNumber: code,
    name: name || "이름 미상",
    sex: "",
    age: "",
    region: "",
    flags: "임시 등록",
    createdAt: new Date().toISOString(),
  };
  state.patients.push(patient);
  return patient;
}

function resolvePatientLink(name, code = "", options = {}) {
  const matches = findPatientMatches(name, code);
  if (matches.length === 1) {
    return { patient: matches[0], needsReview: false, reason: "" };
  }
  if (matches.length > 1) {
    return { patient: null, needsReview: true, reason: "동명이인 확인 필요" };
  }
  if (options.createIfMissing) {
    return { patient: makeTemporaryPatient(name, code), needsReview: false, reason: "임시 환자 생성" };
  }
  return { patient: null, needsReview: true, reason: "환자 연결 필요" };
}

function normalizeNameForMatch(value) {
  return String(value || "")
    .replace(/\s+/g, "")
    .replace(/님$/g, "")
    .trim();
}

function getVisitPatient(visit) {
  return state.patients.find((patient) => patient.id === visit.patientId) || null;
}

function getVisitPatientName(visit) {
  return getVisitPatient(visit)?.name || visit.patientNameText || "환자 확인";
}

function getAppointmentPatient(appointment) {
  return (
    state.patients.find((patient) => patient.id === appointment.patientId) ||
    findPatientByNameOrCode(appointment.patientName || appointment.patientNameText, appointment.chartNumber || appointment.patientCode)
  );
}

function findBestVisitForInbox(inbox) {
  const inboxMinutes = minutesOf(inbox.recordedTime);
  if (inboxMinutes === null) return null;

  const sameDate = state.visits.filter((item) => item.date === inbox.recordedDate);

  let best = null;
  for (const item of sameDate) {
    const itemMinutes = minutesOf(item.time);
    if (itemMinutes === null) continue;
    const delta = Math.abs(itemMinutes - inboxMinutes);
    const patientName = getVisitPatientName(item);
    const nameScore =
      inbox.patientHint && patientName.includes(inbox.patientHint.replace("OO", ""))
        ? 25
        : 0;
    const typeScore = inbox.visitType === item.visitType ? 10 : 0;
    const score = Math.min(100, Math.max(0, 100 - delta * 2 + nameScore + typeScore));
    if (!best || score > best.score) best = { item, score, delta, kind: "visit" };
  }
  return best;
}

function findBestAppointmentForInbox(inbox) {
  const inboxMinutes = minutesOf(inbox.recordedTime);
  if (inboxMinutes === null) return null;

  const sameDate = getAppointments().filter((item) => {
    return item.date === inbox.recordedDate && !item.matchedVisitId;
  });

  let best = null;
  for (const item of sameDate) {
    const itemMinutes = minutesOf(item.time);
    if (itemMinutes === null) continue;
    const delta = Math.abs(itemMinutes - inboxMinutes);
    const nameScore =
      inbox.patientHint && (item.patientName || "").includes(inbox.patientHint.replace("OO", ""))
        ? 25
        : 0;
    const typeScore = inbox.visitType === item.visitType ? 10 : 0;
    const score = Math.min(100, Math.max(0, 90 - delta * 2 + nameScore + typeScore));
    if (!best || score > best.score) best = { item, score, delta, kind: "appointment" };
  }
  return best;
}

function findBestRecordForInbox(inbox) {
  return findBestVisitForInbox(inbox) || findBestAppointmentForInbox(inbox);
}

function findBestScheduleForInbox(inbox) {
  return findBestRecordForInbox(inbox);
}

function createVisitFromInbox(inboxId, scheduleId = null) {
  const inbox = state.rawInbox.find((entry) => entry.id === inboxId);
  if (!inbox) return;

  const schedule = scheduleId
    ? getAppointments().find((item) => item.id === scheduleId)
    : findBestAppointmentForInbox(inbox)?.item;

  const patientLink = resolvePatientLink(schedule?.patientName || inbox.patientHint, schedule?.patientCode, {
    createIfMissing: true,
  });
  const patient = patientLink.patient;

  const text = inbox.correctedText || inbox.text || "";
  const visit = {
    id: uid("visit"),
    patientId: patient?.id || null,
    patientNameText: schedule?.patientName || inbox.patientHint || "신규 환자",
    appointmentId: schedule?.id || null,
    date: inbox.recordedDate || schedule?.date || todayISO(),
    time: inbox.recordedTime || schedule?.time || nowTime(),
    visitType: schedule?.visitType || inbox.visitType || "재진",
    durationMinutes: schedule?.durationMinutes || "",
    sourceInboxId: inbox.id,
    transcriptInboxIds: [inbox.id],
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
    matchStatus: "confirmed",
    needsReview: patientLink.needsReview,
    reviewReason: patientLink.reason || "",
    summary: summarizeTranscript(text),
    createdAt: new Date().toISOString(),
  };
  visit.draft = generateDraft(visit, patient || { name: visit.patientNameText, code: "" });

  state.visits.unshift(visit);
  inbox.status = "matched";
  inbox.matchedVisitId = visit.id;
  if (schedule) {
    schedule.matchedVisitId = visit.id;
    schedule.status = "matched";
    schedule.matchStatus = "confirmed";
    if (patient && !schedule.patientCode) schedule.patientCode = patient.code;
  }
  if (inbox.cloudId) {
    updateSupabaseInboxStatus(inbox.cloudId, "matched");
  }
  if (patient) selectedPatientId = patient.id;
  selectedVisitId = visit.id;
  saveState();
  toast("방문 기록과 차트 초안을 만들었습니다.");
  setView("visits");
}

function linkTranscriptToVisit(inboxId, visitId) {
  const inbox = state.rawInbox.find((entry) => entry.id === inboxId);
  const visit = state.visits.find((entry) => entry.id === visitId);
  if (!inbox || !visit) return;

  const text = inbox.correctedText || inbox.text || inbox.ocrText || "";
  const patient = getVisitPatient(visit) || { name: visit.patientNameText || inbox.patientHint || "환자 확인", code: "" };
  const transcriptIds = new Set(visit.transcriptInboxIds || []);
  transcriptIds.add(inbox.id);

  visit.sourceInboxId = visit.sourceInboxId || inbox.id;
  visit.transcriptInboxIds = [...transcriptIds];
  visit.transcript = [visit.transcript, text].filter(Boolean).join("\n\n");
  if (!visit.summary || /기록 대기|summary 없음/.test(visit.summary)) visit.summary = summarizeTranscript(text);
  if (!visit.signals?.length) visit.signals = extractSignals(text).signals;
  if (!visit.secondarySignals?.length) visit.secondarySignals = extractSignals(text).secondary;
  if (!visit.tracking?.length) visit.tracking = inferTracking(text);
  if (!visit.treatment) visit.treatment = extractSection(text, ["오늘", "치료", "진행"]);
  if (!visit.hep) visit.hep = extractSection(text, ["HEP", "숙제", "운동"]);
  if (!visit.homework) visit.homework = extractSection(text, ["숙제", "HEP", "다음"]);
  if (!visit.nextFocus) visit.nextFocus = extractSection(text, ["다음", "확인", "progression"]);
  if (!visit.draft) visit.draft = generateDraft(visit, patient);
  visit.matchStatus = "confirmed";

  inbox.status = "matched";
  inbox.matchedVisitId = visit.id;
  inbox.visitId = visit.id;
  inbox.patientId = visit.patientId || null;
  inbox.matchStatus = "confirmed";
  if (inbox.cloudId) updateSupabaseInboxStatus(inbox.cloudId, "matched");

  selectedCalendarKind = "visit";
  selectedScheduleId = visit.id;
  selectedVisitId = visit.id;
  if (visit.patientId) selectedPatientId = visit.patientId;
  saveState();
  toast("Transcript를 Visit에 연결했습니다.");
  render();
}

function findBestVisitForChartCleanup(item) {
  const sameDate = state.visits.filter((visit) => visit.date === item.recordedDate);
  if (!sameDate.length) return null;
  const nameHint = normalizeNameForMatch(item.patientHint);
  if (nameHint) {
    const nameMatch = sameDate.find((visit) => normalizeNameForMatch(getVisitPatientName(visit)).includes(nameHint));
    if (nameMatch) return nameMatch;
  }
  return sameDate
    .slice()
    .sort((a, b) => `${b.date} ${b.time}`.localeCompare(`${a.date} ${a.time}`))[0];
}

function linkChartCleanupToVisit(inboxId, visitId) {
  const inbox = state.rawInbox.find((entry) => entry.id === inboxId);
  const visit = state.visits.find((entry) => entry.id === visitId);
  if (!inbox || !visit) return;

  const sections = inbox.sections || sectionsToObject(parseSectionedText(inbox.text || inbox.correctedText || ""));
  const patient = getVisitPatient(visit) || { name: visit.patientNameText || inbox.patientHint || "환자 확인", code: "" };
  const chartText = buildChartDraftFromSections(sections, visit, patient);

  visit.summary = visit.summary || sections.SUBJECTIVE || sections.ASSESSMENT || "";
  visit.treatment = mergeText(visit.treatment, sections.TREATMENT);
  visit.homework = mergeText(visit.homework, sections.HOMEWORK);
  visit.hep = mergeText(visit.hep, sections.HOMEWORK);
  visit.nextFocus = mergeText(visit.nextFocus, sections.NEXT_CHECK);
  visit.noise = mergeText(visit.noise, sections.SPECIAL_NOTES);
  if (!visit.signals?.length && sections.ASSESSMENT) visit.signals = splitStructuredList(sections.ASSESSMENT);
  visit.draft = chartText;
  visit.chartCleanupInboxId = inbox.id;

  inbox.status = "matched";
  inbox.matchedVisitId = visit.id;
  inbox.visitId = visit.id;
  inbox.patientId = visit.patientId || null;
  inbox.matchStatus = "confirmed";

  selectedCalendarKind = "visit";
  selectedScheduleId = visit.id;
  selectedVisitId = visit.id;
  if (visit.patientId) selectedPatientId = visit.patientId;
  saveState();
  toast("정리된 차트를 Visit draft에 연결했습니다.");
  render();
}

function mergeText(existing, next) {
  return [existing, next].filter(Boolean).join(existing && next ? "\n" : "");
}

function buildChartDraftFromSections(sections, visit, patient) {
  const patientLabel = patient?.code || patient?.chartNumber || visit.patientNameText || "patient";
  return [
    `[${patientLabel}] ${visit.visitType || "Follow-up"} PT note`,
    `S: ${sections.SUBJECTIVE || "?"}`,
    `O: ${sections.OBJECTIVE || "?"}`,
    `A: ${sections.ASSESSMENT || "?"}`,
    `P: ${sections.TREATMENT || "?"}`,
    `HEP: ${sections.HOMEWORK || "?"}`,
    `Next: ${sections.NEXT_CHECK || "?"}`,
    sections.SPECIAL_NOTES ? `Notes: ${sections.SPECIAL_NOTES}` : "",
  ].filter(Boolean).join("\n");
}

function readScheduleCandidateInputs(id) {
  return {
    time: normalizeKoreanTime(document.getElementById(`candidateTime-${id}`)?.value || ""),
    patientName: document.getElementById(`candidateName-${id}`)?.value.trim() || "",
    durationMinutes: normalizeTreatmentMinutes(document.getElementById(`candidateDuration-${id}`)?.value || ""),
  };
}

function confirmScheduleCandidate(id) {
  const candidate = state.rawInbox.find((entry) => entry.id === id && entry.type === "schedule_candidate");
  if (!candidate) return;

  const values = readScheduleCandidateInputs(id);
  if (!values.time || !values.patientName || !values.durationMinutes) {
    candidate.recordedTime = values.time || candidate.recordedTime;
    candidate.patientHint = values.patientName || candidate.patientHint;
    candidate.durationMinutes = values.durationMinutes || "";
    candidate.needsReview = true;
    candidate.reviewReason = [
      !values.time ? "시간" : "",
      !values.patientName ? "환자명" : "",
      !values.durationMinutes ? "치료시간" : "",
    ].filter(Boolean).join(", ");
    saveState();
    toast("시간, 환자명, 치료시간을 확인해 주세요.");
    render();
    return;
  }

  candidate.recordedTime = values.time;
  candidate.patientHint = values.patientName;
  candidate.durationMinutes = values.durationMinutes;

  if (candidate.targetRecordType === "visit") {
    const visit = upsertVisitFromScheduleCandidate(candidate);
    candidate.status = "imported";
    candidate.needsReview = false;
    candidate.matchedVisitId = visit.id;
    selectedCalendarKind = "visit";
    selectedScheduleId = visit.id;
    selectedVisitId = visit.id;
    dashboardWeekStart = getWeekStartISO(visit.date);
    saveState();
    toast(`${visit.time} ${getVisitPatientName(visit)} Visit 후보를 확정했습니다.`);
    render();
    return;
  }

  const scheduleItem = scheduleCandidateToItem(candidate);
  const patientLink = resolvePatientLink(scheduleItem.patientName, scheduleItem.patientCode, { createIfMissing: false });
  scheduleItem.patientId = patientLink.patient?.id || null;
  scheduleItem.needsReview = patientLink.needsReview && patientLink.reason === "동명이인 확인 필요";
  scheduleItem.reviewReason = scheduleItem.needsReview ? patientLink.reason : "";
  setAppointments([
    scheduleItem,
    ...getAppointments().filter((item) => {
      return !(
        item.date === scheduleItem.date &&
        item.time === scheduleItem.time &&
        item.sourceFile === scheduleItem.sourceFile
      );
    }),
  ]);
  candidate.status = "imported";
  candidate.needsReview = false;
  candidate.matchedScheduleId = scheduleItem.id;
  candidate.appointmentId = scheduleItem.id;
  candidate.matchStatus = "confirmed";
  selectedCalendarKind = "appointment";
  selectedScheduleId = scheduleItem.id;
  dashboardWeekStart = getWeekStartISO(scheduleItem.date);
  saveState();
  toast(`${scheduleItem.time} ${scheduleItem.patientName} Appointment를 저장했습니다.`);
  render();
}

function discardScheduleCandidate(id) {
  const candidate = state.rawInbox.find((entry) => entry.id === id && entry.type === "schedule_candidate");
  if (!candidate) return;
  candidate.status = "discarded";
  saveState();
  toast("스케줄 후보를 폐기했습니다.");
  render();
}

function upsertVisitFromScheduleCandidate(candidate) {
  const patientName = candidate.patientHint || "환자 확인";
  const patientLink = resolvePatientLink(patientName, candidate.chartNumber || "", { createIfMissing: true });
  const appointment = findAppointmentForVisitCandidate(candidate, patientLink.patient);
  const existing = findExistingVisitForScheduleCandidate(candidate, patientLink.patient);
  const baseVisit = existing || {};
  const patientId = patientLink.needsReview && !patientLink.patient ? null : patientLink.patient?.id || baseVisit.patientId || null;
  const needsReview = Boolean(patientLink.needsReview && patientLink.reason === "동명이인 확인 필요");

  const visit = normalizeVisitRecord({
    ...baseVisit,
    id: baseVisit.id || uid("visit"),
    recordKind: "visit",
    patientId,
    patientNameText: patientName,
    appointmentId: appointment?.id || baseVisit.appointmentId || null,
    date: candidate.recordedDate || todayISO(),
    time: candidate.recordedTime || nowTime(),
    visitType: candidate.visitType || baseVisit.visitType || "재진",
    durationMinutes: candidate.durationMinutes || baseVisit.durationMinutes || "",
    sourceFile: candidate.sourceFile || baseVisit.sourceFile || "daily visit schedule",
    recordSource: "daily_ocr",
    summary: baseVisit.summary || `${patientName} ${candidate.durationMinutes || "?"}분 치료 기록 대기`,
    transcript: baseVisit.transcript || "",
    signals: baseVisit.signals || [],
    secondarySignals: baseVisit.secondarySignals || [],
    noise: baseVisit.noise || "",
    tracking: baseVisit.tracking || [],
    treatment: baseVisit.treatment || "",
    hep: baseVisit.hep || "",
    homework: baseVisit.homework || "",
    nextFocus: baseVisit.nextFocus || "",
    draft: baseVisit.draft || "",
    confirmed: Boolean(baseVisit.confirmed),
    matchStatus: "confirmed",
    needsReview,
    reviewReason: needsReview ? patientLink.reason : baseVisit.reviewReason || "",
    createdAt: baseVisit.createdAt || new Date().toISOString(),
  });

  state.visits = [
    visit,
    ...state.visits.filter((item) => item.id !== visit.id),
  ].sort((a, b) => `${b.date} ${b.time}`.localeCompare(`${a.date} ${a.time}`));

  if (appointment) {
    appointment.matchedVisitId = visit.id;
    appointment.status = "matched";
    appointment.matchStatus = "confirmed";
  }

  candidate.matchStatus = "confirmed";
  candidate.patientId = patientId;
  candidate.appointmentId = appointment?.id || null;
  return visit;
}

function findAppointmentForVisitCandidate(candidate, patient) {
  const targetMinutes = minutesOf(candidate.recordedTime);
  return getAppointments().find((appointment) => {
    if (appointment.date !== candidate.recordedDate) return false;
    const samePatient =
      (patient?.id && appointment.patientId === patient.id) ||
      normalizeNameForMatch(appointment.patientName || appointment.patientNameText) ===
        normalizeNameForMatch(candidate.patientHint);
    if (!samePatient) return false;
    const appointmentMinutes = minutesOf(appointment.time);
    if (targetMinutes === null || appointmentMinutes === null) return appointment.time === candidate.recordedTime;
    return Math.abs(appointmentMinutes - targetMinutes) <= 15;
  });
}

function findExistingVisitForScheduleCandidate(candidate, patient) {
  const targetMinutes = minutesOf(candidate.recordedTime);
  return state.visits.find((visit) => {
    if (visit.date !== candidate.recordedDate) return false;
    const visitMinutes = minutesOf(visit.time);
    const timeClose =
      targetMinutes !== null && visitMinutes !== null
        ? Math.abs(visitMinutes - targetMinutes) <= 10
        : visit.time === candidate.recordedTime;
    if (!timeClose) return false;
    if (patient?.id && visit.patientId === patient.id) return true;
    return normalizeNameForMatch(getVisitPatientName(visit)) === normalizeNameForMatch(candidate.patientHint);
  });
}

function createInitialVisitFromDoctorChart(id) {
  const item = state.rawInbox.find((entry) => entry.id === id && entry.type === "doctor_chart");
  if (!item) return;

  const patientQuery = document.getElementById(`doctorPatient-${id}`)?.value.trim() || "";
  const date = document.getElementById(`doctorDate-${id}`)?.value || item.recordedDate || todayISO();
  if (!patientQuery) {
    toast("환자명 또는 코드를 입력해 주세요.");
    return;
  }

  const text = item.ocrText || item.text || "";
  const chartNumber = item.chartNumber || (/^\d/.test(patientQuery) ? patientQuery : "");
  const patientNameFromChart = extractDoctorChartValue(item, ["patient_name"]) || item.patientHint || "";
  const patientMatches = findPatientMatches(patientNameFromChart || patientQuery, chartNumber || patientQuery);
  if (patientMatches.length > 1) {
    item.needsReview = true;
    item.reviewReason = "동명이인 확인 필요";
    saveState();
    toast("동명이인이 있습니다. 차트번호/코드로 다시 입력해 주세요.");
    render();
    return;
  }
  let patient = findPatientByNameOrCode(patientNameFromChart || patientQuery, chartNumber || patientQuery);
  if (!patient) {
    const nextNumber = String(state.patients.length + 1).padStart(3, "0");
    const code = chartNumber || (patientQuery.startsWith("P") ? patientQuery : `P${nextNumber}`);
    patient = {
      id: uid("patient"),
      code,
      chartNumber: code,
      name: patientNameFromChart || (/^\d/.test(patientQuery) || patientQuery.startsWith("P") ? "신규 환자" : patientQuery),
      sex: "",
      age: "",
      region: extractDoctorChartValue(item, ["pain_location"]) || inferRegion(text),
      flags: extractDoctorChartValue(item, ["precautions_red_flags"], "PRECAUTIONS") || extractSectionFromItem(item, "PRECAUTIONS"),
      createdAt: new Date().toISOString(),
    };
    state.patients.push(patient);
  } else {
    patient.chartNumber = patient.chartNumber || chartNumber || patient.code;
    patient.region = patient.region || extractDoctorChartValue(item, ["pain_location"]) || inferRegion(text);
    patient.flags = patient.flags || extractDoctorChartValue(item, ["precautions_red_flags"], "PRECAUTIONS") || extractSectionFromItem(item, "PRECAUTIONS");
  }

  const visit = buildInitialVisitFromDoctorChart(item, patient, date);
  state.visits.unshift(visit);
  item.status = "matched";
  item.patientHint = patient.name;
  item.patientId = patient.id;
  item.matchedVisitId = visit.id;
  item.matchStatus = "confirmed";
  selectedPatientId = patient.id;
  selectedVisitId = visit.id;
  saveState();
  toast("초진 요약 후보로 방문 기록을 만들었습니다.");
  setView("visits");
}

function buildInitialVisitFromDoctorChart(item, patient, date) {
  const text = item.ocrText || item.text || "";
  const chief = extractSectionFromItem(item, "CHIEF_COMPLAINT") || extractStructuredValue(text, ["chief_complaint", "chief complaint"]);
  const medical = extractSectionFromItem(item, "MEDICAL_INFO") || extractStructuredValue(text, ["relevant_medical_info", "relevant medical info"]);
  const precautions = extractSectionFromItem(item, "PRECAUTIONS") || extractStructuredValue(text, ["precautions_red_flags", "precautions/red flags"]);
  const rawNotes = extractSectionFromItem(item, "RAW_NOTES");
  const reviewNotes = extractSectionFromItem(item, "NEEDS_REVIEW");
  const measurements = Array.isArray(item.measurements) ? item.measurements : [];
  const measurementTracking = measurements.map((measurement) => ({
    id: uid("track"),
    name: measurement.name,
    value: measurement.value || "?",
    trend: "baseline",
  }));
  const onset = extractStructuredValue(text, ["onset_history", "onset/history", "history"]);
  const pain = extractStructuredValue(text, ["pain_location", "pain location"]);
  const aggravating = extractStructuredValue(text, ["aggravating_factors", "aggravating factors"]);
  const easing = extractStructuredValue(text, ["easing_factors", "easing factors"]);
  const initialSignal = extractStructuredValue(text, ["initial_signal", "initial signal"]) || chief;
  const secondarySignal = extractStructuredValue(text, ["secondary_signal", "secondary signal"]) || medical;
  const noise = extractStructuredValue(text, ["noise"]) || rawNotes;
  const tracking = splitStructuredList(extractStructuredValue(text, ["suggested_tracking_variables", "suggested tracking variables"]));

  const summary = [chief, onset, pain].filter(Boolean).join(" / ") || summarizeTranscript(text);
  const signalList = splitStructuredList(initialSignal);
  const secondaryList = splitStructuredList(secondarySignal);
  const trackingItems = tracking.map((name) => ({
    id: uid("track"),
    name,
    value: "baseline 확인",
    trend: "check",
  }));

  const visit = {
    id: uid("visit"),
    patientId: patient.id,
    patientNameText: patient.name,
    date,
    time: nowTime(),
    visitType: "초진",
    sourceInboxId: item.id,
    transcriptInboxIds: [item.id],
    recordSource: "doctor_chart",
    transcript: text,
    signals: signalList.length ? signalList : extractSignals(text).signals,
    secondarySignals: secondaryList,
    noise,
    tracking: measurementTracking.length ? measurementTracking : trackingItems.length ? trackingItems : inferTracking(text),
    treatment: "",
    hep: "",
    homework: "",
    nextFocus: [aggravating, easing, medical, precautions, reviewNotes].filter(Boolean).join(" / "),
    draft: "",
    confirmed: false,
    matchStatus: "confirmed",
    summary,
    createdAt: new Date().toISOString(),
  };
  visit.draft = generateDraft(visit, patient);
  return visit;
}

function discardDoctorChartCandidate(id) {
  const item = state.rawInbox.find((entry) => entry.id === id && entry.type === "doctor_chart");
  if (!item) return;
  item.status = "discarded";
  saveState();
  toast("초진 요약 후보를 폐기했습니다.");
  render();
}

function extractStructuredValue(text, labels) {
  const normalizedLabels = labels.map((label) => label.toLowerCase().replace(/[\s/-]+/g, "_"));
  const lines = String(text || "").split(/\n+/);
  for (const line of lines) {
    const clean = line.replace(/^[*\-\s]+/, "").trim();
    const match = clean.match(/^([^:：]+)\s*[:：]\s*(.*)$/);
    if (!match) continue;
    const key = match[1].trim().toLowerCase().replace(/[\s/-]+/g, "_");
    if (normalizedLabels.includes(key)) {
      const value = match[2].trim();
      return value === "?" ? "" : value;
    }
  }
  return "";
}

function extractDoctorChartValue(item, labels, preferredSection = "INITIAL_CHART") {
  const sections = item.sections || {};
  const sectionText = sections[preferredSection] || "";
  return getStructuredLineValue(sectionText, labels) || extractStructuredValue(item.ocrText || item.text || "", labels);
}

function extractSectionFromItem(item, sectionName) {
  return item.sections?.[normalizeSectionKey(sectionName)] || "";
}

function splitStructuredList(value) {
  return String(value || "")
    .split(/[,;\n]+/)
    .map((item) => item.replace(/^[*\-\s]+/, "").trim())
    .filter((item) => item && item !== "?");
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
  const patientLabel = patient?.code || patient?.chartNumber || visit.patientNameText || "patient";
  const tracking = (visit.tracking || []).map((item) => `${item.name}: ${item.value}`).join("; ");
  const signals = (visit.signals || []).join(", ") || "key symptom and movement response checked";
  const treatment = visit.treatment || "manual therapy / exercise intervention performed as tolerated";
  const hep = visit.homework || visit.hep || "HEP reviewed and adjusted";
  const next = visit.nextFocus || "reassess tracking variables next visit";

  if (visit.visitType === "초진") {
    return [
      `[${patientLabel}] Initial PT note`,
      `S: ${visit.summary || "Initial interview completed."}`,
      `O: Key signals - ${signals}. Tracking variables - ${tracking || "to be established"}.`,
      `A: Candidate hypothesis to confirm: load tolerance / motor control / movement compensation pattern.`,
      `P: ${treatment}. HEP: ${hep}. Next: ${next}.`,
    ].join("\n");
  }

  return [
    `[${patientLabel}] Follow-up PT note`,
    `S: ${visit.summary || "Follow-up status checked."}`,
    `O: Tracking - ${tracking || "no structured tracking update captured"}.`,
    `A: ${signals}. Response monitored; progression adjusted based on symptom and movement quality.`,
    `P: ${treatment}. HEP: ${hep}. Next: ${next}.`,
  ].join("\n");
}

function render() {
  renderSyncStatus();
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
  const appointmentsWeek = getAppointments()
    .filter((item) => weekDates.includes(item.date))
    .filter((item) => !query || JSON.stringify(item).toLowerCase().includes(query))
    .sort((a, b) => a.time.localeCompare(b.time));
  const visitsWeek = state.visits
    .filter((visit) => weekDates.includes(visit.date))
    .filter((visit) => !query || JSON.stringify(visit).toLowerCase().includes(query))
    .sort((a, b) => a.time.localeCompare(b.time));
  const calendarMode = getCalendarViewMode();
  const inbox = state.rawInbox.filter((item) => item.status === "new");
  const selectedInWeek =
    selectedCalendarKind === "visit"
      ? visitsWeek.find((item) => item.id === selectedScheduleId)
      : appointmentsWeek.find((item) => item.id === selectedScheduleId);
  const existingSelected = selectedInWeek ? { kind: selectedCalendarKind, item: selectedInWeek } : null;
  const firstRecord = visitsWeek[0]
    ? { kind: "visit", item: visitsWeek[0] }
    : appointmentsWeek[0]
      ? { kind: "appointment", item: appointmentsWeek[0] }
      : null;
  const selectedRecord = existingSelected || firstRecord;
  if (selectedRecord?.item) {
    selectedCalendarKind = selectedRecord.kind;
    selectedScheduleId = selectedRecord.item.id;
  }

  container.innerHTML = `
    <div class="dashboard-layout">
      <section class="panel weekly-panel">
        <div class="panel-header">
          <div>
            <h2>주간 스케줄</h2>
            <p class="note">${formatWeekRange(weekDates)} · Appointment는 예정, Visit은 실제 치료/마감 기록</p>
          </div>
          <div class="calendar-toolbar">
            <div class="segmented-control">
              ${renderCalendarModeButton("appointments", "Appointment", calendarMode)}
              ${renderCalendarModeButton("visits", "Visit", calendarMode)}
              ${renderCalendarModeButton("split", "Split", calendarMode)}
            </div>
            <div class="row wrap">
              <button class="small-button" data-action="prev-week">이전 주</button>
              <button class="small-button" data-action="this-week">이번 주</button>
              <button class="small-button" data-action="next-week">다음 주</button>
            </div>
          </div>
        </div>
        <div class="panel-body">
          ${renderWeeklyCalendar(weekDates, appointmentsWeek, visitsWeek, calendarMode)}
        </div>
      </section>

      <div class="dashboard-side">
        ${renderWorkflowImportLanes("dashboard-import")}
        ${renderScheduleHistoryPanel(selectedRecord?.item || null, selectedRecord?.kind || "appointment")}
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

function renderCalendarModeButton(mode, label, activeMode) {
  return `<button class="segmented-button ${mode === activeMode ? "active" : ""}" data-action="calendar-mode" data-mode="${mode}">${escapeHTML(label)}</button>`;
}

function findCalendarRecord(kind, id) {
  if (!id) return null;
  if (kind === "visit") {
    const visit = state.visits.find((item) => item.id === id);
    return visit ? { kind: "visit", item: visit } : null;
  }
  const appointment = getAppointments().find((item) => item.id === id);
  return appointment ? { kind: "appointment", item: appointment } : null;
}

function renderWorkflowImportLanes(extraClass = "") {
  return `
    <section class="workflow-import ${escapeHTML(extraClass)}">
      ${renderImportLane(importLanes.combinedSchedule)}
      ${renderImportLane(importLanes.transcriptCleanup)}
      ${renderImportLane(importLanes.doctorChart)}
    </section>
  `;
}

function renderExternalPromptPanel() {
  const prompts = getPromptTemplates();
  return `
    <section class="prompt-panel">
      <div class="panel-header">
        <div>
          <h2>외부 AI 프롬프트</h2>
          <p class="note">앱은 API를 직접 호출하지 않습니다. 프롬프트 복사 → 외부 AI 처리 → 결과 붙여넣기 흐름만 지원합니다.</p>
        </div>
      </div>
      <div class="prompt-grid">
        ${prompts.map(renderPromptCard).join("")}
      </div>
    </section>
  `;
}

function getPromptTemplates() {
  return Object.values(PROMPT_TEMPLATES);
}

function getPromptTemplate(promptId) {
  return PROMPT_TEMPLATES[promptId] || getPromptTemplates().find((prompt) => prompt.id === promptId);
}

function renderPromptCard(prompt) {
  return `
    <article class="prompt-card">
      <div>
        <h3>${escapeHTML(prompt.title)}</h3>
        <p class="note">${escapeHTML(prompt.description)}</p>
        <code>${escapeHTML(prompt.expectedOutputFormat || prompt.sectionHeaders?.join(", ") || "")}</code>
      </div>
      <button class="ghost-button" data-action="copy-import-prompt" data-prompt="${escapeHTML(prompt.id)}">Copy Prompt</button>
    </article>
  `;
}

function renderImportLane(lane) {
  const isSchedule = lane.kind === "combined_schedule";
  const isTranscriptCleanup = lane.kind === "transcript_cleanup";
  const defaultStatus = {
    combined_schedule: "[VISITS] / [APPOINTMENTS] 결과 붙여넣기",
    transcript_cleanup: "외부 AI로 정리한 차트 section 붙여넣기",
    doctor_chart: "초진 차트 OCR section 붙여넣기",
  }[lane.kind] || "정리 텍스트 붙여넣기";
  const placeholder = {
    combined_schedule: "[VISITS]\n09:00 김시완 40\n\n[APPOINTMENTS]\n10:30 조선희 60",
    transcript_cleanup: "[SUBJECTIVE]\n...\n\n[OBJECTIVE]\n...",
    doctor_chart: "[INITIAL_CHART]\ndate:\npatient_name:\nchart_number:",
  }[lane.kind] || "여기에 붙여넣기";
  const badgeLabel = {
    combined_schedule: "V + A",
    transcript_cleanup: "Chart",
    doctor_chart: "Initial",
  }[lane.kind] || "Import";
  const promptId = getPromptIdForLane(lane);
  return `
    <article class="paste-lane" data-lane="${lane.key}" tabindex="0" aria-label="${escapeHTML(lane.title)} 붙여넣기">
      <div class="paste-lane-head">
        <div>
          <h2>${escapeHTML(lane.title)}</h2>
          <p class="note">${escapeHTML(lane.ocrStatus || defaultStatus)}</p>
        </div>
        <button class="badge prompt-badge-button ${isSchedule ? "follow" : "new"}" type="button" data-action="copy-import-prompt" data-prompt="${escapeHTML(promptId)}" title="${escapeHTML(badgeLabel)} 프롬프트 복사">${escapeHTML(badgeLabel)}</button>
      </div>

      <div class="paste-lane-controls">
        ${
          lane.kind === "combined_schedule"
            ? `
              <label class="compact-field">Visit 날짜
                <input id="laneDate-${lane.key}" type="date" value="${escapeHTML(lane.date)}" />
              </label>
              <label class="compact-field">Appointment 날짜
                <input id="laneAppointmentDate-${lane.key}" type="date" value="${escapeHTML(lane.appointmentDate || addDays(lane.date, 1))}" />
              </label>
            `
            : isTranscriptCleanup
              ? `
                <input id="laneDate-${lane.key}" type="date" value="${escapeHTML(lane.date)}" />
                <input id="lanePatient-${lane.key}" value="${escapeHTML(lane.patientHint)}" placeholder="환자명/코드 또는 비워두기" />
              `
            : `<input id="lanePatient-${lane.key}" value="${escapeHTML(lane.patientHint)}" placeholder="환자명/코드" />`
        }
      </div>

      <div class="paste-lane-drop ${lane.text || lane.imagePreview ? "has-content" : ""}">
        ${
          lane.imagePreview
            ? `<div class="lane-image-preview"><img src="${lane.imagePreview}" alt="붙여넣은 이미지 미리보기" /><span>${escapeHTML(lane.imageName || "pasted image")}</span></div>`
            : `<div class="lane-placeholder">${escapeHTML(placeholder)}</div>`
        }
        <textarea id="laneText-${lane.key}" placeholder="${escapeHTML(placeholder)}">${escapeHTML(lane.text)}</textarea>
      </div>

      <div class="paste-lane-actions">
        <button class="primary-button" data-action="lane-process" data-lane="${lane.key}">Apply</button>
        <button class="ghost-button" data-action="lane-clear" data-lane="${lane.key}">Clear</button>
      </div>
    </article>
  `;
}

function getPromptIdForLane(lane) {
  return {
    combined_schedule: "scheduleCombined",
    transcript_cleanup: "transcriptCleanup",
    doctor_chart: "doctorInitialChart",
  }[lane.kind] || "scheduleCombined";
}

function renderWeeklyCalendar(weekDates, appointments, visits, mode = "split") {
  const slots = makeTimeSlots();
  const appointmentBySlot = new Map();
  const visitBySlot = new Map();

  appointments.forEach((item) => {
    const slot = slotFromTime(item.time);
    const key = `${item.date}|${slot}`;
    const items = appointmentBySlot.get(key) || [];
    items.push(item);
    appointmentBySlot.set(key, items);
  });

  visits.forEach((item) => {
    const slot = slotFromTime(item.time);
    const key = `${item.date}|${slot}`;
    const items = visitBySlot.get(key) || [];
    items.push(item);
    visitBySlot.set(key, items);
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
              const appointmentItems = appointmentBySlot.get(`${date}|${slot}`) || [];
              const visitItems = visitBySlot.get(`${date}|${slot}`) || [];
              return `
                ${renderCalendarCell(appointmentItems, visitItems, mode)}
              `;
            }).join("")}
          </div>
        `).join("")}
      </div>
    </div>
  `;
}

function renderCalendarCell(appointments, visits, mode) {
  if (mode === "appointments") {
    return `<div class="calendar-cell">${appointments.map((item) => renderCalendarRecord(item, "appointment")).join("")}</div>`;
  }
  if (mode === "visits") {
    return `<div class="calendar-cell">${visits.map((item) => renderCalendarRecord(item, "visit")).join("")}</div>`;
  }
  return `
    <div class="calendar-cell split-calendar-cell">
      <div class="calendar-lane appointment-lane">
        ${appointments.length ? `<div class="lane-mini-label">A</div>` : ""}
        ${appointments.map((item) => renderCalendarRecord(item, "appointment")).join("")}
      </div>
      <div class="calendar-lane visit-lane">
        ${visits.length ? `<div class="lane-mini-label">V</div>` : ""}
        ${visits.map((item) => renderCalendarRecord(item, "visit")).join("")}
      </div>
    </div>
  `;
}

function renderCalendarRecord(item, kind) {
  const patient = kind === "visit" ? getVisitPatient(item) : getAppointmentPatient(item);
  const durationClass = getScheduleDurationClass(item);
  const durationLabel = getScheduleDurationMinutes(item);
  const name = kind === "visit" ? getVisitPatientName(item) : item.patientName || item.patientNameText || "환자 확인";
  const typeLabel = kind === "visit" ? "Visit" : "Appointment";
  const statusLabel =
    kind === "visit"
      ? item.transcript ? "transcript 연결" : "차트 대기"
      : item.matchedVisitId ? "Visit 연결됨" : "예정";
  const patientCode = patient?.code || patient?.chartNumber || item.patientCode || item.visitType || "";
  const tooltip = `${item.time} ${name}\n${typeLabel}${durationLabel ? ` · ${durationLabel}분` : ""}${patientCode ? ` · ${patientCode}` : ""}\n${statusLabel}`;
  return `
    <button class="appointment-button ${kind === "visit" ? "visit-record" : "appointment-record"} ${item.id === selectedScheduleId && selectedCalendarKind === kind ? "selected" : ""} ${item.visitType === "초진" ? "initial" : "followup"} ${durationClass}" data-action="select-calendar-record" data-kind="${kind}" data-id="${item.id}" title="${escapeHTML(tooltip)}">
      <span class="appointment-time">${escapeHTML(item.time)}</span>
      <span class="appointment-name">${escapeHTML(name)}</span>
      <small class="appointment-duration">${escapeHTML(durationLabel ? `${durationLabel}분` : "시간 ?")}</small>
    </button>
  `;
}

function getScheduleDurationMinutes(item) {
  const explicit = Number(item.durationMinutes);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const noteMatch = String(item.note || "").match(/(\d{2,3})\s*분?/);
  const fromNote = noteMatch ? Number(noteMatch[1]) : 0;
  return Number.isFinite(fromNote) && fromNote > 0 ? fromNote : 0;
}

function getScheduleDurationClass(item) {
  const duration = getScheduleDurationMinutes(item);
  if (duration >= 55) return "duration-60";
  if (duration >= 38) return "duration-40";
  if (duration >= 25) return "duration-30";
  return "duration-unknown";
}

function renderScheduleHistoryPanel(record, kind = "appointment") {
  if (!record) {
    return `
      <section class="panel">
        <div class="panel-header"><h2>환자 요약</h2></div>
        <div class="panel-body">${emptyState("선택된 기록 없음", "주간표에서 Appointment 또는 Visit 블록을 누르면 환자 요약이 표시됩니다.")}</div>
      </section>
    `;
  }

  const patient = kind === "visit" ? getVisitPatient(record) : getAppointmentPatient(record);
  const displayName = kind === "visit" ? getVisitPatientName(record) : record.patientName || record.patientNameText || "환자 확인";
  const duration = getScheduleDurationMinutes(record);
  const visitsForPatient = patient
    ? state.visits
        .filter((visit) => visit.patientId === patient.id)
        .sort((a, b) => `${b.date} ${b.time}`.localeCompare(`${a.date} ${a.time}`))
    : [];
  const visits = patient
    ? visitsForPatient
    : kind === "visit"
      ? [record]
    : [];
  const recordStatus =
    kind === "visit"
      ? record.transcript ? "Transcript 연결됨" : "차트 대기"
      : record.matchedVisitId ? "Visit 연결됨" : "예정 Appointment";

  return `
    <section class="panel history-panel">
      <div class="panel-header">
        <div>
          <h2>${escapeHTML(displayName)}</h2>
          <p class="note">${escapeHTML(record.date)} ${escapeHTML(record.time)} · ${escapeHTML(kind === "visit" ? "Visit" : "Appointment")} · ${escapeHTML(duration ? `${duration}분` : record.note || recordStatus)}</p>
        </div>
        <span class="badge ${record.needsReview ? "warn" : record.visitType === "초진" ? "new" : "follow"}">${escapeHTML(record.needsReview ? record.reviewReason || "확인 필요" : patient?.code || patient?.chartNumber || "미등록")}</span>
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
                <button class="small-button" data-action="select-patient" data-id="${patient.id}">환자 상세 보기</button>
                <button class="small-button" data-action="open-patient-visits" data-id="${patient.id}">방문 기록</button>
                ${kind === "visit" ? `<button class="small-button" data-action="open-visit" data-id="${record.id}">Visit 열기</button>` : record.matchedVisitId ? `<button class="small-button" data-action="open-visit" data-id="${record.matchedVisitId}">연결 Visit</button>` : ""}
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
              ${emptyState(kind === "visit" && record.needsReview ? "환자 확인 필요" : "등록되지 않은 환자", kind === "visit" ? "동명이인이 있거나 환자 등록이 필요합니다. 환자 상세에서 차트번호를 기준으로 정리하세요." : "내일 Appointment는 환자 등록 전 이름 텍스트만 임시로 가질 수 있습니다.")}
              <div class="split-actions">
                <button class="small-button" data-action="go-inbox">초진 정보 업로드</button>
                ${kind === "visit" ? `<button class="small-button" data-action="open-visit" data-id="${record.id}">Visit 열기</button>` : ""}
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
  const patient = getAppointmentPatient(item);
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
  if (item.type === "schedule_candidate") return renderScheduleCandidateCard(item);
  if (item.type === "doctor_chart") return renderDoctorChartCandidateCard(item);
  if (item.type === "chart_cleanup") return renderChartCleanupCandidateCard(item);
  if (item.type === "import_notes") return renderImportNotesCard(item);

  const match = item.type === "transcript" ? findBestRecordForInbox(item) : null;
  const matchName =
    match?.kind === "visit"
      ? getVisitPatientName(match.item)
      : match?.item.patientName || match?.item.patientNameText || "";
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
          ? `<div class="badge-row"><span class="badge follow">${escapeHTML(match.kind === "visit" ? "Visit 후보" : "Appointment 후보")} ${escapeHTML(match.item.time)} ${escapeHTML(matchName)}</span><span class="badge warn">score <span class="match-score">${Math.round(match.score)}</span></span></div>`
          : `<p class="note">자동 후보가 없습니다.</p>`
      }
      <div class="split-actions">
        <button class="small-button" data-action="preview-inbox" data-id="${item.id}">보기</button>
        ${
          item.type === "transcript" && match?.kind === "visit"
            ? `<button class="primary-button" data-action="link-transcript-visit" data-id="${item.id}" data-visit="${match.item.id}">Visit에 연결</button>`
            : item.type === "transcript"
              ? `<button class="primary-button" data-action="create-visit" data-id="${item.id}" data-schedule="${match?.kind === "appointment" ? match.item.id : ""}">새 Visit 생성</button>`
            : ""
        }
      </div>
    </article>
  `;
}

function renderChartCleanupCandidateCard(item) {
  const match = findBestVisitForChartCleanup(item);
  const sections = item.sections || {};
  const sectionLabels = ["SUBJECTIVE", "OBJECTIVE", "TREATMENT", "HOMEWORK", "ASSESSMENT", "NEXT_CHECK", "SPECIAL_NOTES"]
    .filter((key) => sections[key])
    .slice(0, 4);
  return `
    <article class="item">
      <div class="item-top">
        <div>
          <h3>차트 정리 후보</h3>
          <div class="meta">${escapeHTML(item.recordedDate || todayISO())} · ${escapeHTML(item.patientHint || "환자 힌트 없음")}</div>
        </div>
        <span class="badge ${item.needsReview ? "warn" : "follow"}">${item.needsReview ? "검토 필요" : "sectioned"}</span>
      </div>
      <div class="badge-row">${sectionLabels.map((key) => `<span class="badge">${escapeHTML(key)}</span>`).join("")}</div>
      ${
        match
          ? `<p class="note">추천 Visit: ${escapeHTML(match.time)} ${escapeHTML(getVisitPatientName(match))}</p>`
          : `<p class="note">추천 Visit이 없습니다. 먼저 당일 Visit 후보를 확정해 주세요.</p>`
      }
      <div class="split-actions">
        <button class="small-button" data-action="preview-inbox" data-id="${item.id}">보기</button>
        ${match ? `<button class="primary-button" data-action="link-chart-cleanup-visit" data-id="${item.id}" data-visit="${match.id}">Visit 차트에 연결</button>` : ""}
      </div>
    </article>
  `;
}

function renderImportNotesCard(item) {
  return `
    <article class="item">
      <div class="item-top">
        <div>
          <h3>알 수 없는 section</h3>
          <div class="meta">${escapeHTML(item.recordedDate || todayISO())} · ${escapeHTML(item.reviewReason || "검토 필요")}</div>
        </div>
        <span class="badge warn">raw</span>
      </div>
      <div class="transcript mini">${escapeHTML(item.text || "내용 없음")}</div>
      <div class="split-actions">
        <button class="small-button" data-action="preview-inbox" data-id="${item.id}">보기</button>
      </div>
    </article>
  `;
}

function renderDoctorChartCandidateCard(item) {
  const suggestedName = item.patientHint || extractDoctorChartValue(item, ["patient_name"]) || "";
  const chartNumber = item.chartNumber || extractDoctorChartValue(item, ["chart_number"]) || "";
  return `
    <article class="item">
      <div class="item-top">
        <div>
          <h3>초진 요약 후보</h3>
          <div class="meta">${escapeHTML(item.recordedDate || item.createdAt.slice(0, 10))} · ${escapeHTML(suggestedName || "환자명 확인")} · ${escapeHTML(chartNumber || "chart_number 확인")}</div>
        </div>
        <span class="badge ${item.needsReview ? "warn" : "new"}">${item.needsReview ? "검토 필요" : "초진"}</span>
      </div>
      <div class="field-grid">
        <div class="field">
          <label for="doctorPatient-${item.id}">환자명 또는 chart_number</label>
          <input id="doctorPatient-${item.id}" value="${escapeHTML(chartNumber || suggestedName)}" placeholder="33487 또는 우재이" />
        </div>
        <div class="field">
          <label for="doctorDate-${item.id}">초진일</label>
          <input id="doctorDate-${item.id}" type="date" value="${escapeHTML(item.recordedDate || todayISO())}" />
        </div>
      </div>
      ${item.reviewReason ? `<p class="note">${escapeHTML(item.reviewReason)}</p>` : ""}
      <div class="transcript mini">${escapeHTML(item.ocrText || item.text || "정리 텍스트 없음")}</div>
      <div class="split-actions">
        <button class="small-button" data-action="preview-inbox" data-id="${item.id}">보기</button>
        <button class="ghost-button" data-action="discard-doctor-chart" data-id="${item.id}">폐기</button>
        <button class="primary-button" data-action="create-initial-visit" data-id="${item.id}">초진 기록 생성</button>
      </div>
    </article>
  `;
}

function renderScheduleCandidateCard(item) {
  const reason = item.needsReview ? item.reviewReason || "검토 필요" : "확인 후 반영";
  const targetLabel = item.targetRecordType === "visit" ? "Visit" : "Appointment";
  return `
    <article class="item">
      <div class="item-top">
        <div>
          <h3>${escapeHTML(item.recordedTime || "시간 확인")} · ${escapeHTML(item.patientHint || "이름 확인")}</h3>
          <div class="meta">${escapeHTML(item.recordedDate || todayISO())} · ${escapeHTML(targetLabel)} · duration ${escapeHTML(item.durationMinutes || "?")}분</div>
        </div>
        <span class="badge ${item.needsReview ? "warn" : "follow"}">${escapeHTML(reason)}</span>
      </div>
      <div class="field-grid three">
        <div class="field">
          <label for="candidateTime-${item.id}">시간</label>
          <input id="candidateTime-${item.id}" value="${escapeHTML(item.recordedTime || "")}" placeholder="09:00" />
        </div>
        <div class="field">
          <label for="candidateName-${item.id}">환자명</label>
          <input id="candidateName-${item.id}" value="${escapeHTML(item.patientHint || "")}" placeholder="김OO" />
        </div>
        <div class="field">
          <label for="candidateDuration-${item.id}">치료시간</label>
          <input id="candidateDuration-${item.id}" value="${escapeHTML(item.durationMinutes || "")}" placeholder="60" />
        </div>
      </div>
      <div class="split-actions">
        <button class="ghost-button" data-action="discard-schedule-candidate" data-id="${item.id}">폐기</button>
        <button class="primary-button" data-action="confirm-schedule-candidate" data-id="${item.id}">${escapeHTML(targetLabel)} 저장</button>
      </div>
    </article>
  `;
}

function renderInbox() {
  const container = document.getElementById("inboxView");
  const newItems = state.rawInbox.filter((item) => item.status === "new");
  const processed = state.rawInbox.filter((item) => item.status !== "new");

  container.innerHTML = `
    ${renderExternalPromptPanel()}
    ${renderWorkflowImportLanes()}
    <div class="grid two">
      <section class="panel">
        <div class="panel-header">
          <h2>처리 대기</h2>
          <span class="badge warn">${newItems.length}</span>
        </div>
        <div class="panel-body">
          <div class="list compact-list">
            ${newItems.length ? newItems.map(renderInboxMatchCard).join("") : emptyState("대기 항목 없음", "스케줄 후보, Whisper transcript, 초진 차트가 여기에 쌓입니다.")}
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
          <label for="patientCode">차트번호/코드</label>
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
  const tracking = Array.isArray(visit.tracking) ? visit.tracking : [];
  const duration = getScheduleDurationMinutes(visit);
  return `
    <article class="item ${visit.id === selectedVisitId ? "selected" : ""}" data-action="select-visit" data-id="${visit.id}">
      <div class="item-top">
        <div>
          <h3>${escapeHTML(visit.date)} ${escapeHTML(visit.time)} · ${escapeHTML(patient?.name || visit.patientNameText || "환자 확인")}</h3>
          <div class="meta">${escapeHTML(patient?.code || visit.reviewReason || "patient link 필요")} · ${escapeHTML(visit.visitType)}${duration ? ` · ${escapeHTML(duration)}분` : ""}</div>
        </div>
        <span class="badge ${visit.needsReview ? "warn" : visit.transcript ? "follow" : "warn"}">${visit.needsReview ? "patient 확인" : visit.transcript ? "linked" : "chart 대기"}</span>
      </div>
      <p class="note">${escapeHTML(visit.summary || "summary 없음")}</p>
      <div class="badge-row">${tracking.slice(0, 4).map((item) => `<span class="badge">${escapeHTML(item.name)}</span>`).join("")}</div>
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
          <input value="${escapeHTML(patient?.code || visit.reviewReason || "환자 연결 필요")} · ${escapeHTML(patient?.name || visit.patientNameText || "")}" disabled />
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
      <div class="field-grid three">
        <div class="field">
          <label for="visitDuration">치료시간</label>
          <input id="visitDuration" value="${escapeHTML(visit.durationMinutes || "")}" placeholder="60" />
        </div>
        <div class="field">
          <label>연결 상태</label>
          <input value="${escapeHTML(visit.transcript ? "Transcript 연결됨" : "차트 대기")}" disabled />
        </div>
        <div class="field">
          <label>출처</label>
          <input value="${escapeHTML(visit.recordSource || visit.sourceFile || "manual")}" disabled />
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
              <button class="ghost-button" type="button" data-action="supabase-upload">Cloud Save</button>
              <button class="ghost-button" type="button" data-action="supabase-download">Load Latest</button>
              <button class="ghost-button" type="button" data-action="supabase-import-inbox">Load Cloud Inbox</button>
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
            ${pipelineStep("3", "Tomorrow Appointment", "퇴근 전 다음날 예약표를 Appointment로 저장")}
            ${pipelineStep("4", "Daily Visit", "퇴근 전 당일 최종 예약표를 Visit 후보로 확정")}
            ${pipelineStep("5", "Review Inbox", "Whisper transcript를 Visit에 추천 연결하고 사용자가 확인")}
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
            ${pipelineStep("B", "다음", "patients/appointments/visits/raw_inbox를 개별 upsert 방식으로 전환")}
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
    if (action === "open-settings") {
      setView("settings");
      window.setTimeout(() => document.getElementById("supabaseEmail")?.focus(), 0);
    }
    if (action === "open-chatgpt") openChatGPTWindow();
    if (action === "focus-chatgpt") handleFocusChatGPTWindow();
    if (action === "close-chatgpt-sidebar") closeChatGPTSidebar();
    if (action === "process-ai-workflow-result") processAIWorkflowResult();
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
    if (action === "calendar-mode") {
      setCalendarViewMode(target.dataset.mode);
      saveState();
      render();
    }
    if (action === "select-calendar-record") {
      selectedScheduleId = id;
      selectedCalendarKind = target.dataset.kind || "appointment";
      const record = findCalendarRecord(selectedCalendarKind, id)?.item;
      const patient = selectedCalendarKind === "visit" ? getVisitPatient(record || {}) : record ? getAppointmentPatient(record) : null;
      if (patient) selectedPatientId = patient.id;
      render();
    }
    if (action === "select-schedule") {
      selectedScheduleId = id;
      selectedCalendarKind = "appointment";
      const scheduleItem = getAppointments().find((item) => item.id === id);
      const patient = scheduleItem ? getAppointmentPatient(scheduleItem) : null;
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
      const latestVisit = state.visits
        .filter((visit) => visit.patientId === id)
        .sort((a, b) => `${b.date} ${b.time}`.localeCompare(`${a.date} ${a.time}`))[0];
      if (latestVisit) selectedVisitId = latestVisit.id;
      setView("visits");
    }
    if (action === "new-patient") {
      const nextNumber = String(state.patients.length + 1).padStart(3, "0");
      const patient = {
        id: uid("patient"),
        code: `P${nextNumber}`,
        chartNumber: `P${nextNumber}`,
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
    if (action === "link-transcript-visit") linkTranscriptToVisit(id, target.dataset.visit);
    if (action === "link-chart-cleanup-visit") linkChartCleanupToVisit(id, target.dataset.visit);
    if (action === "confirm-schedule-candidate") confirmScheduleCandidate(id);
    if (action === "discard-schedule-candidate") discardScheduleCandidate(id);
    if (action === "create-initial-visit") createInitialVisitFromDoctorChart(id);
    if (action === "discard-doctor-chart") discardDoctorChartCandidate(id);
    if (action === "copy-import-prompt") await copyExternalPrompt(target.dataset.prompt);
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
  const appointmentDate = document.getElementById(`laneAppointmentDate-${laneKey}`)?.value;
  const therapist = document.getElementById(`laneTherapist-${laneKey}`)?.value.trim();
  const patientHint = document.getElementById(`lanePatient-${laneKey}`)?.value.trim();
  const text = document.getElementById(`laneText-${laneKey}`)?.value;
  if (date) lane.date = date;
  if (appointmentDate) lane.appointmentDate = appointmentDate;
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
  let shouldRunOcr = false;
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
      updateImportLaneFromDOM(laneKey);
      if (lane.kind === "combined_schedule" || lane.kind === "transcript_cleanup") {
        lane.imageName = "";
        lane.imagePreview = "";
        lane.ocrStatus = "이미지는 외부 AI에서 처리하고, 정리된 텍스트만 붙여넣어 주세요.";
      } else {
        const preview = await fileToDataURL(file);
        lane.imageName = file.name || `pasted-${new Date().toISOString()}.png`;
        lane.imagePreview = preview;
        lane.screenshotCount = (lane.screenshotCount || 0) + 1;
        lane.ocrStatus = "OCR 읽는 중...";
        shouldRunOcr = true;
      }
      changed = true;
    }
  }

  if (changed) {
    event.preventDefault();
    toast(shouldRunOcr ? "이미지를 읽고 있습니다." : "붙여넣었습니다. 텍스트가 있으면 후보를 만들 수 있습니다.");
    render();
    if (shouldRunOcr) await runLaneOcr(laneKey);
  }
}

function clearImportLane(laneKey) {
  const lane = importLanes[laneKey];
  if (!lane) return;
  importLanes[laneKey] = {
    ...makeImportLane(laneKey),
    date: lane.date,
    appointmentDate: lane.appointmentDate,
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
  if (lane.kind === "combined_schedule" || lane.kind === "transcript_cleanup") {
    lane.ocrStatus = "이미지는 외부 AI에서 처리하고, 정리된 텍스트만 붙여넣어 주세요.";
    lane.imageName = "";
    lane.imagePreview = "";
    render();
    return;
  }

  try {
    const text = await recognizeGenericLaneImage(lane, (status) => {
      lane.ocrStatus = status;
      render();
    });
    if (!text) {
      lane.ocrStatus = "OCR 결과 없음. 텍스트를 붙여넣어 주세요.";
      render();
      return;
    }
    lane.text = [lane.text, text].filter(Boolean).join("\n").trim();
    if (lane.kind === "doctor_chart") {
      lane.ocrStatus = "OCR 후보 정리 완료 · 확인 후 반영";
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

async function recognizeGenericLaneImage(lane, updateStatus) {
  const ocrSource = await prepareLaneOcrSource(lane);
  const result = await window.Tesseract.recognize(ocrSource.src, "kor+eng", {
    logger: (message) => {
      if (message.status === "recognizing text" && typeof message.progress === "number") {
        updateStatus(`OCR ${Math.round(message.progress * 100)}%`);
      }
    },
  });
  const rawText = result?.data?.text?.trim() || "";
  if (lane.kind === "doctor_chart") {
    return buildDoctorChartReviewText(lane.imagePreview, result?.data, rawText);
  }
  return rawText;
}

async function prepareLaneOcrSource(lane) {
  return { src: lane.imagePreview, scale: 1 };
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

function loadImageElement(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = src;
  });
}

async function buildDoctorChartReviewText(imageSrc, ocrData, rawText) {
  const lines = collectOcrLines(ocrData);
  const zones = getDoctorChartZones();
  const byZone = Object.fromEntries(zones.map((zone) => [zone.key, []]));
  const pageBox = await estimateDoctorChartPageBox(imageSrc, lines);

  lines.forEach((line) => {
    const zone = findDoctorChartZone(line, zones, pageBox);
    if (zone) byZone[zone.key].push(line);
  });

  const demographics = inferDoctorChartDemographics(lines, rawText);
  const sections = [
    "초진 차트 OCR 후보",
    "확인 필요: 손글씨는 틀릴 수 있어서 아래 내용을 수정한 뒤 반영하세요.",
    "",
    "[기본정보]",
    `환자번호: ${demographics.code || "?"}`,
    `이름: ${demographics.name || "?"}`,
    `나이/성별: ${demographics.ageSex || "?"}`,
    `차트날짜: ${demographics.date || "?"}`,
    "",
    ...doctorChartZoneText("C/C · P/E & P/H", byZone.complaint),
    "",
    ...doctorChartZoneText("IMPRESSION", byZone.impression),
    ...doctorChartCandidates(byZone.impression, "impression"),
    "",
    ...doctorChartZoneText("SUPINE / PRONE / POSTURE 수치", [
      ...byZone.supine,
      ...byZone.prone,
      ...byZone.posture,
      ...byZone.pelvis,
    ]),
    "",
    ...doctorChartZoneText("POSTURE X-RAY", byZone.xray),
    ...doctorChartCandidates(byZone.xray, "xray"),
    "",
    ...doctorChartZoneText("PRESCRIPT", byZone.prescript),
    ...doctorChartCandidates(byZone.prescript, "prescript"),
    "",
    "[원문 OCR]",
    (rawText || "").trim() || "(원문 없음)",
  ];

  return sections.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function getDoctorChartZones() {
  return [
    { key: "header", x0: 0, y0: 0, x1: 1, y1: 0.07 },
    { key: "complaint", x0: 0, y0: 0.05, x1: 0.31, y1: 0.27 },
    { key: "impression", x0: 0.29, y0: 0.05, x1: 0.61, y1: 0.27 },
    { key: "xray", x0: 0.60, y0: 0.08, x1: 1, y1: 0.59 },
    { key: "supine", x0: 0, y0: 0.26, x1: 0.61, y1: 0.36 },
    { key: "prone", x0: 0, y0: 0.36, x1: 0.61, y1: 0.49 },
    { key: "posture", x0: 0, y0: 0.49, x1: 0.61, y1: 0.58 },
    { key: "pelvis", x0: 0, y0: 0.58, x1: 1, y1: 0.69 },
    { key: "prescript", x0: 0, y0: 0.69, x1: 1, y1: 1 },
  ];
}

function findDoctorChartZone(line, zones, pageBox) {
  const center = centerOfBox(line.bbox);
  const x = pageBox.width ? center.x / pageBox.width : 0;
  const y = pageBox.height ? center.y / pageBox.height : 0;

  return zones.find((zone) => {
    return x >= zone.x0 && x <= zone.x1 && y >= zone.y0 && y <= zone.y1;
  });
}

async function estimateDoctorChartPageBox(imageSrc, lines) {
  if (imageSrc) {
    try {
      const image = await loadImageElement(imageSrc);
      return {
        width: image.naturalWidth || image.width || 1,
        height: image.naturalHeight || image.height || 1,
      };
    } catch {
      // Fall back to OCR bounds below.
    }
  }
  const boxes = (lines || []).map((line) => line.bbox).filter((box) => box.x1 > box.x0 && box.y1 > box.y0);
  if (!boxes.length) return { width: 1, height: 1 };
  return {
    width: Math.max(...boxes.map((box) => box.x1), 1),
    height: Math.max(...boxes.map((box) => box.y1), 1),
  };
}

function doctorChartZoneText(title, lines) {
  const text = linesToDoctorChartText(lines);
  return [`[${title}]`, text || "?"];
}

function linesToDoctorChartText(lines) {
  return [...(lines || [])]
    .sort((a, b) => a.bbox.y0 - b.bbox.y0 || a.bbox.x0 - b.bbox.x0)
    .map((line) => line.text.trim())
    .filter((text) => text && !isDoctorChartPrintedLabel(text))
    .join("\n")
    .trim();
}

function isDoctorChartPrintedLabel(text) {
  return /^(C\/C|P\/E|P\/H|IMPRESSION|POSTURE X-?RAY|SUPINE|PRONE|POSTURE|PRESCRIPT|LEFT|RIGHT|Left|Right|Tibia|Dorsiflexion|Hip|Pelvis|Tilting|Rotation|Elevation|Tr(?:a|ans)malleolar|Knee|Forefoot|R,C,S,P|CM|S|T|L|C|Lt|Rt)$/i.test(
    String(text || "").trim(),
  );
}

function doctorChartCandidates(lines, zone) {
  const text = linesToDoctorChartText(lines);
  const candidates = inferDoctorChartCandidates(text, zone);
  if (!candidates.length) return [];
  return ["후보: " + candidates.join(", ")];
}

function inferDoctorChartCandidates(text, zone) {
  const normalized = String(text || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return [];

  const rules = [
    [/TRM|T?RM|티알엠/i, "TRM"],
    [/MPT|NPT|엠피티/i, "MPT"],
    [/FMP|FNP|FMT|F\/?U|에프엠/i, "FMP/FU"],
    [/LLD|LDD|leg length/i, "LLD"],
    [/unremark|unremarkable|wnl/i, "unremarkable"],
    [/gait|gate|보행/i, "gait"],
    [/insole|insert|깔창/i, "insole"],
    [/outlet|outflare|inlet|pelvis/i, "pelvis alignment"],
    [/ankle|dorsi|DF|plantar/i, "ankle ROM"],
    [/knee|무릎/i, "knee"],
    [/hip|고관절/i, "hip"],
  ];

  const result = rules.filter(([pattern]) => pattern.test(normalized)).map(([, label]) => label);
  if (zone === "prescript" && !result.length) {
    result.push("TRM", "MPT", "FMP/FU");
  }
  return [...new Set(result)];
}

function inferDoctorChartDemographics(lines, rawText) {
  const allText = [rawText, ...lines.map((line) => line.text)].join("\n");
  const code = allText.match(/\b\d{4,7}\b/)?.[0] || "";
  const date = allText.match(/\b20\d{6}\b/)?.[0] || "";
  const age = allText.match(/\b(?:[1-9]\d?|1[01]\d)\b/)?.[0] || "";
  const koreanNames = [...allText.matchAll(/[가-힣]{2,4}/g)]
    .map((match) => match[0])
    .filter((word) => !/차트|등록|일자|처방|기타|추가|신발|도수|운동|자세|교육|교정|저항|골반|고관절|무릎|방문|진료/.test(word));

  return {
    code,
    name: koreanNames[0] || "",
    ageSex: age,
    date,
  };
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

async function copyExternalPrompt(promptId) {
  const prompt = getPromptTemplate(promptId);
  if (!prompt) return;
  try {
    await navigator.clipboard.writeText(prompt.promptText);
    toast(`${prompt.title}를 복사했습니다.`);
  } catch {
    toast("프롬프트 복사에 실패했습니다. 브라우저 권한을 확인해 주세요.");
  }
}

function openChatGPTWindow() {
  const layout = getAIWorkspaceLayout();
  if (!isAIWorkspaceMode()) {
    openChatGPTPopup(layout);
    openAIWorkspaceWindow(layout);
    return;
  }

  setChatGPTWorkflowOpen(true);
  if (isGptOpen) {
    focusGPTWindow();
    toast("ChatGPT 창 앞으로 가져오기를 시도했습니다.");
    return;
  }

  openChatGPTPopup(layout);
}

function setChatGPTWorkflowOpen(isOpen) {
  document.body.classList.toggle("chatgpt-workflow-open", isOpen);
}

function isAIWorkspaceMode() {
  return new URLSearchParams(window.location.search).get("aiWorkspace") === "1";
}

function getAIWorkspaceLayout() {
  const styles = getComputedStyle(document.documentElement);
  const configuredWidth = parseInt(styles.getPropertyValue("--sidebar-expanded-width"), 10);
  const gptWidth = Number.isFinite(configuredWidth) ? configuredWidth : 320;
  const availLeft = typeof window.screen.availLeft === "number" ? window.screen.availLeft : 0;
  const availTop = typeof window.screen.availTop === "number" ? window.screen.availTop : 0;
  const availWidth = window.screen.availWidth || window.outerWidth || 1280;
  const availHeight = window.screen.availHeight || window.outerHeight || 900;
  const appLeft = availLeft + gptWidth;
  const appWidth = Math.max(640, availWidth - gptWidth);

  return {
    gpt: {
      left: availLeft,
      top: availTop,
      width: gptWidth,
      height: availHeight,
    },
    app: {
      left: appLeft,
      top: availTop,
      width: appWidth,
      height: availHeight,
    },
  };
}

function windowFeatures(rect) {
  return `popup=yes,width=${Math.round(rect.width)},height=${Math.round(rect.height)},left=${Math.round(rect.left)},top=${Math.round(rect.top)},resizable=yes,scrollbars=yes`;
}

function getAIWorkspaceURL() {
  const url = new URL(window.location.href);
  url.searchParams.set("aiWorkspace", "1");
  url.searchParams.set("gptOpen", "1");
  return url.toString();
}

function openChatGPTPopup(layout = getAIWorkspaceLayout()) {
  gptWindow = window.open("https://chatgpt.com/", "clinicalMemoryChatGPT", windowFeatures(layout.gpt));
  if (gptWindow) {
    isGptOpen = true;
    focusGPTWindow();
    toast("ChatGPT 창을 열었습니다.");
  } else {
    toast("ChatGPT 팝업이 막혔어요. 브라우저 팝업 허용 후 다시 눌러주세요.");
  }
  return gptWindow;
}

function openAIWorkspaceWindow(layout = getAIWorkspaceLayout()) {
  aiWorkspaceWindow = window.open(getAIWorkspaceURL(), "clinicalMemoryAIWorkspace", windowFeatures(layout.app));
  if (aiWorkspaceWindow) {
    try {
      aiWorkspaceWindow.focus();
    } catch {
      // Browser focus policy can ignore this.
    }
    toast("AI Workspace를 열었습니다.");
  } else {
    toast("AI Workspace 팝업이 막혔어요. 브라우저 팝업 허용 후 다시 눌러주세요.");
  }
  return aiWorkspaceWindow;
}

function focusGPTWindow() {
  if (!gptWindow && isAIWorkspaceMode() && window.opener) {
    window.opener.postMessage({ type: "CMA_FOCUS_GPT" }, "*");
    return true;
  }
  if (!gptWindow) return false;
  try {
    gptWindow.focus();
    return true;
  } catch {
    return false;
  }
}

function handleFocusChatGPTWindow() {
  if (isGptOpen) {
    focusGPTWindow();
    toast("ChatGPT 창 앞으로 가져오기를 시도했습니다.");
    return;
  }

  if (window.confirm("ChatGPT 창이 닫혀 있어요. 다시 열까요?")) {
    gptWindow = null;
    isGptOpen = false;
    openChatGPTWindow();
  }
}

function closeChatGPTSidebar() {
  isGptOpen = false;
  setChatGPTWorkflowOpen(false);
}

function hydrateAIWorkspaceMode() {
  if (!isAIWorkspaceMode()) return;
  setChatGPTWorkflowOpen(true);
  isGptOpen = new URLSearchParams(window.location.search).get("gptOpen") === "1";
}

function handleAIWorkspaceMessage(event) {
  if (event.data?.type !== "CMA_FOCUS_GPT") return;
  focusGPTWindow();
}

function processAIWorkflowResult() {
  const field = document.getElementById("aiWorkflowResult");
  const text = field?.value.trim() || "";
  if (!text) {
    toast("붙여넣을 ChatGPT 결과가 필요합니다.");
    return;
  }

  const target = inferAIWorkflowImportTarget(text);
  if (!target) {
    state.rawInbox.unshift(makeUnknownSectionsInboxItem(parseSectionedText(text), "chatgpt_result", todayISO()));
    saveState();
    if (field) field.value = "";
    toast("알 수 없는 형식으로 Inbox에 보관했습니다.");
    setView("inbox");
    return;
  }

  const lane = importLanes[target];
  lane.text = text;
  lane.sourceFile = "chatgpt_result";
  processImportLane(target, { skipDomUpdate: true });
  if (field) field.value = "";
}

function inferAIWorkflowImportTarget(text) {
  const sectionNames = parseSectionedText(text).map((section) => section.name);
  const hasSection = (names) => names.some((name) => sectionNames.includes(name));
  if (hasSection(["VISITS", "APPOINTMENTS"])) return "combinedSchedule";
  if (hasSection(["INITIAL_CHART", "MEASUREMENTS", "CHIEF_COMPLAINT", "MEDICAL_INFO", "PRECAUTIONS"])) {
    return "doctorChart";
  }
  if (hasSection(["SUBJECTIVE", "OBJECTIVE", "TREATMENT", "HOMEWORK", "ASSESSMENT", "NEXT_CHECK", "SPECIAL_NOTES"])) {
    return "transcriptCleanup";
  }
  return "";
}

function fileToDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function sectionsToObject(sections) {
  return sections.reduce((memo, section) => {
    memo[section.name] = section.text;
    return memo;
  }, {});
}

function makeUnknownSectionsInboxItem(sections, sourceFile, date) {
  return {
    id: uid("inbox"),
    type: "import_notes",
    fileName: "unknown_sections",
    createdAt: new Date().toISOString(),
    recordedDate: date || todayISO(),
    sourceFile,
    sections: sectionsToObject(sections),
    text: sections.map((section) => `[${section.name}]\n${section.text}`).join("\n\n"),
    status: "new",
    matchStatus: "needs_review",
    needsReview: true,
    reviewReason: "알 수 없는 section 확인 필요",
    matchedVisitId: null,
  };
}

function makeTranscriptCleanupInboxItem(lane) {
  const sections = parseSectionedText(lane.text);
  const knownSections = [
    "SUBJECTIVE",
    "OBJECTIVE",
    "TREATMENT",
    "HOMEWORK",
    "ASSESSMENT",
    "NEXT_CHECK",
    "SPECIAL_NOTES",
  ];
  const unknownSections = collectUnknownSections(sections, knownSections);
  return {
    id: uid("inbox"),
    type: "chart_cleanup",
    fileName: "transcript_cleanup_candidate",
    createdAt: new Date().toISOString(),
    recordedDate: lane.date || todayISO(),
    recordedTime: nowTime(),
    patientHint: lane.patientHint || "",
    sourceFile: lane.sourceFile,
    sections: sectionsToObject(sections),
    text: lane.text,
    correctedText: lane.text,
    status: "new",
    matchStatus: "suggested",
    needsReview: unknownSections.length > 0,
    reviewReason: unknownSections.length ? "알 수 없는 section 확인 필요" : "",
    matchedVisitId: null,
  };
}

function makeDoctorChartInboxItem(lane) {
  const sections = parseSectionedText(lane.text);
  const initialChart = getSectionText(sections, ["INITIAL_CHART"]);
  const patientName = getStructuredLineValue(initialChart, ["patient_name", "patient name"]) || lane.patientHint || "";
  const chartNumber = getStructuredLineValue(initialChart, ["chart_number", "chart number", "code"]) || "";
  const date = normalizeDateText(getStructuredLineValue(initialChart, ["date", "초진일"])) || lane.date || todayISO();
  const measurements = parseMeasurements(getSectionText(sections, ["MEASUREMENTS"]));
  const patientMatches = findPatientMatches(patientName, chartNumber || patientName);
  const needsReview = patientMatches.length > 1 || !chartNumber || !patientName || hasUncertainText(lane.text);
  const reviewReason = [
    patientMatches.length > 1 ? "동명이인 확인 필요" : "",
    !chartNumber ? "chart_number 확인" : "",
    !patientName ? "환자명 확인" : "",
    hasUncertainText(lane.text) ? "불확실한 손글씨 확인" : "",
  ].filter(Boolean).join(", ");

  return {
    id: uid("inbox"),
    type: "doctor_chart",
    fileName: "initial_chart_candidate",
    createdAt: new Date().toISOString(),
    recordedDate: date,
    patientHint: patientName,
    chartNumber,
    patientId: patientMatches.length === 1 ? patientMatches[0].id : null,
    sections: sectionsToObject(sections),
    measurements,
    ocrText: lane.text,
    status: "new",
    matchStatus: "suggested",
    needsReview,
    reviewReason,
    matchedVisitId: null,
  };
}

function getStructuredLineValue(text, labels) {
  const normalizedLabels = labels.map((label) => normalizeSectionKey(label));
  const lines = String(text || "").split(/\n+/);
  for (const line of lines) {
    const [key, ...rest] = line.split(":");
    if (!rest.length) continue;
    if (normalizedLabels.includes(normalizeSectionKey(key))) return rest.join(":").trim();
  }
  return "";
}

function normalizeDateText(value) {
  const raw = String(value || "").trim();
  if (!raw || raw === "?") return "";
  const compact = raw.replace(/\D/g, "");
  if (compact.length === 8) return `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
  const match = raw.match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
  if (!match) return "";
  return `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
}

function parseMeasurements(text) {
  return String(text || "")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, ...rest] = line.split(":");
      return {
        id: uid("measure"),
        name: name?.trim() || "measurement",
        value: rest.join(":").trim() || "?",
      };
    })
    .filter((item) => item.name);
}

function hasUncertainText(value) {
  return /\?|\bunclear\b|불확실|확인/i.test(String(value || ""));
}

function processImportLane(laneKey, options = {}) {
  const auto = Boolean(options.auto);
  if (!options.skipDomUpdate) updateAllImportLanesFromDOM();
  const lane = importLanes[laneKey];
  if (!lane) return;

  if (lane.kind === "combined_schedule") {
    const sourceFile = lane.sourceFile;
    const result = parseCombinedScheduleImport(lane.text, {
      visitDate: lane.date,
      appointmentDate: lane.appointmentDate || addDays(lane.date, 1),
      therapist: lane.therapist,
      sourceFile,
    });
    const candidates = result.candidates;

    if (!candidates.length) {
      toast(
        lane.imagePreview
          ? "OCR은 끝났지만 [VISITS]/[APPOINTMENTS]에서 시간/환자명을 읽지 못했습니다."
          : "[VISITS] 또는 [APPOINTMENTS] section에서 읽을 수 있는 시간이 없습니다.",
      );
      lane.ocrStatus = "반영 실패, 텍스트 확인 필요";
      render();
      return;
    }

    const importNotes = result.unknownSections.length
      ? [makeUnknownSectionsInboxItem(result.unknownSections, sourceFile, lane.date)]
      : [];

    state.rawInbox = [
      ...candidates,
      ...importNotes,
      ...state.rawInbox.filter((item) => {
        return !(
          item.sourceFile?.startsWith(sourceFile) &&
          ["schedule_candidate", "import_notes"].includes(item.type)
        );
      }),
    ];
    dashboardWeekStart = getWeekStartISO(lane.date);
    lane.text = "";
    lane.imageName = "";
    lane.imagePreview = "";
    lane.screenshotCount = 0;
    lane.ocrStatus = "";
    saveState();
    toast(`${lane.title}: Visit/Appointment 후보 ${candidates.length}개를 Inbox에 만들었습니다.`);
    if (currentView !== "inbox") setView("inbox");
    else render();
    return;
  }

  if (lane.kind === "transcript_cleanup") {
    if (!lane.text.trim()) {
      toast("정리된 transcript section 텍스트가 필요합니다.");
      lane.ocrStatus = "반영 실패, 텍스트 확인 필요";
      render();
      return;
    }

    const item = makeTranscriptCleanupInboxItem(lane);
    state.rawInbox.unshift(item);
    lane.text = "";
    lane.patientHint = "";
    lane.imageName = "";
    lane.imagePreview = "";
    lane.ocrStatus = "";
    saveState();
    toast("정리된 차트 후보를 Inbox에 만들었습니다.");
    if (currentView !== "inbox") setView("inbox");
    else render();
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

    state.rawInbox.unshift(makeDoctorChartInboxItem(lane));

    lane.text = "";
    lane.patientHint = "";
    lane.imageName = "";
    lane.imagePreview = "";
    lane.ocrStatus = auto ? "OCR 자동 반영 완료" : "";
    saveState();
    toast("초진 요약 후보를 Inbox에 만들었습니다.");
    if (currentView !== "inbox") setView("inbox");
    else render();
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
    setAppointments([
      ...items.map(normalizeAppointmentRecord),
      ...getAppointments().filter((item) => item.date !== date || item.sourceFile !== sourceFile),
    ]);
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
  state.rawInbox.unshift(makeDoctorChartInboxItem({
    text,
    patientHint: patientQuery,
    date: todayISO(),
    sourceFile: file?.name || "doctor chart paste",
  }));

  saveState();
  form.reset();
  toast("초진 요약 후보를 Inbox에 만들었습니다.");
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
  patient.chartNumber = patient.code;
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
  visit.durationMinutes = normalizeTreatmentMinutes(form.querySelector("#visitDuration")?.value || visit.durationMinutes || "");
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
    downloadLatestSupabaseSnapshot({ silent: true, onlyIfNewer: true });
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

async function uploadSupabaseSnapshot(options = {}) {
  const silent = Boolean(options.silent);
  const labelPrefix = options.labelPrefix || "manual";
  try {
    setSyncStatus("syncing", "클라우드 저장 중");
    const rows = await supabaseRequest("/rest/v1/app_snapshots", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: {
        label: `${labelPrefix} ${new Date().toISOString()}`,
        data: makeCloudSnapshot(),
      },
    });
    const createdAt = Array.isArray(rows) ? rows[0]?.created_at : "";
    if (createdAt) rememberCloudSnapshotAt(createdAt);
    setSyncStatus("ready", `저장됨 ${formatSyncClock(createdAt) || "방금"}`, createdAt || syncStatus.lastAt);
    if (!silent) toast("Supabase에 현재 데이터를 저장했습니다.");
  } catch (error) {
    setSyncStatus("error", "저장 실패");
    if (!silent) toast(`클라우드 저장 실패: ${error.message}`);
  }
}

async function downloadLatestSupabaseSnapshot(options = {}) {
  const silent = Boolean(options.silent);
  const onlyIfNewer = Boolean(options.onlyIfNewer);
  try {
    if (!silent) setSyncStatus("syncing", "클라우드 불러오는 중");
    const rows = await supabaseRequest(
      "/rest/v1/app_snapshots?select=label,created_at,data&order=created_at.desc&limit=1",
    );
    if (!Array.isArray(rows) || rows.length === 0) {
      if (!silent) toast("불러올 클라우드 데이터가 없습니다.");
      return;
    }
    if (onlyIfNewer && rows[0].created_at && rows[0].created_at <= lastCloudSnapshotAt) return;
    if (silent && isEditingDataField()) {
      setSyncStatus("pending", "새 데이터 있음 · 불러오기", rows[0].created_at || syncStatus.lastAt);
      return;
    }
    const currentSettings = state.settings;
    state = ensureStateShape(rows[0].data);
    state.settings = {
      ...state.settings,
      supabaseUrl: currentSettings.supabaseUrl,
      supabaseAnonKey: currentSettings.supabaseAnonKey,
    };
    saveState({ skipAutoSync: true });
    rememberCloudSnapshotAt(rows[0].created_at);
    setSyncStatus("ready", `불러옴 ${formatSyncClock(rows[0].created_at) || "방금"}`, rows[0].created_at);
    if (!silent) toast("Supabase 최신 데이터를 불러왔습니다.");
    render();
  } catch (error) {
    setSyncStatus("error", "불러오기 실패");
    if (!silent) toast(`불러오기 실패: ${error.message}`);
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
      if (!silent) toast(`클라우드 Inbox ${added}개를 가져왔습니다.`);
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
    sections: row.sections || {},
    measurements: row.measurements || [],
    status: "new",
    patientId: row.patient_id || null,
    appointmentId: row.appointment_id || null,
    matchStatus: row.match_status || "suggested",
    needsReview: Boolean(row.needs_review),
    reviewReason: row.review_reason || "",
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
hydrateAIWorkspaceMode();
window.addEventListener("message", handleAIWorkspaceMessage);

window.setTimeout(() => {
  if (supabaseSession?.access_token) {
    importSupabaseInbox({ silent: true });
    downloadLatestSupabaseSnapshot({ silent: true, onlyIfNewer: true });
  }
}, 1500);

window.setInterval(() => {
  if (supabaseSession?.access_token) {
    importSupabaseInbox({ silent: true });
    downloadLatestSupabaseSnapshot({ silent: true, onlyIfNewer: true });
  }
}, 30000);
