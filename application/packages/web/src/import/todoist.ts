import type JSZip from 'jszip';
import i18n from '../i18n';
import { withBareLinks } from './bareLinks';
import { mapOutsideCode, stripHtmlComments } from './codeSegments';
import { detailsToFold } from './detailsFold';
import { cleanPath, escapeScriptTags, escapeTypedTags, isJunkEntry, normalizeTagList } from './importHelpers';
import { isoFromStamp, readCsvTable } from './passwordCsv';
import type { ImportedNote, ParsedImport } from './types';
import { zipEntryText } from './zipEntry';
import { openZip } from './zipOpen';

const msg = (key: string, options: Record<string, unknown> = {}): string => i18n.t(`importLog:todoist.${key}`, options);

/**
 * Todoist importer.
 *
 * Reads either a Todoist full-account backup `.zip` (Settings > Backups >
 * Download, containing one `.csv` per active project) or a single project's
 * `.csv` (project menu > Import & export > Export as CSV).
 *
 * Format facts come from real exports made in the importer lab (Todoist Web
 * at app.todoist.com; `skills/importer-lab/apps/todoist.md`):
 *
 *   Columns: TYPE, CONTENT, DESCRIPTION, ICON, IS_COLLAPSED, PRIORITY, INDENT,
 *            AUTHOR, RESPONSIBLE, DATE, DATE_LANG, TIMEZONE, DURATION,
 *            DURATION_UNIT, DEADLINE, DEADLINE_LANG, REMINDER_TYPE,
 *            REMINDER_OFFSET, REMINDER_DATE, REMINDER_DATE_LANG
 *
 *   One `type: 'task'` note per project CSV:
 *     meta          -> view style (`list` / `board`); ignored cleanly
 *     project_note  -> blockquote at the top of the note
 *     section       -> `## <Section name>` heading
 *     task          -> `- [ ]` task indented by `INDENT` (or non-checkable
 *                      `- **...**` for `* ` uncompletable header tasks),
 *                      keeping `[P1]`-`[P3]` (P4 omitted), `(due: ...)`,
 *                      duration, deadline, inline `@labels` (also collected
 *                      into `note.tags`), and indented description
 *     note          -> comment attached under the preceding task
 *
 * Todoist excludes completed tasks and archived projects from CSV exports.
 */

const REQUIRED_COLS = ['type', 'content'] as const;
const MAX_INDENT = 8;
/** Inline Todoist `@label` tokens (must start at string start or whitespace, never an email). */
const LABEL_RE = /(?:^|(?<=\s))@([\p{L}\p{N}_-]{1,64})/gu;

function projectTitleFromFileName(name: string): string {
  const base = (cleanPath(name) ?? name).split('/').pop() ?? name;
  // Todoist backup zips sometimes append ` [123456]` after the project name.
  const stem = base.replace(/\.csv$/i, '').replace(/\s+\[\d+\]$/, '').trim();
  return stem || msg('untitledProject');
}

function extractLabels(content: string): string[] {
  const found: string[] = [];
  mapOutsideCode(content, (prose) => {
    for (const m of prose.matchAll(LABEL_RE)) {
      if (m[1]) found.push(m[1]);
    }
    return prose;
  });
  return found;
}

function formatPriority(raw: string): string {
  const n = Number.parseInt(raw.trim(), 10);
  if (n === 1 || n === 2 || n === 3) return `[P${n}]`;
  return '';
}

function formatDuration(amount: string, unit: string): string {
  const a = amount.trim();
  if (!a) return '';
  const u = unit.trim();
  return u ? `${a} ${u}` : a;
}

function formatCommentDate(raw: string): string {
  const iso = isoFromStamp(raw.trim());
  if (!iso) return '';
  return iso.slice(0, 10);
}

function cleanDescription(raw: string): string {
  const normalized = raw.replace(/\r\n?/g, '\n').trim();
  if (!normalized) return '';
  const folded = detailsToFold(normalized);
  return mapOutsideCode(folded, (prose) => escapeScriptTags(stripHtmlComments(prose)));
}

function indentLines(text: string, prefix: string): string {
  return text
    .split('\n')
    .map((line) => (line === '' ? '' : `${prefix}${line}`))
    .join('\n');
}

interface CsvSource {
  fileName: string;
  file: File;
}

