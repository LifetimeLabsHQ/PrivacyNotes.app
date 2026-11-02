/**
 * The extension's strings: its own catalog and the app keys it borrows, in
 * every locale that has them, English as the fallback. The popup adds the
 * React binding; the background reads plain `t`.
 * Spec: docs/internal/plans/browser-extension-build.md (section 5, strings)
 */
import i18n from 'i18next';
import resources from 'virtual:pn-catalogs';

let started: Promise<unknown> | null = null;

export function startI18n(plugins: Parameters<typeof i18n.use>[0][] = []): Promise<unknown> {
  if (started) return started;
  for (const plugin of plugins) i18n.use(plugin);
  const wanted = (navigator.language || 'en').replace('_', '-');
  started = i18n.init({
    resources,
    lng: wanted,
    fallbackLng: 'en',
    ns: ['extension', 'common', 'shell', 'auth', 'notes', 'security', 'settingsSearch', 'editor'],
    defaultNS: 'extension',
    interpolation: { escapeValue: false },
  });
  return started;
}

export const t = i18n.t.bind(i18n);
