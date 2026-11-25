import { useState } from 'react';
import {
  AccentBar,
  Button,
  Checkbox,
  CloseButton,
  CompareTiles,
  CopyButton,
  DashedAddButton,
  DeleteButton,
  DeviceOnlyTip,
  Disclosure,
  EditRow,
  EYEBROW_ICON_ROW,
  EyebrowGlyph,
  FIELD_BUTTON,
  FIELD_CLASS,
  FieldLabel,
  GroupHeading,
  HeadlineRule,
  HelpChip,
  HelpTip,
  HotkeyField,
  HoverLabel,
  IconButton,
  IconUpgrade,
  InlineRenameField,
  ListSearchInput,
  PhraseInput,
  PinProtectToggle,
  ProMark,
  ProTeaserCard,
  RangeSlider,
  ResetDefaultsButton,
  ROW_TITLE,
  RowTitle,
  SectionEyebrow,
  Select,
  SETTINGS_BTN,
  SETTINGS_BTN_DANGER,
  SETTINGS_BTN_PRIMARY,
  SETTINGS_BTN_UPGRADE,
  SETTINGS_CARD,
  SETTINGS_CARD_GRID,
  SETTINGS_CARD_ON,
  SETTINGS_CARD_REST,
  SETTINGS_EYEBROW,
  SETTINGS_GROUP,
  SETTINGS_HELP,
  SETTINGS_ROW,
  SETTINGS_SELECT,
  SETTINGS_TRACK,
  SettingsCardIcon,
  SettingsSegmented,
  SettingsTabStrip,
  settingsChipClass,
  settingsSegClass,
  settingsTabClass,
  Step,
  Switch,
  TextField,
  ThemeSwatchCard,
  useProGate,
  VaultFieldAction,
  VaultFormActions,
} from '../index';
import { ACTIONS, type ActionName } from '../actions';
import { TimeInput } from '../../TimeInput';
import { PinInput } from '../../PinInput';
import { PasscodeInput } from '../../PasscodeInput';
import {
  Copy,
  Gear,
  Globe,
  MagnifyingGlass,
  PencilSimple,
  SignOut,
  Sparkle,
  Stethoscope,
  Trash,
  User,
  Warning,
} from '../../icons';
import type { KeyBinding } from '../../commandKeys';

const ALL_ACTIONS = Object.keys(ACTIONS) as ActionName[];

export function DemoBlock({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <p className="text-meta font-semibold uppercase tracking-wide text-pn-muted">{title}</p>
      {children}
    </div>
  );
}

export function renderActionOrInputDemo(id: string): React.ReactNode | null {
  switch (id) {
    case 'button': return <ButtonDemo />;
    case 'icon-button': return <IconButtonDemo />;
    case 'close-button': return <CloseButtonDemo />;
    case 'delete-button': return <DeleteButtonDemo />;
    case 'edit-row': return <EditRowDemo />;
    case 'copy-button': return <CopyButtonDemo />;
    case 'vault-actions': return <VaultActionsDemo />;
    case 'use-pro-gate': return <ProGateDemo />;
    case 'class-strings': return <ClassStringsDemo />;
    case 'text-field-select': return <TextFieldSelectDemo />;
    case 'hotkey-field': return <HotkeyFieldDemo />;
    case 'switch': return <SwitchDemo />;
    case 'checkbox': return <CheckboxDemo />;
    case 'segmented': return <SegmentedDemo />;
    case 'compare-tiles': return <CompareTilesDemo />;
    case 'list-search-inline-rename': return <SearchRenameDemo />;
    case 'setting-row-heading': return <SettingRowHeadingDemo />;
    case 'settings-tabs-cards': return <SettingsTabsCardsDemo />;
    case 'reset-help-callout': return <ResetHelpCalloutDemo />;
    case 'form-kit': return <FormKitDemo />;
    case 'time-input': return <TimeInputDemo />;
    case 'pin-passcode-input': return <PinPasscodeDemo />;
    case 'dashed-add-button': return <DashedAddDemo />;
    case 'pin-protect-toggle': return <PinProtectDemo />;
    case 'pro-teaser-card': return <ProTeaserDemo />;
    case 'disclosure': return <DisclosureDemo />;
    case 'step': return <StepDemo />;
    case 'theme-swatch-card': return <ThemeSwatchDemo />;
    case 'phrase-input': return <PhraseInputDemo />;
    case 'range-slider': return <RangeSliderDemo />;
    default: return null;
  }
}

