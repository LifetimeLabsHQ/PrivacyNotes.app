import { useRef, useState } from 'react';
import {
  BackRow,
  Badge,
  Banner,
  Button,
  Callout,
  CanvasControlBar,
  CanvasControlDivider,
  Checkbox,
  ColorSwatch,
  ColorSwatchRow,
  ContextMenu,
  DETAIL_COLUMN,
  DetailAction,
  DetailCopyAction,
  DetailGroup,
  DetailHero,
  DetailLink,
  DetailNotes,
  DetailRow,
  DetailTile,
  Divider,
  DRAG_SOURCE,
  DROP_INSIDE,
  DropLine,
  EmptyState,
  ExpandLabel,
  FeaturePitch,
  FeedbackButton,
  GateCard,
  GlyphTile,
  GridCard,
  HoverLabel,
  IconButton,
  IconTile,
  ItemSwitcher,
  Kbd,
  KindChips,
  ListPaneHeader,
  ListSearchInput,
  ListSearchRow,
  Modal,
  ModalFooter,
  OverflowTip,
  PickerModal,
  PitchBadge,
  PluginSheet,
  Popover,
  ProgressBar,
  ProgressModal,
  RowChip,
  Select,
  SelectionCountStrip,
  SETTINGS_BTN,
  SETTINGS_HELP,
  SETTINGS_TRACK,
  settingsSegClass,
  Snackbar,
  Spinner,
  StatTile,
  StatusLine,
  SubViewHeader,
  SuggestionItem,
  SuggestionPopup,
  Switch,
  TerminalBlock,
  TextField,
  UpdateToast,
  useContextMenu,
  usePointerReorder,
  halfOf,
  nearestRow,
} from '../index';
import { DockableWindow, WindowSizeButtons } from '../DockableWindow';
import { ListEntryCard } from '../../ListEntryCard';
import { ActionItem, Group, OptionsMenu, ToggleItem } from '../../OptionsMenu';
import { textMatcher } from '../../textMatch';
import {
  AppWindow,
  ArrowSquareOut,
  Article,
  Bell,
  BookmarkSimple,
  ChatText,
  CheckCircle,
  CheckFat,
  Clock,
  CreditCard,
  DotsSixVertical,
  Fire,
  Folder,
  Gear,
  Globe,
  HardDrives,
  Info,
  Key,
  Lock,
  MapPin,
  Moon,
  PencilSimple,
  PushPin,
  Scissors,
  SlidersHorizontal,
  Sparkle,
  Trash,
  User,
  Warning,
} from '../../icons';
import type { LookColor } from '../../itemStyles';
import { DemoBlock } from './demosActions';

export function renderSurfaceDemo(id: string): React.ReactNode | null {
  switch (id) {
    case 'modal': return <ModalDemo />;
    case 'dockable-window': return <DockableWindowDemo />;
    case 'popover': return <PopoverDemo />;
    case 'context-menu': return <ContextMenuDemo />;
    case 'options-menu': return <OptionsMenuDemo />;
    case 'back-subview-switcher': return <BackSwitcherDemo />;
    case 'window-lab': return <WindowLabDemo />;
    case 'callout': return <CalloutDemo />;
    case 'banner': return <BannerDemo />;
    case 'snackbar': return <SnackbarDemo />;
    case 'update-toast': return <UpdateToastDemo />;
    case 'badge': return <BadgeDemo />;
    case 'spinner-progress-status': return <ProgressDemo />;
    case 'empty-state': return <EmptyStateDemo />;
    case 'icon-tile': return <IconTileDemo />;
    case 'grid-card': return <GridCardDemo />;
    case 'stat-tile': return <StatTileDemo />;
    case 'detail-pane-kit': return <DetailPaneDemo />;
    case 'kind-chips-expand': return <KindChipsDemo />;
    case 'row-chip': return <RowChipDemo />;
    case 'list-entry-card': return <ListEntryCardDemo />;
    case 'color-swatch': return <ColorSwatchDemo />;
    case 'reorder': return <ReorderDemo />;
    case 'kbd-divider': return <KbdDividerDemo />;
    case 'hover-overflow-tip': return <HoverOverflowDemo />;
    case 'feature-pitch': return <FeaturePitchDemo />;
    case 'terminal-block': return <TerminalBlockDemo />;
    case 'picker-modal': return <PickerModalDemo />;
    case 'progress-modal': return <ProgressModalDemo />;
    case 'plugin-sheet': return <PluginSheetDemo />;
    case 'gate-card': return <GateCardDemo />;
    case 'suggestion-popup': return <SuggestionPopupDemo />;
    case 'canvas-control-bar': return <CanvasControlBarDemo />;
    case 'list-pane-header': return <ListPaneHeaderDemo />;
    case 'selection-count-strip': return <SelectionCountStripDemo />;
    default: return null;
  }
}

