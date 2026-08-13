// =============================================================================
// SkillTree — the hero of Reflect
// =============================================================================
// The question this page exists to answer is "am I progressing, and what do I
// do next?", and the honest answer lives in the prerequisite DAG: 18 topics,
// most of them gated behind a mastery threshold the old dashboard never drew.
// So the tree is not a decoration under the numbers — it *is* the numbers.
//
// Encoding, and why:
//   fill      ordinal ramp by tier progress (dark → light == low → high)
//   icon      state (lock / circle / half / chevrons) — the redundant channel,
//             so state never depends on colour alone
//   label     the topic, always, for the same reason
//   tier chip the tier REACHED (`easy`, `medium`, `×7`), right-aligned on the
//             label row. There is no "mastered" here on purpose: a topic is at
//             a tier, and past the top tier the count keeps climbing.
//   locked    the muted surface + a border, deliberately *off* the ramp: an
//             unreachable topic is a different kind of thing, not "a low value"
//   edges     prerequisite links, recessive; edges pointing into locked
//             territory dim further and go dashed
//
// Clicking a node jumps Study to that topic. That is the loop the user asked
// for: reflect surfaces a weakness, one tap starts reading about it.

import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Circle, Contrast, Lock, ChevronsUp, type LucideIcon } from 'lucide-react';
import type { ReflectTreeNode, Topic } from '@/shared/types';
import { edgePath, rampFor } from './chart';
import { ChartTooltip, TooltipRow, TooltipTitle, Empty } from './primitives';
import { humanize } from '@/client/lib/format';

// --- geometry ----------------------------------------------------------------
// Sized so the whole 5-deep curriculum lands just under 1000px: it fits a
// desktop column without scrolling, and on a phone it scrolls inside its own
// box rather than dragging the page sideways.
const NODE_W = 152;
const NODE_H = 46;
const COL_GAP = 34;
const ROW_GAP = 18;
const PAD = 20;
const PITCH_X = NODE_W + COL_GAP;
const PITCH_Y = NODE_H + ROW_GAP;

type State = ReflectTreeNode['state'];

const STATE_META: Record<State, { label: string; Icon: LucideIcon; hint: string }> = {
  locked: {
    label: 'Locked',
    Icon: Lock,
    hint: 'no prerequisite has completed a tier yet',
  },
  available: { label: 'Available', Icon: Circle, hint: 'open, nothing solved yet' },
  practiced: {
    label: 'Practiced',
    Icon: Contrast,
    hint: 'attempted, no tier completed yet',
  },
  tiered: {
    label: 'Tier reached',
    Icon: ChevronsUp,
    hint: 'at least one tier complete — its dependents are open',
  },
};

const STATE_ORDER: State[] = ['locked', 'available', 'practiced', 'tiered'];

/**
 * The chip on the right of the label row. Shows the tier reached; before the
 * first tier it shows the credits banked toward it (`1/3`), and past the top
 * tier it shows the running count (`×7`) — the number that never stops.
 */
function tierChip(node: ReflectTreeNode): string | null {
  if (node.state === 'locked') return null;
  if (node.tier === 'expert') return `×${node.cleanSolves.expert}`;
  if (node.tier !== 'none') return node.tier;
  return node.towardNext > 0 ? `${node.towardNext}/${node.tierRequirement}` : null;
}

/** Two slugs are too long for a 152px node; everything else humanizes fine. */
const SHORT_LABEL: Partial<Record<Topic, string>> = {
  'dynamic-programming': 'Dynamic Prog.',
  'bit-manipulation': 'Bit Manip.',
  'bfs-dfs': 'BFS / DFS',
};

function nodeLabel(topic: Topic): string {
  return SHORT_LABEL[topic] ?? humanize(topic).replace(/-/g, ' ');
}

interface Placed {
  node: ReflectTreeNode;
  x: number;
  y: number;
}

/**
 * Layer by `depth` (server-computed longest path from a root), then order each
 * column by the mean row of its already-placed prerequisites — a single
 * barycentre pass. It is not optimal crossing-minimisation, but on this DAG it
 * is the difference between a readable tree and a bowl of spaghetti, and it
 * costs one sort per column.
 */
