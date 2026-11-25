/**
 * Compact collapsible "Folder & tags" block shared across Clip, New note, and
 * Add login (#788, Option B). Starts collapsed at ~34 px with a live summary
 * of the chosen folder and tags; expands in place with inline label+field rows
 * so every screen stays compact inside the 600 px popup height cap.
 *
 * Security & Pro rules:
 * - Clips-only (`canFolder === false`): shows "Tags" only (write-only boundary).
 * - Free account (`!pro`): Folder stays clickable with the Pro mark and opens
 *   PrivacyNotes to upgrade; Tags stay free.
 * - Locked Vault (`pro && !unlocked`): Folder offers an inline Unlock button
 *   and reveals zero folder or tag names; typing tags still works immediately.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { browser } from 'wxt/browser';
import { ORGANIZER_LIMITS, type OrganizerFolder } from '@notes/shared/extension';
import { CaretDown, Check, Folder, LockSimple, MagnifyingGlass, Tag, X } from '@web/icons';
import { ProMark } from '@web/proMark';
import { NO_TEXT_ASSIST } from '@web/formFields';
import { SETTINGS_HELP } from '@web/settingsUI';
import { isImeComposing } from '@web/imeComposing';
import { useEscapeToClose } from '@web/useEscapeToClose';
import { APP_URL } from '../../src/config';
import { filterFolders, flattenFolders, folderPathOf, mergeTags, tagSuggestions } from '../../src/organize';

/** Show the folder filter input when the tree has more than this many folders. */
const FILTER_THRESHOLD = 8;

export interface OrganizeFieldsProps {
  /** True when the extension has Vault enabled; false for clips-only. */
  canFolder: boolean;
  /** Optional hydration state from parent (not rendered). */
  hydrated?: boolean;
  unlocked: boolean;
  pro: boolean;
  folders: readonly OrganizerFolder[];
  knownTags: readonly string[];
  folderId: string | null;
  onFolderChange: (id: string | null) => void;
  tags: readonly string[];
  onTagsChange: (tags: string[]) => void;
  tagDraft: string;
  onTagDraftChange: (draft: string) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Jump to Vault unlock and return here once unlocked. */
  onUnlock?: () => void;
}