function ButtonDemo() {
  const [log, setLog] = useState('Click any button to test.');
  return (
    <div className="space-y-5">
      <DemoBlock title={`All ${ALL_ACTIONS.length} canonical actions (ui/actions.ts)`}>
        <div className="flex flex-wrap gap-2">
          {ALL_ACTIONS.map((a) => (
            <Button key={a} action={a} onClick={() => setLog(`Triggered action="${a}"`)}>
              {ACTIONS[a].label ? undefined : a[0]!.toUpperCase() + a.slice(1)}
            </Button>
          ))}
        </div>
      </DemoBlock>
      <DemoBlock title="All 4 app variants (+ extension Saved), pro mark, iconEnd, and disabled">
        <div className="flex flex-wrap items-center gap-2">
          <Button action="save" variant="primary" onClick={() => setLog('primary')}>Primary</Button>
          <Button action="edit" variant="secondary" onClick={() => setLog('secondary')}>Secondary</Button>
          <Button action="delete" variant="danger" onClick={() => setLog('danger')}>Danger</Button>
          <Button variant="upgrade" icon={<IconUpgrade size={15} />} onClick={() => setLog('upgrade')}>Upgrade to Pro</Button>
          <Button action="done" variant="successSoft" onClick={() => setLog('successSoft')}>Saved</Button>
          <Button pro icon={<Stethoscope aria-hidden="true" />} onClick={() => setLog('pro button')}>Doctor report</Button>
          <Button action="done" iconEnd onClick={() => setLog('iconEnd')}>Continue</Button>
          <Button action="save" disabled />
        </div>
      </DemoBlock>
      <p className={SETTINGS_HELP} role="status">{log}</p>
    </div>
  );
}

function IconButtonDemo() {
  const [log, setLog] = useState('Hover to inspect tooltips and shortcut keycaps.');
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <IconButton label="Edit" onClick={() => setLog('Quiet edit')}><PencilSimple aria-hidden="true" /></IconButton>
        <IconButton label="Remove" tone="danger" onClick={() => setLog('Danger remove')}><Trash aria-hidden="true" /></IconButton>
        <IconButton label="Search" tone="accent" keys="Mod+K" onClick={() => setLog('Accent search')}><MagnifyingGlass aria-hidden="true" /></IconButton>
        <IconButton label="Settings" keys="Mod+," onClick={() => setLog('Settings')}><Gear aria-hidden="true" /></IconButton>
        <IconButton label="Unavailable" disabled><Gear aria-hidden="true" /></IconButton>
      </div>
      <p className={SETTINGS_HELP} role="status">{log}</p>
    </div>
  );
}

function CloseButtonDemo() {
  const [clicks, setClicks] = useState(0);
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2 rounded-md border border-divider bg-surface-1 px-3 py-2">
          <span className="text-body font-medium">Active surface header</span>
          <CloseButton onClick={() => setClicks((c) => c + 1)} />
        </div>
        <div className="flex items-center gap-2 rounded-md border border-divider bg-surface-1 px-3 py-2">
          <span className="text-body text-pn-muted">Disabled</span>
          <CloseButton disabled onClick={() => {}} />
        </div>
      </div>
      <p className={SETTINGS_HELP} role="status">Close clicks: {clicks}</p>
    </div>
  );
}

function DeleteButtonDemo() {
  const [log, setLog] = useState('Click trash once to arm for 6s; Escape disarms.');
  return (
    <div className="space-y-3">
      <div className="flex max-w-md items-center gap-2 rounded-md border border-divider bg-surface-1 py-1.5 pe-1.5 ps-3">
        <span className="min-w-0 flex-1 truncate text-body font-medium">Multivitamin</span>
        <IconButton label="Edit"><PencilSimple aria-hidden="true" /></IconButton>
        <DeleteButton kind="remove" label="Remove Multivitamin" onConfirm={() => setLog('Confirmed Remove')} />
      </div>
      <div className="flex max-w-md items-center gap-2 rounded-xl border border-divider bg-surface-1 py-2 pe-3 ps-3">
        <span className="min-w-0 flex-1 truncate text-body">quarterly-report.pdf</span>
        <DeleteButton label="Delete quarterly-report.pdf" onConfirm={() => setLog('Confirmed Delete')} />
      </div>
      <div className="flex max-w-md items-center gap-2 rounded-md border border-divider bg-surface-1 py-1.5 pe-1.5 ps-3">
        <span className="min-w-0 flex-1 truncate text-body">Firefox Extension (custom icon)</span>
        <DeleteButton label="Disconnect browser" confirmLabel="Disconnect?" icon={SignOut} onConfirm={() => setLog('Confirmed Disconnect')} />
      </div>
      <p className={SETTINGS_HELP} role="status">{log}</p>
    </div>
  );
}

