/* Preview storage: this browser only.

   The real app copies DayLoad's storage.js, github.js and merge.js as they
   are — localStorage is the cache, a private `pathfinder-data` repo is the
   truth. The data has the same shape here, so nothing moves when the sync
   is switched on: every item carries updatedAt, deletions go to graveyard. */

const KEY = "pathfinder:v1";
export const SCHEMA = 1;

const EMPTY = () => ({
  schema: SCHEMA,
  favourites: {},          // climbId → { updatedAt }
  done: [],                // { id, climbId, date, updatedAt }
  presets: [],             // { id, name, query, updatedAt }
  settings: { theme: "trail", pace: 6 },
  graveyard: [],           // { id, deletedAt }
  lastQuery: null,
});

export function loadLocal() {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return EMPTY();
    const data = JSON.parse(raw);
    // preview 0.1 stored separate minGain / maxLen / minGrade fields: map them onto the two modes
    const upgrade = (qq) => {
      if (!qq || qq.mode) return qq;
      const grade = qq.minGrade > 0 && !(qq.minGain > 0);
      const { minGain, maxLen, minLen, minGrade, ...rest } = qq;
      return grade
        ? { ...rest, mode: "grade", grade: minGrade, len: minLen || maxLen || 1000, preset: "custom" }
        : { ...rest, mode: "gain", gain: minGain || 300, len: maxLen || 2000, preset: "custom" };
    };
    return {
      ...EMPTY(), ...data,
      settings: { ...EMPTY().settings, ...(data.settings || {}) },
      lastQuery: upgrade(data.lastQuery),
      presets: (data.presets || []).map((p) => ({ ...p, query: upgrade(p.query) })),
    };
  } catch (e) {
    return EMPTY();
  }
}

export function saveLocal(data) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(data));
  } catch (e) {
    /* storage off or full: the session still works, it just won't remember */
  }
}

export function resetLocal() {
  try { window.localStorage.removeItem(KEY); } catch (e) { /* nothing to do */ }
  return EMPTY();
}

export const nowISO = () => new Date().toISOString();
export const uid = () => Math.random().toString(36).slice(2, 10);
