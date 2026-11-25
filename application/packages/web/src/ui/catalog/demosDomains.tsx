import { useEffect, useState } from 'react';
import {
  Brand,
  Button,
  CHIP_ADD,
  ChoiceGrid,
  DeviceIcon,
  IconUpgrade,
  LogoIcon,
  MoodMark,
  MoodScale,
  NinjaIcon,
  NumberStepper,
  PanelQuestion,
  PanelSegmented,
  ProBadge,
  ProGlyph,
  ProMark,
  QuotaRing,
  QuotaRingButton,
  RatingStar,
  ScaleTiles,
  Select,
  SETTINGS_HELP,
  SettingsSegmented,
  StatusLine,
  StorageBar,
  SwissFlag,
  Switch,
  TaskCheckbox,
  TotpRing,
  UpdateDot,
  chipClass,
  choiceTileClass,
} from '../index';
import { MonthGrid, CalendarHeader } from '../../MonthGrid';
import { TrackerPills } from '../../TrackerPills';
import { defaultTrackerSettings, type FactorDef, type JournalTrackerData, type MedicationTemplate } from '../../trackerTypes';
import { MoodDot, CheckInRowIcon, CheckInGlyph } from '../../moodMark';
import { groupTotpCode } from '../../TotpRing';
import { AppleIcon, GithubIcon, GoogleIcon } from '../../providerIcons';
import { UploadProgressModal, type FileUploadEntry } from '../../UploadProgressModal';
import { ExportProgressModal } from '../../ExportProgressModal';
import { PhraseChangeEnd } from '../../security/PhraseChangeWizard';
import { NoteStateRow, ReadOnlySkipNotice } from '../../readOnlyNotice';
import { SyncArrowsIcon } from '../../SyncStatus';
import { ArrowsClockwise, Briefcase, DownloadSimple, EXPORT_GLYPHS, Folder, Gear, NEW_GLYPHS, PILLAR_GLYPHS, Plus } from '../../icons';
import { DemoBlock } from './demosActions';

export function renderDomainDemo(id: string): React.ReactNode | null {
  switch (id) {
    case 'mood-scale-tiles': return <MoodScaleDemo />;
    case 'mood-mark': return <MoodMarkDemo />;
    case 'tracker-panel-parts': return <TrackerPanelDemo />;
    case 'guided-tracker-flow': return <GuidedTrackerDemo />;
    case 'month-grid': return <MonthGridDemo />;
    case 'task-checkbox': return <TaskCheckboxDemo />;
    case 'storage-quota': return <StorageQuotaDemo />;
    case 'totp-ring': return <TotpRingDemo />;
    case 'brand-marks': return <BrandMarksDemo />;
    case 'glyph-maps': return <GlyphMapsDemo />;
    case 'device-providers': return <DeviceProvidersDemo />;
    case 'pro-marks': return <ProMarksDemo />;
    case 'upload-progress': return <UploadProgressDemo />;
    case 'export-progress': return <ExportProgressDemo />;
    case 'phrase-change-end': return <PhraseChangeEndDemo />;
    case 'note-state-row': return <NoteStateRowDemo />;
    default: return null;
  }
}

function MoodScaleDemo() {
  const [mood, setMood] = useState<number | null>(7);
  const [energy, setEnergy] = useState<number | null>(6);
  return (
    <div className="space-y-5">
      <DemoBlock title="MoodScale (1 to 10)">
        <MoodScale value={mood} onPick={setMood} label="How are you today?" />
      </DemoBlock>
      <DemoBlock title="ScaleTiles (0 to 10, with ends and clearable)">
        <ScaleTiles min={0} max={10} value={energy} onPick={setEnergy} onClear={() => setEnergy(null)} label="Energy" ends={['Low', 'High']} />
      </DemoBlock>
    </div>
  );
}

