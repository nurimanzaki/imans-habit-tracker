import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";
import {
  ChevronLeft, ChevronRight, Moon, Sun, Sunrise, Briefcase, Candy,
  Dumbbell, NotebookPen, CalendarDays, LayoutGrid, Settings as SettingsIcon,
  Check, X, Minus, TrendingUp, TrendingDown, Sparkles, RotateCcw, Loader2,
  Mail, LogOut, AlertTriangle, BookOpen, CalendarOff,
} from "lucide-react";
import { supabase, isSupabaseConfigured } from "./lib/supabaseClient";
import { ensureSettings, upsertSettings, fetchAllRecords, upsertRecord, upsertRecordsBulk } from "./lib/db";

/* ---------------------------------------------------------------
   Constants & defaults
--------------------------------------------------------------- */

const HABITS = [
  { key: "sleepTime", label: "Sleep time", icon: Moon, type: "time-target" },
  { key: "wakeTime", label: "Wake-up time", icon: Sun, type: "time-target" },
  { key: "sleepDuration", label: "Sleep duration", icon: Moon, type: "derived" },
  { key: "subuh", label: "Subuh on time", icon: Sunrise, type: "tri" },
  { key: "office", label: "Office arrival", icon: Briefcase, type: "time-target" },
  { key: "sugar", label: "Avoid sugar", icon: Candy, type: "tri" },
  { key: "exercise", label: "Exercise 30 min", icon: Dumbbell, type: "tri" },
  { key: "reading", label: "Read 30 min", icon: BookOpen, type: "tri" },
];

const DEFAULT_SETTINGS = {
  sleepTimeTarget: "23:30",
  wakeTimeTarget: "06:30",
  sleepMinHours: 6,
  sleepMaxHours: 8,
  officeTarget: "09:00",
  exerciseTargetMinutes: 30,
};

/* ---------------------------------------------------------------
   Date helpers (local timezone, no UTC drift)
--------------------------------------------------------------- */

function toISODate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function fromISODate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}
function addDaysISO(iso, n) {
  const d = fromISODate(iso);
  d.setDate(d.getDate() + n);
  return toISODate(d);
}
function todayISO() {
  return toISODate(new Date());
}
function isFutureISO(iso) {
  return iso > todayISO();
}
function formatHeaderDate(iso) {
  const d = fromISODate(iso);
  const weekday = d.toLocaleDateString(undefined, { weekday: "long" });
  const rest = d.toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });
  return { weekday, rest };
}
function lastNDatesISO(n, endISO) {
  const arr = [];
  for (let i = n - 1; i >= 0; i--) arr.push(addDaysISO(endISO, -i));
  return arr;
}

/* ---------------------------------------------------------------
   Time helpers
--------------------------------------------------------------- */

function toMinutes(t) {
  if (!t) return null;
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}
function formatDuration(mins) {
  if (mins == null) return "—";
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${h}h ${String(m).padStart(2, "0")}m`;
}
function formatTime12(t) {
  if (!t) return "—";
  const [h, m] = t.split(":").map(Number);
  const period = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${period}`;
}
function sleepDurationMinutes(sleepTime, wakeTime) {
  const s = toMinutes(sleepTime);
  const w = toMinutes(wakeTime);
  if (s == null || w == null) return null;
  let dur = w - s;
  if (dur <= 0) dur += 24 * 60;
  return dur;
}
// For evening targets (e.g. "before 11:30 PM"), treat any time before noon
// as having rolled past midnight, so "12:30 AM" correctly reads as later
// than an 11:30 PM target rather than numerically earlier.
function eveningMinutes(t) {
  const m = toMinutes(t);
  if (m == null) return null;
  return m < 12 * 60 ? m + 24 * 60 : m;
}

/* ---------------------------------------------------------------
   Scoring engine (isolated, pure functions — no React here)
--------------------------------------------------------------- */

function habitScore(key, record, settings) {
  switch (key) {
    case "sleepTime": {
      if (!record.sleepTime) return null;
      const target = eveningMinutes(settings.sleepTimeTarget);
      const actual = eveningMinutes(record.sleepTime);
      return actual <= target ? 100 : 0;
    }
    case "wakeTime": {
      if (!record.wakeTime) return null;
      const target = toMinutes(settings.wakeTimeTarget);
      const actual = toMinutes(record.wakeTime);
      return actual <= target ? 100 : 0;
    }
    case "sleepDuration": {
      const dur = sleepDurationMinutes(record.sleepTime, record.wakeTime);
      if (dur == null) return null;
      const hrs = dur / 60;
      return hrs >= settings.sleepMinHours && hrs <= settings.sleepMaxHours ? 100 : 0;
    }
    case "office": {
      if (record.isOffDay) {
        return record.beneficialActivities == null ? null : record.beneficialActivities ? 100 : 0;
      }
      if (!record.officeArrival) return null;
      const target = toMinutes(settings.officeTarget);
      const actual = toMinutes(record.officeArrival);
      return actual <= target ? 100 : 0;
    }
    case "subuh":
      return record.subuh == null ? null : record.subuh ? 100 : 0;
    case "sugar":
      return record.sugar == null ? null : record.sugar ? 100 : 0;
    case "exercise":
      return record.exercise == null ? null : record.exercise ? 100 : 0;
    case "reading":
      return record.reading == null ? null : record.reading ? 100 : 0;
    default:
      return null;
  }
}

function calculateDailyScore(record, settings) {
  if (!record) return null;
  const scores = HABITS.map((h) => habitScore(h.key, record, settings)).filter((s) => s != null);
  if (scores.length === 0) return null;
  return Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
}

function officeStatus(record, settings) {
  if (record?.isOffDay) {
    if (record.beneficialActivities == null) return { state: "none", label: "Not recorded" };
    return record.beneficialActivities
      ? { state: "good", label: "Done" }
      : { state: "bad", label: "Missed" };
  }
  if (!record?.officeArrival) return { state: "none", label: "Not recorded" };
  const onTime = toMinutes(record.officeArrival) <= toMinutes(settings.officeTarget);
  return onTime
    ? { state: "good", label: "On time" }
    : { state: "bad", label: "Late" };
}

