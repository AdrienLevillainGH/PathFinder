import React from "react";
import { Star } from "lucide-react";

/* Your note for a segment, out of 5 (half points): one star, filled in
   proportion (3.5/5 = 70 % of the star), and the number. */

export const STAR = "#E0A21B";

export function RatingStar({ value = null, size = 18 }) {
  const f = value == null ? 0 : Math.max(0, Math.min(1, value / 5));
  return (
    <span className="relative inline-block shrink-0 align-middle" style={{ width: size, height: size }}
      role="img" aria-label={value == null ? "Not rated" : `${value} out of 5`}>
      <Star size={size} className="absolute left-0 top-0" style={{ color: STAR }} />
      <span className="absolute left-0 top-0 h-full overflow-hidden" style={{ width: `${f * 100}%` }}>
        <Star size={size} fill={STAR} style={{ color: STAR }} />
      </span>
    </span>
  );
}

export const fmtNote = (v) => (v == null ? "" : `${v}/5`);

// five stars to pick a note: the left half of a star is a half point
export function RatingPicker({ value, onPick, onClear, onClose, title }) {
  return (
    <div className="fixed inset-0 z-[70] flex items-end bg-black/40" onClick={onClose} role="dialog" aria-modal="true" aria-label="Your note">
      <div className="dl-bg dl-text w-full rounded-t-3xl px-5 pb-6 pt-4" onClick={(e) => e.stopPropagation()}
        style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 1.5rem)" }}>
        <div className="mx-auto max-w-md">
          <div className="text-[17px] font-semibold">Your note</div>
          {title && <div className="truncate text-sm dl-muted">{title}</div>}
          <div className="mt-5 flex justify-center gap-1">
            {[1, 2, 3, 4, 5].map((k) => {
              const fill = value == null ? 0 : Math.max(0, Math.min(1, value - (k - 1)));
              return (
                <span key={k} className="relative" style={{ width: 52, height: 52 }}>
                  <Star size={52} strokeWidth={1.5} className="absolute inset-0" style={{ color: STAR }} />
                  <span className="absolute left-0 top-0 h-full overflow-hidden" style={{ width: `${fill * 100}%` }}>
                    <Star size={52} strokeWidth={1.5} fill={STAR} style={{ color: STAR }} />
                  </span>
                  <button className="absolute inset-y-0 left-0 w-1/2" aria-label={`${k - 0.5} out of 5`} onClick={() => onPick(k - 0.5)} />
                  <button className="absolute inset-y-0 right-0 w-1/2" aria-label={`${k} out of 5`} onClick={() => onPick(k)} />
                </span>
              );
            })}
          </div>
          <div className="mt-3 text-center text-[15px] tabular-nums dl-muted">{value == null ? "Tap a star (left half: half a point)" : fmtNote(value)}</div>
          <div className="mt-5 flex gap-3">
            {value != null && <button onClick={onClear} className="dl-soft min-h-[48px] flex-1 rounded-2xl text-[15px] font-semibold">Remove the note</button>}
            <button onClick={onClose} className="dl-accent min-h-[48px] flex-1 rounded-2xl text-[15px] font-semibold">Done</button>
          </div>
        </div>
      </div>
    </div>
  );
}