function EditRowDemo() {
  const [editing, setEditing] = useState(false);
  const [canSave, setCanSave] = useState(true);
  const [log, setLog] = useState('Open the inline form to test Escape-to-cancel.');
  return (
    <div className="space-y-3">
      <Switch label="Valid draft (canSave)" checked={canSave} onChange={setCanSave} />
      {editing ? (
        <div className="space-y-3 rounded-md border border-divider bg-surface-1 p-3">
          <div className="grid gap-2 sm:grid-cols-2">
            <TextField label="Question" defaultValue="Did you stretch today?" />
            <TextField label="Short name" defaultValue="Stretch" />
          </div>
          <EditRow
            canSave={canSave}
            onCancel={() => { setEditing(false); setLog('Canceled inline edit.'); }}
            onSave={() => { setEditing(false); setLog('Saved inline edit.'); }}
          />
        </div>
      ) : (
        <Button action="edit" onClick={() => setEditing(true)}>Open inline edit form</Button>
      )}
      <p className={SETTINGS_HELP} role="status">{log}</p>
    </div>
  );
}

function CopyButtonDemo() {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <div className="flex items-center gap-2 rounded-md border border-divider bg-surface-1 px-3 py-1.5">
        <code className="font-mono text-small">otpauth://totp/PrivacyNotes</code>
        <CopyButton value="otpauth://totp/PrivacyNotes" label="Copy setup URI" />
      </div>
      <p className={SETTINGS_HELP}>Click to see the 2-second green check transition.</p>
    </div>
  );
}

function VaultActionsDemo() {
  const [isNew, setIsNew] = useState(false);
  const [locked, setLocked] = useState(false);
  const [error, setError] = useState(false);
  const [log, setLog] = useState('Toggle switches to inspect every VaultFormActions state.');
  return (
    <div className="space-y-5">
      <DemoBlock title="VaultFormActions">
        <div className="flex flex-wrap gap-4">
          <Switch label="New item" checked={isNew} onChange={setIsNew} />
          <Switch label="Locked (read-only)" checked={locked} onChange={setLocked} />
          <Switch label="Save error" checked={error} onChange={setError} />
        </div>
        <div className="pt-2">
          <VaultFormActions
            isNew={isNew}
            locked={locked}
            saveError={error ? 'Fill in at least one field before saving.' : undefined}
            onSave={() => setLog('Vault Save clicked.')}
            onCancel={() => setLog('Vault Cancel clicked.')}
          />
        </div>
      </DemoBlock>
      <DemoBlock title="VaultFieldAction (all 5 states)">
        <div className="flex flex-wrap items-center gap-4">
          <div><p className={SETTINGS_HELP}>Copy</p><VaultFieldAction kind="copy" title="Copy" onClick={() => setLog('Copy')} /></div>
          <div><p className={SETTINGS_HELP}>Copied</p><VaultFieldAction kind="copy" active title="Copied" onClick={() => setLog('Copied')} /></div>
          <div><p className={SETTINGS_HELP}>Hidden</p><VaultFieldAction kind="reveal" title="Show" onClick={() => setLog('Show')} /></div>
          <div><p className={SETTINGS_HELP}>Revealed</p><VaultFieldAction kind="reveal" active title="Hide" onClick={() => setLog('Hide')} /></div>
          <div><p className={SETTINGS_HELP}>Download</p><VaultFieldAction kind="download" title="Download" onClick={() => setLog('Download')} /></div>
        </div>
      </DemoBlock>
      <p className={SETTINGS_HELP} role="status">{log}</p>
    </div>
  );
}