function sleepTimeStatus(record, settings) {
  if (!record?.sleepTime) return { state: "none", label: "Not recorded" };
  const onTime = eveningMinutes(record.sleepTime) <= eveningMinutes(settings.sleepTimeTarget);
  return onTime ? { state: "good", label: "On target" } : { state: "bad", label: "Later than target" };
}

function wakeTimeStatus(record, settings) {
  if (!record?.wakeTime) return { state: "none", label: "Not recorded" };
  const onTime = toMinutes(record.wakeTime) <= toMinutes(settings.wakeTimeTarget);
  return onTime ? { state: "good", label: "On target" } : { state: "bad", label: "Later than target" };
}

function sleepDurationStatus(record, settings) {
  const dur = sleepDurationMinutes(record?.sleepTime, record?.wakeTime);
  if (dur == null) return { state: "none", label: "—" };
  const hrs = dur / 60;
  if (hrs < settings.sleepMinHours) return { state: "bad", label: "Below target" };
  if (hrs > settings.sleepMaxHours) return { state: "warn", label: "Above target" };
  return { state: "good", label: "Within target" };
}

/* Storage layer lives in ./lib/db.js — all reads/writes go through
   Supabase, scoped to the signed-in user via Row Level Security. */

/* ---------------------------------------------------------------
   Backup: export / import (your data, portable outside this artifact)
--------------------------------------------------------------- */

