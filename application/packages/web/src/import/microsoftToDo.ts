import type JSZip from 'jszip';
import i18n from '../i18n';
import { escapeMarkdownText, guardMarkdownLineStart } from '../markdownEscape';
import { withBareLinks } from './bareLinks';
import { mimeFromExt, mimeFromExtOrBytes } from './blobImport';
import { FileKeys, readKeyedFiles } from './fileRefs';
import { cleanPath, escapeTypedTags, indentLines, isJunkEntry, normalizeTagList, str, stripBom } from './importHelpers';
import { linkifyLiteralText } from './linkify';
import { htmlNoteToMarkdown } from './notesnook';
import { isoFromStamp } from './passwordCsv';
import type { ImportedNote, ParsedImport } from './types';
import { ImportTooLargeError, mediaTooLargeWarning, zipEntryText } from './zipEntry';
import { openZip } from './zipOpen';
import { isTime } from '../schedule';
import {
  isValidIsoDay,
  taskReminderMarkdown,
  type TaskRepeat,
} from '../taskReminderSyntax';

const msg = (key: string, options: Record<string, unknown> = {}): string =>
  i18n.t(`importLog:microsoftToDo.${key}`, options);

/**
 * Microsoft To Do importer.
 *
 * Primary input: the `.zip` archive created by the free browser-only
 * PrivacyNotes Microsoft To Do Exporter (`https://todo.privacynotes.app`),
 * holding `microsoft-to-do-export.json` (schemaVersion 1) plus optional
 * files under `attachments/`.
 *
 * Also accepts:
 *   - A bare `microsoft-to-do-export.json` from the same exporter (no attachments).
 *   - Raw Microsoft Graph / `daylamtayari/Microsoft-To-Do-Export` `.json`
 *     (array of task lists or `{ value: [...] }`, camelCase or PascalCase).
 *
 * Format facts were verified against live Microsoft Graph `/v1.0/me/todo/`
 * responses exported in the importer lab (`skills/importer-lab/apps/microsoft-to-do.md`):
 *   - One `type: 'task'` note per non-empty task list.
 *   - Open tasks come first, completed tasks follow as `- [x]`.
 *   - Non-default statuses (`inProgress`, `waitingOnOthers`, `deferred`),
 *     high importance (`[Important]`), UTC local-midnight due dates resolved
 *     back to `exportedTimeZone`, recurrence (`(repeats ...)`), and categories
 *     stay visible on the task line; categories also normalize into `note.tags`.
 *   - Checklist items (`checklistItems`) become indented subtasks (`  - [ ]` / `  - [x]`).
 *   - Task notes (`body`) convert HTML via `htmlNoteToMarkdown` (with `<details>`
 *     converted to Fold callouts and unsafe schemes/tags stripped) and keep plain
 *     text literal via `escapeMarkdownText` + `linkifyLiteralText`.
 *   - Linked resources keep only http(s)/mailto links with escaped labels;
 *     attachments in the ZIP import as blobs via `FileKeys` (`mstodofile:`)
 *     and `readKeyedFiles`, separated by blank lines for TipTap block parsing.
 */

type JsonObj = Record<string, unknown>;

const JSON_SIZE_LIMIT = 64 * 1024 * 1024;
const MAX_FALLBACK_JSON_CANDIDATES = 25;
const SAFE_URL_RE = /^(?:https?:\/\/|mailto:)/i;
const IMAGE_MIME_RE = /^image\//i;
const IMAGE_EXT_RE = /\.(?:png|jpe?g|gif|webp|avif|bmp|svg)$/i;

const isObj = (v: unknown): v is JsonObj => !!v && typeof v === 'object' && !Array.isArray(v);

/** Reads a property from an untrusted JSON object, checking camelCase then alternate spellings. */
function field(obj: JsonObj, camel: string, ...alts: string[]): unknown {
  if (Object.hasOwn(obj, camel)) return obj[camel];
  for (const alt of alts) {
    if (Object.hasOwn(obj, alt)) return obj[alt];
  }
  return undefined;
}

function fieldStr(obj: JsonObj, camel: string, ...alts: string[]): string {
  return str(field(obj, camel, ...alts));
}

function fieldBool(obj: JsonObj, camel: string, ...alts: string[]): boolean {
  return field(obj, camel, ...alts) === true;
}

function fieldArr(obj: JsonObj, camel: string, ...alts: string[]): unknown[] {
  const v = field(obj, camel, ...alts);
  return Array.isArray(v) ? v : [];
}