export function OrganizeFields({
  canFolder,
  unlocked,
  pro,
  folders,
  knownTags,
  folderId,
  onFolderChange,
  tags,
  onTagsChange,
  tagDraft,
  onTagDraftChange,
  open,
  onOpenChange,
  onUnlock,
}: OrganizeFieldsProps) {
  const { t } = useTranslation('extension');
  const panelId = useId();
  const tagInputId = useId();
  const [pickingFolder, setPickingFolder] = useState(false);
  const [folderQuery, setFolderQuery] = useState('');
  const folderSearchRef = useRef<HTMLInputElement>(null);
  const tagInputRef = useRef<HTMLInputElement>(null);

  const flat = useMemo(() => flattenFolders(folders), [folders]);
  const filteredFolders = useMemo(() => filterFolders(flat, folderQuery), [flat, folderQuery]);
  const activeFolder = useMemo(
    () => (canFolder && unlocked && pro ? folderPathOf(flat, folderId) : null),
    [canFolder, unlocked, pro, flat, folderId],
  );
  const effectiveTags = useMemo(() => mergeTags(tags, tagDraft), [tags, tagDraft]);
  const suggestions = useMemo(
    () => (unlocked ? tagSuggestions(knownTags, effectiveTags, tagDraft) : []),
    [unlocked, knownTags, effectiveTags, tagDraft],
  );

  // Escape closes the open folder picker before the enclosing sheet or popup.
  useEscapeToClose(() => {
    setPickingFolder(false);
    setFolderQuery('');
  }, pickingFolder && unlocked && pro, true);

  // Close the folder list when the section collapses or locks.
  useEffect(() => {
    if (!open || !unlocked || !pro) {
      setPickingFolder(false);
      setFolderQuery('');
    }
  }, [open, unlocked, pro]);

  useEffect(() => {
    if (pickingFolder && flat.length > FILTER_THRESHOLD) {
      requestAnimationFrame(() => folderSearchRef.current?.focus());
    }
  }, [pickingFolder, flat.length]);

  const commitDraft = (text = tagDraft) => {
    if (!text.trim()) return;
    onTagsChange(mergeTags(tags, text));
    onTagDraftChange('');
  };

  const removeTag = (target: string) => {
    const low = target.toLowerCase();
    onTagsChange(tags.filter((x) => x.toLowerCase() !== low));
  };

  const addTag = (tag: string) => {
    onTagsChange(mergeTags([...tags, tag], ''));
    onTagDraftChange('');
    tagInputRef.current?.focus();
  };

  const title = canFolder ? t('organize.title') : t('shell:tagsRail.tags');
  const tagSummary = effectiveTags.length === 0
    ? null
    : effectiveTags.length <= 2
      ? effectiveTags.map((x) => `#${x}`).join(' ')
      : `#${effectiveTags[0]} +${effectiveTags.length - 1}`;

  return (
    <div className={`rounded-lg border bg-surface-1 overflow-hidden transition-colors ${open ? 'border-accent/45' : 'border-divider'}`}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => onOpenChange(!open)}
        className="flex w-full items-center gap-2 px-2.5 py-2 text-start text-small text-pn hover:bg-surface-2/60 transition-colors"
      >
        {canFolder
          ? <Folder aria-hidden="true" className="shrink-0 text-label" />
          : <Tag aria-hidden="true" className="shrink-0 text-accent" />}
        <span className="font-medium shrink-0">{title}</span>
        {!open && (
          <span className="flex-1 min-w-0 truncate text-end text-meta text-pn-muted">
            {activeFolder ? activeFolder.name : null}
            {activeFolder && tagSummary ? ' · ' : null}
            {tagSummary ? <span className="text-accent font-medium">{tagSummary}</span> : null}
          </span>
        )}
        {open && <span className="flex-1" />}
        <CaretDown aria-hidden="true" className={`shrink-0 text-pn-muted transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div id={panelId} className="border-t border-divider bg-surface-2 px-2.5 py-2.5 space-y-2">
          {canFolder && (
            <div className="space-y-1.5">
              <div className="grid grid-cols-[54px_1fr] items-center gap-2">
                <span className="text-meta font-semibold text-pn-muted">{t('shell:folders.chipUnfiled')}</span>
                {!pro ? (
                  <button
                    type="button"
                    aria-label={t('organize.proFolders')}
                    title={t('organize.proFolders')}
                    onClick={() => void browser.tabs.create({ url: APP_URL })}
                    className="flex items-center gap-2 min-w-0 h-8 px-2.5 rounded-lg border border-divider bg-surface-1 text-small text-pn-muted hover:border-accent/50 transition-colors"
                  >
                    <Folder aria-hidden="true" className="shrink-0 text-label" />
                    <span className="flex-1 truncate text-start">{t('shell:folders.unfiled')}</span>
                    <ProMark />
                  </button>
                ) : !unlocked ? (
                  <button
                    type="button"
                    onClick={() => onUnlock?.()}
                    className="flex items-center gap-2 min-w-0 h-8 px-2.5 rounded-lg border border-dashed border-divider bg-surface-0 text-small text-pn-muted hover:border-accent/50 transition-colors"
                  >
                    <LockSimple aria-hidden="true" className="shrink-0" />
                    <span className="flex-1 truncate text-start">{t('organize.unlockToPick')}</span>
                    <span className="shrink-0 rounded-md bg-accent/15 px-2 py-0.5 text-meta font-semibold text-accent">
                      {t('security:lockScreen.unlock')}
                    </span>
                  </button>
                ) : (
                  <button
                    type="button"
                    aria-expanded={pickingFolder}
                    onClick={() => setPickingFolder((v) => !v)}
                    className={`flex items-center gap-2 min-w-0 h-8 px-2.5 rounded-lg border bg-surface-1 text-small transition-colors ${pickingFolder ? 'border-accent ring-2 ring-accent/15' : 'border-divider hover:border-accent/50'}`}
                  >
                    <Folder aria-hidden="true" className="shrink-0 text-label" />
                    <span className="flex-1 min-w-0 truncate text-start" dir="auto">
                      {activeFolder ? (
                        <>
                          {activeFolder.ancestors.length > 0 && (
                            <span className="text-pn-muted">{activeFolder.ancestors.join(' / ')} / </span>
                          )}
                          <span className="text-pn">{activeFolder.name}</span>
                        </>
                      ) : (
                        <span className="text-pn-muted">{t('shell:folders.unfiled')}</span>
                      )}
                    </span>
                    <CaretDown aria-hidden="true" className={`shrink-0 text-pn-muted transition-transform ${pickingFolder ? 'rotate-180' : ''}`} />
                  </button>
                )}
              </div>

              {pickingFolder && unlocked && pro && (
                <div
                  role="listbox"
                  aria-label={t('shell:folders.chipUnfiled')}
                  className="rounded-lg border border-divider bg-surface-1 p-1.5 space-y-0.5 max-h-36 overflow-y-auto"
                >
                  {flat.length > FILTER_THRESHOLD && (
                    <div className="flex items-center gap-1.5 px-2 h-7 mb-1 rounded-md border border-divider bg-surface-2">
                      <MagnifyingGlass aria-hidden="true" className="shrink-0 text-pn-muted" />
                      <input
                        ref={folderSearchRef}
                        data-search-field=""
                        value={folderQuery}
                        onChange={(e) => setFolderQuery(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey && !isImeComposing(e.nativeEvent)) {
                            e.preventDefault();
                            if (filteredFolders.length > 0) {
                              onFolderChange(filteredFolders[0]!.folder.id);
                              setPickingFolder(false);
                              setFolderQuery('');
                            }
                          } else if (e.key === 'Escape' && folderQuery && !isImeComposing(e.nativeEvent)) {
                            e.preventDefault();
                            e.stopPropagation();
                            setFolderQuery('');
                          }
                        }}
                        placeholder={t('shell:folders.searchPlaceholder')}
                        aria-label={t('shell:folders.searchPlaceholder')}
                        autoComplete="off"
                        {...NO_TEXT_ASSIST}
                        className="pn-ext-compact-input flex-1 min-w-0 bg-transparent text-small text-pn placeholder:text-pn-muted outline-none"
                        dir="auto"
                      />
                    </div>
                  )}
                  {!folderQuery.trim() && (
                    <button
                      type="button"
                      role="option"
                      aria-selected={activeFolder === null}
                      onClick={() => {
                        onFolderChange(null);
                        setPickingFolder(false);
                        setFolderQuery('');
                      }}
                      className={`flex w-full items-center gap-2 rounded-md px-2 py-1 text-start text-small transition-colors ${activeFolder === null ? 'bg-accent/15 text-accent font-semibold' : 'text-pn hover:bg-surface-2'}`}
                    >
                      <span className="flex-1 truncate">{t('shell:folders.unfiled')}</span>
                      {activeFolder === null && <Check aria-hidden="true" className="shrink-0 text-accent" />}
                    </button>
                  )}
                  {filteredFolders.length === 0 ? (
                    <p className={`px-2 py-1.5 ${SETTINGS_HELP}`}>
                      {flat.length === 0 ? t('shell:folders.noFoldersYet') : t('shell:folders.noMatches')}
                    </p>
                  ) : (
                    filteredFolders.map((row) => {
                      const selected = row.folder.id === folderId;
                      const indent = folderQuery.trim() ? 0 : Math.min(row.depth, 5) * 14;
                      return (
                        <button
                          key={row.folder.id}
                          type="button"
                          role="option"
                          aria-selected={selected}
                          onClick={() => {
                            onFolderChange(row.folder.id);
                            setPickingFolder(false);
                            setFolderQuery('');
                          }}
                          style={{ paddingInlineStart: `${8 + indent}px` }}
                          className={`flex w-full items-center gap-2 rounded-md pe-2 py-1 text-start text-small transition-colors ${selected ? 'bg-accent/15 text-accent font-semibold' : 'text-pn hover:bg-surface-2'}`}
                        >
                          <Folder aria-hidden="true" className="shrink-0 text-label" />
                          <span className="flex-1 min-w-0 truncate" dir="auto">
                            {folderQuery.trim() && row.ancestors.length > 0 && (
                              <span className="text-pn-muted font-normal">{row.ancestors.join(' / ')} / </span>
                            )}
                            {row.folder.name}
                          </span>
                          {selected && <Check aria-hidden="true" className="shrink-0 text-accent" />}
                        </button>
                      );
                    })
                  )}
                </div>
              )}
            </div>
          )}

          <div className="grid grid-cols-[54px_1fr] items-start gap-x-2 gap-y-1.5">
            <label htmlFor={tagInputId} className="pt-1.5 text-meta font-semibold text-pn-muted">
              {t('shell:tagsRail.tags')}
            </label>
            <div className="min-w-0 space-y-1.5">
              <div
                onClick={() => tagInputRef.current?.focus()}
                className="flex flex-wrap items-center gap-1 min-h-8 px-2 py-1 rounded-lg border border-divider bg-surface-1 focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/15 cursor-text"
              >
                {tags.map((tag) => (
                  <span
                    key={tag}
                    className="inline-flex items-center gap-1 rounded-md bg-accent/15 px-1.5 py-0.5 text-meta font-medium text-accent"
                  >
                    <span dir="auto">#{tag}</span>
                    <button
                      type="button"
                      aria-label={t('common:tagInput.removeTag', { tag })}
                      onClick={(e) => {
                        e.stopPropagation();
                        removeTag(tag);
                      }}
                      className="inline-flex items-center justify-center rounded hover:bg-accent/20 text-accent/80 hover:text-accent"
                    >
                      <X aria-hidden="true" />
                    </button>
                  </span>
                ))}
                <input
                  id={tagInputId}
                  ref={tagInputRef}
                  value={tagDraft}
                  maxLength={ORGANIZER_LIMITS.tag}
                  {...NO_TEXT_ASSIST}
                  onChange={(e) => {
                    const next = e.target.value;
                    if (/[\s,،、，]$/.test(next) && next.trim()) {
                      commitDraft(next);
                    } else {
                      onTagDraftChange(next);
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey && !isImeComposing(e.nativeEvent)) {
                      e.preventDefault();
                      if (tagDraft.trim()) commitDraft();
                    } else if (e.key === 'Backspace' && tagDraft === '' && tags.length > 0) {
                      e.preventDefault();
                      onTagsChange(tags.slice(0, -1));
                    }
                  }}
                  onBlur={() => commitDraft()}
                  placeholder={tags.length ? '' : t('organize.addTag')}
                  autoComplete="off"
                  className="pn-ext-compact-input flex-1 min-w-[76px] bg-transparent text-small text-pn placeholder:text-pn-muted outline-none"
                  dir="auto"
                />
              </div>

              {suggestions.length > 0 ? (
                <div className="flex flex-wrap items-center gap-1">
                  {suggestions.map((tag) => (
                    <button
                      key={tag}
                      type="button"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => addTag(tag)}
                      className="inline-flex items-center rounded-full border border-divider bg-surface-1 px-2 py-0.5 text-meta text-pn-soft hover:border-accent/50 hover:text-accent transition-colors"
                    >
                      + {tag}
                    </button>
                  ))}
                </div>
              ) : !unlocked ? (
                <p className={SETTINGS_HELP}>{t('note.tagsHelp')}</p>
              ) : null}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
