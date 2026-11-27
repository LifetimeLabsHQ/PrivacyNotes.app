import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  APP_ICON_PRESETS,
  setAppIcon,
  useAppIcon,
  type AppIconId,
  type AppIconPreset,
} from './appIcon';
import { ensureLooksLoaded } from './i18n';
import { AppWindow, CheckCircle } from './icons';
import { NoteBoyMark } from './LogoIcon';
import { Callout, SETTINGS_CARD, SETTINGS_CARD_ON, SETTINGS_CARD_REST, SETTINGS_GROUP, SETTINGS_HELP, SectionEyebrow } from './ui';

/**
 * Inline vector preview for each desktop app icon preset. Keeps zero extra
 * asset requests and matches the generated native icons in
 * `packages/desktop/scripts/make-alt-icons.py`.
 */
function AppIconArtwork({ id }: { id: AppIconId }) {
  const uid = useId().replace(/:/g, '');
  const clip = `pn-ic-${uid}`;
  const grad = `pn-gr-${uid}`;
  const shine = `pn-sh-${uid}`;

  switch (id) {
    case 'default':
      return (
        <svg viewBox="0 0 100 100" className="w-12 h-12 shrink-0 drop-shadow-sm" aria-hidden="true">
          <defs><clipPath id={clip}><rect width="100" height="100" rx="22" /></clipPath></defs>
          <g clipPath={`url(#${clip})`}>
            <rect width="100" height="100" fill="#1E40AF" />
            <path fill="#4F6BD5" d="M50 0h50v50z" />
            <g transform="translate(-4.94 -27.7) scale(1.57)">
              <path fill="#FFFFFF" d="m22 44h26c1.1 0 2 0.9 2 2v16c0 1.1-0.9 2-2 2h-26c-1.1 0-2-0.9-2-2v-16c0-1.1 0.9-2 2-2z" />
              <path fill="#FFFFFF" d="m26 44v-8q0-8 9-8 9 0 9 8v8h-5v-8q0-3-4-3-4 0-4 3v8z" />
              <circle cx="48" cy="60" r="11" fill="#10B981" />
              <path fill="none" stroke="#FFFFFF" strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" d="m42 61l4 3 8-8" />
            </g>
          </g>
        </svg>
      );
    case 'dark':
      return (
        <svg viewBox="0 0 100 100" className="w-12 h-12 shrink-0 drop-shadow-sm" aria-hidden="true">
          <defs><clipPath id={clip}><rect width="100" height="100" rx="22" /></clipPath></defs>
          <g clipPath={`url(#${clip})`}>
            <rect width="100" height="100" fill="#18181A" />
            <path fill="#2E2E33" d="M50 0h50v50z" />
            <g transform="translate(-4.94 -27.7) scale(1.57)">
              <path fill="#FFFFFF" d="m22 44h26c1.1 0 2 0.9 2 2v16c0 1.1-0.9 2-2 2h-26c-1.1 0-2-0.9-2-2v-16c0-1.1 0.9-2 2-2z" />
              <path fill="#FFFFFF" d="m26 44v-8q0-8 9-8 9 0 9 8v8h-5v-8q0-3-4-3-4 0-4 3v8z" />
              <circle cx="48" cy="60" r="11" fill="#10B981" />
              <path fill="none" stroke="#FFFFFF" strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" d="m42 61l4 3 8-8" />
            </g>
          </g>
        </svg>
      );
    case 'tinted':
      return (
        <svg viewBox="0 0 100 100" className="w-12 h-12 shrink-0 drop-shadow-sm" aria-hidden="true">
          <defs>
            <clipPath id={clip}><rect width="100" height="100" rx="22" /></clipPath>
            <linearGradient id={grad} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#33363D" />
              <stop offset="100%" stopColor="#1E2025" />
            </linearGradient>
          </defs>
          <g clipPath={`url(#${clip})`}>
            <rect width="100" height="100" fill={`url(#${grad})`} />
            <path fill="#4B505A" d="M50 0h50v50z" />
            <g transform="translate(-4.94 -27.7) scale(1.57)">
              <path fill="#C7CCD6" d="m22 44h26c1.1 0 2 0.9 2 2v16c0 1.1-0.9 2-2 2h-26c-1.1 0-2-0.9-2-2v-16c0-1.1 0.9-2 2-2z" />
              <path fill="#C7CCD6" d="m26 44v-8q0-8 9-8 9 0 9 8v8h-5v-8q0-3-4-3-4 0-4 3v8z" />
              <circle cx="48" cy="60" r="11" fill="#8C93A0" />
              <path fill="none" stroke="#1E2025" strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" d="m42 61l4 3 8-8" />
            </g>
          </g>
        </svg>
      );
    case 'liquid':
      return (
        <svg viewBox="0 0 100 100" className="w-12 h-12 shrink-0 drop-shadow-sm" aria-hidden="true">
          <defs>
            <clipPath id={clip}><rect width="100" height="100" rx="22" /></clipPath>
            <linearGradient id={grad} x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="#E8EEF8" />
              <stop offset="50%" stopColor="#CBD6E8" />
              <stop offset="100%" stopColor="#A8B8D4" />
            </linearGradient>
            <linearGradient id={shine} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#FFFFFF" stopOpacity="0.72" />
              <stop offset="45%" stopColor="#FFFFFF" stopOpacity="0.08" />
              <stop offset="100%" stopColor="#FFFFFF" stopOpacity="0.32" />
            </linearGradient>
          </defs>
          <g clipPath={`url(#${clip})`}>
            <rect width="100" height="100" fill={`url(#${grad})`} />
            <path fill="#FFFFFF" fillOpacity="0.42" d="M50 0h50v50z" />
            <rect width="100" height="100" fill={`url(#${shine})`} />
            <g transform="translate(-4.94 -27.7) scale(1.57)">
              <path fill="#FFFFFF" fillOpacity="0.92" d="m22 44h26c1.1 0 2 0.9 2 2v16c0 1.1-0.9 2-2 2h-26c-1.1 0-2-0.9-2-2v-16c0-1.1 0.9-2 2-2z" />
              <path fill="#FFFFFF" fillOpacity="0.92" d="m26 44v-8q0-8 9-8 9 0 9 8v8h-5v-8q0-3-4-3-4 0-4 3v8z" />
              <circle cx="48" cy="60" r="11" fill="#64748B" fillOpacity="0.58" />
              <path fill="none" stroke="#FFFFFF" strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" d="m42 61l4 3 8-8" />
            </g>
            <rect x="1.5" y="1.5" width="97" height="97" rx="20.5" fill="none" stroke="#FFFFFF" strokeOpacity="0.85" strokeWidth="3" />
          </g>
        </svg>
      );
    case 'note-boy':
      return <NoteBoyMark className="w-12 h-12 shrink-0 drop-shadow-sm" />;
    case 'plain-page':
      return (
        <svg viewBox="0 0 100 100" className="w-12 h-12 shrink-0 drop-shadow-sm" aria-hidden="true">
          <defs><clipPath id={clip}><rect width="100" height="100" rx="22" /></clipPath></defs>
          <g clipPath={`url(#${clip})`}>
            <rect width="100" height="100" fill="#F4F1E8" />
            <rect width="100" height="20" fill="#E3DEC9" />
            <line x1="18" y1="36" x2="70" y2="36" stroke="#8F8A7C" strokeWidth="5.5" strokeLinecap="round" />
            <line x1="18" y1="52" x2="82" y2="52" stroke="#B6B1A2" strokeWidth="5" strokeLinecap="round" />
            <line x1="18" y1="67" x2="76" y2="67" stroke="#B6B1A2" strokeWidth="5" strokeLinecap="round" />
            <line x1="18" y1="82" x2="54" y2="82" stroke="#C7C2B4" strokeWidth="5" strokeLinecap="round" />
            <rect x="0.75" y="0.75" width="98.5" height="98.5" rx="21.25" fill="none" stroke="#D5D0C1" strokeWidth="1.5" />
          </g>
        </svg>
      );
    case 'calculator':
      return (
        <svg viewBox="0 0 100 100" className="w-12 h-12 shrink-0 drop-shadow-sm" aria-hidden="true">
          <defs><clipPath id={clip}><rect width="100" height="100" rx="22" /></clipPath></defs>
          <g clipPath={`url(#${clip})`}>
            <rect width="100" height="100" fill="#2A2C32" />
            <rect x="14" y="14" width="72" height="22" rx="6" fill="#3D414A" />
            <circle cx="25" cy="52" r="9.5" fill="#4B505B" />
            <circle cx="50" cy="52" r="9.5" fill="#4B505B" />
            <circle cx="75" cy="52" r="9.5" fill="#D97706" />
            <circle cx="25" cy="76" r="9.5" fill="#4B505B" />
            <circle cx="50" cy="76" r="9.5" fill="#4B505B" />
            <circle cx="75" cy="76" r="9.5" fill="#D97706" />
          </g>
        </svg>
      );
    case 'journal':
      return (
        <svg viewBox="0 0 100 100" className="w-12 h-12 shrink-0 drop-shadow-sm" aria-hidden="true">
          <defs><clipPath id={clip}><rect width="100" height="100" rx="22" /></clipPath></defs>
          <g clipPath={`url(#${clip})`}>
            <rect width="100" height="100" fill="#4B6B5C" />
            <rect x="0" y="0" width="22" height="100" fill="#365044" />
            <rect x="34" y="28" width="44" height="14" rx="4" fill="#E6EFEA" fillOpacity="0.9" />
            <rect x="34" y="50" width="28" height="6" rx="3" fill="#E6EFEA" fillOpacity="0.45" />
          </g>
        </svg>
      );
    case 'archive':
      return (
        <svg viewBox="0 0 100 100" className="w-12 h-12 shrink-0 drop-shadow-sm" aria-hidden="true">
          <defs><clipPath id={clip}><rect width="100" height="100" rx="22" /></clipPath></defs>
          <g clipPath={`url(#${clip})`}>
            <rect width="100" height="100" fill="#E7E5E0" />
            <path d="M18 33 C18 29 21 26 25 26 H43 L50 34 H75 C79 34 82 37 82 41 V71 C82 75 79 78 75 78 H25 C21 78 18 75 18 71 Z" fill="#78716C" />
            <rect x="18" y="39" width="64" height="39" rx="6" fill="#57534E" />
          </g>
        </svg>
      );
    case 'minimal-fold':
      return (
        <svg viewBox="0 0 100 100" className="w-12 h-12 shrink-0 drop-shadow-sm" aria-hidden="true">
          <defs><clipPath id={clip}><rect width="100" height="100" rx="22" /></clipPath></defs>
          <g clipPath={`url(#${clip})`}>
            <rect width="100" height="100" fill="#334155" />
            <path fill="#64748B" d="M50 0h50v50z" />
          </g>
        </svg>
      );
  }
}