function MoodMarkDemo() {
  return (
    <div className="space-y-4">
      <DemoBlock title="MoodMark (1 to 10)">
        <div className="flex flex-wrap items-center gap-2">
          {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((m) => (
            <MoodMark key={m} mood={m} />
          ))}
        </div>
      </DemoBlock>
      <DemoBlock title="MoodDot, CheckInRowIcon (28px), and CheckInGlyph (16px)">
        <div className="flex flex-wrap items-center gap-4">
          {[2, 5, 8, 10].map((m) => <MoodDot key={m} mood={m} />)}
          <CheckInRowIcon mood={8} />
          <CheckInGlyph mood={8} />
        </div>
      </DemoBlock>
    </div>
  );
}

function TrackerPanelDemo() {
  const [choice, setChoice] = useState<'poor' | 'ok' | 'good' | null>('ok');
  const [taken, setTaken] = useState<'taken' | 'skipped' | null>('taken');
  const [water, setWater] = useState<number | null>(6);
  const [chips, setChips] = useState<string[]>(['Work']);
  const [softOn, setSoftOn] = useState(true);
  return (
    <div className="max-w-sm space-y-4 rounded-lg border border-divider bg-surface-1 p-4">
      <div>
        <PanelQuestion>How did you sleep?</PanelQuestion>
        <ChoiceGrid options={[{ key: 'poor', label: 'Poor' }, { key: 'ok', label: 'Okay' }, { key: 'good', label: 'Good' }]} value={choice} onPick={setChoice} />
      </div>
      <div>
        <PanelQuestion>Medication</PanelQuestion>
        <PanelSegmented options={[{ key: 'taken', label: 'Taken' }, { key: 'skipped', label: 'Skipped' }]} value={taken} onPick={setTaken} tone="status" className="w-full" />
      </div>
      <div>
        <PanelQuestion>Water</PanelQuestion>
        <NumberStepper value={water} onChange={setWater} min={0} step={1} unit="glasses" quick={[4, 6, 8]} expanded />
      </div>
      <div>
        <PanelQuestion>Factors (chipClass + CHIP_ADD)</PanelQuestion>
        <div className="flex flex-wrap gap-1.5">
          {['Work', 'Family', 'Exercise'].map((c) => (
            <button key={c} type="button" aria-pressed={chips.includes(c)} onClick={() => setChips((x) => (x.includes(c) ? x.filter((y) => y !== c) : [...x, c]))} className={chipClass(chips.includes(c))}>{c}</button>
          ))}
          <button type="button" className={CHIP_ADD}><Plus aria-hidden="true" />Add</button>
        </div>
      </div>
      <div>
        <PanelQuestion>choiceTileClass (soft mode, used in Calendar DayCountStrip)</PanelQuestion>
        <button type="button" onClick={() => setSoftOn((v) => !v)} className={`${choiceTileClass(softOn, 'soft')} px-3 py-1.5`}>
          {softOn ? 'Selected soft tile' : 'Unselected soft tile'}
        </button>
      </div>
    </div>
  );
}

function GuidedTrackerDemo() {
  const [data, setData] = useState<JournalTrackerData>({});
  const [config, setConfig] = useState(defaultTrackerSettings);
  const [factors] = useState<FactorDef[]>([]);
  const meds: MedicationTemplate[] = [];
  const [done, setDone] = useState(false);
  const [mode, setMode] = useState<'entry' | 'card'>('card');
  const [readOnly, setReadOnly] = useState(false);
  const [resetKey, setResetKey] = useState(0);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <SettingsSegmented
          label="Tracker host"
          value={mode}
          onChange={(v) => { setMode(v); setDone(false); setResetKey((k) => k + 1); }}
          options={[{ value: 'card', label: 'Guided card' }, { value: 'entry', label: 'Journal entry' }]}
        />
        <Switch label="Read-only" checked={readOnly} onChange={setReadOnly} />
        <Button action="restore" onClick={() => { setData({}); setDone(false); setResetKey((k) => k + 1); }}>Restart</Button>
      </div>
      <TrackerPills
        key={resetKey}
        data={data}
        onChange={setData}
        trackerSettings={config}
        onSettingsChange={setConfig}
        factors={factors}
        medications={meds}
        isPro
        readOnly={readOnly}
        variant={mode}
        flow={mode === 'card' && !readOnly ? { onFinish: () => setDone(true), done: done ? <StatusLine tone="success">Fixture complete</StatusLine> : undefined } : undefined}
      />
    </div>
  );
}

