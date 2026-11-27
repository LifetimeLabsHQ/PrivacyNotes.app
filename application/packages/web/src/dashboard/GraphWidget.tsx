/**
 * Home Graph widget: live miniature constellation of linked notes in the open
 * space. Lazy-loaded from widgets.tsx so graph physics and canvas code stay
 * off the boot path.
 * Spec: docs/internal/specs/dashboard.md (section 5)
 */
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { EmptyState } from '../ui';
import { useTheme } from '../theme';
import { GraphCanvas, kindLookColor, type CanvasEdge, type CanvasNode } from '../graph/GraphCanvas';
import { buildGraphSnapshot, parseGraphSelectionId, type GraphFilters } from '../graph/graphModel';
import { useDashboardEnv } from './env';

const HOME_GRAPH_ALL: GraphFilters = {
  searchQuery: '',
  colorBy: 'looks',
  showNotes: true,
  showJournals: true,
  showMissing: false,
  showOrphans: true,
  showSuggested: false,
  collapseFolders: false,
  expandedFolderIds: new Set<string>(),
  focusNodeId: null,
  focusDepth: 1,
  maxCreatedAt: null,
};

const HOME_GRAPH_LINKED: GraphFilters = {
  ...HOME_GRAPH_ALL,
  showOrphans: false,
};

export default function GraphWidget() {
  const { t } = useTranslation(['shell', 'notes']);
  const env = useDashboardEnv();
  const dark = useTheme().theme === 'dark';

  const fullSnapshot = useMemo(
    () =>
      buildGraphSnapshot({
        notes: env.pool,
        linkIndex: env.linkIndex,
        isNoteLocked: env.isNoteLocked,
        itemStyles: env.itemStyles,
        folders: env.folders,
        suggestedEdges: [],
        filters: HOME_GRAPH_ALL,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- gatedKey tracks lock predicate changes
    [env.pool, env.linkIndex, env.gatedKey, env.itemStyles, env.folders],
  );

  const linkedCount = useMemo(() => fullSnapshot.nodes.filter((n) => n.degree > 0).length, [fullSnapshot.nodes]);
  const orphanCount = fullSnapshot.nodes.length - linkedCount;

  // When linked clusters exist, focus the compact canvas on connected notes so
  // a ring of unlinked daily logs does not push the cluster tiny in the middle.
  const snapshot = useMemo(
    () =>
      linkedCount > 0
        ? buildGraphSnapshot({
            notes: env.pool,
            linkIndex: env.linkIndex,
            isNoteLocked: env.isNoteLocked,
            itemStyles: env.itemStyles,
            folders: env.folders,
            suggestedEdges: [],
            filters: HOME_GRAPH_LINKED,
          })
        : fullSnapshot,
    // eslint-disable-next-line react-hooks/exhaustive-deps -- gatedKey tracks lock predicate changes
    [linkedCount, fullSnapshot, env.pool, env.linkIndex, env.gatedKey, env.itemStyles, env.folders],
  );

  const canvasNodes = useMemo<CanvasNode[]>(
    () =>
      snapshot.nodes.map((node) => ({
        id: node.id,
        noteId: node.noteId,
        folderId: node.folderId,
        title: node.title,
        kind: node.kind,
        colorKey: node.colorKey ?? kindLookColor(node.kind),
        tags: node.tags,
        degree: node.degree,
        inCount: node.inCount,
        outCount: node.outCount,
        memberCount: node.memberCount,
        snippet: node.snippet,
      })),
    [snapshot.nodes],
  );

  const canvasEdges = useMemo<CanvasEdge[]>(
    () =>
      snapshot.edges.map((edge) => ({
        key: edge.key,
        source: edge.source,
        target: edge.target,
        kind: edge.kind,
      })),
    [snapshot.edges],
  );

  if (snapshot.nodes.length === 0) {
    return (
      <div className="flex h-full items-center justify-center">
        <EmptyState compact flush>{t('shell:dashboard.empty.graph')}</EmptyState>
      </div>
    );
  }

  const openNode = (id: string) => {
    const parsed = parseGraphSelectionId(id);
    if (parsed.kind === 'note') env.open(parsed.id);
    else env.openGraph('graph');
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-1.5">
      <div className="relative min-h-0 flex-1 overflow-hidden rounded-lg border border-divider bg-track/40">
        <GraphCanvas
          nodes={canvasNodes}
          edges={canvasEdges}
          selectedId={env.selectedId}
          onSelectNode={(id) => {
            if (id) openNode(id);
          }}
          onOpenNode={(id) => openNode(id)}
          showArrows={false}
          showAllLabels={false}
          showFolderHalos={false}
          repelStrength={3600}
          layoutLocked
          dark={dark}
          ariaLabel={t('notes:footer.graph')}
        />
      </div>
      <p className="shrink-0 truncate text-meta tabular-nums text-pn-muted">
        {t('shell:dashboard.graphSummary', { linked: linkedCount, orphans: orphanCount })}
      </p>
    </div>
  );
}