function ModalDemo() {
  const [open, setOpen] = useState<'inline' | 'bar' | null>(null);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <Button icon={<AppWindow aria-hidden="true" />} onClick={() => setOpen('inline')}>Short window (inline header)</Button>
        <Button icon={<AppWindow aria-hidden="true" />} onClick={() => setOpen('bar')}>Scrolling window (bar header)</Button>
      </div>
      <DemoBlock title="Modal embedded={true} (used inside SettingsShell)">
        <Modal embedded title="Ignored in embedded mode" embeddedClassName="rounded-lg border border-divider bg-surface-1 p-4">
          <p className="text-body">When embedded is true, Modal renders only its body without backdrop or header.</p>
        </Modal>
      </DemoBlock>
      {open === 'inline' && (
        <Modal onClose={() => setOpen(null)} title="Clip page" icon={<Scissors />} className="max-w-md p-6 space-y-4">
          <TextField label="Web address" icon={<Globe />} dir="ltr" placeholder="https://" />
          <div className={SETTINGS_TRACK}>
            <button type="button" aria-pressed={false} className={settingsSegClass(false)}>Bookmark</button>
            <button type="button" aria-pressed className={settingsSegClass(true)}>Main text</button>
          </div>
          <ModalFooter>
            <Button action="cancel" onClick={() => setOpen(null)} />
            <Button action="save" onClick={() => setOpen(null)} />
          </ModalFooter>
        </Modal>
      )}
      {open === 'bar' && (
        <Modal onClose={() => setOpen(null)} title="Note history" icon={<Clock />} subtitle="Local example versions." header="bar" className="max-w-lg max-h-[80vh] flex flex-col">
          <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4 space-y-2">
            {['Today, 14:02', 'Yesterday, 09:40', 'Oct 12, 18:15'].map((v) => (
              <p key={v} className="flex items-center gap-2 text-body"><Article className="text-accent" aria-hidden="true" />{v}</p>
            ))}
          </div>
          <ModalFooter bar>
            <Button action="cancel" onClick={() => setOpen(null)} />
            <Button action="restore" onClick={() => setOpen(null)}>Restore</Button>
          </ModalFooter>
        </Modal>
      )}
    </div>
  );
}

function DockableWindowDemo() {
  const [open, setOpen] = useState(false);
  const [dockedPreview, setDockedPreview] = useState(false);
  return (
    <div className="space-y-4">
      <DemoBlock title="WindowSizeButtons (header controls)">
        <div className="flex flex-wrap items-center gap-4">
          <div className="inline-flex items-center gap-1 rounded-md border border-divider bg-surface-1 px-2 py-1">
            <span className="text-small text-pn-muted me-2">{dockedPreview ? 'Docked:' : 'Modal:'}</span>
            <WindowSizeButtons
              docked={dockedPreview}
              wide={false}
              isMobile={false}
              pickSize={(s) => setDockedPreview(s === 'side')}
              flipEdge={() => {}}
            />
          </div>
          <Button action="open" onClick={() => setOpen(true)}>Launch live DockableWindow</Button>
        </div>
      </DemoBlock>
      {open && (
        <DockableWindow
          storagePrefix="privacynotes.catalog.dockDemo"
          title="Dockable workspace demo"
          icon={<Sparkle className="text-accent" />}
          onClose={() => setOpen(false)}
        >
          {({ size, edge, docked }) => (
            <div className="p-6 space-y-3">
              <p className="text-body">Try the top-end buttons to switch between normal modal, full window, and docked side panel.</p>
              <p className={SETTINGS_HELP}>Current mode: <strong>{size}</strong> · edge: <strong>{edge}</strong> · docked: <strong>{String(docked)}</strong></p>
            </div>
          )}
        </DockableWindow>
      )}
    </div>
  );
}

function PopoverDemo() {
  const anchor = useRef<HTMLSpanElement | null>(null);
  const [open, setOpen] = useState(false);
  return (
    <div className="space-y-2">
      <span ref={anchor} className="inline-flex">
        <Button icon={<SlidersHorizontal aria-hidden="true" />} onClick={() => setOpen((v) => !v)}>Toggle Popover</Button>
      </span>
      <Popover open={open} anchorRef={anchor} onClose={() => setOpen(false)} title="View options">
        <div className="space-y-2 p-1">
          <Checkbox label="Show previews" defaultChecked />
          <Divider />
          <Checkbox label="Compact rows" />
        </div>
      </Popover>
    </div>
  );
}

function ContextMenuDemo() {
  const menu = useContextMenu();
  const [log, setLog] = useState('Click the button to open ContextMenu with every row type.');
  return (
    <div className="space-y-3">
      <Button
        action="open"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          menu.open({ clientX: r.left, clientY: r.bottom + 4, preventDefault: () => {}, stopPropagation: () => {} }, [
            { type: 'header', label: 'Note actions' },
            { label: 'Rename', icon: <PencilSimple />, onSelect: () => setLog('Rename'), shortcut: 'F2' },
            { label: 'Pinned', icon: <PushPin />, onSelect: () => setLog('Pin'), checked: true },
            { label: 'Move to folder', icon: <Folder />, onSelect: () => setLog('Move'), pro: true },
            { label: 'Restore version', icon: <CheckCircle />, onSelect: () => setLog('Restore'), success: true },
            { label: 'Disabled row', icon: <Lock />, onSelect: () => {}, disabled: true },
            { type: 'separator' },
            { label: 'Move to trash', icon: <Trash />, onSelect: () => setLog('Trash'), destructive: true },
          ]);
        }}
      >
        Open ContextMenu
      </Button>
      {menu.state && <ContextMenu state={menu.state} onClose={menu.close} />}
      <p className={SETTINGS_HELP} role="status">{log}</p>
    </div>
  );
}