function MonthGridDemo() {
  const [day, setDay] = useState<string | undefined>(undefined);
  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <DemoBlock title="MonthGrid (6-week picker)">
          <div className="rounded-lg border border-divider bg-surface-1 p-3">
            <MonthGrid marked={{ has: (d) => d.endsWith('-05') || d.endsWith('-12') || d.endsWith('-21') }} selected={day} onPick={setDay} />
          </div>
        </DemoBlock>
        <div className="space-y-4">
          <DemoBlock title="MonthGrid (weeks={1} strip with mood discs)">
            <div className="rounded-lg border border-divider bg-surface-1 p-3">
              <MonthGrid
                weeks={1}
                wide
                wheelStep={false}
                marked={{ has: () => true }}
                moodOf={(d) => (Number(d.slice(-2)) % 10) + 1}
                selected={day}
                onPick={setDay}
              />
            </div>
          </DemoBlock>
          <DemoBlock title="CalendarHeader">
            <div className="rounded-lg border border-divider bg-surface-1 p-3">
              <CalendarHeader
                title="November 2026"
                shortTitle="Nov 2026"
                prevLabel="Previous"
                nextLabel="Next"
                onPrev={() => {}}
                onNext={() => {}}
                onToday={() => {}}
                focus="2026-11-25"
                onJump={() => {}}
              />
            </div>
          </DemoBlock>
        </div>
      </div>
      <p className={SETTINGS_HELP}>Selected date: {day ?? 'None'}</p>
    </div>
  );
}

function TaskCheckboxDemo() {
  return (
    <div className="flex flex-wrap items-center gap-4">
      <label className="inline-flex items-center gap-2 text-body"><TaskCheckbox aria-label="Unchecked task" defaultChecked={false} />Open task</label>
      <label className="inline-flex items-center gap-2 text-body"><TaskCheckbox aria-label="Completed task" defaultChecked />Completed task</label>
      <label className="inline-flex items-center gap-2 text-body text-pn-muted"><TaskCheckbox aria-label="Disabled task" disabled />Disabled</label>
      <label className="inline-flex items-center gap-2 text-body text-pn-muted"><TaskCheckbox aria-label="Disabled completed" defaultChecked disabled />Disabled done</label>
    </div>
  );
}

function StorageQuotaDemo() {
  const [log, setLog] = useState('');
  return (
    <div className="space-y-5">
      <DemoBlock title="StorageBar">
        <div className="max-w-md rounded-lg border border-divider bg-surface-1 p-3">
          <StorageBar label="Files" usedBytes={312_000_000} maxBytes={1_000_000_000} onRefresh={async () => setLog('Refreshed storage bar.')} />
        </div>
      </DemoBlock>
      <DemoBlock title="QuotaRing (full, compact, warning >80%) & QuotaRingButton">
        <div className="flex flex-wrap items-center gap-6">
          <QuotaRing label="Encrypted storage" usedBytes={312_000_000} maxBytes={1_000_000_000} />
          <div className="space-y-4">
            <QuotaRing label="Compact (normal)" usedBytes={312_000_000} maxBytes={1_000_000_000} compact />
            <QuotaRing label="Compact (>80% amber)" usedBytes={880_000_000} maxBytes={1_000_000_000} compact />
            <div className="flex items-center gap-3">
              <QuotaRingButton usedBytes={312_000_000} maxBytes={1_000_000_000} onOpen={() => setLog('QuotaRingButton clicked.')} />
              <QuotaRingButton usedBytes={910_000_000} maxBytes={1_000_000_000} onOpen={() => setLog('QuotaRingButton warning clicked.')} />
              <span className={SETTINGS_HELP}>Footer ring buttons</span>
            </div>
          </div>
        </div>
      </DemoBlock>
      <DemoBlock title="Round Footer SyncStatus States (SyncArrowsIcon)">
        <div className="flex flex-wrap items-center gap-4 rounded-lg border border-divider bg-surface-1 px-4 py-3">
          <span className="inline-flex items-center gap-2 text-small text-pn"><Gear size={20} className="text-accent" /> Gear</span>
          <span className="inline-flex items-center gap-2 text-small text-pn"><ArrowsClockwise size={20} className="text-success" /> Synced</span>
          <span className="inline-flex items-center gap-2 text-small text-pn"><ArrowsClockwise size={20} className="text-pn-muted opacity-60 animate-spin [animation-duration:2s]" /> Syncing</span>
          <span className="inline-flex items-center gap-2 text-small text-pn"><SyncArrowsIcon mark="slash" size={20} className="text-warning" /> Offline</span>
          <span className="inline-flex items-center gap-2 text-small text-pn"><SyncArrowsIcon mark="warning" size={20} className="text-warning" /> Not synced</span>
          <span className="inline-flex items-center gap-2 text-small text-pn"><SyncArrowsIcon mark="x" size={20} className="text-warning" /> Not saved (demo)</span>
        </div>
      </DemoBlock>
      {log && <p className={SETTINGS_HELP} role="status">{log}</p>}
    </div>
  );
}

