import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from './auth';
import { isDemoMode } from './demo';
import { DMS_PERIODS, fetchDmsStatus, setDms, type DmsPeriod, type DmsStatus } from './dms';
import { CalendarBlank, CloudX, Hourglass } from './icons';
import { formatInstant } from './intlFormat';
import { intlLocale } from './languages';
import { RowTitle, ROW_TITLE, SETTINGS_HELP } from './settingsUI';
import { Switch } from './Switch';
import { Button, Callout, HelpChip, Modal, ModalFooter, Select, StatTile } from './ui';

/**
 * Settings > ID & Sync > Dead man's switch: the toggle, the period, and the
 * date the server would delete on. Turning it on asks first; turning it off
 * and changing the period do not. The demo keeps everything in local state.
 * Spec: docs/internal/specs/dead-mans-switch.md (section 4)
 */
// Spec: docs/internal/specs/dead-mans-switch.md (section 4, default 12 months)
const DEFAULT_PERIOD: DmsPeriod = 12;

export function DmsPanel() {
  const { t } = useTranslation('settings');
  const { auth, supabase } = useAuth();
  const pubkey = auth.status === 'authenticated' ? auth.pubkey : null;
  const demo = isDemoMode();
  const [status, setStatus] = useState<DmsStatus | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [period, setPeriod] = useState<DmsPeriod>(DEFAULT_PERIOD);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (!pubkey) return;
    if (demo) {
      setStatus({ months: null, wipeGen: 0, wipedAt: null, deletesOn: null });
      return;
    }
    let cancelled = false;
    fetchDmsStatus(supabase, pubkey)
      .then((s) => {
        if (cancelled) return;
        setStatus(s);
        if (s.months) setPeriod(s.months);
      })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [pubkey, supabase, demo]);

  if (!pubkey) return null;

  const on = status?.months != null;

  async function apply(months: DmsPeriod | null) {
    if (!pubkey) return;
    if (demo) {
      // As dms_check counts it: the period, then the 14-day wait.
      const end = new Date();
      end.setMonth(end.getMonth() + (months ?? 0));
      end.setDate(end.getDate() + 14);
      const deletesOn = months ? end.toISOString() : null;
      setStatus((s) => s && { ...s, months, deletesOn });
      return;
    }
    setBusy(true);
    try {
      setStatus(await setDms(supabase, pubkey, months));
      setFailed(false);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  function choose(p: DmsPeriod) {
    setPeriod(p);
    if (on && p !== status?.months) void apply(p);
  }

  // Whole years read as years, the rest as months, in the reader's language
  // with no catalog keys (the same Intl unit formatting EventCard uses).
  const periodLabel = (p: DmsPeriod) =>
    p % 12 === 0
      ? new Intl.NumberFormat(intlLocale(), { style: 'unit', unit: 'year', unitDisplay: 'long' }).format(p / 12)
      : new Intl.NumberFormat(intlLocale(), { style: 'unit', unit: 'month', unitDisplay: 'long' }).format(p);

  return (
    <div className="space-y-1">
      <Switch
        setting="me.dms"
        icon={<CloudX className="text-accent" />}
        label={t('dms.title')}
        labelClassName={`${ROW_TITLE} text-pn`}
        description={t('dms.bodyOff')}
        checked={on}
        disabled={busy || status === null}
        onChange={(next) => { if (next) setConfirming(true); else void apply(null); }}
      />

      {/* The Appearance pane's row layout: below lg the control sits under its
          title; above, beside it, wrapping under it when the pane is narrow. */}
      <div className="flex flex-col gap-2 lg:flex-row lg:flex-wrap lg:items-center lg:justify-between lg:gap-x-5 lg:gap-y-2 py-3">
        <div className="min-w-0">
          <RowTitle icon={CalendarBlank}>{t('dms.after')}</RowTitle>
          <p className={`${SETTINGS_HELP} mt-0.5`}>{t('dms.afterHelp')}</p>
        </div>
        {/* Five periods are too wide for a segmented control on a phone, so
            the catalog's Select (a list too long for one). */}
        <Select
          size="sm"
          aria-label={t('dms.after')}
          value={period}
          disabled={busy || status === null}
          onChange={(e) => choose(Number(e.target.value) as DmsPeriod)}
        >
          {DMS_PERIODS.map((p) => <option key={p} value={p}>{periodLabel(p)}</option>)}
        </Select>
      </div>

      {/* No ticking counter: the device showing this pane is online, and going
          online restarts the timer, so a countdown would always read the full
          period. The date and the period are what is worth reading. */}
      {on && status?.deletesOn && status.months && (
        <div className="grid grid-cols-2 gap-2 pt-1">
          <StatTile
            label={t('dms.deletesOnLabel')}
            value={formatInstant(status.deletesOn, 'date')}
            sub={t('dms.deletesOnSub')}
          />
          <StatTile label={t('dms.timerLabel')} value={periodLabel(status.months)} sub={t('dms.timerSub')} />
        </div>
      )}
      {failed && <Callout tone="danger" className="mt-2">{t('dms.loadError')}</Callout>}
      <HelpChip surface="dms" />

      {confirming && (
        <Modal
          title={t('dms.confirmTitle')}
          icon={<Hourglass />}
          onClose={() => setConfirming(false)}
          className="max-w-md p-6 space-y-4"
        >
          <p className="text-body text-pn-muted leading-relaxed">
            {t('dms.confirmBody', { period: periodLabel(period) })}
          </p>
          <ModalFooter>
            <Button action="cancel" onClick={() => setConfirming(false)} />
            <Button
              action="confirm"
              onClick={() => { setConfirming(false); void apply(period); }}
            >
              {t('shell:alerts.turnOn')}
            </Button>
          </ModalFooter>
        </Modal>
      )}
    </div>
  );
}