function OptionsMenuDemo() {
  const anchor = useRef<HTMLSpanElement | null>(null);
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<'main' | 'sub'>('main');
  const [readOnly, setReadOnly] = useState(false);
  return (
    <div className="space-y-2">
      <span ref={anchor} className="inline-flex">
        <Button icon={<SlidersHorizontal aria-hidden="true" />} onClick={() => { setView('main'); setOpen((v) => !v); }}>
          Open multi-view OptionsMenu
        </Button>
      </span>
      {open && (
        <OptionsMenu anchorRef={anchor} onClose={() => setOpen(false)} label="Example options menu" view={view}>
          {view === 'main' ? (
            <>
              <Group>
                <ToggleItem icon={<Lock />} label="Read-only" checked={readOnly} onClick={() => setReadOnly((v) => !v)} />
                <ActionItem icon={<Clock />} label="Schedule" value="Today" chevron onClick={() => setView('sub')} />
              </Group>
              <Group>
                <ActionItem icon={<Trash />} label="Move to trash" tone="danger" onClick={() => setOpen(false)} />
              </Group>
            </>
          ) : (
            <div className="p-2 space-y-2">
              <BackRow title="Schedule" onBack={() => setView('main')} />
              <p className={SETTINGS_HELP}>Nested sub-view inside the same anchored menu.</p>
            </div>
          )}
        </OptionsMenu>
      )}
    </div>
  );
}

function BackSwitcherDemo() {
  const [current, setCurrent] = useState('sleep');
  const [log, setLog] = useState('Use Up/Down arrows on the ItemSwitcher button or click to open its list.');
  return (
    <div className="space-y-5">
      <DemoBlock title="BackRow (default and wide)">
        <div className="max-w-xs space-y-2 rounded-md border border-divider bg-surface-1 p-2">
          <BackRow title="Default BackRow" onBack={() => setLog('Back (default)')} />
          <Divider />
          <BackRow title="Wide BackRow (full row button)" wide onBack={() => setLog('Back (wide)')} />
        </div>
      </DemoBlock>
      <DemoBlock title="SubViewHeader + ItemSwitcher + GlyphTile">
        <div className="rounded-md border border-divider bg-surface-1 p-4 pt-5">
          <SubViewHeader backLabel="Back to trackers" onBack={() => setLog('Back to all trackers')}>
            <ItemSwitcher
              label="Switch tracker"
              currentId={current}
              onPick={(id) => { setCurrent(id); setLog(`Switched to ${id}`); }}
              items={[
                { id: 'sleep', name: 'Sleep', detail: '7.5 h', tile: (s) => <GlyphTile color="#6366f1" size={s}><Moon /></GlyphTile> },
                { id: 'energy', name: 'Energy', detail: '8 / 10', tile: (s) => <GlyphTile color="#f59e0b" size={s}><Sparkle /></GlyphTile> },
                { id: 'water', name: 'Water', detail: '6 glasses', tile: (s) => <GlyphTile color="#0ea5e9" size={s} /> },
              ]}
            />
          </SubViewHeader>
        </div>
      </DemoBlock>
      <p className={SETTINGS_HELP} role="status">{log}</p>
    </div>
  );
}

function WindowLabDemo() {
  const [size, setSize] = useState('max-w-md');
  const [long, setLong] = useState(false);
  const [info, setInfo] = useState(false);
  const [open, setOpen] = useState(false);
  const [child, setChild] = useState(false);
  const [busy, setBusy] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const [result, setResult] = useState('No window opened yet.');
  const close = (reason: string) => { setOpen(false); setChild(false); setBusy(false); setResult(reason); };
  return (
    <div className="space-y-3">
      <Select aria-label="Window width" value={size} onChange={(e) => setSize(e.target.value)}>
        <option value="max-w-sm">Confirm (max-w-sm)</option>
        <option value="max-w-md">Form (max-w-md)</option>
        <option value="max-w-lg">Content (max-w-lg)</option>
        <option value="max-w-3xl">Workspace (max-w-3xl)</option>
      </Select>
      <div className="flex flex-wrap gap-4">
        <Switch label="Long scrolling content" checked={long} onChange={setLong} />
        <Switch label="Info window (no footer)" checked={info} onChange={setInfo} />
        <Switch label="Field error" checked={invalid} onChange={setInvalid} />
      </div>
      <Button action="open" onClick={() => setOpen(true)}>Open window lab</Button>
      <p className={SETTINGS_HELP} role="status">{result}</p>
      {open && (
        <Modal
          title="Window lab"
          header="bar"
          onClose={() => close('Dismissed via X, Escape, or backdrop.')}
          escape={!busy}
          closeOnBackdrop={!busy}
          className={`${size} max-h-[calc(100dvh-3rem)] flex flex-col`}
        >
          <div className="min-h-0 flex-1 overflow-y-auto p-6 space-y-4">
            <TextField label="Example name" placeholder="Local draft" error={invalid ? 'Example validation error.' : undefined} />
            <p className={SETTINGS_HELP}>Tab wraps inside the dialog (keepTabInside); Escape closes the child layer first.</p>
            <div className="flex flex-wrap gap-2">
              <Button action="open" disabled={busy} onClick={() => setChild(true)}>Open nested z-[60] child</Button>
              <Button action={busy ? 'done' : 'next'} onClick={() => setBusy((v) => !v)}>{busy ? 'End busy state' : 'Simulate busy state'}</Button>
            </div>
            {busy && <StatusLine busy>Busy: X, Escape, and backdrop are disabled.</StatusLine>}
            {long && Array.from({ length: 14 }, (_, i) => (
              <p key={i} className="text-body">Paragraph {i + 1}. Scrolling stays inside the body while header and footer remain pinned.</p>
            ))}
          </div>
          {!info && (
            <ModalFooter bar>
              <Button action="cancel" disabled={busy} onClick={() => close('Canceled.')} />
              <Button action="save" disabled={busy || invalid} onClick={() => close('Saved fixture.')} />
            </ModalFooter>
          )}
          {child && (
            <Modal title="Child window" layer="z-[60]" onClose={() => setChild(false)} className="max-w-sm p-6 space-y-4">
              <p className="text-body">Escape closes only this child; parent remains open.</p>
              <ModalFooter>
                <Button action="cancel" onClick={() => setChild(false)} />
                <Button action="done" onClick={() => setChild(false)} />
              </ModalFooter>
            </Modal>
          )}
        </Modal>
      )}
    </div>
  );
}