function layout(tree: ReflectTreeNode[]) {
  const curriculumOrder = new Map<Topic, number>(tree.map((n, i) => [n.topic, i]));
  const depths = [...new Set(tree.map((n) => n.depth))].sort((a, b) => a - b);
  const rowOf = new Map<Topic, number>();
  const columns: ReflectTreeNode[][] = [];

  for (const d of depths) {
    const nodes = tree.filter((n) => n.depth === d);
    const barycentre = (n: ReflectTreeNode) => {
      // Prereqs always sit in a strictly shallower column, so they are placed.
      const rows = n.prereqs
        .map((p) => rowOf.get(p))
        .filter((r): r is number => r !== undefined);
      return rows.length ? rows.reduce((a, b) => a + b, 0) / rows.length : 0;
    };
    nodes.sort(
      (a, b) =>
        barycentre(a) - barycentre(b) ||
        (curriculumOrder.get(a.topic) ?? 0) - (curriculumOrder.get(b.topic) ?? 0),
    );
    nodes.forEach((n, i) => rowOf.set(n.topic, i));
    columns.push(nodes);
  }

  const maxRows = Math.max(1, ...columns.map((c) => c.length));
  const width = PAD * 2 + Math.max(1, columns.length) * PITCH_X - COL_GAP;
  const height = PAD * 2 + maxRows * PITCH_Y - ROW_GAP;
  const midY = height / 2;

  const placed = new Map<Topic, Placed>();
  columns.forEach((col, ci) => {
    const colHeight = col.length * PITCH_Y - ROW_GAP;
    col.forEach((node, i) => {
      placed.set(node.topic, {
        node,
        x: PAD + ci * PITCH_X,
        y: midY - colHeight / 2 + i * PITCH_Y,
      });
    });
  });

  return { placed, width, height, order: tree.map((n) => n.topic) };
}