function isSafeHttpUrl(url: string): boolean {
  return SAFE_URL_RE.test(url.trim());
}

/**
 * Parses a Microsoft Graph ISO timestamp (which often has 7-digit fractional
 * seconds, e.g. `2026-11-24T13:55:59.6955743Z`) and rejects impossible/future dates.
 */
function validEpochMs(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const normalized = trimmed.replace(/(\.\d{3})\d+/, '$1');
  const iso = isoFromStamp(normalized);
  const ms = iso ? Date.parse(iso) : Date.parse(normalized);
  if (Number.isNaN(ms) || ms <= 0) return null;
  const year = new Date(ms).getUTCFullYear();
  if (year < 1970 || ms > Date.now() + 86_400_000) return null;
  return ms;
}

/**
 * Microsoft Graph returns To Do due dates as local midnight shifted into UTC
 * (e.g. Nov 25 00:00 in UTC+8 arrives as `2026-11-24T16:00:00.0000000` UTC).
 * Convert UTC timestamps with non-midnight time back to the exported IANA zone.
 */
function formatGraphDate(dtVal: unknown, targetTimeZone?: string): string {
  if (!isObj(dtVal)) return '';
  const raw = fieldStr(dtVal, 'dateTime', 'DateTime').trim();
  if (!raw) return '';
  const datePart = raw.match(/^(\d{4}-\d{2}-\d{2})/)?.[1];
  if (!datePart) return '';

  const tz = fieldStr(dtVal, 'timeZone', 'TimeZone').trim();
  const isUtc = !tz || tz.toUpperCase() === 'UTC';
  const hasNonMidnight = /T(?!00:00(?::00(?:\.0+)?)?(?:Z|$))/.test(raw);
  if (isUtc && hasNonMidnight && targetTimeZone) {
    const normalized = raw.replace(/(\.\d{3})\d+/, '$1');
    const hasExplicitZone = /Z|[+-]\d{2}:?\d{2}$/i.test(normalized);
    const ms = Date.parse(hasExplicitZone ? normalized : `${normalized}Z`);
    if (!Number.isNaN(ms)) {
      try {
        return new Intl.DateTimeFormat('en-CA', { // date-ok: ISO YYYY-MM-DD in exported IANA timeZone
          timeZone: targetTimeZone,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
        }).format(new Date(ms));
      } catch {
        return datePart;
      }
    }
  }
  return datePart;
}

/**
 * Resolve a Microsoft Graph `reminderDateTime` (UTC clock time) into local
 * `{ day, time }` in `targetTimeZone` (or directly from the raw ISO string
 * when already local / no time zone is provided).
 */
function formatGraphDateTime(dtVal: unknown, targetTimeZone?: string): { day: string; time: string } | null {
  if (!isObj(dtVal)) return null;
  const raw = fieldStr(dtVal, 'dateTime', 'DateTime').trim();
  if (!raw) return null;
  const tz = fieldStr(dtVal, 'timeZone', 'TimeZone').trim();
  const isUtc = !tz || tz.toUpperCase() === 'UTC';
  if (isUtc && targetTimeZone) {
    const normalized = raw.replace(/(\.\d{3})\d+/, '$1');
    const hasExplicitZone = /Z|[+-]\d{2}:?\d{2}$/i.test(normalized);
    const ms = Date.parse(hasExplicitZone ? normalized : `${normalized}Z`);
    if (!Number.isNaN(ms)) {
      try {
        const parts = new Intl.DateTimeFormat('en-CA', { // date-ok: ISO parts in exported IANA timeZone
          timeZone: targetTimeZone,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          hourCycle: 'h23',
        }).formatToParts(new Date(ms));
        const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
        const day = `${get('year')}-${get('month')}-${get('day')}`;
        const h = get('hour') === '24' ? '00' : get('hour');
        const time = `${h}:${get('minute')}`;
        if (isValidIsoDay(day) && isTime(time)) return { day, time };
      } catch {
        // Fall through to raw date/time extraction.
      }
    }
  }
  const m = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}))?/.exec(raw);
  if (!m) return null;
  const day = m[1]!;
  const time = m[2] ?? '09:00';
  return isValidIsoDay(day) && isTime(time) ? { day, time } : null;
}