function CalloutDemo() {
  const [log, setLog] = useState('');
  return (
    <div className="space-y-4">
      <DemoBlock title="App look (tinted box, 4 tones)">
        <div className="space-y-2">
          <Callout>Files up to 5 MB on the free plan.</Callout>
          <Callout tone="warning" title="Notifications are blocked">Allow them in the settings of this browser.</Callout>
          <Callout tone="danger">Fill in at least one field before saving.</Callout>
          <Callout tone="danger" action={<FeedbackButton action="retry" onClick={() => setLog('Retry clicked.')}>Retry</FeedbackButton>}>
            The page could not be downloaded.
          </Callout>
          <Callout tone="success">Your recovery phrase is saved.</Callout>
        </div>
      </DemoBlock>
      <DemoBlock title='Extension look="card" (raised card, do not use in main app)'>
        <Callout look="card" tone="warning" title="Extension notice" action={<FeedbackButton action="retry" onClick={() => setLog('Card retry.')}>Retry</FeedbackButton>}>
          Card look is reserved for the browser extension popup.
        </Callout>
      </DemoBlock>
      {log && <p className={SETTINGS_HELP} role="status">{log}</p>}
    </div>
  );
}

function BannerDemo() {
  const [log, setLog] = useState('');
  return (
    <div className="space-y-2">
      <div className="overflow-hidden rounded-md border border-divider">
        <Banner action={<FeedbackButton icon={<HardDrives aria-hidden="true" />} onClick={() => setLog('Manage storage')}>Manage storage</FeedbackButton>} onDismiss={() => setLog('Dismissed')} dismissLabel="Later">
          Storage is full. New files are not uploaded.
        </Banner>
        <Banner tone="info">A newer version is ready.</Banner>
        <Banner tone="warning">Permission is needed before continuing.</Banner>
        <Banner tone="danger">The operation failed. Your draft is still here.</Banner>
        <Banner tone="success">Payment confirmed. Pro is active.</Banner>
      </div>
      {log && <p className={SETTINGS_HELP} role="status">{log}</p>}
    </div>
  );
}

function SnackbarDemo() {
  const [show, setShow] = useState(false);
  return (
    <div className="space-y-2">
      <Button icon={<ChatText aria-hidden="true" />} onClick={() => setShow((v) => !v)}>
        {show ? 'Hide Snackbar' : 'Show live Snackbar'}
      </Button>
      {show && <Snackbar actionLabel="Undo" onAction={() => setShow(false)}>Moved to Work</Snackbar>}
    </div>
  );
}

function UpdateToastDemo() {
  const [mode, setMode] = useState<'none' | 'optional' | 'required' | 'reminder'>('none');
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <Button icon={<Bell aria-hidden="true" />} onClick={() => setMode(mode === 'optional' ? 'none' : 'optional')}>Optional update</Button>
        <Button icon={<Warning aria-hidden="true" />} onClick={() => setMode(mode === 'required' ? 'none' : 'required')}>Required floor</Button>
        <Button icon={<Clock aria-hidden="true" />} onClick={() => setMode(mode === 'reminder' ? 'none' : 'reminder')}>Reminder w/ Snooze</Button>
      </div>
      {mode === 'optional' && (
        <UpdateToast version="0.840.0" sizeBytes={24_500_000} actionLabel="Restart" onAction={() => setMode('none')} onChangelog={() => setMode('none')} onDismiss={() => setMode('none')} />
      )}
      {mode === 'required' && (
        <UpdateToast version="0.840.0" required actionLabel="Update now" onAction={() => setMode('none')} />
      )}
      {mode === 'reminder' && (
        <UpdateToast
          title="Dentist appointment"
          meta="In 15 minutes"
          icon={<Bell aria-hidden="true" />}
          actionLabel="Open"
          onAction={() => setMode('none')}
          secondary={{ label: 'Snooze 10m', onAction: () => setMode('none') }}
          onDismiss={() => setMode('none')}
        />
      )}
    </div>
  );
}