export function SkillTree({ tree }: { tree: ReflectTreeNode[] }) {
  const navigate = useNavigate();
  const [active, setActive] = useState<Topic | null>(null);
  const { placed, width, height, order } = useMemo(() => layout(tree), [tree]);

  if (tree.length === 0) {
    return <Empty>No curriculum data yet.</Empty>;
  }

  const hovered = active ? placed.get(active) : undefined;
  const open = (topic: Topic) => navigate(`/study?topic=${encodeURIComponent(topic)}`);

  return (
    <div>
      {/* The tree is intrinsically ~1000px wide. It scrolls in here so the page
          body never scrolls sideways at 390px. */}
      <div className="reflect-hscroll -mx-1 overflow-x-auto px-1 pb-1">
        <div className="relative" style={{ width, height }}>
          <svg
            width={width}
            height={height}
            viewBox={`0 0 ${width} ${height}`}
            role="img"
            aria-label="Prerequisite skill tree"
            className="block"
          >
            {/* --- edges, drawn first so nodes sit on top ------------------- */}
            <g fill="none" strokeLinecap="round">
              {order.map((topic) => {
                const to = placed.get(topic);
                if (!to) return null;
                const intoLocked = to.node.state === 'locked';
                return to.node.prereqs.map((p) => {
                  const from = placed.get(p);
                  if (!from) return null;
                  const lit = active === topic || active === p;
                  return (
                    <path
                      key={`${p}->${topic}`}
                      d={edgePath(
                        from.x + NODE_W,
                        from.y + NODE_H / 2,
                        to.x,
                        to.y + NODE_H / 2,
                      )}
                      className={lit ? 'stroke-foreground' : 'stroke-border'}
                      strokeWidth={lit ? 1.6 : 1.2}
                      strokeOpacity={lit ? 0.55 : intoLocked ? 0.35 : 0.9}
                      strokeDasharray={intoLocked && !lit ? '3 4' : undefined}
                    />
                  );
                });
              })}
            </g>

            {/* --- nodes ---------------------------------------------------- */}
            {order.map((topic) => {
              const p = placed.get(topic);
              if (!p) return null;
              const { node, x, y } = p;
              const locked = node.state === 'locked';
              const colour = rampFor(node.mastery);
              const { Icon, label: stateLabel } = STATE_META[node.state];
              const isActive = active === topic;
              const chip = tierChip(node);
              return (
                <g
                  key={topic}
                  tabIndex={0}
                  role="button"
                  aria-label={`${humanize(topic)} — ${stateLabel}, tier ${node.tierLabel}. Open in Study.`}
                  className="cursor-pointer outline-none"
                  onMouseEnter={() => setActive(topic)}
                  onMouseLeave={() => setActive((t) => (t === topic ? null : t))}
                  onFocus={() => setActive(topic)}
                  onBlur={() => setActive((t) => (t === topic ? null : t))}
                  onClick={() => open(topic)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      open(topic);
                    }
                  }}
                >
                  {/* Hit target, deliberately larger than the mark. */}
                  <rect
                    x={x - 6}
                    y={y - 6}
                    width={NODE_W + 12}
                    height={NODE_H + 12}
                    fill="transparent"
                  />
                  {/* Opaque backing: a few prerequisite edges skip a layer
                      (arrays → greedy) and would otherwise show through the
                      16%-opacity node fill as if they pierced it. */}
                  <rect
                    x={x}
                    y={y}
                    width={NODE_W}
                    height={NODE_H}
                    rx={9}
                    className="fill-card"
                  />
                  {locked ? (
                    // Off the ramp on purpose: unreachable is a different kind
                    // of thing, not a low value on the same scale.
                    <rect
                      x={x}
                      y={y}
                      width={NODE_W}
                      height={NODE_H}
                      rx={9}
                      className="fill-muted stroke-border"
                      fillOpacity={0.45}
                      strokeWidth={isActive ? 1.75 : 1.25}
                    />
                  ) : (
                    <rect
                      x={x}
                      y={y}
                      width={NODE_W}
                      height={NODE_H}
                      rx={9}
                      fill={colour}
                      fillOpacity={0.16}
                      stroke={colour}
                      strokeOpacity={isActive ? 0.95 : 0.5}
                      strokeWidth={isActive ? 1.75 : 1.25}
                    />
                  )}
                  {isActive && (
                    <rect
                      x={x - 3}
                      y={y - 3}
                      width={NODE_W + 6}
                      height={NODE_H + 6}
                      rx={11}
                      fill="none"
                      className="stroke-ring"
                      strokeOpacity={0.5}
                      strokeWidth={1}
                    />
                  )}

                  {/* State icon — the non-colour channel. */}
                  <g
                    transform={`translate(${x + 11},${y + 9})`}
                    className={locked ? 'text-muted-foreground' : undefined}
                    style={locked ? undefined : { color: colour }}
                  >
                    <Icon width={14} height={14} strokeWidth={2.25} />
                  </g>

                  <text
                    x={x + 32}
                    y={y + 20}
                    fontSize={11.5}
                    fontWeight={600}
                    className={locked ? 'fill-muted-foreground' : 'fill-foreground'}
                  >
                    {nodeLabel(topic)}
                  </text>

                  {/* Tier reached — the honest headline for a node. Text, not a
                      swatch: the difficulty palette is never colour-alone. */}
                  {chip && (
                    <text
                      x={x + NODE_W - 11}
                      y={y + 20}
                      textAnchor="end"
                      fontSize={9.5}
                      fontWeight={600}
                      className="fill-muted-foreground"
                    >
                      {chip}
                    </text>
                  )}

                  {/* Progress as a quantity, under the label: the ramp says
                      roughly-how-much, this says exactly-how-much. */}
                  <rect
                    x={x + 11}
                    y={y + 30}
                    width={NODE_W - 22}
                    height={4}
                    rx={2}
                    className="fill-foreground"
                    fillOpacity={0.08}
                  />
                  <rect
                    x={x + 11}
                    y={y + 30}
                    width={Math.max(0, Math.min(1, node.mastery)) * (NODE_W - 22)}
                    height={4}
                    rx={2}
                    className={locked ? 'fill-muted-foreground' : undefined}
                    fill={locked ? undefined : colour}
                    fillOpacity={locked ? 0.5 : 1}
                  />
                </g>
              );
            })}
          </svg>

          {hovered && (
            <ChartTooltip
              x={hovered.x + NODE_W / 2}
              y={hovered.y}
              containerWidth={width}
            >
              <TooltipTitle>{humanize(hovered.node.topic)}</TooltipTitle>
              <TooltipRow
                label={STATE_META[hovered.node.state].label}
                value={hovered.node.tierLabel}
              />
              <TooltipRow
                label={
                  hovered.node.nextTier
                    ? `Toward ${hovered.node.nextTier}`
                    : 'Top tier solves'
                }
                value={
                  hovered.node.nextTier
                    ? `${hovered.node.towardNext}/${hovered.node.tierRequirement} clean`
                    : String(hovered.node.cleanSolves.expert)
                }
              />
              <TooltipRow
                label="Solved"
                value={`${hovered.node.solved}/${hovered.node.attempts}`}
              />
              <TooltipRow label="Serving" value={hovered.node.difficulty} />
              <TooltipRow
                label="Box · streak"
                value={`${hovered.node.box} · ${hovered.node.streak}`}
              />
              <TooltipRow
                label="Lessons read"
                value={`${hovered.node.lessonsRead}/${hovered.node.lessonsTotal}`}
              />
              <div className="mt-1 border-t border-border pt-1 text-[0.7rem] text-muted-foreground">
                Tap to read this in Study
              </div>
            </ChartTooltip>
          )}
        </div>
      </div>

      {/* Legend — always present, icon + label per state, never colour alone. */}
      <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
        {STATE_ORDER.map((s, i) => {
          const { Icon, label, hint } = STATE_META[s];
          return (
            <li key={s} className="inline-flex items-center gap-1.5" title={hint}>
              <Icon
                className="h-3.5 w-3.5 shrink-0"
                style={
                  s === 'locked'
                    ? undefined
                    : { color: rampFor((i - 0.5) / (STATE_ORDER.length - 1)) }
                }
              />
              <span>{label}</span>
            </li>
          );
        })}
        <li className="ml-auto hidden sm:block">Tap a topic to read it in Study</li>
      </ul>
    </div>
  );
}