async function readCsvSources(file: File): Promise<{ sources: CsvSource[]; fromZip: boolean }> {
  if (!/\.zip$/i.test(file.name)) {
    if (file.size > 64 * 1024 * 1024) throw new Error(msg('notTodoist'));
    return { sources: [{ fileName: file.name, file }], fromZip: false };
  }
  let zip: JSZip;
  try {
    zip = await openZip(await file.arrayBuffer());
  } catch {
    throw new Error(msg('notTodoist'));
  }
  const entries: Array<{ clean: string; entry: JSZip.JSZipObject }> = [];
  zip.forEach((rawPath, entry) => {
    if (entry.dir || isJunkEntry(rawPath)) return;
    const clean = cleanPath(rawPath);
    if (!clean || !/\.csv$/i.test(clean)) return;
    entries.push({ clean, entry });
  });
  if (entries.length === 0) throw new Error(msg('noCsv'));
  entries.sort((a, b) => a.clean.localeCompare(b.clean));
  const sources: CsvSource[] = [];
  for (const { clean, entry } of entries) {
    const text = await zipEntryText(entry);
    sources.push({ fileName: clean, file: new File([text], clean, { type: 'text/csv' }) });
  }
  return { sources, fromZip: true };
}

interface ProjectParseResult {
  note: ImportedNote | null;
  tasks: number;
  sections: number;
  comments: number;
  reminders: number;
  validHeader: boolean;
}

async function parseProjectCsv(src: CsvSource, fallbackIso: string): Promise<ProjectParseResult> {
  const { rows, col } = await readCsvTable(src.file);
  if (REQUIRED_COLS.some((c) => col(c) < 0)) {
    return { note: null, tasks: 0, sections: 0, comments: 0, reminders: 0, validHeader: false };
  }
  const cell = (row: string[], name: string): string => {
    const i = col(name);
    return i < 0 ? '' : (row[i] ?? '');
  };

  const projectNotes: string[] = [];
  const bodyParts: string[] = [];
  const rawLabels: string[] = [];
  let tasks = 0;
  let sections = 0;
  let comments = 0;
  let reminders = 0;
  let lastTaskIndent = 0;
  let earliestMs = Infinity;
  let latestMs = -Infinity;

  const trackStamp = (raw: string) => {
    const iso = isoFromStamp(raw.trim());
    if (!iso) return;
    const ms = Date.parse(iso);
    if (!Number.isNaN(ms) && ms > 0 && ms <= Date.now() + 86_400_000) {
      if (ms < earliestMs) earliestMs = ms;
      if (ms > latestMs) latestMs = ms;
    }
  };

  // Track consecutive task lines so lists stay tight while sections get blank-line gaps.
  let inList = false;

  for (const row of rows) {
    const type = cell(row, 'type').trim().toLowerCase();
    const content = cell(row, 'content').replace(/\r\n?/g, '\n');

    if (type === 'meta' || !type) continue;

    if (type === 'project_note') {
      const text = escapeTypedTags(content.trim());
      if (!text) continue;
      trackStamp(cell(row, 'date'));
      const dateStr = formatCommentDate(cell(row, 'date'));
      const prefix = dateStr ? `**${dateStr}:** ` : '';
      projectNotes.push(
        text
          .split('\n')
          .map((l, idx) => `> ${idx === 0 ? prefix : ''}${l}`)
          .join('\n'),
      );
      comments++;
      continue;
    }

    if (type === 'section') {
      const heading = content.replace(/\s+/g, ' ').trim();
      if (!heading) continue;
      if (bodyParts.length > 0) bodyParts.push('');
      bodyParts.push(`## ${escapeTypedTags(heading)}`);
      bodyParts.push('');
      sections++;
      inList = false;
      lastTaskIndent = 0;
      continue;
    }

    if (type === 'task') {
      const trimmed = content.trim();
      if (!trimmed) continue;
      tasks++;
      rawLabels.push(...extractLabels(trimmed));

      const rawIndent = Number.parseInt(cell(row, 'indent').trim(), 10);
      const level = Number.isFinite(rawIndent) && rawIndent >= 1 ? Math.min(rawIndent - 1, MAX_INDENT) : 0;
      lastTaskIndent = level;
      const indentStr = '  '.repeat(level);

      const priority = formatPriority(cell(row, 'priority'));
      const due = cell(row, 'date').trim();
      const duration = formatDuration(cell(row, 'duration'), cell(row, 'duration_unit'));
      const deadline = cell(row, 'deadline').trim();
      if (cell(row, 'reminder_type').trim() || cell(row, 'reminder_date').trim() || cell(row, 'reminder_offset').trim()) {
        reminders++;
      }

      const meta: string[] = [];
      if (priority) meta.push(priority);
      if (due) meta.push(`(${msg('dueValue', { value: due })})`);
      if (duration) meta.push(`(${duration})`);
      if (deadline) meta.push(`(${msg('deadlineValue', { value: deadline })})`);
      const suffix = meta.length > 0 ? ` ${meta.join(' ')}` : '';

      const isHeaderTask = /^\*\s+/.test(trimmed);
      const text = escapeTypedTags((isHeaderTask ? trimmed.replace(/^\*\s+/, '') : trimmed).replace(/\n+/g, ' '));
      const line = isHeaderTask ? `${indentStr}- **${text}**${suffix}` : `${indentStr}- [ ] ${text}${suffix}`;
      bodyParts.push(line);
      inList = true;

      const desc = cleanDescription(cell(row, 'description'));
      if (desc) {
        bodyParts.push('');
        bodyParts.push(indentLines(desc, `${indentStr}  `));
        bodyParts.push('');
      }
      continue;
    }

    if (type === 'note') {
      const text = escapeTypedTags(content.trim());
      if (!text) continue;
      trackStamp(cell(row, 'date'));
      const dateStr = formatCommentDate(cell(row, 'date'));
      const label = dateStr ? `${msg('commentLabel')} (${dateStr})` : msg('commentLabel');
      const indentStr = inList ? `${'  '.repeat(lastTaskIndent)}  ` : '';
      const lines = text.split('\n');
      const formatted = lines.map((l, idx) => (idx === 0 ? `${indentStr}> **${label}:** ${l}` : `${indentStr}> ${l}`)).join('\n');
      bodyParts.push(formatted);
      comments++;
    }
  }

  if (tasks === 0 && projectNotes.length === 0 && sections === 0) {
    return { note: null, tasks: 0, sections: 0, comments: 0, reminders: 0, validHeader: true };
  }

  const sectionsOut: string[] = [];
  if (projectNotes.length > 0) sectionsOut.push(projectNotes.join('\n\n'));
  const mainBody = bodyParts.join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+|\n+$/g, '');
  if (mainBody) sectionsOut.push(mainBody);

  const createdAt = Number.isFinite(earliestMs) ? new Date(earliestMs).toISOString() : fallbackIso;
  const updatedAt = Number.isFinite(latestMs) ? new Date(latestMs).toISOString() : createdAt;

  return {
    note: {
      title: projectTitleFromFileName(src.fileName),
      body: sectionsOut.join('\n\n'),
      tags: normalizeTagList(rawLabels),
      createdAt,
      updatedAt,
      type: 'task',
    },
    tasks,
    sections,
    comments,
    reminders,
    validHeader: true,
  };
}