function IconGrid({
  presets,
  selected,
  busy,
}: {
  presets: readonly AppIconPreset[];
  selected: AppIconId;
  busy: boolean;
}) {
  const { t } = useTranslation(['settings', 'looks', 'notes', 'shell']);
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(7.1rem,1fr))] gap-2">
      {presets.map((preset) => {
        const active = preset.id === selected;
        return (
          <button
            key={preset.id}
            type="button"
            disabled={busy}
            aria-pressed={active}
            onClick={() => void setAppIcon(preset.id)}
            className={`${SETTINGS_CARD} relative flex-col justify-start gap-1.5 px-2 py-2.5 text-center bg-surface-0 ${
              active ? `${SETTINGS_CARD_ON} ring-1 ring-accent/30` : SETTINGS_CARD_REST
            }`}
          >
            {active && (
              <span className="absolute top-1.5 end-1.5 text-accent text-meta leading-none" aria-hidden="true">
                <CheckCircle weight="fill" />
              </span>
            )}
            <AppIconArtwork id={preset.id} />
            <span className="text-compact font-medium text-pn leading-tight max-w-full truncate">
              {t(preset.nameKey)}
            </span>
            <span className="text-meta text-pn-muted leading-tight max-w-full truncate">
              {t(preset.descKey)}
            </span>
          </button>
        );
      })}
    </div>
  );
}