function downloadFile(content, filename, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function exportJSON(records, settings) {
  const payload = { exportedAt: new Date().toISOString(), settings, records };
  downloadFile(JSON.stringify(payload, null, 2), `habit-tracker-backup-${todayISO()}.json`, "application/json");
}

function exportCSV(records) {
  const cols = ["date", "sleepTime", "wakeTime", "sleepDurationMinutes", "subuh", "isOffDay", "officeArrival", "beneficialActivities", "sugar", "exercise", "reading", "notes"];
  const rows = Object.values(records)
    .sort((a, b) => (a.date < b.date ? -1 : 1))
    .map((r) => {
      const dur = sleepDurationMinutes(r.sleepTime, r.wakeTime);
      const val = (v) => (v == null ? "" : v);
      const bool = (v) => (v == null ? "" : v ? "done" : "missed");
      const notes = (r.notes || "").replace(/"/g, '""');
      return [
        r.date,
        val(r.sleepTime),
        val(r.wakeTime),
        val(dur),
        bool(r.subuh),
        r.isOffDay ? "yes" : "no",
        val(r.officeArrival),
        bool(r.beneficialActivities),
        bool(r.sugar),
        bool(r.exercise),
        bool(r.reading),
        `"${notes}"`,
      ].join(",");
    });
  const csv = [cols.join(","), ...rows].join("\n");
  downloadFile(csv, `habit-tracker-backup-${todayISO()}.csv`, "text/csv");
}

async function importJSONFile(file) {
  const text = await file.text();
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || !parsed.records) {
    throw new Error("This file doesn't look like a habit tracker backup.");
  }
  return parsed;
}

/* ---------------------------------------------------------------
   Small UI atoms
--------------------------------------------------------------- */

function StatusPill({ status }) {
  const map = {
    good: { icon: Check, cls: "text-emerald-700 bg-emerald-50", },
    warn: { icon: Minus, cls: "text-amber-700 bg-amber-50" },
    bad: { icon: X, cls: "text-rose-700 bg-rose-50" },
    none: { icon: Minus, cls: "text-stone-400 bg-stone-100" },
  };
  const cfg = map[status.state] || map.none;
  const Icon = cfg.icon;
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium ${cfg.cls}`}>
      <Icon size={12} strokeWidth={2.5} />
      {status.label}
    </span>
  );
}

// Three-state tap toggle: not recorded -> done -> missed -> not recorded
function TriToggle({ value, onChange, disabled }) {
  const cycle = () => {
    if (disabled) return;
    if (value == null) onChange(true);
    else if (value === true) onChange(false);
    else onChange(null);
  };
  let content;
  if (value == null) {
    content = <span className="text-stone-400 text-xs font-medium">Tap to log</span>;
  } else if (value === true) {
    content = (
      <span className="inline-flex items-center gap-1.5 text-emerald-700 font-medium text-sm">
        <Check size={16} strokeWidth={2.5} /> Done
      </span>
    );
  } else {
    content = (
      <span className="inline-flex items-center gap-1.5 text-rose-600 font-medium text-sm">
        <X size={16} strokeWidth={2.5} /> Missed
      </span>
    );
  }
  const bg =
    value == null ? "bg-stone-100 border-stone-200" : value === true ? "bg-emerald-50 border-emerald-200" : "bg-rose-50 border-rose-200";
  return (
    <button
      type="button"
      onClick={cycle}
      disabled={disabled}
      aria-label="Toggle habit status"
      className={`min-w-[104px] h-11 px-4 rounded-xl border flex items-center justify-center transition-colors active:scale-[0.97] ${bg} ${disabled ? "opacity-50" : ""}`}
    >
      {content}
    </button>
  );
}

function TimeField({ label, value, onChange, disabled }) {
  return (
    <label className="flex flex-col gap-1.5 flex-1 min-w-[130px]">
      <span className="text-xs text-stone-500">{label}</span>
      <input
        type="time"
        value={value || ""}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value || null)}
        className="h-11 rounded-xl border border-stone-200 px-3 text-[15px] text-stone-800 bg-white focus:outline-none focus:ring-2 focus:ring-emerald-600/30 focus:border-emerald-600/50 disabled:opacity-50"
      />
    </label>
  );
}

function SectionLabel({ children }) {
  return <h3 className="text-[13px] font-semibold text-stone-400 tracking-wide mb-3">{children}</h3>;
}

/* ---------------------------------------------------------------
   Daily (Today) screen
--------------------------------------------------------------- */

function DailyScreen({ settings, records, onSaveRecord }) {
  const [dateISO, setDateISO] = useState(todayISO());
  const [draft, setDraft] = useState(() => records[dateISO] || {});
  const [saveState, setSaveState] = useState("idle"); // idle | saving | saved
  const debounceRef = useRef(null);
  const dateInputRef = useRef(null);

  useEffect(() => {
    setDraft(records[dateISO] || {});
    setSaveState("idle");
  }, [dateISO]); // eslint-disable-line

  const update = useCallback(
    (patch) => {
      const next = { ...draft, ...patch };
      setDraft(next);
      setSaveState("saving");
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(async () => {
        try {
          await onSaveRecord(dateISO, next);
          setSaveState("saved");
        } catch {
          setSaveState("error");
        }
      }, 500);
    },
    [draft, dateISO, onSaveRecord]
  );

  const manualSave = async () => {
    setSaveState("saving");
    try {
      await onSaveRecord(dateISO, draft);
      setSaveState("saved");
    } catch {
      setSaveState("error");
    }
  };

  useEffect(() => {
    const handler = (e) => {
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
      if (e.key === "ArrowLeft") setDateISO((d) => addDaysISO(d, -1));
      if (e.key === "ArrowRight") setDateISO((d) => addDaysISO(d, 1));
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const { weekday, rest } = formatHeaderDate(dateISO);
  const future = isFutureISO(dateISO);
  const isToday = dateISO === todayISO();
  const durMins = sleepDurationMinutes(draft.sleepTime, draft.wakeTime);
  const score = calculateDailyScore(draft, settings);

  return (
    <div className="pb-28">
      {/* Date header */}
      <div className="px-5 pt-6 pb-5 text-center">
        <div className="flex items-center justify-center gap-3">
          <button
            onClick={() => setDateISO((d) => addDaysISO(d, -1))}
            aria-label="Previous day"
            className="h-9 w-9 rounded-full flex items-center justify-center hover:bg-stone-100 active:scale-95 transition"
          >
            <ChevronLeft size={20} className="text-stone-500" />
          </button>
          <button
            onClick={() => dateInputRef.current?.showPicker?.() || dateInputRef.current?.focus()}
            className="flex flex-col items-center px-2"
          >
            <span className="text-[22px] font-semibold text-stone-900 leading-tight">{rest}</span>
            <span className="text-[13px] text-stone-500">{weekday}</span>
          </button>
          <button
            onClick={() => setDateISO((d) => addDaysISO(d, 1))}
            aria-label="Next day"
            className="h-9 w-9 rounded-full flex items-center justify-center hover:bg-stone-100 active:scale-95 transition"
          >
            <ChevronRight size={20} className="text-stone-500" />
          </button>
        </div>
        <input
          ref={dateInputRef}
          type="date"
          className="sr-only"
          value={dateISO}
          onChange={(e) => e.target.value && setDateISO(e.target.value)}
        />
        <div className="mt-3 flex items-center justify-center gap-2">
          {!isToday && (
            <button
              onClick={() => setDateISO(todayISO())}
              className="text-xs font-medium text-emerald-700 bg-emerald-50 px-3 py-1.5 rounded-full"
            >
              Back to today
            </button>
          )}
          <button
            onClick={() => dateInputRef.current?.showPicker?.() || dateInputRef.current?.focus()}
            className="text-xs font-medium text-stone-500 bg-stone-100 px-3 py-1.5 rounded-full inline-flex items-center gap-1"
          >
            <CalendarDays size={13} /> Pick date
          </button>
        </div>
        {future && (
          <p className="mt-3 text-xs text-amber-700 bg-amber-50 inline-block px-3 py-1 rounded-full">
            This day hasn't happened yet
          </p>
        )}
      </div>

      {/* Score */}
      {score != null && (
        <div className="mx-5 mb-6 rounded-2xl bg-stone-900 text-white px-5 py-4 flex items-center justify-between">
          <div>
            <p className="text-xs text-stone-400">Daily score</p>
            <p className="text-2xl font-semibold">{score}%</p>
          </div>
          <div className="text-right text-xs text-stone-400 leading-relaxed">
            based on habits<br />recorded so far
          </div>
        </div>
      )}

      <div className="px-5 space-y-7">
        {/* SLEEP */}
        <section>
          <SectionLabel>Sleep</SectionLabel>
          <div className="flex gap-3">
            <TimeField label="Sleep time" value={draft.sleepTime} onChange={(v) => update({ sleepTime: v })} />
            <TimeField label="Wake-up time" value={draft.wakeTime} onChange={(v) => update({ wakeTime: v })} />
          </div>
          <div className="mt-3 flex items-center justify-between rounded-xl bg-stone-50 px-4 py-3">
            <div>
              <p className="text-xs text-stone-500">Sleep duration</p>
              <p className="text-lg font-semibold text-stone-800">{formatDuration(durMins)}</p>
            </div>
            <StatusPill status={sleepDurationStatus(draft, settings)} />
          </div>
        </section>

        {/* MORNING */}
        <section>
          <SectionLabel>Morning</SectionLabel>
          <div className="flex items-center justify-between rounded-xl bg-stone-50 px-4 py-3">
            <span className="text-[15px] text-stone-800 flex items-center gap-2">
              <Sunrise size={17} className="text-stone-400" /> Subuh on time
            </span>
            <TriToggle value={draft.subuh ?? null} onChange={(v) => update({ subuh: v })} disabled={future} />
          </div>
        </section>

        {/* WORK */}
        <section>
          <div className="flex items-center justify-between mb-3">
            <SectionLabel>Work</SectionLabel>
            <button
              type="button"
              onClick={() => update({ isOffDay: !draft.isOffDay })}
              disabled={future}
              className={`inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-full transition ${
                draft.isOffDay ? "bg-stone-900 text-white" : "bg-stone-100 text-stone-500"
              } ${future ? "opacity-50" : ""}`}
            >
              <CalendarOff size={13} /> Off day
            </button>
          </div>
          {draft.isOffDay ? (
            <div className="flex items-center justify-between rounded-xl bg-stone-50 px-4 py-3">
              <span className="text-[15px] text-stone-800 flex items-center gap-2">
                <CalendarOff size={17} className="text-stone-400" /> 3 hours of beneficial activities
              </span>
              <TriToggle
                value={draft.beneficialActivities ?? null}
                onChange={(v) => update({ beneficialActivities: v })}
                disabled={future}
              />
            </div>
          ) : (
            <div className="flex items-center gap-3">
              <TimeField label="Arrive office" value={draft.officeArrival} onChange={(v) => update({ officeArrival: v })} />
              <div className="pt-6">
                <StatusPill status={officeStatus(draft, settings)} />
              </div>
            </div>
          )}
        </section>

        {/* HEALTH */}
        <section>
          <SectionLabel>Health</SectionLabel>
          <div className="space-y-2.5">
            <div className="flex items-center justify-between rounded-xl bg-stone-50 px-4 py-3">
              <span className="text-[15px] text-stone-800 flex items-center gap-2">
                <Candy size={17} className="text-stone-400" /> Avoid sugar
              </span>
              <TriToggle value={draft.sugar ?? null} onChange={(v) => update({ sugar: v })} disabled={future} />
            </div>
            <div className="flex items-center justify-between rounded-xl bg-stone-50 px-4 py-3">
              <span className="text-[15px] text-stone-800 flex items-center gap-2">
                <Dumbbell size={17} className="text-stone-400" /> Exercise {settings.exerciseTargetMinutes} min
              </span>
              <TriToggle value={draft.exercise ?? null} onChange={(v) => update({ exercise: v })} disabled={future} />
            </div>
            <div className="flex items-center justify-between rounded-xl bg-stone-50 px-4 py-3">
              <span className="text-[15px] text-stone-800 flex items-center gap-2">
                <BookOpen size={17} className="text-stone-400" /> Read 30 min
              </span>
              <TriToggle value={draft.reading ?? null} onChange={(v) => update({ reading: v })} disabled={future} />
            </div>
          </div>
        </section>

        {/* NOTES */}
        <section>
          <SectionLabel>Notes</SectionLabel>
          <textarea
            value={draft.notes || ""}
            onChange={(e) => update({ notes: e.target.value })}
            placeholder="How was your day?"
            rows={3}
            maxLength={500}
            className="w-full rounded-xl border border-stone-200 bg-white px-4 py-3 text-[15px] text-stone-800 placeholder:text-stone-400 focus:outline-none focus:ring-2 focus:ring-emerald-600/30 focus:border-emerald-600/50 resize-none"
          />
        </section>

        <button
          onClick={manualSave}
          className="w-full h-12 rounded-xl bg-emerald-700 text-white font-medium flex items-center justify-center gap-2 active:scale-[0.98] transition"
        >
          {saveState === "saving" ? (
            <>
              <Loader2 size={16} className="animate-spin" /> Saving…
            </>
          ) : saveState === "saved" ? (
            <>
              <Check size={16} /> Saved
            </>
          ) : saveState === "error" ? (
            "Unable to save — tap to retry"
          ) : (
            "Save day"
          )}
        </button>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------
   Dashboard screen
--------------------------------------------------------------- */

function ProgressBar({ pct, tone = "emerald" }) {
  const colors = {
    emerald: "bg-emerald-600",
    amber: "bg-amber-500",
    rose: "bg-rose-500",
    stone: "bg-stone-300",
  };
  return (
    <div className="h-2 w-full rounded-full bg-stone-100 overflow-hidden">
      <div className={`h-full rounded-full ${colors[tone]}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

function toneFor(pct) {
  if (pct >= 80) return "emerald";
  if (pct >= 50) return "amber";
  return "rose";
}

function DashboardScreen({ settings, records }) {
  const [period, setPeriod] = useState(7);

  const dates = useMemo(() => lastNDatesISO(period, todayISO()), [period]);
  const dayData = useMemo(
    () => dates.map((iso) => ({ iso, record: records[iso] || null, score: calculateDailyScore(records[iso], settings) })),
    [dates, records, settings]
  );
  const scoredDays = dayData.filter((d) => d.score != null);

  const overall = scoredDays.length
    ? Math.round(scoredDays.reduce((a, d) => a + d.score, 0) / scoredDays.length)
    : null;
  const goodDays = scoredDays.filter((d) => d.score >= 80).length;
  const perfectDays = scoredDays.filter((d) => d.score === 100).length;
  const poorDays = scoredDays.filter((d) => d.score < 80).length;

  const habitStats = useMemo(() => {
    return HABITS.filter((h) => h.type !== "derived" || true).map((h) => {
      let completed = 0;
      let recorded = 0;
      dayData.forEach((d) => {
        if (!d.record) return;
        const s = habitScore(h.key, d.record, settings);
        if (s != null) {
          recorded += 1;
          if (s === 100) completed += 1;
        }
      });
      const rate = recorded > 0 ? Math.round((completed / recorded) * 100) : null;
      return { ...h, completed, recorded, rate };
    });
  }, [dayData, settings]);

  const rankable = habitStats.filter((h) => h.rate != null);
  const strongest = [...rankable].sort((a, b) => b.rate - a.rate).slice(0, 3);
  const weakest = [...rankable].sort((a, b) => a.rate - b.rate).slice(0, 3);

  // Sleep section
  const sleepDurations = dayData
    .map((d) => (d.record ? sleepDurationMinutes(d.record.sleepTime, d.record.wakeTime) : null))
    .filter((v) => v != null);
  const avgSleepMins = sleepDurations.length
    ? Math.round(sleepDurations.reduce((a, b) => a + b, 0) / sleepDurations.length)
    : null;
  const withinTargetDays = dayData.filter((d) => {
    if (!d.record) return false;
    return habitScore("sleepDuration", d.record, settings) === 100;
  }).length;
  const sleepRecordedDays = dayData.filter((d) => d.record && sleepDurationMinutes(d.record.sleepTime, d.record.wakeTime) != null).length;
  const bedtimes = dayData.map((d) => (d.record?.sleepTime ? eveningMinutes(d.record.sleepTime) % (24 * 60) : null)).filter((v) => v != null);
  const wakes = dayData.map((d) => (d.record?.wakeTime ? toMinutes(d.record.wakeTime) : null)).filter((v) => v != null);
  const avgOf = (arr) => (arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : null);
  const avgToTime = (mins) => {
    if (mins == null) return "—";
    const h = Math.floor((mins / 60) % 24);
    const m = mins % 60;
    return formatTime12(`${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`);
  };

  // Trend chart data (simple SVG sparkline, no chart lib needed for this scale)
  const trendPoints = dayData.map((d) => d.score);

  // Insights (deterministic)
  const insights = useMemo(() => {
    const list = [];
    if (scoredDays.length < 3) {
      return ["Keep tracking to unlock more insights."];
    }
    if (weakest[0]) list.push(`${weakest[0].label} is your weakest habit this period, at ${weakest[0].rate}%.`);
    if (strongest[0]) list.push(`You're most consistent with ${strongest[0].label.toLowerCase()}, at ${strongest[0].rate}%.`);
    if (avgSleepMins != null) {
      const targetLabel = `${settings.sleepMinHours}–${settings.sleepMaxHours}h`;
      const avgHrs = avgSleepMins / 60;
      if (avgHrs < settings.sleepMinHours) list.push(`Average sleep is ${formatDuration(avgSleepMins)}, below your ${targetLabel} target.`);
      else if (avgHrs > settings.sleepMaxHours) list.push(`Average sleep is ${formatDuration(avgSleepMins)}, above your ${targetLabel} target.`);
      else list.push(`Average sleep is ${formatDuration(avgSleepMins)}, within your ${targetLabel} target.`);
    }
    // trend: compare first half vs second half of scored days
    if (scoredDays.length >= 4) {
      const mid = Math.floor(scoredDays.length / 2);
      const firstHalf = scoredDays.slice(0, mid);
      const secondHalf = scoredDays.slice(mid);
      const avgFirst = firstHalf.reduce((a, d) => a + d.score, 0) / firstHalf.length;
      const avgSecond = secondHalf.reduce((a, d) => a + d.score, 0) / secondHalf.length;
      if (avgSecond - avgFirst >= 5) list.push("Your daily score is trending up compared with earlier in this period.");
      else if (avgFirst - avgSecond >= 5) list.push("Your daily score has dipped compared with earlier in this period.");
    }
    return list.slice(0, 4);
  }, [scoredDays, weakest, strongest, avgSleepMins, settings]);

  const hasAnyData = dayData.some((d) => d.record);

  return (
    <div className="pb-28 px-5 pt-6">
      <div className="flex items-center justify-between mb-5">
        <h1 className="text-xl font-semibold text-stone-900">Dashboard</h1>
        <div className="flex bg-stone-100 rounded-full p-1">
          {[7, 30, 90].map((p) => (
            <button
              key={p}
              onClick={() => setPeriod(p)}
              className={`px-3 py-1.5 text-xs font-medium rounded-full transition ${
                period === p ? "bg-white shadow-sm text-stone-900" : "text-stone-500"
              }`}
            >
              {p}d
            </button>
          ))}
        </div>
      </div>

      {!hasAnyData ? (
        <div className="rounded-2xl bg-stone-50 px-6 py-10 text-center">
          <Sparkles className="mx-auto mb-3 text-stone-300" size={28} />
          <p className="text-stone-500 text-sm">Not enough data yet.</p>
          <p className="text-stone-400 text-xs mt-1">Start tracking today and your trends will appear here.</p>
        </div>
      ) : (
        <div className="space-y-7">
          {/* Top summary */}
          <div className="rounded-2xl bg-stone-900 text-white px-5 py-5">
            <p className="text-xs text-stone-400 mb-1">Last {period} days</p>
            <div className="flex items-end justify-between">
              <div>
                <p className="text-3xl font-semibold">{overall != null ? `${overall}%` : "—"}</p>
                <p className="text-xs text-stone-400 mt-1">{goodDays} / {scoredDays.length} good days</p>
              </div>
              <div className="text-right text-xs text-stone-300 space-y-1">
                <p>{perfectDays} perfect</p>
                <p>{poorDays} needs work</p>
              </div>
            </div>
          </div>

          {/* Strongest / weakest */}
          {rankable.length > 0 && (
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-2xl bg-emerald-50 px-4 py-4">
                <p className="text-xs font-semibold text-emerald-700 mb-2">Strongest</p>
                {strongest.map((h) => (
                  <div key={h.key} className="flex justify-between text-sm text-stone-700 mb-1">
                    <span>{h.label}</span>
                    <span className="font-medium">{h.rate}%</span>
                  </div>
                ))}
              </div>
              <div className="rounded-2xl bg-amber-50 px-4 py-4">
                <p className="text-xs font-semibold text-amber-700 mb-2">Needs attention</p>
                {weakest.map((h) => (
                  <div key={h.key} className="flex justify-between text-sm text-stone-700 mb-1">
                    <span>{h.label}</span>
                    <span className="font-medium">{h.rate}%</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Trend */}
          {scoredDays.length >= 2 && (
            <section>
              <SectionLabel>Score trend</SectionLabel>
              <TrendSparkline data={trendPoints} />
            </section>
          )}

          {/* Habit performance */}
          <section>
            <SectionLabel>Habit performance</SectionLabel>
            <div className="space-y-3">
              {habitStats.map((h) => (
                <div key={h.key}>
                  <div className="flex justify-between text-sm text-stone-700 mb-1.5">
                    <span>{h.label}</span>
                    <span className="text-stone-400">{h.rate != null ? `${h.rate}%` : "no data"}</span>
                  </div>
                  <ProgressBar pct={h.rate ?? 0} tone={h.rate != null ? toneFor(h.rate) : "stone"} />
                </div>
              ))}
            </div>
          </section>

          {/* Sleep */}
          {avgSleepMins != null && (
            <section>
              <SectionLabel>Sleep</SectionLabel>
              <div className="grid grid-cols-2 gap-3">
                <StatBox label="Average" value={formatDuration(avgSleepMins)} />
                <StatBox label="Target" value={`${settings.sleepMinHours}–${settings.sleepMaxHours}h`} />
                <StatBox label="Within target" value={`${withinTargetDays} / ${sleepRecordedDays} days`} />
                <StatBox label="Avg bedtime" value={avgToTime(avgOf(bedtimes))} />
                <StatBox label="Avg wake-up" value={avgToTime(avgOf(wakes))} />
              </div>
            </section>
          )}

          {/* Heatmap */}
          <section>
            <SectionLabel>Consistency heatmap</SectionLabel>
            <div className="overflow-x-auto -mx-5 px-5">
              <div className="inline-block min-w-full">
                <div className="grid" style={{ gridTemplateColumns: `88px repeat(${dayData.length}, 18px)`, rowGap: "6px" }}>
                  <div />
                  {dayData.map((d) => (
                    <div key={d.iso} className="text-center text-[9px] text-stone-300">
                      {fromISODate(d.iso).getDate()}
                    </div>
                  ))}
                  {HABITS.map((h) => (
                    <React.Fragment key={h.key}>
                      <div className="text-xs text-stone-500 flex items-center pr-2 truncate">{h.label}</div>
                      {dayData.map((d) => {
                        const s = d.record ? habitScore(h.key, d.record, settings) : null;
                        const color = s == null ? "bg-stone-100" : s === 100 ? "bg-emerald-500" : "bg-rose-300";
                        return <div key={d.iso} className={`h-4 w-4 rounded-[3px] ${color} justify-self-center`} />;
                      })}
                    </React.Fragment>
                  ))}
                </div>
              </div>
            </div>
          </section>

          {/* Insights */}
          <section>
            <SectionLabel>Insights</SectionLabel>
            <div className="space-y-2">
              {insights.map((text, i) => (
                <div key={i} className="rounded-xl bg-stone-50 px-4 py-3 text-sm text-stone-700 flex items-start gap-2">
                  <Sparkles size={14} className="text-stone-400 mt-0.5 shrink-0" />
                  <span>{text}</span>
                </div>
              ))}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

function StatBox({ label, value }) {
  return (
    <div className="rounded-xl bg-stone-50 px-4 py-3">
      <p className="text-xs text-stone-400">{label}</p>
      <p className="text-base font-semibold text-stone-800 mt-0.5">{value}</p>
    </div>
  );
}

function TrendSparkline({ data }) {
  const w = 320;
  const h = 90;
  const pad = 8;
  const points = data.map((v, i) => ({ x: i, y: v }));
  const valid = points.filter((p) => p.y != null);
  if (valid.length < 2) return null;
  const xStep = (w - pad * 2) / Math.max(data.length - 1, 1);
  const toXY = (p) => [pad + p.x * xStep, pad + (1 - p.y / 100) * (h - pad * 2)];
  let path = "";
  let started = false;
  points.forEach((p) => {
    if (p.y == null) {
      started = false;
      return;
    }
    const [x, y] = toXY(p);
    path += started ? ` L ${x} ${y}` : `M ${x} ${y}`;
    started = true;
  });
  return (
    <div className="rounded-2xl bg-stone-50 px-4 py-4">
      <svg viewBox={`0 0 ${w} ${h}`} className="w-full" style={{ height: h }}>
        <line x1={pad} y1={pad + (1 - 0.8) * (h - pad * 2)} x2={w - pad} y2={pad + (1 - 0.8) * (h - pad * 2)} stroke="#e7e5e4" strokeDasharray="3 3" />
        <path d={path} fill="none" stroke="#047857" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
        {points.map((p, i) =>
          p.y == null ? null : (
            <circle key={i} cx={toXY(p)[0]} cy={toXY(p)[1]} r="2.5" fill="#047857" />
          )
        )}
      </svg>
      <div className="flex justify-between text-[10px] text-stone-400 mt-1">
        <span>{data.length} days ago</span>
        <span>today</span>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------
   Settings screen
--------------------------------------------------------------- */

function SettingsScreen({ settings, onSave, records, onImportRecords, userEmail, onSignOut }) {
  const [form, setForm] = useState(settings);
  const [status, setStatus] = useState("idle");
  const [importStatus, setImportStatus] = useState(null);
  const fileInputRef = useRef(null);

  useEffect(() => setForm(settings), [settings]);

  const recordCount = Object.keys(records || {}).length;

  const handleFilePicked = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setImportStatus("loading");
    try {
      const parsed = await importJSONFile(file);
      const count = Object.keys(parsed.records).length;
      await onImportRecords(parsed.records);
      setImportStatus(`Imported ${count} day${count === 1 ? "" : "s"}.`);
    } catch (err) {
      setImportStatus(err.message || "Couldn't read that file.");
    }
  };

  const set = (patch) => {
    setForm((f) => ({ ...f, ...patch }));
    setStatus("idle");
  };

  const save = async () => {
    setStatus("saving");
    try {
      await onSave(form);
      setStatus("saved");
    } catch {
      setStatus("error");
    }
  };

  const reset = () => setForm(DEFAULT_SETTINGS);

  return (
    <div className="pb-28 px-5 pt-6">
      <h1 className="text-xl font-semibold text-stone-900 mb-6">Settings</h1>

      <section className="mb-7">
        <SectionLabel>Profile</SectionLabel>
        <div className="flex items-center justify-between rounded-xl bg-stone-50 px-4 py-3">
          <span className="text-[15px] text-stone-700 truncate">{userEmail}</span>
          <button
            onClick={onSignOut}
            className="text-xs font-medium text-stone-500 bg-white border border-stone-200 px-3 py-1.5 rounded-full inline-flex items-center gap-1.5 active:scale-95 transition"
          >
            <LogOut size={13} /> Sign out
          </button>
        </div>
      </section>

      <section className="mb-7">
        <SectionLabel>Habit targets</SectionLabel>
        <div className="space-y-4">
          <FieldRow label="Sleep before">
            <input type="time" value={form.sleepTimeTarget} onChange={(e) => set({ sleepTimeTarget: e.target.value })} className="settings-input" />
          </FieldRow>
          <FieldRow label="Wake up before">
            <input type="time" value={form.wakeTimeTarget} onChange={(e) => set({ wakeTimeTarget: e.target.value })} className="settings-input" />
          </FieldRow>
          <FieldRow label="Sleep duration">
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={0}
                max={12}
                value={form.sleepMinHours}
                onChange={(e) => set({ sleepMinHours: Number(e.target.value) })}
                className="settings-input w-16 text-center"
              />
              <span className="text-stone-400 text-sm">to</span>
              <input
                type="number"
                min={0}
                max={12}
                value={form.sleepMaxHours}
                onChange={(e) => set({ sleepMaxHours: Number(e.target.value) })}
                className="settings-input w-16 text-center"
              />
              <span className="text-stone-400 text-sm">hours</span>
            </div>
          </FieldRow>
          <FieldRow label="Office before">
            <input type="time" value={form.officeTarget} onChange={(e) => set({ officeTarget: e.target.value })} className="settings-input" />
          </FieldRow>
          <FieldRow label="Exercise">
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={0}
                max={300}
                value={form.exerciseTargetMinutes}
                onChange={(e) => set({ exerciseTargetMinutes: Number(e.target.value) })}
                className="settings-input w-16 text-center"
              />
              <span className="text-stone-400 text-sm">minutes</span>
            </div>
          </FieldRow>
        </div>
      </section>

      <div className="flex gap-3">
        <button onClick={reset} className="flex-1 h-12 rounded-xl border border-stone-200 text-stone-600 font-medium flex items-center justify-center gap-2 active:scale-[0.98] transition">
          <RotateCcw size={15} /> Reset defaults
        </button>
        <button onClick={save} className="flex-1 h-12 rounded-xl bg-emerald-700 text-white font-medium flex items-center justify-center gap-2 active:scale-[0.98] transition">
          {status === "saving" ? <Loader2 size={16} className="animate-spin" /> : status === "saved" ? <Check size={16} /> : null}
          {status === "saving" ? "Saving…" : status === "saved" ? "Saved" : "Save changes"}
        </button>
      </div>

      <p className="text-xs text-stone-400 mt-4 leading-relaxed">
        Changes apply to future calculations only. Past days keep the record of what actually happened.
      </p>

      <section className="mt-9">
        <SectionLabel>Your data</SectionLabel>
        <div className="rounded-xl bg-stone-50 px-4 py-4 mb-3">
          <p className="text-sm text-stone-700">{recordCount} day{recordCount === 1 ? "" : "s"} recorded</p>
          <p className="text-xs text-stone-400 mt-1">
            Synced to your account in real time. Export a backup occasionally anyway — it's good practice and lets you take your data anywhere.
          </p>
        </div>
        <div className="flex gap-3 mb-3">
          <button
            onClick={() => exportJSON(records, settings)}
            className="flex-1 h-11 rounded-xl border border-stone-200 text-stone-600 text-sm font-medium active:scale-[0.98] transition"
          >
            Export JSON
          </button>
          <button
            onClick={() => exportCSV(records)}
            className="flex-1 h-11 rounded-xl border border-stone-200 text-stone-600 text-sm font-medium active:scale-[0.98] transition"
          >
            Export CSV
          </button>
        </div>
        <button
          onClick={() => fileInputRef.current?.click()}
          className="w-full h-11 rounded-xl border border-dashed border-stone-300 text-stone-500 text-sm font-medium active:scale-[0.98] transition"
        >
          Restore from JSON backup
        </button>
        <input ref={fileInputRef} type="file" accept="application/json" className="hidden" onChange={handleFilePicked} />
        {importStatus && (
          <p className={`text-xs mt-2 ${importStatus.startsWith("Imported") ? "text-emerald-700" : "text-rose-600"}`}>
            {importStatus === "loading" ? "Importing…" : importStatus}
          </p>
        )}
      </section>

      <style>{`
        .settings-input {
          height: 44px;
          border-radius: 12px;
          border: 1px solid #e7e5e4;
          padding: 0 12px;
          font-size: 15px;
          color: #292524;
          background: white;
        }
        .settings-input:focus {
          outline: none;
          border-color: rgba(4,120,87,0.5);
          box-shadow: 0 0 0 3px rgba(4,120,87,0.15);
        }
      `}</style>
    </div>
  );
}

function FieldRow({ label, children }) {
  return (
    <div className="flex items-center justify-between rounded-xl bg-stone-50 px-4 py-3">
      <span className="text-[15px] text-stone-700">{label}</span>
      {children}
    </div>
  );
}

/* ---------------------------------------------------------------
   Setup / auth screens
--------------------------------------------------------------- */

function SetupNeededScreen() {
  return (
    <div className="min-h-screen bg-[#F6F6F2] flex items-center justify-center px-6">
      <div className="max-w-sm text-center">
        <AlertTriangle className="mx-auto mb-4 text-amber-500" size={32} />
        <h1 className="text-lg font-semibold text-stone-900 mb-2">Backend not configured</h1>
        <p className="text-sm text-stone-500 leading-relaxed">
          This app needs a Supabase project to store your data. Add{" "}
          <code className="bg-stone-100 px-1 rounded">VITE_SUPABASE_URL</code> and{" "}
          <code className="bg-stone-100 px-1 rounded">VITE_SUPABASE_ANON_KEY</code> as environment
          variables (see the README) and rebuild.
        </p>
      </div>
    </div>
  );
}

function SignInScreen() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState("idle"); // idle | sending | sent | error
  const [errorMsg, setErrorMsg] = useState("");

  const sendLink = async (e) => {
    e.preventDefault();
    if (!email) return;
    setStatus("sending");
    try {
      const { error } = await supabase.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: window.location.origin + window.location.pathname },
      });
      if (error) throw error;
      setStatus("sent");
    } catch (err) {
      setErrorMsg(err.message || "Couldn't send the link. Try again.");
      setStatus("error");
    }
  };

  return (
    <div className="min-h-screen bg-[#F6F6F2] flex items-center justify-center px-6">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="mx-auto mb-4 h-12 w-12 rounded-2xl bg-stone-900 flex items-center justify-center">
            <Moon className="text-white" size={22} />
          </div>
          <h1 className="text-xl font-semibold text-stone-900">Habit Tracker</h1>
          <p className="text-sm text-stone-500 mt-1">Sign in to sync your daily records.</p>
        </div>

        {status === "sent" ? (
          <div className="rounded-2xl bg-emerald-50 px-5 py-6 text-center">
            <Mail className="mx-auto mb-2 text-emerald-700" size={22} />
            <p className="text-sm text-emerald-800 font-medium">Check your email</p>
            <p className="text-xs text-emerald-700 mt-1">
              We sent a sign-in link to {email}. Open it on this device to continue.
            </p>
          </div>
        ) : (
          <form onSubmit={sendLink} className="space-y-3">
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              className="w-full h-12 rounded-xl border border-stone-200 px-4 text-[15px] bg-white focus:outline-none focus:ring-2 focus:ring-emerald-600/30 focus:border-emerald-600/50"
            />
            <button
              type="submit"
              disabled={status === "sending"}
              className="w-full h-12 rounded-xl bg-emerald-700 text-white font-medium flex items-center justify-center gap-2 active:scale-[0.98] transition disabled:opacity-60"
            >
              {status === "sending" ? <Loader2 size={16} className="animate-spin" /> : <Mail size={16} />}
              {status === "sending" ? "Sending…" : "Send sign-in link"}
            </button>
            {status === "error" && <p className="text-xs text-rose-600 text-center">{errorMsg}</p>}
          </form>
        )}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------
   Root app
--------------------------------------------------------------- */

export default function HabitTrackerApp() {
  const [tab, setTab] = useState("today");
  const [session, setSession] = useState(undefined); // undefined = checking, null = signed out
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [records, setRecords] = useState({});
  const [dataLoading, setDataLoading] = useState(true);
  const [dataError, setDataError] = useState(null);

  useEffect(() => {
    if (!isSupabaseConfigured) {
      setSession(null);
      return;
    }
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    setDataLoading(true);
    setDataError(null);
    (async () => {
      try {
        const [s, r] = await Promise.all([ensureSettings(session.user.id), fetchAllRecords(session.user.id)]);
        if (cancelled) return;
        setSettings(s);
        setRecords(r);
      } catch (err) {
        if (!cancelled) setDataError(err.message || "Couldn't load your data.");
      } finally {
        if (!cancelled) setDataLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [session]);

  const handleSaveRecord = useCallback(
    async (dateISO, record) => {
      setRecords((prev) => ({ ...prev, [dateISO]: { ...record, date: dateISO } }));
      await upsertRecord(session.user.id, dateISO, record);
    },
    [session]
  );

  const handleSaveSettings = useCallback(
    async (newSettings) => {
      setSettings(newSettings);
      await upsertSettings(session.user.id, newSettings);
    },
    [session]
  );

  const handleImportRecords = useCallback(
    async (importedRecords) => {
      setRecords((prev) => ({ ...prev, ...importedRecords }));
      await upsertRecordsBulk(session.user.id, importedRecords);
    },
    [session]
  );

  const handleSignOut = useCallback(async () => {
    await supabase.auth.signOut();
  }, []);

  if (!isSupabaseConfigured) return <SetupNeededScreen />;
  if (session === undefined) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#F6F6F2]">
        <Loader2 className="animate-spin text-stone-300" size={28} />
      </div>
    );
  }
  if (session === null) return <SignInScreen />;

  if (dataLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#F6F6F2]">
        <Loader2 className="animate-spin text-stone-300" size={28} />
      </div>
    );
  }

  if (dataError) {
    return (
      <div className="min-h-screen bg-[#F6F6F2] flex items-center justify-center px-6">
        <div className="max-w-sm text-center">
          <AlertTriangle className="mx-auto mb-4 text-rose-500" size={28} />
          <p className="text-sm text-stone-600 mb-4">{dataError}</p>
          <button onClick={() => setSession({ ...session })} className="text-sm font-medium text-emerald-700 bg-emerald-50 px-4 py-2 rounded-full">
            Try again
          </button>
        </div>
      </div>
    );
  }

  const navItems = [
    { id: "today", label: "Today", icon: CalendarDays },
    { id: "dashboard", label: "Dashboard", icon: LayoutGrid },
    { id: "settings", label: "Settings", icon: SettingsIcon },
  ];

  return (
    <div className="min-h-screen bg-[#F6F6F2] flex flex-col font-sans">
      <div className="max-w-[480px] w-full mx-auto flex-1 flex flex-col bg-[#F6F6F2] relative">
        <div className="flex-1 overflow-y-auto">
          {tab === "today" && <DailyScreen settings={settings} records={records} onSaveRecord={handleSaveRecord} />}
          {tab === "dashboard" && <DashboardScreen settings={settings} records={records} />}
          {tab === "settings" && (
            <SettingsScreen
              settings={settings}
              onSave={handleSaveSettings}
              records={records}
              onImportRecords={handleImportRecords}
              userEmail={session.user.email}
              onSignOut={handleSignOut}
            />
          )}
        </div>

        <nav className="sticky bottom-0 bg-white/95 backdrop-blur border-t border-stone-200 flex justify-around py-2 px-2">
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = tab === item.id;
            return (
              <button
                key={item.id}
                onClick={() => setTab(item.id)}
                className="flex flex-col items-center gap-1 px-6 py-1.5 rounded-xl"
              >
                <Icon size={20} strokeWidth={2} className={active ? "text-emerald-700" : "text-stone-400"} />
                <span className={`text-[11px] font-medium ${active ? "text-emerald-700" : "text-stone-400"}`}>
                  {item.label}
                </span>
              </button>
            );
          })}
        </nav>
      </div>
    </div>
  );
}