function BadgeDemo() {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Badge>Default</Badge>
      <Badge tone="info">Info · 3</Badge>
      <Badge tone="success">Stronger</Badge>
      <Badge tone="warning">Not backed up</Badge>
      <Badge tone="danger">Expired</Badge>
      <Badge tone="info" icon={<Sparkle size={11} />}>With icon</Badge>
    </div>
  );
}

function ProgressDemo() {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-4">
        <Spinner />
        <Spinner size={24} label="Loading" />
      </div>
      <ProgressBar value={0.42} label="Exporting" />
      <ProgressBar label="Indeterminate running" />
      <ProgressBar value={1} tone="success" label="Complete" />
      <ProgressBar value={1} tone="warning" label="Incomplete" />
      <ProgressBar value={1} tone="danger" label="Failed" />
      <StatusLine busy>Downloading pictures, 1 of 2</StatusLine>
      <StatusLine tone="success">Saved locally.</StatusLine>
      <StatusLine tone="danger">The page could not be downloaded.</StatusLine>
    </div>
  );
}

function EmptyStateDemo() {
  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-divider bg-surface-1">
        <EmptyState
          icon={<BookmarkSimple weight="duotone" />}
          title="No bookmarks yet"
          actions={<><Button action="add">Add bookmark</Button><Button action="import">Import</Button></>}
        >
          Save links to read later or clip full pages offline.
        </EmptyState>
      </div>
      <div className="rounded-lg border border-divider bg-surface-1">
        <EmptyState compact>No versions yet (compact variant).</EmptyState>
      </div>
    </div>
  );
}

function IconTileDemo() {
  return (
    <div className="space-y-3">
      <DemoBlock title="size='md' (default, 40px)">
        <div className="flex flex-wrap items-center gap-3">
          <IconTile><Info /></IconTile>
          <IconTile tone="success"><CheckCircle /></IconTile>
          <IconTile tone="warning"><Warning /></IconTile>
          <IconTile tone="danger"><Trash /></IconTile>
        </div>
      </DemoBlock>
      <DemoBlock title="size='sm' (28px)">
        <div className="flex flex-wrap items-center gap-3">
          <IconTile size="sm"><Info /></IconTile>
          <IconTile size="sm" tone="success"><CheckCircle /></IconTile>
          <IconTile size="sm" tone="warning"><Warning /></IconTile>
          <IconTile size="sm" tone="danger"><Trash /></IconTile>
        </div>
      </DemoBlock>
    </div>
  );
}

function GridCardDemo() {
  return (
    <ul className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      <GridCard title="Open tasks" icon={CheckFat} style={{ gridColumn: 'span 2' }} link={{ label: 'Tasks', onClick: () => {} }}>
        <p className="text-compact text-pn">Book dentist appointment</p>
        <p className="text-compact text-pn-soft">Review release notes</p>
      </GridCard>
      <GridCard title="Streak" icon={Fire}>
        <StatTile label="Writing" value="12 days" bare />
      </GridCard>
    </ul>
  );
}

function StatTileDemo() {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <StatTile label="Writing streak" value="4 days" sub="Today is in." />
        <StatTile label="Words" value="2,515" />
        <StatTile label="Mood" value="7.4" />
        <StatTile label="Days logged" value="5 of 7" />
      </div>
      <div className="rounded-lg border border-divider bg-surface-1 p-3">
        <StatTile label="Bare variant (inside an existing card)" value="128 notes" bare />
      </div>
    </div>
  );
}

function DetailPaneDemo() {
  const [copied, setCopied] = useState<string | null>(null);
  return (
    <div className={DETAIL_COLUMN}>
      <DetailHero tile={<DetailTile><Globe size={22} /></DetailTile>} title="Google" subtitle="accounts.google.com" onEdit={() => {}} editLabel="Edit" />
      <DetailGroup heading="Login">
        <DetailRow icon={<User />} label="Username" actions={<DetailCopyAction value="user@example.com" id="u" copied={copied} onCopy={(_, id) => setCopied(id)} label="Copy" />}>
          user@example.com
        </DetailRow>
        <DetailRow icon={<Globe />} label="Website" actions={<DetailAction label="Open" href="https://accounts.google.com"><ArrowSquareOut /></DetailAction>}>
          <DetailLink href="https://accounts.google.com">accounts.google.com</DetailLink>
        </DetailRow>
      </DetailGroup>
      <DetailNotes heading="Notes" markdown>**Formatted** markdown notes inside DetailNotes.</DetailNotes>
    </div>
  );
}