function ProGateDemo() {
  const [free, setFree] = useState(true);
  const [log, setLog] = useState('Click the Pro button in Free vs Pro mode.');
  const guard = useProGate(!free, () => setLog('Free account: opened UpgradeModal.'));
  return (
    <div className="space-y-3">
      <Switch label="Simulate free account" checked={free} onChange={setFree} />
      <div className="flex flex-wrap items-center gap-3">
        <Button pro={free} icon={<Sparkle aria-hidden="true" />} onClick={guard(() => setLog('Pro account: ran protected action.'))}>
          Export doctor report
        </Button>
      </div>
      <p className={SETTINGS_HELP} role="status">{log}</p>
    </div>
  );
}

function ClassStringsDemo() {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <a href="#ui-catalog" className={SETTINGS_BTN}>SETTINGS_BTN</a>
        <a href="#ui-catalog" className={SETTINGS_BTN_PRIMARY}>SETTINGS_BTN_PRIMARY</a>
        <a href="#ui-catalog" className={SETTINGS_BTN_DANGER}>SETTINGS_BTN_DANGER</a>
        <a href="#ui-catalog" className={SETTINGS_BTN_UPGRADE}><IconUpgrade size={12} /> SETTINGS_BTN_UPGRADE</a>
        <span className={SETTINGS_SELECT}>SETTINGS_SELECT</span>
      </div>
      <p className={ROW_TITLE}>ROW_TITLE on a plain element</p>
      <p className={`${SETTINGS_EYEBROW} ${EYEBROW_ICON_ROW}`}><EyebrowGlyph icon={Sparkle} />SETTINGS_EYEBROW + EyebrowGlyph</p>
    </div>
  );
}

function TextFieldSelectDemo() {
  const [val, setVal] = useState('Short title');
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <TextField label="Web address" icon={<Globe />} placeholder="https://" hint="Helper line under field." />
      <TextField label="With error" icon={<User />} defaultValue="A value that exceeds the limit" error="Must be 20 characters or fewer." />
      <TextField
        label="Live validation"
        value={val}
        onChange={(e) => setVal(e.target.value)}
        hint="Type > 14 chars to trigger error."
        error={val.length > 14 ? `${val.length} / 14 characters` : undefined}
      />
      <TextField size="sm" label="Small (settings row)" placeholder="size='sm'" />
      <TextField label="Disabled" value="Unavailable" disabled />
      <TextField label="Read-only" value="Selectable, not editable" readOnly />
      <div className="space-y-1">
        <FieldLabel>Select (md)</FieldLabel>
        <Select aria-label="Range md" defaultValue="30" className="w-full">
          <option value="7">7 days</option>
          <option value="30">30 days</option>
          <option value="90">90 days</option>
        </Select>
      </div>
      <div className="space-y-1">
        <FieldLabel>Select (sm + disabled)</FieldLabel>
        <div className="flex gap-2">
          <Select size="sm" aria-label="Range sm" defaultValue="30">
            <option value="7">7 days</option>
            <option value="30">30 days</option>
          </Select>
          <Select size="sm" aria-label="Disabled select" disabled defaultValue="30">
            <option value="30">Disabled</option>
          </Select>
        </div>
      </div>
    </div>
  );
}

function HotkeyFieldDemo() {
  const [macKey, setMacKey] = useState<KeyBinding | null>({ mod: true, shift: true, key: 'k' });
  const [winKey, setWinKey] = useState<KeyBinding | null>({ ctrl: true, alt: true, key: 'n' });
  const [note, setNote] = useState('Click either field and press a key combination (Escape blurs).');
  const readKey = (e: KeyboardEvent): KeyBinding | null => {
    if (!e.metaKey && !e.ctrlKey && !e.altKey) return null;
    return { mod: e.metaKey || e.ctrlKey, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, key: e.key.toLowerCase() };
  };
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-4">
        <div className="space-y-1">
          <p className={SETTINGS_HELP}>macOS caps</p>
          <HotkeyField label="macOS shortcut" os="mac" value={macKey} read={readKey} onChange={setMacKey} onInvalid={() => setNote('Hold at least one modifier key.')} />
        </div>
        <div className="space-y-1">
          <p className={SETTINGS_HELP}>Windows / Linux caps</p>
          <HotkeyField label="Windows shortcut" os="pc" value={winKey} read={readKey} onChange={setWinKey} onInvalid={() => setNote('Hold at least one modifier key.')} />
        </div>
      </div>
      <p className={SETTINGS_HELP} role="status">{note}</p>
    </div>
  );
}

