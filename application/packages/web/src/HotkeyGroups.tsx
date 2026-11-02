/**
 * A list of hotkey groups in the printed cheat sheet's layout: one key cap
 * per key, "/" between alternatives, two columns once there is room (a
 * container query, so the copy embedded in Settings follows its own width).
 * The app's list (AboutModal.tsx) and the drawing canvas's own list
 * (drawing/DrawingHotkeys.tsx) both draw through it, so the two look alike.
 */
import { Keyboard } from './icons';
import { Kbd } from './ui';
import { EYEBROW_ICON_ROW, EyebrowGlyph, SETTINGS_EYEBROW } from './settingsUI';
import { DESKTOP_APP, KEY_OS } from './shortcutMatch';
import { rowCaps, rowText, type HotkeyGroup } from './hotkeysData';

export function HotkeyGroups({ groups }: { groups: readonly HotkeyGroup[] }) {
  return (
    <div className="@container">
      <div className="@2xl:columns-2 @2xl:gap-8">
        {groups.map((g) => {
          const rows = g.rows.filter((r) => rowCaps(r, KEY_OS, DESKTOP_APP).length > 0);
          if (rows.length === 0) return null;
          return (
            <section key={g.title} className="break-inside-avoid pb-6">
              <h3 className={`${SETTINGS_EYEBROW} ${EYEBROW_ICON_ROW} mb-2`}>
                <EyebrowGlyph icon={Keyboard} />
                {g.title}
              </h3>
              <div className="divide-y divide-divider">
                {rows.map((r, i) => (
                  <div key={i} className="flex items-center justify-between py-1.5 gap-4">
                    <span className="text-pn-soft">{r.label}</span>
                    <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap" dir="ltr" aria-label={rowText(r, KEY_OS, DESKTOP_APP)}>
                      {rowCaps(r, KEY_OS, DESKTOP_APP).map((part, j) => (
                        typeof part === 'string'
                          ? <span key={j} className="text-meta text-pn-muted" aria-hidden="true">{part}</span>
                          : <span key={j} className="inline-flex gap-0.5" aria-hidden="true">{part.map((k, n) => <Kbd key={n}>{k}</Kbd>)}</span>
                      ))}
                    </span>
                  </div>
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
