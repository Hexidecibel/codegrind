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
// at that topic (`practiceTopicOf`) with `pattern=<id>`, so the generated
// problem uses that card's pattern. Prefix sum and fast & slow have no topic
// of their own; they practise on `practiceTopic` (hashing, linked-list), which
// `patternForTopic` never reads, so those topics keep their general cards.
// Two cards can share a topic (stack + monotonic stack, BFS + topo sort +
// union-find on graphs); `patternForTopic` returns the FIRST card in
// PATTERN_SHAPES order, so the older general card keeps the topic.
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
  /** "Practice this" topic for a card with no `topics` of its own; not used by `patternForTopic`. */
  practiceTopic?: Topic;
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
  'monotonic-stack',
  'topo-sort',
  'union-find',
  'greedy',
  'linked-list-reversal',
  'bit-manipulation',
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
  { clue: "brackets, undo, the most recent thing matters", pattern: "stack", label: "Stack" },
  { clue: "shortest path in steps, grid spreading, level by level", pattern: "bfs", label: "BFS" },
  { clue: "trees, explore everything, count islands, paths", pattern: "dfs", label: "DFS" },
  { clue: "top k, k-th largest, merge k sorted, always need the smallest", pattern: "heap", label: "Heap" },
  { clue: "meetings, overlapping ranges, merge ranges", pattern: "intervals", label: "Intervals" },
  { clue: "all combinations / subsets / permutations", pattern: "backtracking", label: "Backtracking" },
  { clue: "number of ways, min cost, max profit, choices that build on smaller answers", pattern: "dynamic-programming", label: "DP" },
  { clue: "linked list cycle, middle of list", pattern: "fast-slow", label: "Fast & slow" },
  { clue: "\"next greater / smaller element\", days until warmer, biggest rectangle in a histogram", pattern: "monotonic-stack", label: "Monotonic stack" },
  { clue: "prerequisites, build order, \"can all the tasks finish?\"", pattern: "topo-sort", label: "Topological sort" },
  { clue: "connected components, \"same group?\", which edge makes a cycle", pattern: "union-find", label: "Union-find" },
  { clue: "fewest / most of something, \"can you reach the end?\", one safe choice at each step", pattern: "greedy", label: "Greedy" },
  { clue: "reverse a linked list, or part of one (between positions, k at a time)", pattern: "linked-list-reversal", label: "List reversal" },
  { clue: "every value appears twice except one, count 1 bits, **O(1) extra space**", pattern: "bit-manipulation", label: "Bit manipulation" },
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
    shape: "one template: find the **first true** in F F F T T T. Ask \"what's my T?\", then `hi = mid` on T, `lo = mid + 1` on F, return `lo`.",
    code: `// The template: first index where isT(i) is true
let lo = 0, hi = nums.length;          // half-open [lo, hi)
while (lo < hi) {
  const mid = Math.floor((lo + hi) / 2);
  if (isT(mid)) hi = mid;              // T → answer is mid or left of it
  else lo = mid + 1;                   // F → answer is right of mid
}
return lo;                             // nums.length if there's no T

// Find target in a sorted array: T = nums[mid] >= target
let lo = 0, hi = nums.length;
while (lo < hi) {
  const mid = Math.floor((lo + hi) / 2);
  if (nums[mid] >= target) hi = mid;
  else lo = mid + 1;
}
return nums[lo] === target ? lo : -1;  // lo may be n; nums[n] is undefined, safe

// Binary search on the ANSWER: T = works(x)
let lo = minPossible, hi = maxPossible; // hi must be a value that works
while (lo < hi) {
  const mid = Math.floor((lo + hi) / 2);
  if (works(mid)) hi = mid;
  else lo = mid + 1;
}
return lo;`,
    trap: "T has to stay true once it turns true (F F F T T T, never T F T). Same three lines every time: `lo < hi`, `hi = mid`, `lo = mid + 1`. Never `mid - 1`. For the index search, `lo` can come back as `nums.length`, so check it before using it.",
    note: "`(lo + hi) >> 1` is the same (right shift = halve, round down) and fine for array indexes; in JS it breaks above ~2.1 billion because `>>` works on 32-bit ints, so use `Math.floor` (or `>>> 1`) when searching a huge answer range.",
  },
  {
    id: "prefix-sum",
    title: "Prefix sum",
    bigO: "O(n)",
    topics: [],
    practiceTopic: "hashing",
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
    spot: "matching pairs (brackets), undo, the most recent thing matters.",
    shape: "push as you go; pop when the new item resolves the top.",
    code: `// Valid brackets
const pairs = { ')': '(', ']': '[', '}': '{' };
const stack = [];
for (const ch of s) {
  if (!pairs[ch]) stack.push(ch);
  else if (stack.pop() !== pairs[ch]) return false;
}
return stack.length === 0;`,
    trap: "skipping the final `stack.length === 0` check. `\"((\"` never fails a pop, but it isn't valid.",
    note: "\"Next greater / smaller element\"? That's its own card: **Monotonic stack**.",
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
    practiceTopic: "linked-list",
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
  {
    id: "monotonic-stack",
    title: "Monotonic stack",
    bigO: "O(n) time · O(n) space",
    topics: ["stack"],
    spot: "\"next greater / smaller element\", \"how many days until it's warmer\", the biggest rectangle in a histogram. Each item waits for the first later item that beats it.",
    shape: "a **waiting room** of indexes still waiting for a bigger value. Each new value walks in and **pops everyone it beats**: it is their answer. Then it sits down and waits too.",
    code: `// Next greater element: for each index, the first bigger value to its right
const ans = Array(nums.length).fill(-1);   // -1 = nobody bigger ever came
const waiting = [];                         // the waiting room: INDEXES, not values
                                            // (their values go down, bottom to top)

for (let i = 0; i < nums.length; i++) {
  // 1. POP: nums[i] beats whoever is on top → nums[i] is their answer
  while (waiting.length && nums[i] > nums[waiting.at(-1)]) {
    const j = waiting.pop();                // j was waiting for something bigger
    ans[j] = nums[i];                       // ...and nums[i] is it
  }
  // 2. PUSH: now i waits for its own bigger value
  waiting.push(i);
}
return ans;                                 // anyone still waiting keeps -1

// Daily temperatures: the same loop, but the answer is the WAIT
//   ans[j] = i - j;                        // days j sat in the waiting room

// Largest rectangle in a histogram: the waiting room holds bars going UP.
// A shorter bar pops each taller bar: that bar's rectangle ends here.
heights.push(0);                            // a 0 at the end pops everyone left
const st = [];
let best = 0;
for (let i = 0; i < heights.length; i++) {
  while (st.length && heights[i] < heights[st.at(-1)]) {
    const h = heights[st.pop()];            // the popped bar sets the height
    const left = st.length ? st.at(-1) + 1 : 0;   // it stretches back to just past the new top
    best = Math.max(best, h * (i - left));  // ...and forward to just before i
  }
  st.push(i);
}
return best;`,
    trap: "pushing **values** instead of **indexes**. You need the index to fill `ans[j]` or to measure the wait `i - j`.",
    note: "Next **smaller**? Flip the pop test to `<`. Circular array? Loop `i` from `0` to `2n - 1` and read `nums[i % n]`.",
  },
  {
    id: "topo-sort",
    title: "Topological sort",
    bigO: "O(V + E)",
    topics: ["graphs"],
    spot: "tasks with prerequisites, \"course schedule\", build order: one thing must come **before** another.",
    shape: "count each node's **indegree** (arrows pointing in). Queue every node at 0. Take one, then knock one off each neighbor; a neighbor that hits 0 joins the queue.",
    code: `// Course schedule: can you finish all n courses? pairs are [course, prereq]
const graph = Array.from({ length: n }, () => []);
const indegree = Array(n).fill(0);          // prereqs each course still needs
for (const [course, pre] of prerequisites) {
  graph[pre].push(course);                  // arrow: pre → course
  indegree[course]++;
}

const queue = [];
for (let i = 0; i < n; i++) if (indegree[i] === 0) queue.push(i);   // ready now

for (let h = 0; h < queue.length; h++) {    // the queue doubles as the order
  const node = queue[h];                    // take this course
  for (const next of graph[node]) {
    indegree[next]--;                       // one prereq done
    if (indegree[next] === 0) queue.push(next);   // all done → ready
  }
}
return queue.length === n;                  // fewer than n → a cycle blocked some`,
    trap: "a cycle never fails loudly. Its nodes just never reach 0, so check **processed count < n** at the end.",
  },
  {
    id: "union-find",
    title: "Union-find",
    bigO: "≈ O(1) per call",
    topics: ["graphs"],
    spot: "\"number of connected components\", \"are these two in the same group?\", \"which edge makes a cycle\". Groups only ever **merge**.",
    shape: "every node points at a **parent**; the root names the group. `find` walks up to the root and flattens the path. `union` hangs the smaller tree under the bigger root.",
    code: `const parent = Array.from({ length: n }, (_, i) => i);   // everyone is their own root
const size = Array(n).fill(1);

function find(x) {
  while (parent[x] !== x) {
    parent[x] = parent[parent[x]];          // path compression: skip to grandparent
    x = parent[x];
  }
  return x;
}

function union(a, b) {
  let ra = find(a), rb = find(b);
  if (ra === rb) return false;              // already in the same group
  if (size[ra] < size[rb]) [ra, rb] = [rb, ra];
  parent[rb] = ra;                          // smaller tree under the bigger root
  size[ra] += size[rb];
  return true;
}

// Connected components: start at n, each real merge removes one
let components = n;
for (const [a, b] of edges) if (union(a, b)) components--;

// Redundant connection: the first edge whose ends are already joined
for (const [a, b] of edges) if (!union(a, b)) return [a, b];`,
    trap: "`parent[a] = b` links the nodes, not the groups. Always `find` both roots first, then link root to root.",
  },
  {
    id: "greedy",
    title: "Greedy",
    bigO: "usually O(n log n) (the sort)",
    topics: ["greedy"],
    spot: "fewest / most of something, \"can you reach the end?\", and one choice at each step looks obviously safe.",
    shape: "**sort first** (often by end), then walk once and take the locally best choice. Never go back.",
    code: `// Non-overlapping intervals: fewest to remove so none overlap
intervals.sort((a, b) => a[1] - b[1]);      // sort by END: finish early, leave room
let end = -Infinity, removed = 0;
for (const [s, e] of intervals) {
  if (s >= end) end = e;                    // fits → keep it
  else removed++;                           // overlaps → drop it (it ends later)
}
return removed;

// Jump game: can you reach the last index?
let reach = 0;                              // farthest index reachable so far
for (let i = 0; i < nums.length; i++) {
  if (i > reach) return false;              // stuck: i is past what you can reach
  reach = Math.max(reach, i + nums[i]);
}
return true;`,
    trap: "a greedy that feels right can still be wrong. **Prove it**, or try to break it with a tiny example. If a tiny example breaks it, it's DP.",
  },
  {
    id: "linked-list-reversal",
    title: "Linked list reversal",
    bigO: "O(n) time · O(1) space",
    topics: ["linked-list"],
    spot: "reverse a list, or part of one (between positions, k at a time), palindrome list.",
    shape: "three pointers: **prev**, **cur**, **next**. Save next, flip `cur.next` back to prev, step both forward. A **dummy head** saves you from special-casing the first node.",
    code: `// Reverse the whole list
let prev = null, cur = head;
while (cur) {
  const next = cur.next;                    // 1. save the rest of the list
  cur.next = prev;                          // 2. flip this arrow backwards
  prev = cur;                               // 3. step prev forward
  cur = next;                               // 4. step cur forward
}
return prev;                                // prev is the new head

// Reverse between positions left..right (1-based), with a dummy head
const dummy = { next: head };
let before = dummy;
for (let i = 1; i < left; i++) before = before.next;   // node just before the part
let p = null, c = before.next;
for (let i = left; i <= right; i++) {       // the same four lines
  const next = c.next;
  c.next = p;
  p = c;
  c = next;
}
before.next.next = c;                       // old first of the part → node after it
before.next = p;                            // node before → new first of the part
return dummy.next;`,
    trap: "setting `cur.next` before saving it loses the rest of the list. **Save next first**, always.",
    note: "Reverse in **k-groups**: check k nodes exist ahead (fewer → stop), reverse them with the same four lines, reconnect like above, then move `before` to the old first node and repeat.",
  },
  {
    id: "bit-manipulation",
    title: "Bit manipulation",
    bigO: "O(n) time · O(1) space",
    topics: ["bit-manipulation"],
    spot: "\"every value appears twice except one\", count the 1 bits, powers of two, and **O(1) extra space** with no other trick in sight.",
    shape: "XOR is a **light switch**: each value flips it, and a pair flips it back. XOR everything and only the odd one out is left on. `n & (n - 1)` drops the lowest 1 bit.",
    code: `// Single number: every value appears twice except one
let x = 0;
for (const v of nums) x ^= v;               // pairs flip back off: a ^ a = 0
return x;                                   // the one left on

// Count the 1 bits: n & (n - 1) drops the lowest one each time
let bits = 0;
while (n !== 0) {
  n &= n - 1;
  bits++;
}

// Counting bits for 0..n: i has one more 1 than i with its lowest 1 dropped
const ans = [0];
for (let i = 1; i <= n; i++) ans[i] = ans[i & (i - 1)] + 1;

// Masks
(n >> i) & 1                                // is bit i set?
n | (1 << i)                                // turn bit i on
n & ~(1 << i)                               // turn bit i off
n > 0 && (n & (n - 1)) === 0                // power of two`,
    trap: "missing the tell. **O(1) extra space** on a problem a hash map would solve is the hint to think XOR.",
    note: "`&` binds looser than `===`, so `n & 1 === 0` means `n & (1 === 0)`. Wrap bit math in parentheses.",
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

/** The topic a card's "Practice this" opens Manual at. */
export function practiceTopicOf(p: PatternShape): Topic {
  return p.practiceTopic ?? p.topics[0];
}

/** Manual at the pattern's topic, Easy (the "Practice this" deep link); `pattern` steers generation to that card. */
export function practiceHref(topic: Topic, difficulty = 'easy', pattern?: PatternId): string {
  return `/manual?topic=${topic}&difficulty=${difficulty}${pattern ? `&pattern=${pattern}` : ''}`;
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