const GRAPH_WEEKDAY = new Map<string, number>([
  ['sunday', 0],
  ['monday', 1],
  ['tuesday', 2],
  ['wednesday', 3],
  ['thursday', 4],
  ['friday', 5],
  ['saturday', 6],
]);

/** Convert a Microsoft Graph recurrence pattern into a PrivacyNotes task repeat rule. */
function parseGraphRecurrence(recVal: unknown): TaskRepeat | undefined {
  if (!isObj(recVal)) return undefined;
  const pattern = field(recVal, 'pattern', 'Pattern');
  if (!isObj(pattern)) return undefined;
  const typeKey = fieldStr(pattern, 'type', 'Type').trim().toLowerCase();
  if (!typeKey) return undefined;
  const rawInterval = field(pattern, 'interval', 'Interval');
  const interval = typeof rawInterval === 'number' && Number.isFinite(rawInterval) && rawInterval >= 1
    ? Math.min(999, Math.floor(rawInterval))
    : 1;

  if (typeKey === 'daily') return { mode: 'schedule', every: 'day', interval };
  if (typeKey === 'weekly') {
    const weekdays = fieldArr(pattern, 'daysOfWeek', 'DaysOfWeek')
      .filter((d): d is string => typeof d === 'string')
      .map((d) => GRAPH_WEEKDAY.get(d.trim().toLowerCase()))
      .filter((n): n is number => n !== undefined);
    const unique = [...new Set(weekdays)].sort((a, b) => a - b);
    return {
      mode: 'schedule',
      every: 'week',
      interval,
      ...(unique.length > 0 ? { weekdays: unique } : {}),
    };
  }
  if (typeKey === 'absolutemonthly') {
    return { mode: 'schedule', every: 'month', interval };
  }
  if (typeKey === 'absoluteyearly') {
    return { mode: 'schedule', every: 'year', interval };
  }
  // Relative monthly/yearly patterns (e.g. "second tuesday") are not represented
  // by :remind[...] yet; returning undefined lets the caller keep "(repeats ...)".
  return undefined;
}

const RECURRENCE_UNIT: Record<string, string> = {
  daily: 'days',
  weekly: 'weeks',
  absolutemonthly: 'months',
  relativemonthly: 'months',
  absoluteyearly: 'years',
  relativeyearly: 'years',
};

const RECURRENCE_SINGULAR: Record<string, string> = {
  daily: 'daily',
  weekly: 'weekly',
  absolutemonthly: 'monthly',
  relativemonthly: 'monthly',
  absoluteyearly: 'yearly',
  relativeyearly: 'yearly',
};

function formatRecurrence(recVal: unknown): string {
  if (!isObj(recVal)) return '';
  const pattern = field(recVal, 'pattern', 'Pattern');
  if (!isObj(pattern)) return '';
  const rawType = fieldStr(pattern, 'type', 'Type').trim();
  if (!rawType) return '';
  const typeKey = rawType.toLowerCase();

  const rawInterval = field(pattern, 'interval', 'Interval');
  const interval = typeof rawInterval === 'number' && Number.isFinite(rawInterval) && rawInterval > 1
    ? Math.floor(rawInterval)
    : 1;

  const days = fieldArr(pattern, 'daysOfWeek', 'DaysOfWeek')
    .filter((d): d is string => typeof d === 'string' && d.trim() !== '')
    .map((d) => d.trim());
  const index = fieldStr(pattern, 'index', 'Index').trim();
  const isRelative = typeKey === 'relativemonthly' || typeKey === 'relativeyearly';
  const daysDetail =
    days.length > 0 ? (isRelative && index ? `${index} ${days.join(', ')}` : days.join(', ')) : '';
  const daysSuffix = daysDetail ? ` (${daysDetail})` : '';

  if (interval === 1) {
    const label = Object.hasOwn(RECURRENCE_SINGULAR, typeKey) ? RECURRENCE_SINGULAR[typeKey]! : rawType;
    return `${label}${daysSuffix}`;
  }
  const unit = Object.hasOwn(RECURRENCE_UNIT, typeKey) ? RECURRENCE_UNIT[typeKey]! : rawType;
  return `every ${interval} ${unit}${daysSuffix}`;
}

function statusBadge(rawStatus: string): string {
  switch (rawStatus.trim().toLowerCase()) {
    case 'inprogress':
      return i18n.t('editor:kanban.inProgress');
    case 'waitingonothers':
      return msg('statusWaiting');
    case 'deferred':
      return msg('statusDeferred');
    default:
      return '';
  }
}