function TotpRingDemo() {
  return (
    <div className="flex flex-wrap items-center gap-6">
      <span className="inline-flex items-center gap-2 font-mono text-title">
        <TotpRing secondsLeft={22} period={30} danger={false} />
        {groupTotpCode('482913')}
      </span>
      <span className="inline-flex items-center gap-2 font-mono text-title text-danger">
        <TotpRing secondsLeft={4} period={30} danger />
        {groupTotpCode('482913')}
      </span>
      <span className="inline-flex items-center gap-2 font-mono text-title text-pn-muted">
        <TotpRing secondsLeft={30} period={30} danger={false} static />
        ••• •••
      </span>
    </div>
  );
}

function BrandMarksDemo() {
  return (
    <div className="space-y-5">
      <DemoBlock title="Brand wordmark & LogoIcon">
        <div className="flex flex-wrap items-center gap-6">
          <span className="text-heading"><Brand /></span>
          <span className="text-heading"><Brand suffix=".app" /></span>
          <span className="rounded-md px-3 py-1.5 text-heading" style={{ backgroundColor: '#171717' }}><Brand tone="dark" /></span>
          <LogoIcon size={24} />
          <LogoIcon size={32} tint />
        </div>
      </DemoBlock>
      <DemoBlock title="NinjaIcon, SwissFlag, RatingStar & UpdateDot">
        <div className="flex flex-wrap items-center gap-6">
          <div className="flex items-center gap-2">
            <NinjaIcon size={16} />
            <NinjaIcon size={24} />
            <NinjaIcon size={32} tone="real" />
          </div>
          <span className="inline-flex items-center gap-1.5 text-body"><SwissFlag /> Swiss privacy</span>
          <div className="flex items-center gap-1">
            {[1, 2, 3, 4, 5].map((n) => <RatingStar key={n} size={18} />)}
          </div>
          <span className="relative inline-flex rounded-md border border-divider bg-surface-1 p-2">
            <DownloadSimple aria-hidden="true" />
            <UpdateDot ring="ring-surface-1" />
          </span>
        </div>
      </DemoBlock>
    </div>
  );
}

function GlyphMapsDemo() {
  return (
    <div className="space-y-5">
      <DemoBlock title={`PILLAR_GLYPHS (${Object.keys(PILLAR_GLYPHS).length})`}>
        <div className="flex flex-wrap gap-2">
          {Object.entries(PILLAR_GLYPHS).map(([key, Icon]) => (
            <span key={key} className="inline-flex items-center gap-1.5 rounded-md border border-divider bg-surface-1 px-2.5 py-1 text-small">
              <Icon className="text-accent" aria-hidden="true" />
              <span>{key}</span>
            </span>
          ))}
        </div>
      </DemoBlock>
      <DemoBlock title={`NEW_GLYPHS (${Object.keys(NEW_GLYPHS).length})`}>
        <div className="flex flex-wrap gap-2">
          {Object.entries(NEW_GLYPHS).map(([key, Icon]) => (
            <span key={key} className="inline-flex items-center gap-1.5 rounded-md border border-divider bg-surface-1 px-2.5 py-1 text-small">
              <Icon className="text-accent" aria-hidden="true" />
              <span>{key}</span>
            </span>
          ))}
        </div>
      </DemoBlock>
      <DemoBlock title={`EXPORT_GLYPHS (${Object.keys(EXPORT_GLYPHS).length})`}>
        <div className="flex flex-wrap gap-2">
          {Object.entries(EXPORT_GLYPHS).map(([key, Icon]) => (
            <span key={key} className="inline-flex items-center gap-1.5 rounded-md border border-divider bg-surface-1 px-2.5 py-1 text-small">
              <Icon className="text-accent" aria-hidden="true" />
              <span>{key}</span>
            </span>
          ))}
        </div>
      </DemoBlock>
    </div>
  );
}

