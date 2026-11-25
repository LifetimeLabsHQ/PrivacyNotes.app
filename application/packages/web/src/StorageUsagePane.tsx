import { useEffect, useRef, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { SupabaseClient } from '@notes/shared';
import { formatBytes } from './formatBytes';
import { intlLocale } from './languages';
import {
  FileText,
  HardDrives,
  Image as ImageIcon,
  LockSimple,
  NotePencil,
  Trash,
} from './icons';
import { Badge, Callout, DeleteButton, EmptyState, SectionEyebrow, SETTINGS_HELP, Spinner } from './ui';
import { clearHistoryOnlyBlobs, inspectHistoryOnlyBlobs, type HistoryOnlyBlobsSummary } from './imageGC';
import type { ImageStore } from './imageStore';
import type { VaultStorageBreakdown, VaultStorageItem } from './vaultStorage';
import { isDemoMode } from './demo';
import { useSyncing } from './syncingStore';
import { getSyncLog, pullStanding } from './syncLog';
import { db } from './db';

type Props = {
  breakdown: VaultStorageBreakdown;
  /** Account storage cap in bytes, or null in local-only mode. */
  maxBytes: number | null;
  isPro: boolean;
  localOnly: boolean;
  /** Open the owning note (and close Settings). */
  onOpenNote: (noteId: string) => void;
  /** Open the Trash view (and close Settings). */
  onOpenTrash?: () => void;
  /** Open the Files view (and close Settings). */
  onOpenFiles?: () => void;
  /** Triggered on mount to resolve any missing remote image sizes. */
  onResolveImageSizes?: () => void;
  /** Context needed to inspect and clear removed files still held by Note History (Pro cloud only). */
  historyContext?: {
    supabase: SupabaseClient;
    pubkey: string;
    encryptionKey: Uint8Array;
    imageStore: ImageStore | null;
    /** Runs a sync pass (including pull) immediately before deleting History blobs. */
    onSyncBeforeClear: () => Promise<void>;
    onCleared?: () => void;
  };
};

/** Brief in-memory cache so toggling Storage <-> Usage <-> Images does not
 *  re-scan the bucket and decrypt note_versions on every tab click. */
const HISTORY_SCAN_TTL_MS = 30_000;
let historyScanCache: {
  key: string;
  at: number;
  result: HistoryOnlyBlobsSummary | null;
} | null = null;

function formatCapLabel(maxBytes: number, t: TFunction<['settings', 'shell', 'notes', 'common']>): string {
  const gb = maxBytes / 1000 ** 3;
  const gbRounded = Math.round(gb * 2) / 2;
  return gb >= 1
    ? t('settings:quota.gb', { value: Number.isInteger(gbRounded) ? gbRounded : gbRounded.toFixed(1) })
    : t('settings:quota.mb', { value: Math.round(maxBytes / 1000 ** 2 / 50) * 50 });
}

/**
 * Compute proportional bar widths for Files, Notes and Trash that stay strictly
 * within `totalPct <= 100` (so a vault near 97% never overflows or falsely
 * looks 100% full when tiny categories take a visible minimum sliver).
 */
function stackedBarWidths(
  filesBytes: number,
  notesBytes: number,
  trashBytes: number,
  barDenom: number,
): { files: number; notes: number; trash: number } {
  const totalBytes = filesBytes + notesBytes + trashBytes;
  if (totalBytes <= 0 || barDenom <= 0) return { files: 0, notes: 0, trash: 0 };
  const totalPct = Math.min(100, Math.max(1.5, (totalBytes / barDenom) * 100));
  const raw = [
    filesBytes > 0 ? (filesBytes / totalBytes) * totalPct : 0,
    notesBytes > 0 ? (notesBytes / totalBytes) * totalPct : 0,
    trashBytes > 0 ? (trashBytes / totalBytes) * totalPct : 0,
  ];
  // Give each non-zero slice a tiny visible floor, then rescale to fit totalPct.
  const floored = raw.map((v) => (v > 0 ? Math.max(1.2, v) : 0));
  const sum = floored[0]! + floored[1]! + floored[2]!;
  const scale = sum > totalPct ? totalPct / sum : 1;
  return {
    files: floored[0]! * scale,
    notes: floored[1]! * scale,
    trash: floored[2]! * scale,
  };
}

function ItemGlyph({ item }: { item: VaultStorageItem }) {
  if (item.gated) return <LockSimple aria-hidden="true" />;
  if (item.kind === 'image') return <ImageIcon aria-hidden="true" />;
  if (item.kind === 'file') return <FileText aria-hidden="true" />;
  if (item.location === 'trash') return <Trash aria-hidden="true" />;
  return <NotePencil aria-hidden="true" />;
}

function itemKindLabel(
  item: VaultStorageItem,
  t: TFunction<['settings', 'shell', 'notes', 'common']>,
): string {
  if (item.gated) return t('settings:storage.usage.kindProtected');
  if (item.kind === 'image') return t('settings:storage.usage.kindImage');
  if (item.kind === 'file') return t('shell:fileTypes.attachment');
  switch (item.noteType) {
    case 'drawing': return t('notes:newMenu.drawing');
    case 'contact': return t('notes:newMenu.contact');
    case 'login': return t('notes:newMenu.login');
    case 'card': return t('shell:vaultItem.badgeCard');
    case 'ssh-key': return t('notes:vaultNew.sshKey');
    case 'link': return t('notes:newMenu.bookmark');
    default:
      return t('settings:storage.usage.kindNote', {
        count: item.chars,
        formatted: new Intl.NumberFormat(intlLocale()).format(item.chars),
      });
  }
}

/**
 * Settings > Storage > Usage: one unified breakdown screen for Free, Pro,
 * local-only and future own-storage vaults. Sums live files, notes and Trash
 * from the local mirror so every row adds up to the headline figure and drops
 * the instant an item is deleted.
 */
export function StorageUsagePane({
  breakdown,
  maxBytes,
  isPro,
  localOnly,
  onOpenNote,
  onOpenTrash,
  onOpenFiles,
  onResolveImageSizes,
  historyContext,
}: Props) {
  const { t } = useTranslation(['settings', 'shell', 'notes', 'common']);
  const syncing = useSyncing();
  const prevSyncingRef = useRef(syncing);
  const [syncDoneTick, setSyncDoneTick] = useState(0);
  const [historyBlobs, setHistoryBlobs] = useState<HistoryOnlyBlobsSummary | null>(null);
  const [clearingHistory, setClearingHistory] = useState(false);
  const [clearedNote, setClearedNote] = useState<number | null>(null);
  const [clearError, setClearError] = useState(false);
  const [pendingGcCount, setPendingGcCount] = useState(0);

  // Resolve any uncached remote image sizes when the user opens Usage.
  useEffect(() => {
    onResolveImageSizes?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run on open
  }, []);

  // Re-inspect Note History blobs once a sync pass finishes (catches images
  // just removed from a note whose dirty write took a few seconds to push).
  useEffect(() => {
    if (prevSyncingRef.current && !syncing) {
      historyScanCache = null;
      setSyncDoneTick((n) => n + 1);
    }
    prevSyncingRef.current = syncing;
  }, [syncing]);

  // Check whether any deleted files are still in the local 24h server-cleanup
  // hold so users who just emptied Trash understand why server quota clears later.
  useEffect(() => {
    if (localOnly || isDemoMode()) {
      setPendingGcCount(0);
      return;
    }
    let cancelled = false;
    void db.blobGC.count().then((n) => {
      if (!cancelled) setPendingGcCount(n);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [localOnly, breakdown.filesCount, breakdown.trashCount, syncDoneTick]);

  // Inspect removed files kept alive only by Pro Note History.
  useEffect(() => {
    if (!isPro || localOnly || isDemoMode() || !historyContext) {
      setHistoryBlobs(null);
      return;
    }
    const cacheKey = `${historyContext.pubkey}:${breakdown.filesCount}:${breakdown.trashCount}:${breakdown.notesCount}`;
    if (
      historyScanCache &&
      historyScanCache.key === cacheKey &&
      Date.now() - historyScanCache.at < HISTORY_SCAN_TTL_MS
    ) {
      setHistoryBlobs(historyScanCache.result);
      return;
    }
    let cancelled = false;
    void inspectHistoryOnlyBlobs(
      historyContext.supabase,
      historyContext.pubkey,
      historyContext.encryptionKey,
    ).then((res) => {
      if (cancelled) return;
      if (res !== null) {
        historyScanCache = { key: cacheKey, at: Date.now(), result: res };
      }
      setHistoryBlobs(res);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-inspect when vault totals or sync change
  }, [isPro, localOnly, historyContext?.pubkey, breakdown.filesCount, breakdown.trashCount, breakdown.notesCount, syncDoneTick]);

  async function handleClearHistory() {
    if (!historyContext?.imageStore || !historyBlobs || historyBlobs.uuids.length === 0 || clearingHistory) return;
    setClearingHistory(true);
    setClearError(false);
    try {
      // Run a fresh sync pull first so any cross-device restore of an older
      // version lands in db.notes before clearHistoryOnlyBlobs checks live refs.
      await historyContext.onSyncBeforeClear();
      if (pullStanding(getSyncLog()) !== 'ok') {
        setClearError(true);
        return;
      }
      const res = await clearHistoryOnlyBlobs(
        historyContext.supabase,
        historyContext.pubkey,
        historyContext.encryptionKey,
        historyContext.imageStore,
        historyBlobs.uuids,
      );
      if (res) {
        historyScanCache = null;
        setClearedNote(res.removedBytes);
        setHistoryBlobs({ count: 0, bytes: 0, uuids: [] });
        historyContext.onCleared?.();
      } else {
        setClearError(true);
      }
    } finally {
      setClearingHistory(false);
    }
  }

  const hasCap = !localOnly && maxBytes !== null && maxBytes > 0;
  const pct = hasCap ? Math.min((breakdown.totalBytes / maxBytes) * 100, 100) : 0;
  const pctLabel = pct === 0 ? '0%' : pct < 1 ? '<1%' : `${Math.round(pct)}%`;
  const capLabel = hasCap ? formatCapLabel(maxBytes, t) : null;
  const barDenom = hasCap ? Math.max(maxBytes, breakdown.totalBytes) : Math.max(breakdown.totalBytes, 1);
  const widths = stackedBarWidths(breakdown.filesBytes, breakdown.notesBytes, breakdown.trashBytes, barDenom);

  return (
    <div className="flex-1 min-h-0 overflow-y-auto px-6 pb-6 pt-4 space-y-5">
      {/* Headline figure + proportional stacked bar */}
      <div>
        <div className="flex flex-wrap items-baseline justify-between gap-2 mb-2">
          <div className="text-heading font-semibold text-pn tabular-nums">
            <span>{formatBytes(breakdown.totalBytes)}</span>
            {capLabel && (
              <>
                {' '}
                <span className="text-row font-normal text-pn-muted">
                  <Trans
                    i18nKey="settings:quota.ofMax"
                    values={{ max: capLabel }}
                    components={{ max: <span className="font-medium text-accent" /> }}
                  />
                </span>
              </>
            )}
          </div>
          <span className="text-small text-pn-muted tabular-nums">
            {hasCap
              ? t('settings:storage.usage.usedLive', { percent: pctLabel })
              : t('settings:storage.usage.localVault')}
          </span>
        </div>

        <div
          className="h-2.5 w-full rounded-full bg-track overflow-hidden flex"
          role="img"
          aria-label={t('settings:storage.usage.barLabel')}
        >
          {widths.files > 0 && (
            <div className="h-full bg-accent transition-all" style={{ width: `${widths.files}%` }} />
          )}
          {widths.notes > 0 && (
            <div className="h-full bg-success transition-all" style={{ width: `${widths.notes}%` }} />
          )}
          {widths.trash > 0 && (
            <div className="h-full bg-warning transition-all" style={{ width: `${widths.trash}%` }} />
          )}
        </div>
      </div>

      {/* Category breakdown - rows always sum to the headline figure */}
      <div className="rounded-lg border border-divider bg-surface-2 divide-y divide-divider px-4">
        <div className="flex items-center gap-3 py-2.5 text-body">
          <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-accent" aria-hidden="true" />
          <div className="min-w-0 flex-1 flex flex-wrap items-baseline gap-x-2">
            <span className="font-medium text-pn">{t('settings:storage.usage.filesLabel')}</span>
            <span className="text-small text-pn-muted">
              {breakdown.archivedFilesCount > 0
                ? t('settings:storage.usage.filesCountArchived', {
                    count: breakdown.filesCount,
                    archived: breakdown.archivedFilesCount,
                  })
                : t('shell:noteRow.files', { count: breakdown.filesCount })}
            </span>
            {onOpenFiles && breakdown.filesCount > 0 && (
              <button
                type="button"
                onClick={onOpenFiles}
                className="text-small text-accent hover:underline"
              >
                {t('settings:storage.usage.openFiles')}
              </button>
            )}
          </div>
          <span className="shrink-0 font-semibold text-pn tabular-nums">
            {formatBytes(breakdown.filesBytes)}
          </span>
        </div>

        <div className="flex items-center gap-3 py-2.5 text-body">
          <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-success" aria-hidden="true" />
          <div className="min-w-0 flex-1 flex flex-wrap items-baseline gap-x-2">
            <span className="font-medium text-pn">{t('settings:storage.usage.notesLabel')}</span>
            <span className="text-small text-pn-muted">
              {t('settings:storage.usage.notesCount', { count: breakdown.notesCount })}
            </span>
          </div>
          <span className="shrink-0 font-semibold text-pn tabular-nums">
            {formatBytes(breakdown.notesBytes)}
          </span>
        </div>

        <div className="flex items-center gap-3 py-2.5 text-body">
          <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-warning" aria-hidden="true" />
          <div className="min-w-0 flex-1 flex flex-wrap items-baseline gap-x-2">
            <span className="font-medium text-pn">{t('shell:pillars.trash')}</span>
            <span className="text-small text-pn-muted">
              {breakdown.trashCount > 0
                ? t('settings:storage.usage.trashCount', { count: breakdown.trashCount })
                : t('notes:trash.empty')}
            </span>
            {onOpenTrash && breakdown.trashCount > 0 && (
              <button
                type="button"
                onClick={onOpenTrash}
                className="text-small text-accent hover:underline"
              >
                {t('settings:storage.usage.openTrash')}
              </button>
            )}
          </div>
          <span className="shrink-0 font-semibold text-pn tabular-nums">
            {formatBytes(breakdown.trashBytes)}
          </span>
        </div>
      </div>

      {/* Quiet note while recently deleted files finish their 24h server hold */}
      {pendingGcCount > 0 && (
        <p className={`${SETTINGS_HELP} -mt-2`}>
          {t('common:storageBar.cleanupInfo')}
        </p>
      )}

      {/* Removed files still kept by Pro Note History (7-day undo window) */}
      {historyBlobs && historyBlobs.count > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-divider bg-surface-2 px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="text-small font-semibold text-pn">
              {t('settings:storage.usage.historyTitle', { size: formatBytes(historyBlobs.bytes) })}
            </div>
            <div className="mt-0.5 text-help text-pn-muted leading-relaxed">
              {t('settings:storage.usage.historyDesc', { count: historyBlobs.count })}
            </div>
          </div>
          {clearingHistory ? (
            <Spinner />
          ) : (
            <DeleteButton
              label={t('settings:storage.usage.clearHistoryLabel')}
              confirmLabel={t('settings:storage.usage.clearHistoryConfirm')}
              onConfirm={() => void handleClearHistory()}
            />
          )}
        </div>
      )}

      {clearedNote !== null && (
        <Callout tone="success">
          {t('settings:storage.usage.historyCleared', { size: formatBytes(clearedNote) })}
        </Callout>
      )}
      {clearError && (
        <Callout tone="warning">
          {t('settings:storage.usage.historyClearFailed')}
        </Callout>
      )}

      {/* Largest items across all open Spaces, Archive and Trash */}
      <div>
        <div className="flex flex-wrap items-baseline justify-between gap-2 mb-2">
          <SectionEyebrow icon={HardDrives} className="mb-0">
            {t('settings:storage.usage.largestHeading')}
          </SectionEyebrow>
          <span className="text-help text-pn-muted">
            {t('settings:storage.usage.largestScope')}
          </span>
        </div>

        {breakdown.largest.length === 0 ? (
          <div className="rounded-lg border border-divider bg-surface-2 py-6">
            <EmptyState
              flush
              icon={<HardDrives weight="duotone" aria-hidden="true" />}
              title={t('settings:storage.usage.emptyTitle')}
            >
              {t('settings:storage.usage.emptyBody')}
            </EmptyState>
          </div>
        ) : (
          <div className="rounded-lg border border-divider bg-surface-2 divide-y divide-divider overflow-hidden">
            {breakdown.largest.map((item) => (
              <button
                key={item.key}
                type="button"
                onClick={() => onOpenNote(item.noteId)}
                className="w-full flex items-center gap-3 px-3.5 py-2.5 text-start transition hover:bg-pn/5 cursor-pointer"
              >
                <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-track text-accent">
                  <ItemGlyph item={item} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-body font-medium text-pn">
                    {item.title}
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-help text-pn-muted">
                    <span>{itemKindLabel(item, t)}</span>
                    {item.location === 'archive' && (
                      <Badge>{t('shell:tagsRail.archive')}</Badge>
                    )}
                    {item.location === 'trash' && (
                      <Badge tone="warning">{t('shell:pillars.trash')}</Badge>
                    )}
                    {item.spaceLabel && (
                      <Badge>{item.spaceLabel}</Badge>
                    )}
                  </div>
                </div>
                <span className="shrink-0 text-small font-semibold text-pn tabular-nums">
                  {formatBytes(item.bytes)}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