/** Escapes one plain-text line from Microsoft To Do while keeping bare URLs clickable. */
function plainInlineToMarkdown(raw: string, onLink?: () => void): string {
  const singleLine = raw.replace(/\r?\n+/g, ' ').trim();
  if (!singleLine) return '';
  const linked = linkifyLiteralText(singleLine, escapeMarkdownText);
  if (linked.links > 0) onLink?.();
  return escapeTypedTags(linked.markdown);
}

/** Converts a multi-line plain-text task body without inventing accidental Markdown formatting. */
function plainBodyToMarkdown(raw: string, onLink?: () => void): string {
  const normalized = raw.replace(/\r\n?/g, '\n').trim();
  if (!normalized) return '';
  return normalized
    .split('\n')
    .map((line) => {
      if (line === '') return '';
      const linked = linkifyLiteralText(line, escapeMarkdownText);
      if (linked.links > 0) onLink?.();
      return guardMarkdownLineStart(escapeTypedTags(linked.markdown));
    })
    .join('\n')
    .trim();
}

const MAX_HTML_FOLDS = 100;

/**
 * Converts HTML `<details><summary>` elements in a parsed DOM into PrivacyNotes
 * `> [!fold]+/-` callout blocks (innermost first) before `htmlNoteToMarkdown` runs.
 */
function extractHtmlFolds(doc: Document): Map<string, string> {
  const folds = new Map<string, string>();
  for (let i = 0; i < MAX_HTML_FOLDS; i++) {
    const detailsList = Array.from(doc.body.querySelectorAll('details'));
    const leaf = detailsList.find((el) => !el.querySelector('details'));
    if (!leaf) break;

    const open = leaf.hasAttribute('open');
    const summaryEl = leaf.querySelector(':scope > summary');
    const title = (summaryEl?.textContent ?? '').replace(/\s+/g, ' ').trim();
    summaryEl?.remove();

    const innerMd = htmlNoteToMarkdown(leaf.innerHTML).trim();
    const head = `> [!fold]${open ? '+' : '-'}${title ? ` ${escapeMarkdownText(title)}` : ''}`;
    const bodyLines = innerMd
      ? innerMd.split('\n').map((line) => (line.trim() ? `> ${line}` : '>'))
      : [];
    const block = [head, ...bodyLines].join('\n');

    const token = `PNMSTODOFOLDTOKEN${i}END`;
    folds.set(token, block);
    const p = doc.createElement('p');
    p.textContent = token;
    leaf.replaceWith(p);
  }
  return folds;
}