function DeviceProvidersDemo() {
  const devices = [
    { platform: 'desktop', device_name: 'macOS' },
    { platform: 'ios', device_name: 'iPhone' },
    { platform: 'ios', device_name: 'iPad' },
    { platform: 'android', device_name: 'Android' },
    { platform: 'desktop', device_name: 'Windows' },
    { platform: 'desktop', device_name: 'Linux' },
    { platform: 'web', device_name: 'ChromeOS' },
    { platform: 'web', device_name: 'Browser' },
  ];
  return (
    <div className="space-y-5">
      <DemoBlock title="DeviceIcon (OS logo + kind badge)">
        <div className="flex flex-wrap items-center gap-4">
          {devices.map((row) => (
            <div key={`${row.platform}-${row.device_name}`} className="flex flex-col items-center gap-1">
              <DeviceIcon row={row} />
              <span className="text-meta text-pn-muted">{row.device_name}</span>
            </div>
          ))}
        </div>
      </DemoBlock>
      <DemoBlock title="OAuth Provider Icons">
        <div className="flex items-center gap-4 text-pn">
          <span className="inline-flex items-center gap-2 rounded-md border border-divider bg-surface-1 px-3 py-1.5 text-body"><GoogleIcon /> Google</span>
          <span className="inline-flex items-center gap-2 rounded-md border border-divider bg-surface-1 px-3 py-1.5 text-body"><AppleIcon /> Apple</span>
          <span className="inline-flex items-center gap-2 rounded-md border border-divider bg-surface-1 px-3 py-1.5 text-body"><GithubIcon /> GitHub</span>
        </div>
      </DemoBlock>
    </div>
  );
}

function ProMarksDemo() {
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-6">
        <div className="space-y-1">
          <p className={SETTINGS_HELP}>ProMark (headings / rows)</p>
          <ProMark />
        </div>
        <div className="space-y-1">
          <p className={SETTINGS_HELP}>IconUpgrade (buttons / tabs)</p>
          <div className="flex items-center gap-2">
            <IconUpgrade size={14} />
            <IconUpgrade size={18} />
          </div>
        </div>
        <div className="space-y-1">
          <p className={SETTINGS_HELP}>ProGlyph (corner badge)</p>
          <span className="inline-flex rounded-md border border-divider bg-surface-1 p-2">
            <ProGlyph pro><Folder aria-hidden="true" /></ProGlyph>
          </span>
        </div>
        <div className="space-y-1">
          <p className={SETTINGS_HELP}>ProBadge (quiet menu pill)</p>
          <ProBadge />
        </div>
      </div>
      <DemoBlock title="ProBadge in menus (OptionsMenu / NoteOptionsMenu / ConnectionsPanel)">
        <div className="max-w-xs rounded-xl border border-divider bg-surface-2 py-1 divide-y divide-divider">
          <div className="flex items-center gap-3 px-4 py-2 text-body text-pn">
            <Folder className="shrink-0 text-accent" aria-hidden="true" />
            <span className="flex-1 truncate">Move to folder</span>
            <ProBadge />
          </div>
          <div className="flex items-center gap-3 px-4 py-2 text-body text-pn">
            <Briefcase className="shrink-0 text-accent" aria-hidden="true" />
            <span className="flex-1 truncate">Move to <strong>Work</strong></span>
            <ProBadge />
          </div>
        </div>
      </DemoBlock>
    </div>
  );
}