const BRAND_PRESETS = APP_ICON_PRESETS.filter((p) => p.group === 'brand');
const DISCREET_PRESETS = APP_ICON_PRESETS.filter((p) => p.group === 'discreet');

export function AppIconPicker() {
  const { t } = useTranslation('settings');
  const { icon, status, error, busy } = useAppIcon();
  const [, setLooksReady] = useState(false);

  useEffect(() => {
    let alive = true;
    void ensureLooksLoaded().then(() => {
      if (alive) setLooksReady(true);
    });
    return () => {
      alive = false;
    };
  }, []);

  const noteKey =
    status?.note === 'bundle_readonly'
      ? 'system.appIcon.noteBundleReadonly'
      : status?.note === 'wayland_relaunch'
        ? 'system.appIcon.noteWaylandRelaunch'
        : status?.note === 'windows_pinned'
          ? 'system.appIcon.noteWindowsPinned'
          : status?.note === 'no_shortcuts'
            ? 'system.appIcon.noteWindowsNoShortcuts'
            : status
              ? 'system.appIcon.applied'
              : null;

  return (
    <section data-setting="system.appIcon" className="space-y-2">
      <SectionEyebrow icon={AppWindow}>{t('system.appIconTitle')}</SectionEyebrow>
      <div className={`${SETTINGS_GROUP} bg-surface-2`}>
        <div className="p-3.5 space-y-3">
          <p className={SETTINGS_HELP}>{t('system.appIconDesc')}</p>

          <div className="space-y-1.5">
            <p className="text-small font-medium text-pn-soft">{t('system.appIcon.groupBrand')}</p>
            <IconGrid presets={BRAND_PRESETS} selected={icon} busy={busy} />
          </div>

          <div className="space-y-1.5">
            <p className="text-small font-medium text-pn-soft">{t('system.appIcon.groupDiscreet')}</p>
            <IconGrid presets={DISCREET_PRESETS} selected={icon} busy={busy} />
          </div>

          {error ? (
            <Callout tone="danger">{t('system.appIcon.error')}</Callout>
          ) : noteKey ? (
            <Callout tone={noteKey === 'system.appIcon.applied' ? 'success' : 'info'}>{t(noteKey)}</Callout>
          ) : (
            <p className={SETTINGS_HELP}>{t('system.appIcon.timingHint')}</p>
          )}
        </div>
      </div>
    </section>
  );
}
