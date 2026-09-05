import { supabase } from "./supabaseClient";

/* Postgres `time` columns come back as "HH:MM:SS" — trim to "HH:MM" to
   match the <input type="time"> format the rest of the app expects. */
function toHHMM(v) {
  return v ? v.slice(0, 5) : null;
}

const DEFAULT_SETTINGS = {
  sleepTimeTarget: "23:30",
  wakeTimeTarget: "06:30",
  sleepMinHours: 6,
  sleepMaxHours: 8,
  officeTarget: "09:00",
  exerciseTargetMinutes: 30,
};

function rowToSettings(row) {
  return {
    sleepTimeTarget: toHHMM(row.sleep_time_target),
    wakeTimeTarget: toHHMM(row.wake_time_target),
    sleepMinHours: Number(row.sleep_min_hours),
    sleepMaxHours: Number(row.sleep_max_hours),
    officeTarget: toHHMM(row.office_target),
    exerciseTargetMinutes: row.exercise_target_minutes,
  };
}

function settingsToRow(userId, s) {
  return {
    user_id: userId,
    sleep_time_target: s.sleepTimeTarget,
    wake_time_target: s.wakeTimeTarget,
    sleep_min_hours: s.sleepMinHours,
    sleep_max_hours: s.sleepMaxHours,
    office_target: s.officeTarget,
    exercise_target_minutes: s.exerciseTargetMinutes,
    updated_at: new Date().toISOString(),
  };
}

function rowToRecord(row) {
  return {
    date: row.date,
    sleepTime: toHHMM(row.sleep_time),
    wakeTime: toHHMM(row.wake_time),
    subuh: row.subuh,
    officeArrival: toHHMM(row.office_arrival),
    sugar: row.avoid_sugar,
    exercise: row.exercise_completed,
    notes: row.notes || "",
  };
}

function recordToRow(userId, dateISO, r) {
  return {
    user_id: userId,
    date: dateISO,
    sleep_time: r.sleepTime || null,
    wake_time: r.wakeTime || null,
    subuh: r.subuh ?? null,
    office_arrival: r.officeArrival || null,
    avoid_sugar: r.sugar ?? null,
    exercise_completed: r.exercise ?? null,
    notes: r.notes || null,
    updated_at: new Date().toISOString(),
  };
}

/** Returns saved settings, or null if this user has never saved any yet. */
export async function fetchSettings(userId) {
  const { data, error } = await supabase
    .from("user_settings")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return data ? rowToSettings(data) : null;
}

export async function ensureSettings(userId) {
  const existing = await fetchSettings(userId);
  if (existing) return existing;
  await upsertSettings(userId, DEFAULT_SETTINGS);
  return { ...DEFAULT_SETTINGS };
}

export async function upsertSettings(userId, settings) {
  const { error } = await supabase
    .from("user_settings")
    .upsert(settingsToRow(userId, settings), { onConflict: "user_id" });
  if (error) throw error;
}

/** Returns a map keyed by ISO date, matching the shape the app already uses. */
export async function fetchAllRecords(userId) {
  const { data, error } = await supabase
    .from("daily_records")
    .select("*")
    .eq("user_id", userId);
  if (error) throw error;
  const map = {};
  (data || []).forEach((row) => {
    map[row.date] = rowToRecord(row);
  });
  return map;
}

export async function upsertRecord(userId, dateISO, record) {
  const { error } = await supabase
    .from("daily_records")
    .upsert(recordToRow(userId, dateISO, record), { onConflict: "user_id,date" });
  if (error) throw error;
}

export async function upsertRecordsBulk(userId, recordsByDate) {
  const rows = Object.entries(recordsByDate).map(([dateISO, r]) => recordToRow(userId, dateISO, r));
  if (rows.length === 0) return;
  const { error } = await supabase
    .from("daily_records")
    .upsert(rows, { onConflict: "user_id,date" });
  if (error) throw error;
}