function UploadProgressDemo() {
  const [phase, setPhase] = useState('mixed');
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open || phase !== 'running') return;
    const timer = window.setTimeout(() => setPhase('complete'), 3000);
    return () => window.clearTimeout(timer);
  }, [open, phase]);
  const entries: FileUploadEntry[] = phase === 'running'
    ? [{ name: 'Example.pdf', size: 1024, status: 'uploading' }, { name: 'Waiting.txt', size: 128, status: 'pending' }]
    : phase === 'complete' ? [{ name: 'Example.pdf', size: 1024, status: 'done' }]
    : phase === 'storage' ? [{ name: 'Example.pdf', size: 1024, status: 'failed', errorCode: 'storage-full' }, { name: 'Kept-on-device.txt', size: 128, status: 'failed', errorCode: 'storage-full-kept' }]
    : [{ name: 'Example.pdf', size: 1024, status: 'done' }, { name: 'A long example filename that must stay within the upload window.txt', size: 128, status: 'failed', error: 'The file could not be uploaded. Try again.' }];
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Select size="sm" aria-label="Upload fixture state" value={phase} onChange={(e) => setPhase(e.target.value)}>
        <option value="mixed">Mixed results</option>
        <option value="storage">Storage failures</option>
        <option value="complete">Complete</option>
        <option value="running">Running (3s then complete)</option>
      </Select>
      <Button action="open" onClick={() => setOpen(true)}>Open UploadProgressModal</Button>
      {open && <UploadProgressModal entries={entries} isPro hasStorageSub onOpenUpgrade={() => {}} onManageStorage={() => {}} onClose={() => setOpen(false)} />}
    </div>
  );
}

function ExportProgressDemo() {
  const [phase, setPhase] = useState('failed');
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open || phase !== 'running') return;
    const timer = window.setTimeout(() => setPhase('complete'), 3000);
    return () => window.clearTimeout(timer);
  }, [open, phase]);
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Select size="sm" aria-label="Export fixture state" value={phase} onChange={(e) => setPhase(e.target.value)}>
        <option value="failed">Failed</option>
        <option value="incomplete">Incomplete</option>
        <option value="complete">Complete</option>
        <option value="running">Running (3s then complete)</option>
      </Select>
      <Button action="export" onClick={() => setOpen(true)}>Open ExportProgressModal</Button>
      {open && (
        <ExportProgressModal
          done={phase !== 'running'}
          status={phase === 'incomplete' ? 'Some files could not be included. Keep your original data.' : ''}
          steps={['pictures', 'files', 'notes', 'zip']}
          step={phase === 'running' ? { step: 'pictures', done: 17, total: 56 } : undefined}
          error={phase === 'failed' ? 'The backup could not be created. Try exporting again.' : undefined}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}

function PhraseChangeEndDemo() {
  const states = [
    { kind: 'running', stage: 'prepare' },
    { kind: 'running', stage: 'send' },
    { kind: 'failed', message: 'Your phrase changed three times in the last 24 hours. Try again later.' },
    { kind: 'unknown' },
    { kind: 'signIn' },
    { kind: 'done', connections: true, twoFactorOff: true },
  ] as const;
  return (
    <div className="grid gap-3 @container sm:grid-cols-2">
      {states.map((end, i) => (
        <div key={i} className="rounded-lg border border-divider bg-surface-1 p-4" data-phrase-end={end.kind}>
          <PhraseChangeEnd end={end} onOpenTwoFactor={() => {}} />
        </div>
      ))}
    </div>
  );
}

function NoteStateRowDemo() {
  const [log, setLog] = useState('Hover any action to see its below-start tooltip.');
  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-divider bg-surface-1 p-4">
        <NoteStateRow
          states={['readOnly', 'archived', 'unlocked']}
          place="editor"
          onTurnOff={() => setLog('Turn off read-only')}
          onUnarchive={() => setLog('Unarchive')}
          onLock={() => setLog('Lock now')}
        />
      </div>
      <ReadOnlySkipNotice count={3} />
      <p className={SETTINGS_HELP} role="status">{log}</p>
    </div>
  );
}
