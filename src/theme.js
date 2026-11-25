/* Look and feel.
   The theme machinery and the dl-* class names come from DayLoad, so
   components move between the two apps as they are. "Trail", the
   default, takes its colours from the Komoot screens Adrien shared:
   warm paper, olive green for the main action, sand for the second. */

const base = { water: "#9CC3DB", route: "#8FA9F5", slate: "#2D3945", cta: "#EE6C18" };

export const THEMES = {
  trail:    { ...base, label: "Trail",    mode: "light", bg: "#F6F3EC", surface: "#FFFFFF", field: "#FFFFFF", line: "#E4DFD3", text: "#1B1A16", muted: "#55524A", faint: "#8C877C", accentBg: "#4F6814", accentText: "#FFFFFF", softBg: "#E3D2B4", softText: "#404823", grid: "#ECE7DB", land: "#EBEDDA", sel: "#564637" },
  dark:     { ...base, label: "Dark",     mode: "dark",  bg: "#000000", surface: "#111111", field: "#000000", line: "#2A2A2A", text: "#FFFFFF", muted: "#B4B4B4", faint: "#7A7A7A", accentBg: "#FFFFFF", accentText: "#000000", softBg: "#222222", softText: "#FFFFFF", grid: "#1C1C1C", land: "#0D0F0B", sel: "#F2E6D0", water: "#2B4A5E", slate: "#1A222B" },
  light:    { ...base, label: "Light",    mode: "light", bg: "#FFFFFF", surface: "#F6F6F4", field: "#FFFFFF", line: "#E3E3DE", text: "#141414", muted: "#4B4B4B", faint: "#8A8A85", accentBg: "#141414", accentText: "#FFFFFF", softBg: "#EDEDE8", softText: "#141414", grid: "#EAEAE6", land: "#F2F3EC", sel: "#3B3127" },
  midnight: { ...base, label: "Midnight", mode: "dark",  bg: "#07070B", surface: "#12121C", field: "#07070B", line: "#26263A", text: "#F2F2FF", muted: "#A9A9C4", faint: "#6E6E8C", accentBg: "#C2F53C", accentText: "#0A0A0F", softBg: "#1D1D2C", softText: "#F2F2FF", grid: "#1A1A2A", land: "#0C0C14", sel: "#C2F53C", water: "#22364A", slate: "#151523" },
  emerald:  { ...base, label: "Emerald",  mode: "light", bg: "#F5F2EC", surface: "#FFFFFF", field: "#FFFFFF", line: "#E2DED4", text: "#101613", muted: "#4A5750", faint: "#8A9189", accentBg: "#00A862", accentText: "#FFFFFF", softBg: "#E2DED4", softText: "#101613", grid: "#E8E4DA", land: "#EDEEDD", sel: "#20352A" },
};

export function pickTheme(setting) {
  if (setting && THEMES[setting]) return THEMES[setting];
  if (setting === "auto") {
    const forced = document.documentElement.getAttribute("data-theme");
    if (forced === "dark") return THEMES.dark;
    if (forced === "light") return THEMES.trail;
    try {
      if (window.matchMedia("(prefers-color-scheme: dark)").matches) return THEMES.dark;
    } catch (e) { /* no matchMedia */ }
  }
  return THEMES.trail;
}

export function themeCss(t) {
  return `
.dl-root{--bg:${t.bg};--surface:${t.surface};--field:${t.field};--line:${t.line};--text:${t.text};--muted:${t.muted};--faint:${t.faint};--abg:${t.accentBg};--atext:${t.accentText};--soft:${t.softBg};--softtext:${t.softText};--grid:${t.grid};--land:${t.land};--water:${t.water};--route:${t.route};--sel:${t.sel};--slate:${t.slate};--cta:${t.cta};font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color-scheme:${t.mode};}
.dl-bg{background:var(--bg);}
.dl-surface{background:var(--surface);}
.dl-field{background:var(--field);}
.dl-text{color:var(--text);}
.dl-muted{color:var(--muted);}
.dl-faint{color:var(--faint);}
.dl-line{border-color:var(--line);}
.dl-accent{background:var(--abg);color:var(--atext);}
.dl-soft{background:var(--soft);color:var(--softtext);}
.dl-float{background:var(--surface);box-shadow:0 2px 10px rgba(0,0,0,.14);}
.dl-root input,.dl-root select{color:var(--text);}
.dl-root input[type=range]{accent-color:var(--abg);}
`;
}

/* Grade, as climbing apps colour it: green for gentle, through yellow
   and orange, to deep red for walls. A convention runners already read
   at a glance; the numbers are always printed next to it. */
export const GRADE_BINS = [0.05, 0.1, 0.15, 0.2, 0.25];
export const GRADE_COLORS = ["#8CC152", "#C9D23F", "#F2B53A", "#EE6C18", "#D23A1E", "#A3201B"];
export const GRADE_LABELS = ["< 5", "5–10", "10–15", "15–20", "20–25", "≥ 25"];

export function gradeColor(g) {
  let k = 0;
  while (k < GRADE_BINS.length && g >= GRADE_BINS[k]) k++;
  return GRADE_COLORS[k];
}