function KindChipsDemo() {
  const [kind, setKind] = useState<'all' | 'login' | 'card' | 'ssh-key'>('all');
  return (
    <div className="space-y-4">
      <DemoBlock title="KindChips (interactive; hover cells to see ExpandLabel)">
        <div className="max-w-sm">
          <KindChips
            kinds={[
              { key: 'all', label: 'All', Icon: null, count: 12 },
              { key: 'login', label: 'Logins', Icon: Lock, count: 9 },
              { key: 'card', label: 'Cards', Icon: CreditCard, count: 2 },
              { key: 'ssh-key', label: 'Keys', Icon: Key, count: 1 },
            ]}
            value={kind}
            onChange={setKind}
          />
        </div>
      </DemoBlock>
      <DemoBlock title="ExpandLabel standalone (hover to expand)">
        <button type="button" className="group inline-flex items-center rounded-md border border-divider bg-surface-1 px-2.5 py-1.5 text-pn">
          <Gear aria-hidden="true" />
          <ExpandLabel>Settings</ExpandLabel>
        </button>
      </DemoBlock>
    </div>
  );
}

function RowChipDemo() {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <RowChip icon={<Folder className="shrink-0 text-label" aria-hidden="true" />} onClick={() => {}} label="Move to folder">Travel</RowChip>
      <RowChip icon={<Folder className="shrink-0 text-label" aria-hidden="true" />} empty onClick={() => {}} label="Move to folder">Unfiled</RowChip>
      <RowChip icon={<MapPin className="shrink-0" aria-hidden="true" />} onClick={() => {}} label="Location">Zurich</RowChip>
      <RowChip icon={<MapPin className="shrink-0" aria-hidden="true" />} empty onClick={() => {}}>Location</RowChip>
      <RowChip icon={<Folder className="shrink-0 text-label" aria-hidden="true" />}>Read-only note</RowChip>
      <RowChip icon={<MapPin className="shrink-0" aria-hidden="true" />} onClick={() => {}}>A very long place name that truncates neatly</RowChip>
    </div>
  );
}

function ListEntryCardDemo() {
  const [dismissed, setDismissed] = useState(false);
  return (
    <div className="space-y-4">
      <DemoBlock title='variant="row" (accent offer + amber active filter)'>
        <ul className="overflow-hidden rounded-lg border border-divider bg-surface-1">
          {!dismissed && (
            <ListEntryCard variant="row" tone="accent" icon={BookmarkSimple} label="Import bookmarks from your browser" onClick={() => {}} onDismiss={() => setDismissed(true)} dismissLabel="Dismiss" />
          )}
          <ListEntryCard variant="row" tone="amber" icon={SlidersHorizontal} label="Filter active: clear filters" onClick={() => setDismissed(false)} />
        </ul>
      </DemoBlock>
      <DemoBlock title='variant="tile" (grid view)'>
        <ul className="grid grid-cols-2 gap-3 max-w-md">
          <ListEntryCard variant="tile" tone="accent" icon={BookmarkSimple} label="Import bookmarks" onClick={() => {}} onDismiss={() => {}} dismissLabel="Dismiss" />
          <ListEntryCard variant="tile" tone="amber" icon={SlidersHorizontal} label="Clear filters" onClick={() => {}} />
        </ul>
      </DemoBlock>
    </div>
  );
}

function ColorSwatchDemo() {
  const [swatch, setSwatch] = useState<string | null>('blue');
  const [look, setLook] = useState<LookColor | 'none' | null>('blue');
  return (
    <div className="space-y-4">
      <DemoBlock title="ColorSwatch (none, selected, inherited dashed ring)">
        <div className="flex flex-wrap gap-2">
          <ColorSwatch label="No color" none selected={swatch === null} onClick={() => setSwatch(null)} />
          {([['blue', '#2563eb'], ['green', '#16a34a'], ['amber', '#d97706'], ['red', '#dc2626'], ['purple', '#9333ea']] as const).map(([k, c]) => (
            <ColorSwatch key={k} label={k} background={c} selected={swatch === k} inherited={k === 'purple' && swatch !== k} onClick={() => setSwatch(k)} />
          ))}
        </div>
      </DemoBlock>
      <DemoBlock title="ColorSwatchRow (full LOOK_COLORS palette, inherited='purple')">
        <ColorSwatchRow
          selected={look}
          inherited="purple"
          noneLabel="No color"
          colorLabel={(c) => c[0]!.toUpperCase() + c.slice(1)}
          onPick={(c) => setLook(c ?? 'none')}
        />
      </DemoBlock>
    </div>
  );
}