function formatTaskBody(bodyVal: unknown, onLink?: () => void): string {
  if (!isObj(bodyVal)) return '';
  const content = fieldStr(bodyVal, 'content', 'Content');
  if (!content.trim()) return '';
  const contentType = fieldStr(bodyVal, 'contentType', 'ContentType').trim().toLowerCase();
  if (contentType === 'html') {
    const doc = new DOMParser().parseFromString(content, 'text/html');
    for (const el of doc.querySelectorAll('iframe, embed, object')) el.remove();
    for (const a of doc.querySelectorAll('a[href]')) {
      if (!isSafeHttpUrl(a.getAttribute('href') ?? '')) a.removeAttribute('href');
    }
    for (const img of doc.querySelectorAll('img[src]')) {
      if (!/^https?:\/\//i.test((img.getAttribute('src') ?? '').trim())) img.remove();
    }
    const folds = extractHtmlFolds(doc);
    let md = htmlNoteToMarkdown(doc.body.innerHTML).trim();
    for (const [token, block] of folds) {
      md = md.replace(token, block);
    }
    return md;
  }
  return plainBodyToMarkdown(content, onLink);
}

function escapeLinkLabel(label: string): string {
  const clean = label.replace(/\r?\n+/g, ' ').replace(/\[/g, '(').replace(/\]/g, ')').trim();
  return clean ? escapeMarkdownText(clean) : 'file';
}

function encodeMarkdownUrl(url: string): string {
  return url
    .trim()
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, '%20')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
    .replace(/</g, '%3C')
    .replace(/>/g, '%3E')
    .replace(/"/g, '%22')
    .replace(/\\/g, '%5C');
}

interface NormalizedSource {
  lists: JsonObj[];
  exportedAt?: string;
  exportedTimeZone?: string;
  zipFiles: Map<string, JSZip.JSZipObject>;
  fromZip: boolean;
  rootPrefix: string;
}

function looksLikeTaskList(v: unknown): v is JsonObj {
  if (!isObj(v)) return false;
  const hasName = typeof field(v, 'displayName', 'DisplayName') === 'string';
  if (!hasName) return false;
  const tasksVal = field(v, 'tasks', 'Tasks');
  const hasTasks = Array.isArray(tasksVal);
  const hasNullTasksAndId = tasksVal === null && typeof field(v, 'id', 'Id') === 'string';
  const hasWellknown = typeof field(v, 'wellknownListName', 'WellknownListName', 'WellKnownListName') === 'string';
  return hasTasks || hasNullTasksAndId || hasWellknown;
}

function extractListsPayload(parsed: unknown): {
  lists: JsonObj[];
  exportedAt?: string;
  exportedTimeZone?: string;
} | null {
  if (isObj(parsed)) {
    // Primary format: PrivacyNotes Microsoft To Do Exporter JSON
    if (fieldStr(parsed, 'source') === 'microsoft-to-do' && Array.isArray(parsed.lists)) {
      const lists = parsed.lists.filter(isObj);
      const exportedAt = fieldStr(parsed, 'exportedAt') || undefined;
      const exportedTimeZone = fieldStr(parsed, 'exportedTimeZone') || undefined;
      return { lists, exportedAt, exportedTimeZone };
    }
    // Graph collection wrapper `{ value: [...] }`
    const value = field(parsed, 'value', 'Value');
    if (Array.isArray(value) && value.length > 0 && value.every(looksLikeTaskList)) {
      return { lists: value };
    }
    // Single list object with tasks
    if (looksLikeTaskList(parsed)) {
      return { lists: [parsed] };
    }
    return null;
  }

  // Array of task lists (e.g. daylamtayari/Microsoft-To-Do-Export JSON)
  if (Array.isArray(parsed) && parsed.length > 0 && parsed.every(looksLikeTaskList)) {
    return { lists: parsed };
  }

  return null;
}

async function readSource(file: File): Promise<NormalizedSource> {
  if (/\.zip$/i.test(file.name)) {
    let zip: JSZip;
    try {
      zip = await openZip(await file.arrayBuffer());
    } catch (err) {
      if (err instanceof ImportTooLargeError) throw err;
      throw new Error(msg('notMicrosoftToDo'));
    }

    const zipFiles = new Map<string, JSZip.JSZipObject>();
    const jsonCandidates: Array<{ path: string; entry: JSZip.JSZipObject }> = [];
    zip.forEach((rawPath, entry) => {
      if (entry.dir || isJunkEntry(rawPath)) return;
      const clean = cleanPath(rawPath);
      if (!clean) return;
      zipFiles.set(clean, entry);
      if (/\.json$/i.test(clean) && !/(?:^|\/)attachments\//i.test(clean)) {
        jsonCandidates.push({ path: clean, entry });
      }
    });

    if (jsonCandidates.length === 0) {
      throw new Error(msg('noJson'));
    }

    // Prefer `microsoft-to-do-export.json`, shallowest path first.
    jsonCandidates.sort((a, b) => {
      const aPreferred = /(?:^|\/)microsoft-to-do-export\.json$/i.test(a.path) ? 0 : 1;
      const bPreferred = /(?:^|\/)microsoft-to-do-export\.json$/i.test(b.path) ? 0 : 1;
      if (aPreferred !== bPreferred) return aPreferred - bPreferred;
      return a.path.split('/').length - b.path.split('/').length || a.path.localeCompare(b.path);
    });

    const preferred = jsonCandidates.filter((c) => /(?:^|\/)microsoft-to-do-export\.json$/i.test(c.path));
    const toProbe = preferred.length > 0 ? preferred : jsonCandidates.slice(0, MAX_FALLBACK_JSON_CANDIDATES);

    for (const candidate of toProbe) {
      let text: string;
      try {
        text = await zipEntryText(candidate.entry, JSON_SIZE_LIMIT);
      } catch (err) {
        if (err instanceof ImportTooLargeError) throw err;
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(stripBom(text));
      } catch {
        continue;
      }
      const extracted = extractListsPayload(parsed);
      if (extracted) {
        const slashIdx = candidate.path.lastIndexOf('/');
        const rootPrefix = slashIdx >= 0 ? candidate.path.slice(0, slashIdx + 1) : '';
        return {
          ...extracted,
          zipFiles,
          fromZip: true,
          rootPrefix,
        };
      }
    }

    throw new Error(msg('notMicrosoftToDo'));
  }

  if (file.size > JSON_SIZE_LIMIT) {
    throw new Error(msg('tooLarge'));
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripBom(await file.text()));
  } catch {
    throw new Error(msg('notMicrosoftToDo'));
  }

  const extracted = extractListsPayload(parsed);
  if (!extracted) {
    throw new Error(msg('notMicrosoftToDo'));
  }

  return {
    ...extracted,
    zipFiles: new Map(),
    fromZip: false,
    rootPrefix: '',
  };
}