function SwitchDemo() {
  const [a, setA] = useState(true);
  const [b, setB] = useState(false);
  return (
    <div className="divide-y divide-divider rounded-lg border border-divider bg-surface-1 px-4">
      <Switch
        label="Daily check-in card"
        icon={<Sparkle className="text-accent" />}
        labelClassName={ROW_TITLE}
        hint={<DeviceOnlyTip />}
        description="Shows at the top of Journals until you log today."
        checked={a}
        onChange={setA}
        className="py-3"
      />
      <Switch
        label="Compact rows"
        icon={<Gear className="text-accent" />}
        labelClassName={ROW_TITLE}
        description="Tighter spacing in the notes list."
        checked={b}
        onChange={setB}
        className="py-3"
      />
      <Switch label="Disabled (off)" checked={false} onChange={() => {}} disabled className="py-3" />
      <Switch label="Disabled (on)" checked onChange={() => {}} disabled className="py-3" />
    </div>
  );
}

function CheckboxDemo() {
  const [sub, setSub] = useState(true);
  const [card, setCard] = useState(false);
  return (
    <div className="space-y-3">
      <Checkbox label="Also delete its subfolders" checked={sub} onChange={(e) => setSub(e.target.checked)} />
      <Checkbox
        label="I wrote my recovery phrase down"
        description="Nobody can recover a lost phrase."
        card
        checked={card}
        onChange={(e) => setCard(e.target.checked)}
      />
      <Checkbox label="Require PIN to view (disabled)" disabled />
    </div>
  );
}

function SegmentedDemo() {
  const [layer, setLayer] = useState<'both' | 'writing' | 'mood'>('both');
  const [clock, setClock] = useState<'auto' | '24' | '12'>('auto');
  return (
    <div className="space-y-4">
      <DemoBlock title="SettingsSegmented (toolbar / chart header)">
        <SettingsSegmented
          label="Layer"
          value={layer}
          onChange={setLayer}
          options={[
            { value: 'both', label: 'Both' },
            { value: 'writing', label: 'Writing' },
            { value: 'mood', label: 'Mood' },
          ]}
        />
      </DemoBlock>
      <DemoBlock title="SETTINGS_TRACK + settingsSegClass (setting row)">
        <div className={SETTINGS_TRACK}>
          {(['auto', '24', '12'] as const).map((v) => (
            <button key={v} type="button" aria-pressed={clock === v} onClick={() => setClock(v)} className={settingsSegClass(clock === v)}>
              {v === 'auto' ? 'Automatic' : v === '24' ? '24-hour' : '12-hour'}
            </button>
          ))}
        </div>
      </DemoBlock>
    </div>
  );
}

function CompareTilesDemo() {
  const [kind, setKind] = useState<'pin' | 'passcode'>('pin');
  const [words, setWords] = useState<'12' | '24'>('24');
  return (
    <div className="space-y-5">
      <CompareTiles
        label="Kind of secret"
        value={kind}
        onChange={setKind}
        tiles={[
          {
            value: 'pin',
            title: '4-digit PIN',
            badge: { label: 'Default' },
            rows: [
              { label: 'Typing it', mark: 'yes', text: 'Four digits, fast on any keypad.' },
              { label: 'Device threat', mark: 'no', text: 'All 10,000 PINs can be tried.' },
            ],
          },
          {
            value: 'passcode',
            title: 'Passcode',
            badge: { label: 'Stronger', tone: 'success' },
            rows: [
              { label: 'Typing it', mark: 'meh', text: 'At least 8 characters, slower on a phone.' },
              { label: 'Device threat', mark: 'yes', text: 'Too large to guess; subgrid keeps rows aligned even when copy wraps.' },
            ],
          },
        ]}
      />
      <CompareTiles
        label="Phrase length (with staged footer)"
        value={words}
        onChange={setWords}
        tiles={[
          { value: '12', title: '12 words', badge: { label: 'Default' }, rows: [{ label: 'Security', mark: 'yes', text: '128-bit entropy.' }] },
          { value: '24', title: '24 words', badge: { label: 'Extra margin', tone: 'success' }, rows: [{ label: 'Security', mark: 'yes', text: '256-bit entropy; generates a new phrase.' }] },
        ]}
        footer={{ note: 'Changing phrase length generates a new recovery phrase.', button: <Button variant="primary" icon={<Sparkle aria-hidden="true" />}>Switch to {words} words</Button> }}
      />
    </div>
  );
}

