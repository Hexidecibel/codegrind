// =============================================================================
// pattern-shapes — the code shape of each interview pattern (the /patterns page)
// =============================================================================
// Static reference content, no model call: for each pattern, the clues that
// give it away ("Spot it"), the shape in one sentence, a commented JavaScript
// template, and the trap people fall into. The "Which one?" table maps a clue
// to a pattern.
//
// Each pattern maps to the curriculum's topic ids (shared/types TOPICS) so
// links go both ways: a topic → its card (`patternForTopic`), a card → Manual
// at that topic (`topics[0]`). Prefix sum and fast & slow have no topic of
// their own; they still get cards, just no "Practice this".
//
// Also here: the 9-day Pattern Refresh plan Today runs (REFRESH_PLAN).

import type { Topic } from './types.js';

export interface WhichOneRow {
  /** What the problem says. `**bold**` marks emphasis. */
  clue: string;
  pattern: PatternId;
  label: string;
}

export interface PatternShape {
  id: PatternId;
  title: string;
  bigO: string;
  /** Curriculum topics this pattern is the shape for; [0] is the "Practice this" topic. */
  topics: Topic[];
  /** Inline markup: `**bold**` and `` `code` ``. */
  spot: string;
  shape: string;
  code: string;
  trap: string;
  /** An extra note under the template (inline markup). */
  note?: string;
}

export const PATTERN_IDS = [
  'hash-map',
  'two-pointers',
  'sliding-window',
  'binary-search',
  'prefix-sum',
  'stack',
  'bfs',
  'dfs',
  'heap',
  'intervals',
  'backtracking',
  'dynamic-programming',
  'fast-slow',
] as const;
export type PatternId = (typeof PATTERN_IDS)[number];

export function isPatternId(x: unknown): x is PatternId {
  return typeof x === 'string' && (PATTERN_IDS as readonly string[]).includes(x);
}

export const WHICH_ONE: readonly WhichOneRow[] = [
  { clue: "count, frequency, \"seen before\", pair that sums to, group by", pattern: "hash-map", label: "Hash map" },
  { clue: "sorted array, pair/triplet, palindrome, reverse in place", pattern: "two-pointers", label: "Two pointers" },
  { clue: "longest / shortest **contiguous** substring or subarray that…", pattern: "sliding-window", label: "Sliding window" },
  { clue: "sorted + find; \"minimum X such that…\"; answer has a yes/no cutoff", pattern: "binary-search", label: "Binary search" },
  { clue: "sum of a range; number of subarrays summing to k", pattern: "prefix-sum", label: "Prefix sum" },
  { clue: "brackets, undo, \"next greater/smaller element\"", pattern: "stack", label: "Stack" },
  { clue: "shortest path in steps, grid spreading, level by level", pattern: "bfs", label: "BFS" },
  { clue: "trees, explore everything, count islands, paths", pattern: "dfs", label: "DFS" },
  { clue: "top k, k-th largest, merge k sorted, always need the smallest", pattern: "heap", label: "Heap" },
  { clue: "meetings, overlapping ranges, merge ranges", pattern: "intervals", label: "Intervals" },
  { clue: "all combinations / subsets / permutations", pattern: "backtracking", label: "Backtracking" },
  { clue: "number of ways, min cost, max profit, choices that build on smaller answers", pattern: "dynamic-programming", label: "DP" },
  { clue: "linked list cycle, middle of list", pattern: "fast-slow", label: "Fast & slow" },
];

