import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CaretLeft, CaretRight, GridFour } from '../icons';
import { SectionEyebrow } from '../settingsUI';
import { Button } from '../ui';
import { saveBlob } from '../saveFile';
import { formatDay, monthInitial } from '../intlFormat';
import { toLocalIso } from '../notesViewUtils';
import { buildSeries } from '../trackerSeries';
import { moodColor } from '../moodColors';
import { PIXEL_ROWS, pixelYears, yearPixelGrid, yearRange } from '../yearPixels';
import type { WellnessModel } from './wellnessModel';

// The saved picture: squares and gaps in device pixels, no text on it.
const PNG_CELL = 20;
const PNG_GAP = 4;
const PNG_PAD = 16;

function paintedColor(el: Element | null, fallback: string): string {
  const color = el ? getComputedStyle(el).backgroundColor : '';
  return color && color !== 'rgba(0, 0, 0, 0)' && color !== 'transparent' ? color : fallback;
}

/**
 * One square per day of a year in the mood colors, free. The grid reads the
 * mood series of the chosen year, never the entries; a tap opens the day. The
 * picture it saves carries no title and no name, so it can be shared as it
 * is: a reader sees colors and nothing else.
 * Spec: docs/internal/specs/wellness-statistics.md (section 8)
 */
export function YearInPixels({
  model,
  onOpenDay,
  bare = false,
  year: controlledYear,
  hideHeader = false,
  fitBox,
}: {
  model: WellnessModel;
  onOpenDay?: (date: string) => void;
  bare?: boolean;
  year?: number;
  hideHeader?: boolean;
  fitBox?: { width: number; height: number };
}) {
  const { t } = useTranslation('stats');
  const today = toLocalIso(new Date());
  const years = useMemo(() => pixelYears(model.firstDay, today), [model.firstDay, today]);
  const [picked, setPicked] = useState<number | null>(null);
  const year = controlledYear !== undefined && years.includes(controlledYear)
    ? controlledYear
    : picked !== null && years.includes(picked) ? picked : years[years.length - 1]!;
  const mood = model.byId('mood');
  const grid = useMemo(
    () => (mood ? yearPixelGrid(buildSeries(model.entries, mood, yearRange(year)), year) : null),
    [model.entries, mood, year],
  );
  const months = useMemo(() => Array.from({ length: 12 }, (_, i) => monthInitial(i)), []);
  const [saveFailed, setSaveFailed] = useState(false);
  // The picture takes the colors the pane paints, so it matches the theme on screen.
  const surfaceProbe = useRef<HTMLSpanElement>(null);
  const emptyProbe = useRef<HTMLSpanElement>(null);

  if (!grid) return null;
  const index = years.indexOf(year);

  const cellTitle = (date: string, value: number | undefined) =>
    value === undefined
      ? t('writing.tooltipNoMood', { date: formatDay(date, 'date') })
      : t('writing.tooltipMood', { date: formatDay(date, 'date'), mood: value });

  const saveImage = async () => {
    const canvas = document.createElement('canvas');
    canvas.width = PNG_PAD * 2 + 12 * PNG_CELL + 11 * PNG_GAP;
    canvas.height = PNG_PAD * 2 + PIXEL_ROWS * PNG_CELL + (PIXEL_ROWS - 1) * PNG_GAP;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = paintedColor(surfaceProbe.current, '#FFFFFF');
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const empty = paintedColor(emptyProbe.current, '#E5E7EB');
    grid.forEach((column, m) => {
      column.forEach((cell, d) => {
        if (!cell) return;
        ctx.fillStyle = cell.mood === undefined ? empty : moodColor(cell.mood);
        ctx.fillRect(PNG_PAD + m * (PNG_CELL + PNG_GAP), PNG_PAD + d * (PNG_CELL + PNG_GAP), PNG_CELL, PNG_CELL);
      });
    });
    const blob = await new Promise<Blob | null>((resolve) => {
      try {
        canvas.toBlob((b) => resolve(b), 'image/png');
      } catch {
        resolve(null);
      }
    });
    if (!blob) {
      setSaveFailed(true);
      return;
    }
    const saved = await saveBlob(blob, `privacy-notes-year-in-pixels-${year}.png`);
    if (saved.ok) setSaveFailed(false);
    else if (saved.reason === 'failed') setSaveFailed(true);
  };

  const cellOf = (cell: NonNullable<(typeof grid)[number][number]>, fill = false) => {
    const color = cell.mood === undefined ? undefined : moodColor(cell.mood);
    const className = `${fill ? 'h-full w-full' : 'aspect-square'} rounded-[2px] ${color ? '' : 'bg-track'}`;
    const style = color ? { backgroundColor: color } : undefined;
    const title = cellTitle(cell.date, cell.mood);
    return onOpenDay ? (
      <button key={cell.date} type="button" title={title} aria-label={title} className={`${className} hover:ring-1 hover:ring-pn-muted`} style={style} onClick={() => onOpenDay(cell.date)} />
    ) : (
      <div key={cell.date} title={title} className={className} style={style} />
    );
  };

  if (fitBox) {
    const { width: bw, height: bh } = fitBox;
    if (bw <= 0 || bh <= 0) return null;
    const portrait = bh > bw * 1.25;
    if (portrait) {
      const gap = 2;
      const headH = 16;
      const rawH = (bh - headH - (PIXEL_ROWS - 1) * gap) / PIXEL_ROWS;
      const rawW = (bw - 11 * gap) / 12;
      const cellH = Math.max(4, Math.min(rawH, rawW * 1.45));
      const cellW = Math.max(4, Math.min(rawW, cellH * 1.85));
      const gridW = Math.min(bw, Math.floor(11 * gap + 12 * cellW));
      const gridH = Math.min(bh - headH, Math.floor((PIXEL_ROWS - 1) * gap + PIXEL_ROWS * cellH));
      return (
        <div className="mx-auto flex flex-col" style={{ width: gridW }}>
          <div className="mb-1 grid grid-cols-12" style={{ gap }}>
            {months.map((m, i) => (
              <span key={i} className="text-center text-meta text-pn-muted leading-none">{m}</span>
            ))}
          </div>
          <div
            className="grid grid-cols-12 grid-flow-col"
            style={{ height: gridH, gap, gridTemplateRows: `repeat(${PIXEL_ROWS}, minmax(0, 1fr))` }}
            role="img"
            aria-label={t('wellness.pixels.aria', { year })}
          >
            {grid.flatMap((column, m) => column.map((cell, d) => (cell ? cellOf(cell, true) : <div key={`${m}-${d}`} aria-hidden="true" />)))}
          </div>
        </div>
      );
    }
    const compact = bw < 420 || bh < 185;
    const gap = compact ? 2 : 3;
    const labelW = bw < 420 ? 16 : 20;
    const rawW = (bw - labelW - PIXEL_ROWS * gap) / PIXEL_ROWS;
    const rawH = (bh - 11 * gap) / 12;
    // Allow gently rectangular pixel tiles on wide cards so wide Home tiles
    // fill cleanly without giant empty side margins or vertical scrollbars.
    const cellW = Math.max(4, Math.min(rawW, rawH * 1.95));
    const cellH = Math.max(4, Math.min(rawH, cellW * 1.45));
    const gridW = Math.min(bw, Math.floor(labelW + PIXEL_ROWS * gap + PIXEL_ROWS * cellW));
    const gridH = Math.min(bh, Math.floor(11 * gap + 12 * cellH));
    return (
      <div
        className="mx-auto grid items-stretch overflow-hidden"
        style={{
          width: gridW,
          height: gridH,
          gap,
          gridTemplateColumns: `${labelW}px repeat(${PIXEL_ROWS}, minmax(0, 1fr))`,
          gridTemplateRows: 'repeat(12, minmax(0, 1fr))',
        }}
        role="img"
        aria-label={t('wellness.pixels.aria', { year })}
      >
        {grid.flatMap((column, m) => [
          <span key={`l${m}`} className="flex min-h-0 items-center overflow-hidden text-meta text-pn-muted leading-none">{months[m]}</span>,
          ...column.map((cell, d) => (cell ? cellOf(cell, true) : <div key={`${m}-${d}`} aria-hidden="true" />)),
        ])}
      </div>
    );
  }

  return (
    <div className="@container">
      {!hideHeader && (
        <div className={`flex items-center ${bare ? 'justify-end mb-1' : 'justify-between mb-2'} gap-2`}>
          {!bare && <SectionEyebrow setting="stats.yearInPixels" icon={GridFour}>{t('common:ninja.features.yearInPixels.label')}</SectionEyebrow>}
          <div className="flex items-center gap-1 text-small">
            <button
              type="button"
              aria-label={t('wellness.pixels.prevYear')}
              disabled={index <= 0}
              onClick={() => setPicked(years[index - 1]!)}
              className="p-1 rounded text-pn-muted hover:text-pn disabled:opacity-30 disabled:hover:text-pn-muted"
            >
              <CaretLeft />
            </button>
            <span className="tabular-nums font-medium min-w-[3ch] text-center">{year}</span>
            <button
              type="button"
              aria-label={t('wellness.pixels.nextYear')}
              disabled={index >= years.length - 1}
              onClick={() => setPicked(years[index + 1]!)}
              className="p-1 rounded text-pn-muted hover:text-pn disabled:opacity-30 disabled:hover:text-pn-muted"
            >
              <CaretRight />
            </button>
          </div>
        </div>
      )}
      {/* Wide: one row per month, the days across, so the year fills the pane. */}
      <div
        className={`hidden ${bare ? '@md:grid' : '@xl:grid'} w-full gap-[3px] items-center`}
        style={{ gridTemplateColumns: `1.25rem repeat(${PIXEL_ROWS}, minmax(0, 1fr))` }}
        role="img"
        aria-label={t('wellness.pixels.aria', { year })}
      >
        {grid.flatMap((column, m) => [
          <span key={`l${m}`} className="text-meta text-pn-muted leading-none">{months[m]}</span>,
          ...column.map((cell, d) => (cell ? cellOf(cell) : <div key={`${m}-${d}`} aria-hidden="true" />)),
        ])}
      </div>
      {/* Narrow: one column per month, the days down. */}
      <div className={`${bare ? '@md:hidden' : '@xl:hidden'} mx-auto w-full max-w-[220px]`}>
        <div className="grid grid-cols-12 gap-[3px] mb-1">
          {months.map((m, i) => (
            <span key={i} className="text-center text-meta text-pn-muted leading-none">{m}</span>
          ))}
        </div>
        <div
          className="grid grid-cols-12 grid-flow-col gap-[3px]"
          style={{ gridTemplateRows: `repeat(${PIXEL_ROWS}, minmax(0, 1fr))` }}
          role="img"
          aria-label={t('wellness.pixels.aria', { year })}
        >
          {grid.flatMap((column, m) => column.map((cell, d) => (cell ? cellOf(cell) : <div key={`${m}-${d}`} aria-hidden="true" />)))}
        </div>
      </div>
      {!bare && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2 mt-2">
            <span className="text-small text-pn-muted">{onOpenDay ? t('wellness.pixels.hintTap') : t('wellness.pixels.hint')}</span>
            <Button action="download" onClick={saveImage} className="!px-3 !py-1.5 !text-small">
              {t('wellness.pixels.saveImage')}
            </Button>
          </div>
          {saveFailed && <p className="mt-2 text-small text-danger">{t('wellness.export.saveFailed')}</p>}
          <span ref={surfaceProbe} className="hidden bg-surface-2" aria-hidden="true" />
          <span ref={emptyProbe} className="hidden bg-track" aria-hidden="true" />
        </>
      )}
    </div>
  );
}