function SearchRenameDemo() {
  const [q, setQ] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState('Quarterly report.pdf');
  return (
    <div className="space-y-4">
      <DemoBlock title="ListSearchInput">
        <div className="max-w-xs">
          <ListSearchInput value={q} onChange={setQ} placeholder="Search notes..." />
        </div>
      </DemoBlock>
      <DemoBlock title="InlineRenameField">
        {renaming ? (
          <InlineRenameField
            value={name}
            onValueChange={setName}
            onCommit={() => setRenaming(false)}
            onCancel={() => setRenaming(false)}
            aria-label="File name"
            className={FIELD_CLASS}
          />
        ) : (
          <Button action="rename" onClick={() => setRenaming(true)}>{name}</Button>
        )}
      </DemoBlock>
    </div>
  );
}

function SettingRowHeadingDemo() {
  const [mode, setMode] = useState<'a' | 'b'>('a');
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2.5">
        <AccentBar />
        <h3 className="text-heading font-semibold">Pane Title</h3>
        <HeadlineRule />
      </div>
      <div className="flex flex-wrap items-center gap-6">
        <SectionEyebrow icon={Sparkle}>Section heading <ProMark /></SectionEyebrow>
        <SectionEyebrow icon={Warning} danger>Danger zone</SectionEyebrow>
      </div>
      <div className="divide-y divide-divider rounded-lg border border-divider bg-surface-1 px-4">
        <div className={SETTINGS_ROW}>
          <div className="min-w-0">
            <RowTitle
              icon={Gear}
              hint={<><HelpTip text="Explains what this setting controls." /><DeviceOnlyTip /><DeviceOnlyTip phone /></>}
            >
              Setting row with tips
            </RowTitle>
            <p className={SETTINGS_HELP}>Helper line in SETTINGS_HELP explaining the behavior.</p>
          </div>
          <div className={SETTINGS_TRACK}>
            <button type="button" aria-pressed={mode === 'a'} onClick={() => setMode('a')} className={settingsSegClass(mode === 'a')}>Auto</button>
            <button type="button" aria-pressed={mode === 'b'} onClick={() => setMode('b')} className={settingsSegClass(mode === 'b')}>Manual</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function SettingsTabsCardsDemo() {
  const [tab, setTab] = useState(0);
  const [activeCard, setActiveCard] = useState('obsidian');
  const [chip, setChip] = useState('sleep');
  return (
    <div className="space-y-5">
      <DemoBlock title="SettingsTabStrip">
        <SettingsTabStrip>
          {['General', 'Lists', 'Custom', 'Advanced'].map((label, i) => (
            <button key={label} type="button" aria-pressed={tab === i} onClick={() => setTab(i)} className={settingsTabClass(tab === i)}>
              <Gear aria-hidden="true" />
              <span>{label}</span>
            </button>
          ))}
        </SettingsTabStrip>
      </DemoBlock>
      <DemoBlock title="SETTINGS_CARD_GRID + SettingsCardIcon">
        <div className={SETTINGS_CARD_GRID}>
          {[
            { id: 'obsidian', name: 'Obsidian', sub: 'Markdown vault' },
            { id: 'notion', name: 'Notion', sub: 'ZIP export' },
            { id: 'keep', name: 'Google Keep', sub: 'Takeout JSON' },
          ].map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => setActiveCard(c.id)}
              className={`${SETTINGS_CARD} ${activeCard === c.id ? SETTINGS_CARD_ON : SETTINGS_CARD_REST}`}
            >
              <SettingsCardIcon glyph={<Globe />} />
              <span className="min-w-0">
                <span className="block truncate text-body font-medium">{c.name}</span>
                <span className="block truncate text-meta text-pn-muted">{c.sub}</span>
              </span>
            </button>
          ))}
        </div>
      </DemoBlock>
      <DemoBlock title="SETTINGS_GROUP & settingsChipClass">
        <div className={SETTINGS_GROUP}>
          <div className="px-3 py-2 text-body">First grouped row</div>
          <div className="px-3 py-2 text-body">Second grouped row</div>
        </div>
        <div className="flex flex-wrap gap-1.5 pt-2">
          {['sleep', 'energy', 'water', 'focus'].map((k) => (
            <button key={k} type="button" aria-pressed={chip === k} onClick={() => setChip(k)} className={settingsChipClass(chip === k)}>
              {k[0]!.toUpperCase() + k.slice(1)}
            </button>
          ))}
        </div>
      </DemoBlock>
    </div>
  );
}