export const parseTodoist = withBareLinks(readTodoist);

async function readTodoist(file: File, onProgress?: (msg: string) => void): Promise<ParsedImport> {
  onProgress?.(msg('reading'));
  const { sources, fromZip } = await readCsvSources(file);
  const fallbackIso =
    file.lastModified > 0 && file.lastModified <= Date.now() + 86_400_000
      ? new Date(file.lastModified).toISOString()
      : new Date().toISOString();

  const notes: ImportedNote[] = [];
  let validCsvs = 0;
  let emptyProjects = 0;
  let totalTasks = 0;
  let totalSections = 0;
  let totalComments = 0;
  let totalReminders = 0;

  for (let i = 0; i < sources.length; i++) {
    const src = sources[i]!;
    if (sources.length > 1) onProgress?.(msg('readingProject', { current: i + 1, total: sources.length }));
    const res = await parseProjectCsv(src, fallbackIso);
    if (!res.validHeader) {
      if (!fromZip) throw new Error(msg('notTodoist'));
      continue;
    }
    validCsvs++;
    if (!res.note) {
      emptyProjects++;
      continue;
    }
    notes.push(res.note);
    totalTasks += res.tasks;
    totalSections += res.sections;
    totalComments += res.comments;
    totalReminders += res.reminders;
  }

  if (validCsvs === 0) throw new Error(msg('notTodoist'));
  if (notes.length === 0) throw new Error(msg('noTasks'));

  const warnings: string[] = [];
  if (emptyProjects > 0) warnings.push(msg('emptyProjects', { count: emptyProjects }));
  if (totalReminders > 0) warnings.push(msg('reminders', { count: totalReminders }));

  const transforms: string[] = [msg('importedProjects', { count: notes.length, tasks: totalTasks })];
  if (totalSections > 0) transforms.push(msg('sections', { count: totalSections }));
  if (totalComments > 0) transforms.push(msg('comments', { count: totalComments }));

  return {
    notes,
    warnings,
    transforms,
    source: 'todoist',
  };
}