function resolveAttachmentPath(
  rawZipPath: string,
  rootPrefix: string,
  zipFiles: Map<string, JSZip.JSZipObject>,
): string | null {
  const clean = cleanPath(rawZipPath);
  if (!clean) return null;
  if (rootPrefix && zipFiles.has(`${rootPrefix}${clean}`)) {
    return `${rootPrefix}${clean}`;
  }
  if (zipFiles.has(clean)) {
    return clean;
  }
  return null;
}

export const parseMicrosoftToDo = withBareLinks(readMicrosoftToDo);

async function readMicrosoftToDo(file: File, onProgress?: (msg: string) => void): Promise<ParsedImport> {
  onProgress?.(msg('reading'));
  const source = await readSource(file);

  const fallbackMs =
    (source.exportedAt ? validEpochMs(source.exportedAt) : null) ??
    (file.lastModified > 0 && file.lastModified <= Date.now() + 86_400_000 ? file.lastModified : Date.now());
  const fallbackIso = new Date(fallbackMs).toISOString();

  const notes: ImportedNote[] = [];
  const fileKeys = new FileKeys('mstodofile');
  const nameByPath = new Map<string, string>();
  const mimeByPath = new Map<string, string>();

  let emptyLists = 0;
  let totalTasks = 0;
  let totalCompleted = 0;
  let totalSubtasks = 0;
  let importedReminders = 0;
  let skippedReminders = 0;
  let missingAttachments = 0;
  let noAttachmentsInJson = 0;
  let linkifiedNotes = 0;

  for (let i = 0; i < source.lists.length; i++) {
    const rawList = source.lists[i]!;
    if (source.lists.length > 1) {
      onProgress?.(msg('readingList', { current: i + 1, total: source.lists.length }));
    }

    const listTitle = fieldStr(rawList, 'displayName', 'DisplayName').trim() || msg('untitledList');
    const rawTasks = fieldArr(rawList, 'tasks', 'Tasks').filter(isObj);
    if (rawTasks.length === 0) {
      emptyLists++;
      continue;
    }

    const isCompleted = (t: JsonObj): boolean =>
      fieldStr(t, 'status', 'Status').trim().toLowerCase() === 'completed';

    const orderedTasks = [
      ...rawTasks.filter((t) => !isCompleted(t)),
      ...rawTasks.filter((t) => isCompleted(t)),
    ];

    const bodyParts: string[] = [];
    const listCategories: string[] = [];
    let earliestMs = Infinity;
    let latestMs = -Infinity;
    let noteLinkified = false;
    const markLinkified = () => { noteLinkified = true; };

    const trackDate = (raw: string) => {
      const ms = validEpochMs(raw);
      if (ms === null) return;
      if (ms < earliestMs) earliestMs = ms;
      if (ms > latestMs) latestMs = ms;
    };

    for (const task of orderedTasks) {
      const rawTitle = fieldStr(task, 'title', 'Title');
      const titleMd = plainInlineToMarkdown(rawTitle, markLinkified) || msg('untitledTask');
      const rawStatus = fieldStr(task, 'status', 'Status');
      const done = isCompleted(task);

      totalTasks++;
      if (done) totalCompleted++;

      const createdRaw = fieldStr(task, 'createdDateTime', 'CreatedDateTime');
      const modifiedRaw = fieldStr(task, 'lastModifiedDateTime', 'LastModifiedDateTime');
      trackDate(createdRaw);
      trackDate(modifiedRaw);
      if (!createdRaw && !modifiedRaw) {
        const completedDt = field(task, 'completedDateTime', 'CompletedDateTime');
        if (isObj(completedDt)) {
          trackDate(fieldStr(completedDt, 'dateTime', 'DateTime'));
        }
      }

      const importance = fieldStr(task, 'importance', 'Importance').trim().toLowerCase();
      const statusTag = statusBadge(rawStatus);
      const due = formatGraphDate(field(task, 'dueDateTime', 'DueDateTime'), source.exportedTimeZone);
      const rawRecurrence = field(task, 'recurrence', 'Recurrence');
      const recurrence = formatRecurrence(rawRecurrence);
      const parsedRepeat = parseGraphRecurrence(rawRecurrence);
      const categories = fieldArr(task, 'categories', 'Categories')
        .filter((c): c is string => typeof c === 'string' && c.trim() !== '')
        .map((c) => c.trim());
      if (categories.length > 0) {
        listCategories.push(...categories);
      }

      const rawReminderFlag = field(task, 'isReminderOn', 'IsReminderOn');
      const rawReminderDt = field(task, 'reminderDateTime', 'ReminderDateTime');
      const hasReminderFlag =
        typeof rawReminderFlag === 'boolean'
          ? rawReminderFlag
          : isObj(rawReminderDt);
      const reminderDt = hasReminderFlag ? formatGraphDateTime(rawReminderDt, source.exportedTimeZone) : null;
      let reminderToken = '';
      if (reminderDt) {
        reminderToken = taskReminderMarkdown({
          day: reminderDt.day,
          time: reminderDt.time,
          ...(parsedRepeat ? { repeat: parsedRepeat } : {}),
        });
        importedReminders++;
      } else if (hasReminderFlag) {
        skippedReminders++;
      }

      const meta: string[] = [];
      if (importance === 'high') meta.push(`[${i18n.t('editor:callout.types.important')}]`);
      if (statusTag) meta.push(`[${statusTag}]`);
      if (due) meta.push(`(${msg('dueValue', { value: due })})`);
      if (recurrence && !(reminderToken && parsedRepeat)) meta.push(`(${msg('repeatsValue', { value: recurrence })})`);
      for (const cat of categories) {
        meta.push(`[${plainInlineToMarkdown(cat, markLinkified)}]`);
      }
      if (reminderToken) meta.push(reminderToken);

      const suffix = meta.length > 0 ? ` ${meta.join(' ')}` : '';
      bodyParts.push(`- [${done ? 'x' : ' '}] ${titleMd}${suffix}`);

      // Subtasks (checklistItems)
      const checklistItems = fieldArr(task, 'checklistItems', 'ChecklistItems').filter(isObj);
      for (const item of checklistItems) {
        const stepText = plainInlineToMarkdown(fieldStr(item, 'displayName', 'DisplayName'), markLinkified);
        if (!stepText) continue;
        const checked = fieldBool(item, 'isChecked', 'IsChecked');
        bodyParts.push(`  - [${checked ? 'x' : ' '}] ${stepText}`);
        totalSubtasks++;
      }

      // Task body / note
      const noteBody = formatTaskBody(field(task, 'body', 'Body'), markLinkified);
      if (noteBody) {
        bodyParts.push('');
        bodyParts.push(indentLines(noteBody, '  '));
        bodyParts.push('');
      }

      // Linked resources (Outlook flagged emails, web links)
      const linkedResources = fieldArr(task, 'linkedResources', 'LinkedResources').filter(isObj);
      for (const lr of linkedResources) {
        const webUrl = fieldStr(lr, 'webUrl', 'WebUrl').trim();
        const displayName =
          fieldStr(lr, 'displayName', 'DisplayName').trim() ||
          fieldStr(lr, 'applicationName', 'ApplicationName').trim() ||
          webUrl;
        if (!displayName) continue;
        if (webUrl && isSafeHttpUrl(webUrl)) {
          bodyParts.push(`  - ${msg('linkLabel')}: [${escapeLinkLabel(displayName)}](${encodeMarkdownUrl(webUrl)})`);
        } else {
          bodyParts.push(`  - ${msg('linkLabel')}: ${plainInlineToMarkdown(displayName, markLinkified)}`);
        }
      }

      // Attachments
      const attachments = fieldArr(task, 'attachments', 'Attachments').filter(isObj);
      for (const att of attachments) {
        const attName = fieldStr(att, 'name', 'Name').trim() || 'attachment';
        const attZipPath = fieldStr(att, 'zipPath').trim();
        const attSourceUrl = fieldStr(att, 'sourceUrl', 'SourceUrl').trim();
        const attError = fieldStr(att, 'error').trim();
        const rawMime = fieldStr(att, 'contentType', 'ContentType').trim();
        const attMime = rawMime || mimeFromExt(attName);

        if (attSourceUrl && isSafeHttpUrl(attSourceUrl) && !attZipPath) {
          bodyParts.push(`  - ${msg('cloudAttachmentLabel')}: [${escapeLinkLabel(attName)}](${encodeMarkdownUrl(attSourceUrl)})`);
          continue;
        }

        if (!source.fromZip) {
          noAttachmentsInJson++;
          bodyParts.push(`  - ${msg('missingAttachmentLine', { name: plainInlineToMarkdown(attName, markLinkified) })}`);
          continue;
        }

        const resolvedPath = !attError && attZipPath
          ? resolveAttachmentPath(attZipPath, source.rootPrefix, source.zipFiles)
          : null;

        if (!resolvedPath) {
          missingAttachments++;
          bodyParts.push(`  - ${msg('missingAttachmentLine', { name: plainInlineToMarkdown(attName, markLinkified) })}`);
          continue;
        }

        const key = fileKeys.keyOf(resolvedPath);
        nameByPath.set(resolvedPath, attName);
        if (rawMime) mimeByPath.set(resolvedPath, rawMime);
        const isImg = IMAGE_MIME_RE.test(attMime) || IMAGE_EXT_RE.test(attName);
        const label = escapeLinkLabel(attName);
        // Blank lines around block image/attachment nodes prevent ghost <br> paragraphs in TipTap.
        bodyParts.push('', isImg ? `  ![${label}](${key})` : `  [${label}](${key})`, '');
      }
    }

    if (noteLinkified) linkifiedNotes++;
    const createdAt = Number.isFinite(earliestMs) ? new Date(earliestMs).toISOString() : fallbackIso;
    const updatedAt = Number.isFinite(latestMs) ? new Date(latestMs).toISOString() : createdAt;

    notes.push({
      title: listTitle,
      body: bodyParts.join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+|\n+$/g, ''),
      tags: normalizeTagList(listCategories),
      createdAt,
      updatedAt,
      type: 'task',
    });
  }

  if (notes.length === 0) {
    throw new Error(msg('noTasks'));
  }

  let blobs: ParsedImport['blobs'];
  let tooLarge = 0;
  if (fileKeys.size > 0) {
    const read = await readKeyedFiles(
      fileKeys,
      source.zipFiles,
      notes,
      (done, total) => onProgress?.(msg('readingAttachments', { done, total })),
      (path) => nameByPath.get(path) ?? path.slice(path.lastIndexOf('/') + 1),
    );
    blobs = read.blobs;
    tooLarge = read.tooLarge;
    if (blobs) {
      for (const [path, key] of fileKeys.entries()) {
        const blob = blobs.get(key);
        if (!blob) continue;
        const declared = mimeByPath.get(path);
        if (declared && declared !== 'application/octet-stream') {
          blob.mime = declared;
        } else if (!blob.mime || blob.mime === 'application/octet-stream') {
          blob.mime = mimeFromExtOrBytes(blob.name, blob.data);
        }
      }
    }
  }

  const warnings: string[] = [];
  if (emptyLists > 0) warnings.push(msg('emptyLists', { count: emptyLists }));
  if (skippedReminders > 0) warnings.push(msg('reminders', { count: skippedReminders }));
  if (noAttachmentsInJson > 0) warnings.push(msg('noAttachmentsInJson', { count: noAttachmentsInJson }));
  if (missingAttachments > 0) warnings.push(msg('missingAttachments', { count: missingAttachments }));
  if (tooLarge > 0) warnings.push(mediaTooLargeWarning(tooLarge));

  const transforms: string[] = [msg('importedLists', { count: notes.length, tasks: totalTasks })];
  if (totalCompleted > 0) transforms.push(msg('completedTasks', { count: totalCompleted }));
  if (totalSubtasks > 0) transforms.push(msg('subtasks', { count: totalSubtasks }));
  if (importedReminders > 0) transforms.push(msg('remindersImported', { count: importedReminders }));
  if (blobs && blobs.size > 0) transforms.push(msg('attachmentsImported', { count: blobs.size }));
  if (linkifiedNotes > 0) transforms.push(i18n.t('importLog:shared.linkifiedNotes', { count: linkifiedNotes }));

  return {
    notes,
    blobs,
    warnings,
    transforms,
    source: 'microsoft-to-do',
  };
}