function ResetHelpCalloutDemo() {
  const [log, setLog] = useState('Click Reset to defaults once to arm for 6 seconds.');
  return (
    <div className="space-y-4">
      <ResetDefaultsButton onReset={() => setLog('Reset confirmed.')} className="pt-0" />
      <p className={SETTINGS_HELP} role="status">{log}</p>
      <HelpChip surface="images" />
    </div>
  );
}

function FormKitDemo() {
  return (
    <div className="max-w-md space-y-3">
      <GroupHeading>Login details</GroupHeading>
      <div>
        <FieldLabel icon={<User />}>Username</FieldLabel>
        <div className="flex gap-1.5">
          <input className={FIELD_CLASS} defaultValue="alex@example.com" aria-label="Username" />
          <button type="button" className={FIELD_BUTTON} aria-label="Copy"><Copy aria-hidden="true" /></button>
        </div>
      </div>
      <div>
        <FieldLabel>Notes (textarea with FIELD_CLASS)</FieldLabel>
        <textarea className={`${FIELD_CLASS} min-h-20 resize-y`} defaultValue="Recovery codes stored in vault." aria-label="Notes" />
      </div>
    </div>
  );
}

function TimeInputDemo() {
  const [time, setTime] = useState<string | undefined>('15:00');
  return (
    <div className="max-w-xs space-y-2">
      <TimeInput label="Reminder time" value={time} onCommit={(v) => setTime(v ?? undefined)} className={FIELD_CLASS} clearable />
      <p className={SETTINGS_HELP}>Committed HH:MM: <strong>{time ?? 'None'}</strong>. Desktop accepts "3pm" or "15:30"; touch uses native picker.</p>
    </div>
  );
}

function PinPasscodeDemo() {
  const [pin, setPin] = useState('12');
  const [totp, setTotp] = useState('482913');
  const [pass, setPass] = useState('correct horse');
  return (
    <div className="space-y-5">
      <DemoBlock title="PinInput (4-digit masked, compact, and 6-digit revealed TOTP)">
        <div className="flex flex-wrap items-center gap-6">
          <div className="space-y-1">
            <p className={SETTINGS_HELP}>4-digit masked</p>
            <PinInput value={pin} onChange={setPin} ariaLabel="Example 4-digit PIN" />
          </div>
          <div className="space-y-1">
            <p className={SETTINGS_HELP}>4-digit compact</p>
            <PinInput value={pin} onChange={setPin} compact ariaLabel="Example compact PIN" />
          </div>
          <div className="space-y-1">
            <p className={SETTINGS_HELP}>6-digit TOTP (reveal)</p>
            <PinInput value={totp} onChange={setTotp} length={6} reveal compact ariaLabel="Example TOTP code" />
          </div>
        </div>
      </DemoBlock>
      <DemoBlock title="PasscodeInput (masked with show/hide)">
        <div className="max-w-sm">
          <PasscodeInput value={pass} onChange={setPass} compact ariaLabel="Example passcode" />
        </div>
      </DemoBlock>
    </div>
  );
}

function DashedAddDemo() {
  return (
    <div className="max-w-sm space-y-3">
      <DashedAddButton fullWidth>Add tracker</DashedAddButton>
      <DashedAddButton fullWidth pro>Add custom field</DashedAddButton>
      <DashedAddButton disabled>Disabled add</DashedAddButton>
    </div>
  );
}