export const PATTERN_SHAPES: readonly PatternShape[] = [
  {
    id: "hash-map",
    title: "Hash map",
    bigO: "O(n) time · O(n) space",
    topics: ["hashing"],
    spot: "you're looking something up over and over, or a nested loop could become one loop.",
    shape: "one pass. For each item, **check** the map for what you need, then **store** this item.",
    code: `// Count by key
const count = new Map();
for (const x of items) count.set(x, (count.get(x) ?? 0) + 1);

// Have I seen the partner?  (check first, then store)
const seen = new Map();            // value → index
for (let i = 0; i < nums.length; i++) {
  const need = target - nums[i];
  if (seen.has(need)) return [seen.get(need), i];
  seen.set(nums[i], i);
}

// Group by a computed key (anagrams)
const groups = new Map();
for (const w of words) {
  const key = [...w].sort().join('');
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(w);
}`,
    trap: "storing before checking lets an item pair with itself.",
  },
  {
    id: "two-pointers",
    title: "Two pointers",
    bigO: "O(n) time · O(1) space",
    topics: ["two-pointer"],
    spot: "the array is **sorted** (or you can sort it), you want a pair, or you compare the two ends.",
    shape: "one pointer at each end. Look at the pair, then move the pointer that gets you closer. Or both start left: a **slow** writer and a **fast** reader.",
    code: `// Opposite ends: pair in a sorted array that sums to target
let left = 0, right = nums.length - 1;
while (left < right) {
  const sum = nums[left] + nums[right];
  if (sum === target) return [left, right];
  if (sum < target) left++;            // too small → need a bigger left
  else right--;                         // too big → need a smaller right
}

// Same direction: remove duplicates in place (slow writes, fast reads)
let slow = 0;
for (let fast = 1; fast < nums.length; fast++) {
  if (nums[fast] !== nums[slow]) nums[++slow] = nums[fast];
}
return slow + 1;                          // new length`,
    trap: "opposite-ends only works on sorted data. Unsorted pair problem? Use a hash map.",
  },
  {
    id: "sliding-window",
    title: "Sliding window",
    bigO: "O(n) time",
    topics: ["sliding-window"],
    spot: "longest / shortest / count of a **contiguous** substring or subarray that meets a rule.",
    shape: "the **end** pointer walks forward every step and takes in one item. When the window breaks the rule, **whip start forward** (removing items) until it's valid again. Then record the answer.",
    code: `// Variable window: longest substring without repeating characters
let start = 0, best = 0;
const inWindow = new Map();          // char → count inside the window

for (let end = 0; end < s.length; end++) {
  // 1. GROW: take in s[end]
  inWindow.set(s[end], (inWindow.get(s[end]) ?? 0) + 1);

  // 2. SHRINK: window broke the rule → move start up until it's valid
  while (inWindow.get(s[end]) > 1) {
    inWindow.set(s[start], inWindow.get(s[start]) - 1);
    start++;
  }

  // 3. RECORD: window [start..end] is valid now
  best = Math.max(best, end - start + 1);
}
return best;

// Fixed window of size k: max sum
let sum = 0, max = -Infinity;
for (let end = 0; end < nums.length; end++) {
  sum += nums[end];                        // add the new one
  if (end >= k) sum -= nums[end - k];     // drop the one that fell out
  if (end >= k - 1) max = Math.max(max, sum);
}`,
    trap: "the shrink is a `while`, not an `if`. One step of start may not fix it. Record **after** shrinking for \"longest\"; for \"shortest\", record **inside** the while loop, before each shrink.",
  },
  {
    id: "binary-search",
    title: "Binary search",
    bigO: "O(log n)",
    topics: ["binary-search"],
    spot: "sorted input, or the answer has a cutoff: every value below it fails and every value above it works (\"minimum speed to finish in h hours\").",
    shape: "keep a range `[lo, hi]`, check the middle, throw away the half that can't hold the answer.",
    code: `// Find target in a sorted array
let lo = 0, hi = nums.length - 1;
while (lo <= hi) {
  const mid = Math.floor((lo + hi) / 2);
  if (nums[mid] === target) return mid;
  if (nums[mid] < target) lo = mid + 1;
  else hi = mid - 1;
}
return -1;

// Binary search on the ANSWER: smallest x where works(x) is true
let lo = minPossible, hi = maxPossible;
while (lo < hi) {
  const mid = Math.floor((lo + hi) / 2);
  if (works(mid)) hi = mid;             // mid works → answer is mid or smaller
  else lo = mid + 1;                   // mid fails → answer is bigger
}
return lo;`,
    trap: "mixing the two loop styles. `lo <= hi` goes with `mid ± 1`; `lo < hi` goes with `hi = mid`. Pick one pair and stick to it.",
    note: "`(lo + hi) >> 1` is the same (right shift = halve, round down) and fine for array indexes; in JS it breaks above ~2.1 billion because `>>` works on 32-bit ints, so use `Math.floor` (or `>>> 1`) when searching a huge answer range.",
  },
  {
    id: "prefix-sum",
    title: "Prefix sum",
    bigO: "O(n)",
    topics: [],
    spot: "sums over ranges, or \"how many subarrays add up to k\".",
    shape: "running total. Sum of `i..j` is `pre[j+1] − pre[i]`. With a hash map of totals seen so far, you can count subarrays in one pass.",
    code: `// Range sums
const pre = [0];
for (const x of nums) pre.push(pre.at(-1) + x);
const rangeSum = (i, j) => pre[j + 1] - pre[i];

// Count subarrays that sum to k
const seen = new Map([[0, 1]]);       // running total → times seen
let total = 0, count = 0;
for (const x of nums) {
  total += x;
  count += seen.get(total - k) ?? 0;     // an earlier total that leaves exactly k
  seen.set(total, (seen.get(total) ?? 0) + 1);
}`,
    trap: "forgetting to start the map with `0 → 1`, which misses subarrays that start at index 0. Negative numbers break sliding window; that's when prefix sum is the answer.",
  },
  {
    id: "stack",
    title: "Stack",
    bigO: "O(n)",
    topics: ["stack"],
    spot: "matching pairs (brackets), the most recent thing matters, or \"next greater / smaller element\".",
    shape: "push as you go; pop when the new item resolves the top. For \"next greater\", keep the stack in order and pop everything the new item beats.",
    code: `// Valid brackets
const pairs = { ')': '(', ']': '[', '}': '{' };
const stack = [];
for (const ch of s) {
  if (!pairs[ch]) stack.push(ch);
  else if (stack.pop() !== pairs[ch]) return false;
}
return stack.length === 0;

// Monotonic stack: next greater element for each index
const ans = Array(nums.length).fill(-1);
const st = [];                           // indexes still waiting for a bigger value
for (let i = 0; i < nums.length; i++) {
  while (st.length && nums[i] > nums[st.at(-1)]) ans[st.pop()] = nums[i];
  st.push(i);
}`,
    trap: "push **indexes**, not values, when you need to fill an answer array or measure distance.",
  },
  {
    id: "bfs",
    title: "BFS",
    bigO: "O(V + E)",
    topics: ["bfs-dfs","graphs"],
    spot: "fewest steps / shortest path when every step costs the same; spreading through a grid; level-by-level.",
    shape: "a queue. Mark visited **when you add** to the queue. Process one whole level at a time to count steps.",
    code: `// Shortest steps in a grid from start to goal
const dirs = [[1,0],[-1,0],[0,1],[0,-1]];
const seen = new Set([\`\${sr},\${sc}\`]);
let queue = [[sr, sc]], steps = 0;

while (queue.length) {
  const next = [];
  for (const [r, c] of queue) {
    if (r === gr && c === gc) return steps;
    for (const [dr, dc] of dirs) {
      const nr = r + dr, nc = c + dc, key = \`\${nr},\${nc}\`;
      if (nr < 0 || nc < 0 || nr >= rows || nc >= cols) continue;
      if (grid[nr][nc] === '#' || seen.has(key)) continue;
      seen.add(key);                       // mark when ADDING, not when popping
      next.push([nr, nc]);
    }
  }
  queue = next;
  steps++;
}
return -1;`,
    trap: "marking visited when you pop lets the same cell enter the queue many times. Weighted edges? That's Dijkstra (BFS with a heap).",
  },
  {
    id: "dfs",
    title: "DFS / trees",
    bigO: "O(V + E)",
    topics: ["trees"],
    spot: "any tree question; explore every reachable thing; count islands; does a path exist.",
    shape: "handle the empty case, recurse on the children, combine their answers. On graphs, keep a visited set.",
    code: `// Tree: max depth (base case, recurse, combine)
function depth(node) {
  if (!node) return 0;
  return 1 + Math.max(depth(node.left), depth(node.right));
}

// Grid: count islands (sink each island as you find it)
function sink(r, c) {
  if (r < 0 || c < 0 || r >= rows || c >= cols || grid[r][c] !== '1') return;
  grid[r][c] = '0';                       // mark visited
  sink(r + 1, c); sink(r - 1, c); sink(r, c + 1); sink(r, c - 1);
}
let islands = 0;
for (let r = 0; r < rows; r++)
  for (let c = 0; c < cols; c++)
    if (grid[r][c] === '1') { islands++; sink(r, c); }`,
    trap: "missing the base case (null node, off the grid) is the most common crash. Say it first, out loud.",
  },
  {
    id: "heap",
    title: "Heap / top‑k",
    bigO: "O(n log k)",
    topics: ["heap"],
    spot: "top k, k-th largest, merge k sorted lists, \"always grab the smallest next\".",
    shape: "for the k **largest**, keep a **min**-heap of size k. Push each item; if the heap grows past k, pop the smallest. What's left is the top k.",
    code: `// JavaScript has no built-in heap. In an interview, say:
// "I'll assume a MinHeap with push / pop / peek / size", then use it.
const heap = new MinHeap();
for (const x of nums) {
  heap.push(x);
  if (heap.size() > k) heap.pop();      // throw out the smallest
}
return heap.peek();                      // k-th largest

// Small inputs: sorting is fine and simpler, O(n log n)
return [...nums].sort((a, b) => b - a)[k - 1];`,
    trap: "k largest uses a **min**-heap (so you can throw out the smallest), not a max-heap. And `.sort()` without a comparator sorts numbers as strings.",
  },
  {
    id: "intervals",
    title: "Intervals",
    bigO: "O(n log n)",
    topics: ["intervals"],
    spot: "meetings, bookings, ranges that overlap.",
    shape: "**sort by start**. Walk through: if this one starts before the last one ends, they overlap, so merge. Otherwise start a new one.",
    code: `// Merge overlapping intervals
intervals.sort((a, b) => a[0] - b[0]);
const out = [intervals[0]];
for (const [start, end] of intervals.slice(1)) {
  const last = out.at(-1);
  if (start <= last[1]) last[1] = Math.max(last[1], end);   // overlap → stretch
  else out.push([start, end]);                              // gap → new interval
}
return out;`,
    trap: "`last[1] = end` instead of `Math.max` breaks when one interval sits fully inside another.",
  },
  {
    id: "backtracking",
    title: "Backtracking",
    bigO: "exponential",
    topics: ["backtracking"],
    spot: "\"all\" combinations, subsets, permutations, ways to place things.",
    shape: "**choose** an option, **explore** (recurse), **un-choose**. Save a copy when the current path is complete.",
    code: `// All subsets
const result = [], path = [];
function go(i) {
  if (i === nums.length) { result.push([...path]); return; }  // save a COPY
  path.push(nums[i]);  go(i + 1);  path.pop();         // take it
  go(i + 1);                                          // skip it
}
go(0);
return result;`,
    trap: "`result.push(path)` without copying saves the same array over and over, and it ends up empty.",
  },
  {
    id: "dynamic-programming",
    title: "Dynamic programming",
    bigO: "usually O(n) or O(n·m)",
    topics: ["dynamic-programming"],
    spot: "\"number of ways\", \"minimum cost\", \"maximum profit\", where each choice builds on the answer to a smaller version.",
    shape: "define `dp[i]` in words first (\"best answer using the first i items\"). Write how `dp[i]` comes from earlier entries. Fill the table from small to big.",
    code: `// House robber: can't take two neighbors. dp[i] = best using houses 0..i
// dp[i] = max( skip house i → dp[i-1],  take house i → dp[i-2] + nums[i] )
let prev2 = 0, prev1 = 0;
for (const x of nums) {
  const cur = Math.max(prev1, prev2 + x);
  prev2 = prev1;
  prev1 = cur;
}
return prev1;

// Climbing stairs (1 or 2 steps): ways(i) = ways(i-1) + ways(i-2)`,
    trap: "jumping to code before you can say `dp[i]` in one sentence. If you can't, write the plain recursive version first, then add a memo.",
  },
  {
    id: "fast-slow",
    title: "Fast & slow pointers",
    bigO: "O(n) · O(1)",
    topics: [],
    spot: "linked list cycle, middle of a list, \"happy number\"-style loops.",
    shape: "slow moves 1, fast moves 2. If there's a loop, fast laps slow and they meet. If fast hits the end, there's no loop, and slow is in the middle.",
    code: `let slow = head, fast = head;
while (fast && fast.next) {
  slow = slow.next;
  fast = fast.next.next;
  if (slow === fast) return true;        // cycle
}
return false;                              // no cycle; slow is the middle`,
    trap: "checking `fast.next.next` without first checking `fast && fast.next` crashes at the end of the list.",
  },
];