function ReorderDemo() {
  const [items, setItems] = useState(['Notes', 'Journals', 'Tasks', 'Vault']);
  const listRef = useRef<HTMLUListElement | null>(null);
  const { drag, pressProps } = usePointerReorder<{ id: string; edge: 'top' | 'bottom' }>({
    resolve: (dragId, x, y) => {
      const hit = nearestRow(listRef.current, x, y);
      const hitId = hit?.dataset.reorderId;
      if (!hit || !hitId || hitId === dragId) return null;
      return { id: hitId, edge: halfOf(hit, x, y) === 'before' ? 'top' : 'bottom' };
    },
    targetKey: (t) => `${t.id}:${t.edge}`,
    onDrop: (dragId, target) => {
      setItems((prev) => {
        const next = prev.filter((x) => x !== dragId);
        const idx = next.indexOf(target.id);
        if (idx === -1) return prev;
        next.splice(target.edge === 'top' ? idx : idx + 1, 0, dragId);
        return next;
      });
    },
  });

  return (
    <div className="space-y-4">
      <DemoBlock title="Interactive usePointerReorder + DropLine + DRAG_SOURCE (drag rows)">
        <ul ref={listRef} className="max-w-xs space-y-1">
          {items.map((item) => {
            const dragging = drag?.active && drag.id === item;
            const edge = drag?.active && drag.target?.id === item ? drag.target.edge : null;
            return (
              <li
                key={item}
                data-reorder-id={item}
                {...pressProps(item)}
                className={`relative flex cursor-grab items-center gap-2 rounded-md border border-divider bg-surface-1 px-3 py-2 text-body select-none ${dragging ? DRAG_SOURCE : ''}`}
              >
                {edge && <DropLine edge={edge} />}
                <DotsSixVertical className="text-pn-muted" aria-hidden="true" />
                <span>{item}</span>
              </li>
            );
          })}
        </ul>
      </DemoBlock>
      <DemoBlock title="DROP_INSIDE highlight token (folder drop target)">
        <div className={`max-w-xs flex items-center gap-2 rounded-md px-3 py-2 text-body ${DROP_INSIDE}`}>
          <Folder className="text-accent" aria-hidden="true" />
          <span>Work folder (drop target)</span>
        </div>
      </DemoBlock>
    </div>
  );
}

function KbdDividerDemo() {
  return (
    <div className="space-y-4">
      <p className="text-body text-pn-soft">
        Press <Kbd>Esc</Kbd> to close, <Kbd>⌘</Kbd><Kbd>K</Kbd> to jump, or <Kbd>Q</Kbd> for quick add.
      </p>
      <Divider />
      <div className="inline-flex items-center gap-2 rounded-md border border-divider bg-surface-1 px-2 py-1">
        <Button action="copy" />
        <Divider vertical />
        <Button action="edit" />
      </div>
    </div>
  );
}

function HoverOverflowDemo() {
  return (
    <div className="space-y-4">
      <DemoBlock title="HoverLabel (with shortcut keys, count, and Pro mark)">
        <div className="flex flex-wrap gap-3">
          <HoverLabel label="Quick switcher" keys="Mod+K"><span className={SETTINGS_BTN}>With keys</span></HoverLabel>
          <HoverLabel label="Vault logins" count={14}><span className={SETTINGS_BTN}>With count</span></HoverLabel>
          <HoverLabel label="Smart connections" pro><span className={SETTINGS_BTN}>With Pro mark</span></HoverLabel>
        </div>
      </DemoBlock>
      <DemoBlock title="OverflowTip (hover the truncated label)">
        <div className="w-48 rounded-md border border-divider bg-surface-1 px-3 py-1.5">
          <OverflowTip text="A very long folder name that truncates and shows its full text on hover">
            <span className="block truncate text-body">A very long folder name that truncates and shows its full text on hover</span>
          </OverflowTip>
        </div>
      </DemoBlock>
    </div>
  );
}

function FeaturePitchDemo() {
  const [tone, setTone] = useState<'info' | 'amber'>('info');
  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <Button variant={tone === 'info' ? 'primary' : 'secondary'} icon={<Info aria-hidden="true" />} onClick={() => setTone('info')}>tone="info"</Button>
        <Button variant={tone === 'amber' ? 'primary' : 'secondary'} icon={<Folder aria-hidden="true" />} onClick={() => setTone('amber')}>tone="amber"</Button>
      </div>
      <div className="max-w-md">
        <FeaturePitch
          banner={{ tone, icon: <Sparkle />, title: 'Example feature', sub: 'One line on what it does', badge: <PitchBadge>Free</PitchBadge> }}
          intro="One centered sentence explaining how this feature works."
          chips={[{ icon: <Scissors />, label: 'Chip one' }, { icon: <Globe />, label: 'Chip two' }, { icon: <Clock />, label: 'Chip three' }]}
          uses={[{ icon: <Article />, label: 'First use case' }, { icon: <Bell />, label: 'Second use case' }, { icon: <Folder />, label: 'Third use case' }]}
          facts={[
            { icon: <CheckCircle className="text-success" />, title: 'Private on device', sub: 'Never leaves your machine' },
            { icon: <Warning className="text-danger" />, title: 'Clear limit', sub: 'Stated plainly up front' },
          ]}
          tagline={{ icon: <Sparkle />, label: 'Ready when you are' }}
          actions={<Button action="open" variant="primary">Get started</Button>}
        />
      </div>
    </div>
  );
}

function TerminalBlockDemo() {
  return (
    <div className="max-w-lg space-y-2">
      <TerminalBlock value='echo "# Hello" | privacynotes save' prompt copyLabel="Copy" />
      <TerminalBlock value='"privacynotes": { "command": "privacynotes", "args": ["mcp"] }' copyLabel="Copy" />
    </div>
  );
}