function PinProtectDemo() {
  const [checkedA, setCheckedA] = useState(true);
  const [checkedB, setCheckedB] = useState(false);
  return (
    <div className="max-w-md space-y-4">
      <DemoBlock title="PIN configured">
        <PinProtectToggle checked={checkedA} pinConfigured onChange={setCheckedA} />
      </DemoBlock>
      <DemoBlock title="No PIN configured yet (shows helper line)">
        <PinProtectToggle checked={checkedB} pinConfigured={false} onChange={setCheckedB} />
      </DemoBlock>
    </div>
  );
}

function ProTeaserDemo() {
  return (
    <div className="max-w-md space-y-4">
      <DemoBlock title="Card mode">
        <ProTeaserCard actionLabel="Upgrade to Pro" onUpgrade={() => {}}>
          Unlock correlation charts, custom trackers, and doctor PDF exports.
        </ProTeaserCard>
      </DemoBlock>
      <DemoBlock title="Compact mode (Statistics tables)">
        <ProTeaserCard compact onUpgrade={() => {}}>
          Upgrade to Pro to see which trackers move your mood
        </ProTeaserCard>
      </DemoBlock>
    </div>
  );
}

function DisclosureDemo() {
  return (
    <div className="max-w-md space-y-3">
      <Disclosure label="Show local version" meta="Today, 09:15" defaultOpen>
        <div className="rounded-md border border-divider bg-surface-1 p-3 text-body">
          Collapsible content with aria-expanded and rotating caret.
        </div>
      </Disclosure>
    </div>
  );
}

function StepDemo() {
  return (
    <ol className="max-w-md rounded-xl border border-divider bg-surface-1 p-4">
      <Step n={1} done title="Choose backup folder" hint="Saved directly on this computer." />
      <Step n={2} done={false} title="Pick backup rhythm" hint="Daily or weekly." />
      <Step n={3} done={false} last title="Run first backup">
        <Button action="save">Back up now</Button>
      </Step>
    </ol>
  );
}

function ThemeSwatchDemo() {
  const [active, setActive] = useState<'paper' | 'forest' | 'nord'>('paper');
  return (
    <div className="grid max-w-md grid-cols-3 gap-2">
      <ThemeSwatchCard name="Warm Paper" colors={['#faf8f5', '#f2ede4', '#2563eb']} active={active === 'paper'} quick onClick={() => setActive('paper')} />
      <ThemeSwatchCard name="Forest" colors={['#141e19', '#1d2b24', '#34d399']} active={active === 'forest'} pro onClick={() => setActive('forest')} />
      <ThemeSwatchCard name="Nord" colors={['#2e3440', '#3b4252', '#88c0d0']} active={active === 'nord'} onClick={() => setActive('nord')} />
    </div>
  );
}

function PhraseInputDemo() {
  const [phrase, setPhrase] = useState(
    'moment fossil useful attend festival twelve scrub include note concert bean notaword ',
  );
  return (
    <div className="max-w-md space-y-4">
      <DemoBlock title='App tone (LockScreen, PinRecoveryForm, PhraseReplacedScreen) - click "Show phrase" to inspect chips'>
        <PhraseInput
          value={phrase}
          onChange={setPhrase}
          placeholder="word1 word2 word3 ..."
        />
      </DemoBlock>
    </div>
  );
}

function RangeSliderDemo() {
  const [spread, setSpread] = useState(110);
  const [length, setLength] = useState(20);
  return (
    <div className="max-w-md space-y-5">
      <DemoBlock title="With label + tabular readout (Graph spread)">
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-small text-pn-soft">
            <span>Spread</span>
            <span className="tabular-nums text-meta text-pn-muted">{spread}</span>
          </div>
          <RangeSlider
            min={40}
            max={180}
            value={spread}
            onChange={(e) => setSpread(Number(e.target.value))}
            aria-label="Spread"
            className="w-full"
          />
        </div>
      </DemoBlock>
      <DemoBlock title="With typed numeric twin (PasswordGenerator)">
        <div className="flex items-center gap-2">
          <span className="w-14 shrink-0 text-small text-pn-muted">Length</span>
          <RangeSlider
            min={8}
            max={64}
            value={length}
            onChange={(e) => setLength(Number(e.target.value))}
            aria-label="Length"
            className="flex-1 min-w-0"
          />
          <span className="w-12 shrink-0 rounded border border-divider bg-surface-0 px-1.5 py-1 text-center text-small tabular-nums">
            {length}
          </span>
        </div>
      </DemoBlock>
    </div>
  );
}