const BY_ID = new Map(PATTERN_SHAPES.map((p) => [p.id, p]));

export function patternShape(id: PatternId): PatternShape {
  return BY_ID.get(id)!;
}

/** A curriculum topic → the pattern card that shows its shape, or null. */
export function patternForTopic(topic: string): PatternShape | null {
  return PATTERN_SHAPES.find((p) => (p.topics as readonly string[]).includes(topic)) ?? null;
}

/** The card's anchor on /patterns. */
export function patternHref(id: PatternId, query = ''): string {
  return `/patterns${query ? `?${query}` : ''}#${id}`;
}

/** Manual at the pattern's topic, Easy (the "Practice this" deep link). */
export function practiceHref(topic: Topic, difficulty = 'easy'): string {
  return `/manual?topic=${topic}&difficulty=${difficulty}`;
}

// -----------------------------------------------------------------------------
// The Pattern Refresh plan (Today's "Pattern refresh" mode)
// -----------------------------------------------------------------------------
export interface RefreshDayPlan {
  /** 1-based. */
  day: number;
  label: string;
  /** Null on the mixed day. */
  pattern: PatternId | null;
  topic: Topic | null;
}

export const REFRESH_PLAN: readonly RefreshDayPlan[] = [
  { day: 1, label: 'Hash map', pattern: 'hash-map', topic: 'hashing' },
  { day: 2, label: 'Two pointers', pattern: 'two-pointers', topic: 'two-pointer' },
  { day: 3, label: 'Sliding window', pattern: 'sliding-window', topic: 'sliding-window' },
  { day: 4, label: 'Binary search', pattern: 'binary-search', topic: 'binary-search' },
  { day: 5, label: 'Stack', pattern: 'stack', topic: 'stack' },
  { day: 6, label: 'BFS/DFS (trees)', pattern: 'dfs', topic: 'trees' },
  { day: 7, label: 'Heap (top-k)', pattern: 'heap', topic: 'heap' },
  { day: 8, label: 'Intervals/sorting', pattern: 'intervals', topic: 'intervals' },
  { day: 9, label: 'Mixed day', pattern: null, topic: null },
];
export const REFRESH_DAYS = REFRESH_PLAN.length;

/** The eight refresh topics (the mixed day draws from these). */
export const REFRESH_TOPICS: readonly Topic[] = REFRESH_PLAN.flatMap((d) => (d.topic ? [d.topic] : []));

// -----------------------------------------------------------------------------
// "Write it from memory" recall cards (GET /api/patterns)
// -----------------------------------------------------------------------------
/** One pattern's recall schedule, on the gap-card ladder (shared/gap-cards). */
export interface PatternRecallCard {
  id: PatternId;
  /** Rung on GAP_CARD_LADDER_DAYS. */
  step: number;
  dueAt: string;
  reps: number;
  lastGrade: 'got' | 'shaky' | 'missed' | null;
  lastReviewedAt: string | null;
  retired: boolean;
  due: boolean;
}

export interface PatternsState {
  /** Patterns written from memory at least once. */
  cards: PatternRecallCard[];
  /** Due now, oldest-due first. */
  due: PatternId[];
}