function PickerModalDemo() {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const match = textMatcher(q);
  const folders = ['Projects', 'Personal', 'Travel', 'Archive'].filter((f) => !q.trim() || match(f) !== null);
  return (
    <div>
      <Button action="open" onClick={() => setOpen(true)}>Open PickerModal</Button>
      {open && (
        <PickerModal
          title="Move to folder"
          icon={<Folder />}
          onClose={() => setOpen(false)}
          search={{ value: q, onChange: setQ, placeholder: 'Search folders...' }}
        >
          {folders.map((f) => (
            <button key={f} type="button" onClick={() => setOpen(false)} className="w-full flex items-center gap-2 rounded-md px-3 py-2 text-body text-start hover:bg-pn/5 transition">
              <Folder className="shrink-0 text-accent" aria-hidden="true" />
              <span>{f}</span>
            </button>
          ))}
        </PickerModal>
      )}
    </div>
  );
}

function ProgressModalDemo() {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <Button action="open" onClick={() => setOpen(true)}>Open ProgressModal</Button>
      {open && (
        <ProgressModal
          title="Exporting backup"
          onClose={() => setOpen(false)}
          footer={<Button action="cancel" onClick={() => setOpen(false)} />}
        >
          <StatusLine busy>Encrypting notes (24 of 40)...</StatusLine>
          <ProgressBar label="Exporting backup" value={0.6} />
        </ProgressModal>
      )}
    </div>
  );
}

function PluginSheetDemo() {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <Button action="open" onClick={() => setOpen(true)}>Open PluginSheet</Button>
      {open && (
        <PluginSheet
          title="Text from image"
          icon={<Sparkle />}
          onClose={() => setOpen(false)}
          footer={
            <>
              <Button action="cancel" onClick={() => setOpen(false)} />
              <Button action="copy" variant="primary" onClick={() => setOpen(false)} />
            </>
          }
        >
          <StatusLine tone="success">Extracted 3 paragraphs on device.</StatusLine>
        </PluginSheet>
      )}
    </div>
  );
}

function GateCardDemo() {
  return (
    <GateCard
      framed
      icon={<Lock />}
      title="Protected note"
      subtitle="Enter your PIN to view this note."
      footer={<Button action="cancel" className="w-full justify-center" />}
    >
      <Button action="open" variant="primary" className="w-full justify-center">Unlock</Button>
    </GateCard>
  );
}

function SuggestionPopupDemo() {
  const [active, setActive] = useState(0);
  const items = [
    { label: 'Heading 1', hint: 'Large section heading', shortcut: '# ' },
    { label: 'Task list', hint: 'Checkable to-do items', shortcut: '[] ' },
    { label: 'Callout', hint: 'Highlighted note box', shortcut: '> ' },
  ];
  return (
    <div className="max-w-xs">
      <SuggestionPopup>
        {items.map((it, i) => (
          <SuggestionItem
            key={it.label}
            active={active === i}
            icon={<Article />}
            label={it.label}
            hint={it.hint}
            shortcut={it.shortcut}
            onMouseEnter={() => setActive(i)}
            onSelect={() => setActive(i)}
          />
        ))}
      </SuggestionPopup>
    </div>
  );
}

function CanvasControlBarDemo() {
  const [q, setQ] = useState('');
  void q;
  return (
    <div className="flex flex-wrap items-center gap-4">
      <CanvasControlBar>
        <IconButton label="Zoom in"><Sparkle aria-hidden="true" /></IconButton>
        <IconButton label="Fit view"><Globe aria-hidden="true" /></IconButton>
        <CanvasControlDivider />
        <IconButton label="Center on my spot"><MapPin aria-hidden="true" /></IconButton>
      </CanvasControlBar>
      <CanvasControlBar orientation="vertical">
        <IconButton label="Zoom in"><Sparkle aria-hidden="true" /></IconButton>
        <CanvasControlDivider orientation="vertical" />
        <IconButton label="Locate"><MapPin aria-hidden="true" /></IconButton>
      </CanvasControlBar>
    </div>
  );
}

function ListPaneHeaderDemo() {
  const [q, setQ] = useState('');
  return (
    <div className="max-w-sm overflow-hidden rounded-lg border border-divider bg-surface-1">
      <ListPaneHeader
        leading={<span className="text-title font-semibold">Notes</span>}
        trailing={<IconButton label="Options"><SlidersHorizontal aria-hidden="true" /></IconButton>}
      />
      <ListSearchRow>
        <ListSearchInput value={q} onChange={setQ} placeholder="Search notes..." />
      </ListSearchRow>
    </div>
  );
}

function SelectionCountStripDemo() {
  const [selected, setSelected] = useState(2);
  const total = 12;
  return (
    <div className="max-w-sm space-y-3">
      <div className="overflow-hidden rounded-lg border border-divider bg-surface-1">
        <SelectionCountStrip
          selectedCount={selected}
          totalCount={total}
          onSelectAll={() => setSelected(total)}
          onDeselectAll={() => setSelected(0)}
        />
      </div>
      <div className="flex items-center gap-2">
        <Button icon={<CheckFat aria-hidden="true" />} onClick={() => setSelected(2)}>Select 2 of 12</Button>
        <Button icon={<CheckCircle aria-hidden="true" />} onClick={() => setSelected(total)}>Select all 12</Button>
      </div>
    </div>
  );
}
