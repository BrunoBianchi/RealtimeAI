// Pair programming problems. The main process owns them because the test cases
// decide pass or fail; the renderer gets a copy through rtai:pair-catalog.
// Text is English source, translated by the renderer catalogs like the rest of
// the UI. Statements are written for LipCue; only the problem names are shared
// with public lists.
'use strict';

// Target time shown on the list, by difficulty.
const MINUTES = { Easy: 15, Medium: 25, Hard: 35 };

const PROBLEMS = [
  {
    id: 'two-sum', title: 'Two Sum', difficulty: 'Easy', topic: 'Arrays & Hashing',
    fn: 'twoSum', params: [{ name: 'nums', type: 'int[]' }, { name: 'target', type: 'int' }], returns: 'int[]', anyOrder: true,
    description: 'Given an array of integers nums and an integer target, return the indices of the two numbers that add up to target. Each input has exactly one solution and the same element cannot be used twice.',
    constraints: ['2 ≤ nums.length ≤ 10⁴', '−10⁹ ≤ nums[i] ≤ 10⁹', 'Exactly one answer exists'],
    clarify: ['Can there be negative numbers?', 'Can I return the indices in any order?'],
    brute: 'Brute force: two loops testing every pair, O(n²).',
    optimal: 'A hash map from value to index: for each number, I look up target minus that number.',
    hint: 'As you walk through the array, what do you need to remember about the numbers you have already seen?',
    edge: 'Think about [3,3] with target 6: the same value appears twice.',
    complexity: 'O(n) time and O(n) space for the map.',
    examples: 3,
    cases: [
      { args: [[2, 7, 11, 15], 9], expected: [0, 1] },
      { args: [[3, 2, 4], 6], expected: [1, 2] },
      { args: [[3, 3], 6], expected: [0, 1] },
      { args: [[-3, 4, 3, 90], 0], expected: [0, 2] },
      { args: [[0, 4, 3, 0], 0], expected: [0, 3] }
    ]
  },
  {
    id: 'valid-parentheses', title: 'Valid Parentheses', difficulty: 'Easy', topic: 'Stack',
    fn: 'isValid', params: [{ name: 's', type: 'string' }], returns: 'bool',
    description: 'Given a string s containing only the characters ( ) { } [ ], decide whether it is valid: every opening bracket must be closed by the same type and in the correct order.',
    constraints: ['1 ≤ s.length ≤ 10⁴', 's contains only ()[]{}'],
    clarify: ['Does the empty string count as valid?', 'Can there be characters other than brackets?'],
    brute: 'Repeatedly remove the pairs "()", "[]" and "{}" until nothing is left, O(n²).',
    optimal: 'A stack: I push the opening brackets and, on a closing one, check that the top matches.',
    hint: 'Which bracket has to be closed first: the oldest one or the most recent one?',
    edge: 'What if the string ends with opening brackets still on the stack?',
    complexity: 'O(n) time and O(n) space for the stack.',
    examples: 3,
    cases: [
      { args: ['()[]{}'], expected: true },
      { args: ['(]'], expected: false },
      { args: ['([])'], expected: true },
      { args: ['(('], expected: false },
      { args: ['([)]'], expected: false },
      { args: ['}'], expected: false }
    ]
  },
  {
    id: 'longest-substring', title: 'Longest Substring Without Repeating Characters', difficulty: 'Medium', topic: 'Sliding Window',
    fn: 'lengthOfLongestSubstring', params: [{ name: 's', type: 'string' }], returns: 'int',
    description: 'Given a string s, find the length of the longest substring without repeated characters.',
    constraints: ['0 ≤ s.length ≤ 5 · 10⁴', 's has letters, digits, symbols and spaces'],
    clarify: ['Do uppercase and lowercase count as different?', 'The substring has to be contiguous, right?'],
    brute: 'Test every substring and check for repeats, O(n³).',
    optimal: 'A sliding window with a set; when a character repeats, I move the start of the window.',
    hint: 'When a repeated character appears, do you really need to start over from zero?',
    edge: 'What about the empty string? And "pwwkew", where the answer is not a prefix?',
    complexity: 'O(n) time and O(min(n, alphabet)) space.',
    examples: 3,
    cases: [
      { args: ['abcabcbb'], expected: 3 },
      { args: ['bbbbb'], expected: 1 },
      { args: ['pwwkew'], expected: 3 },
      { args: [''], expected: 0 },
      { args: ['abba'], expected: 2 },
      { args: ['a b c'], expected: 3 }
    ]
  },
  {
    id: 'course-schedule', title: 'Course Schedule', difficulty: 'Medium', topic: 'Graphs',
    fn: 'canFinish', params: [{ name: 'numCourses', type: 'int' }, { name: 'prerequisites', type: 'int[][]' }], returns: 'bool',
    description: 'There are numCourses courses, numbered from 0 to numCourses − 1. prerequisites[i] = [a, b] means b must be taken before a. Return whether it is possible to finish all the courses.',
    constraints: ['1 ≤ numCourses ≤ 2000', '0 ≤ prerequisites.length ≤ 5000', 'All pairs are distinct'],
    clarify: ['Can there be courses with no prerequisites?', 'Can the graph have disconnected components?'],
    brute: 'For each course, run a DFS and see whether it gets back to itself.',
    optimal: 'Detect a cycle in the graph: topological sort with BFS (Kahn) and in-degrees.',
    hint: 'When is it impossible to finish all the courses? Think about a cycle.',
    edge: 'What about a course that depends on itself, like [[0,0]]?',
    complexity: 'O(V + E) time and O(V + E) space.',
    examples: 2,
    cases: [
      { args: [2, [[1, 0]]], expected: true },
      { args: [2, [[1, 0], [0, 1]]], expected: false },
      { args: [1, [[0, 0]]], expected: false },
      { args: [5, []], expected: true },
      { args: [4, [[1, 0], [2, 1], [3, 2], [1, 3]]], expected: false },
      { args: [4, [[1, 0], [2, 0], [3, 1], [3, 2]]], expected: true }
    ]
  },
  {
    id: 'cheapest-flights', title: 'Cheapest Flights Within K Stops', difficulty: 'Medium', topic: 'Graphs',
    fn: 'findCheapestPrice', params: [{ name: 'n', type: 'int' }, { name: 'flights', type: 'int[][]' }, { name: 'src', type: 'int' }, { name: 'dst', type: 'int' }, { name: 'k', type: 'int' }], returns: 'int',
    description: 'There are n cities connected by flights [from, to, price]. Return the lowest price from src to dst with at most k stops, or −1 if there is no such route.',
    constraints: ['1 ≤ n ≤ 100', '0 ≤ k < n', 'No duplicate flights'],
    clarify: ['Do k stops mean k + 1 flights?', 'Can prices be zero?'],
    brute: 'A DFS testing every route with up to k stops.',
    optimal: 'Bellman-Ford limited to k + 1 rounds, copying the price array on each round.',
    hint: 'Why can plain Dijkstra go wrong here? What does it ignore?',
    edge: 'What if the cheapest route has too many stops?',
    complexity: 'O(k · E) time and O(n) space.',
    examples: 2,
    cases: [
      { args: [4, [[0, 1, 100], [1, 2, 100], [2, 0, 100], [1, 3, 600], [2, 3, 200]], 0, 3, 1], expected: 700 },
      { args: [3, [[0, 1, 100], [1, 2, 100], [0, 2, 500]], 0, 2, 1], expected: 200 },
      { args: [3, [[0, 1, 100], [1, 2, 100], [0, 2, 500]], 0, 2, 0], expected: 500 },
      { args: [3, [[0, 1, 100]], 0, 2, 2], expected: -1 },
      { args: [4, [[0, 1, 1], [0, 2, 5], [1, 2, 1], [2, 3, 1]], 0, 3, 1], expected: 6 }
    ]
  },
  {
    id: 'merge-k-lists', title: 'Merge k Sorted Lists', difficulty: 'Hard', topic: 'Heap / Linked List',
    fn: 'mergeKLists', params: [{ name: 'lists', type: 'ListNode[]' }], returns: 'ListNode',
    description: 'You receive an array of k linked lists, each in ascending order. Merge them all into one sorted list and return it.',
    constraints: ['0 ≤ k ≤ 10⁴', '0 ≤ lists[i].length ≤ 500', 'Total nodes ≤ 10⁴'],
    clarify: ['Can any of the lists be empty?', 'Can I modify the original lists?'],
    brute: 'Put all values in an array, sort it and rebuild the list, O(N log N).',
    optimal: 'A min-heap with the first node of each list; I always take the smallest.',
    hint: 'At each step, how many candidates are you choosing the smallest from?',
    edge: 'What about lists = [] or lists = [[]]?',
    complexity: 'O(N log k) time and O(k) space for the heap.',
    examples: 2,
    cases: [
      { args: [[[1, 4, 5], [1, 3, 4], [2, 6]]], expected: [1, 1, 2, 3, 4, 4, 5, 6] },
      { args: [[]], expected: [] },
      { args: [[[]]], expected: [] },
      { args: [[[1], [], [0, 2]]], expected: [0, 1, 2] },
      { args: [[[-2, -1], [-3, 0]]], expected: [-3, -2, -1, 0] }
    ]
  },
  {
    id: 'binary-search', title: 'Binary Search', difficulty: 'Easy', topic: 'Binary Search',
    fn: 'search', params: [{ name: 'nums', type: 'int[]' }, { name: 'target', type: 'int' }], returns: 'int',
    description: 'Given nums in strictly increasing order, return the zero-based index of target, or −1 if it is absent. Use O(log n) time.',
    constraints: ['0 ≤ nums.length ≤ 10⁴', '−10⁹ ≤ nums[i], target ≤ 10⁹'],
    clarify: ['Are the indices zero-based?', 'Can the array be empty?'],
    brute: 'Scan the array from left to right in O(n) time.',
    optimal: 'Compare the midpoint with the target and discard the half that cannot contain it.',
    hint: 'What does the midpoint tell you about the entire left half?',
    edge: 'Try an empty array and a target at the last index.',
    complexity: 'O(log n) time and O(1) auxiliary space.',
    examples: 2,
    cases: [
      { args: [[-4, 0, 3, 9, 12], 9], expected: 3 },
      { args: [[-4, 0, 3, 9, 12], 5], expected: -1 },
      { args: [[], 2], expected: -1 },
      { args: [[7], 7], expected: 0 },
      { args: [[-8, -6, -3, -1], -1], expected: 3 },
      { args: [[2, 4], 2], expected: 0 }
    ]
  },
  {
    id: 'best-time-stock', title: 'Best Time to Buy and Sell Stock', difficulty: 'Easy', topic: 'Arrays',
    fn: 'maxProfit', params: [{ name: 'prices', type: 'int[]' }], returns: 'int',
    description: 'Each value in prices is the price of one stock on that day. Return the largest profit from buying once and selling on a later day. Return 0 if no trade makes a profit.',
    constraints: ['1 ≤ prices.length ≤ 10⁵', '0 ≤ prices[i] ≤ 10⁴'],
    clarify: ['Can I skip the trade?', 'Does the sale have to happen on a later day?'],
    brute: 'Try every pair of buy and sell days.',
    optimal: 'For each possible sale, track the lowest price on an earlier day.',
    hint: 'If today is your sell day, which earlier buy price gives the most profit?',
    edge: 'A falling market or a single price cannot yield a profit.',
    complexity: 'O(n) time and O(1) auxiliary space.',
    examples: 2,
    cases: [
      { args: [[7, 1, 5, 3, 6, 4]], expected: 5 },
      { args: [[7, 6, 4, 3, 1]], expected: 0 },
      { args: [[4]], expected: 0 },
      { args: [[2, 4, 1]], expected: 2 },
      { args: [[3, 3, 0, 0, 3, 1, 4]], expected: 4 },
      { args: [[1, 2, 3]], expected: 2 }
    ]
  },
  {
    id: 'valid-palindrome', title: 'Valid Palindrome', difficulty: 'Easy', topic: 'Two Pointers',
    fn: 'isPalindrome', params: [{ name: 's', type: 'string' }], returns: 'bool',
    description: 'Keep only ASCII letters and digits in s and ignore letter case. Return whether the remaining characters read the same forward and backward. An empty result is a palindrome.',
    constraints: ['0 ≤ s.length ≤ 2 · 10⁵', 's contains printable ASCII characters'],
    clarify: ['Do digits count?', 'Does punctuation count?'],
    brute: 'Build the cleaned string and compare it with its reversal.',
    optimal: 'Walk two pointers inward, skipping punctuation and comparing lowercase characters.',
    hint: 'Can you compare the two ends without building another string?',
    edge: 'Try a string with only punctuation and one with unequal digits.',
    complexity: 'O(n) time and O(1) auxiliary space with two pointers.',
    examples: 2,
    cases: [
      { args: ['Was it a car or a cat I saw?'], expected: true },
      { args: ['race a car'], expected: false },
      { args: ['  ,!'], expected: true },
      { args: ['0P'], expected: false },
      { args: ['A1, 1a'], expected: true },
      { args: [''], expected: true }
    ]
  },
  {
    id: 'merge-intervals', title: 'Merge Intervals', difficulty: 'Medium', topic: 'Intervals',
    fn: 'merge', params: [{ name: 'intervals', type: 'int[][]' }], returns: 'int[][]',
    description: 'Merge overlapping closed intervals [start, end] and return the merged intervals sorted by start. Intervals that share an endpoint overlap.',
    constraints: ['1 ≤ intervals.length ≤ 10⁴', '−10⁴ ≤ start ≤ end ≤ 10⁴'],
    clarify: ['Do intervals that touch at an endpoint overlap?', 'Is the input sorted?'],
    brute: 'Keep comparing and merging pairs until no overlap remains.',
    optimal: 'Sort by start, then scan once and extend the last merged interval when it overlaps.',
    hint: 'After sorting by start, which merged interval can overlap the next one?',
    edge: 'Try nested intervals and intervals that touch at a single point.',
    complexity: 'O(n log n) time to sort and O(n) space for the result.',
    examples: 2,
    cases: [
      { args: [[[1, 3], [2, 6], [8, 10], [15, 18]]], expected: [[1, 6], [8, 10], [15, 18]] },
      { args: [[[4, 5], [1, 4]]], expected: [[1, 5]] },
      { args: [[[1, 10], [2, 3], [4, 8]]], expected: [[1, 10]] },
      { args: [[[5, 5], [-1, -1], [2, 3]]], expected: [[-1, -1], [2, 3], [5, 5]] },
      { args: [[[1, 3], [5, 7], [3, 5]]], expected: [[1, 7]] }
    ]
  },
  {
    id: 'coin-change', title: 'Coin Change', difficulty: 'Medium', topic: 'Dynamic Programming',
    fn: 'coinChange', params: [{ name: 'coins', type: 'int[]' }, { name: 'amount', type: 'int' }], returns: 'int',
    description: 'Given coin denominations and a target amount, return the fewest coins needed to make exactly that amount, or −1 if it is impossible. Each denomination can be used any number of times.',
    constraints: ['1 ≤ coins.length ≤ 12', '1 ≤ coins[i] ≤ 10⁴', '0 ≤ amount ≤ 10⁴'],
    clarify: ['Can I use a denomination more than once?', 'How many coins are needed for amount zero?'],
    brute: 'Try all ways of subtracting coins until the remainder is zero.',
    optimal: 'Store the minimum coins for every smaller amount and try each denomination as the last coin.',
    hint: 'If you choose the last coin, what smaller amount must already be possible?',
    edge: 'The largest coin first is not always optimal, as in [1, 3, 4] for amount 6.',
    complexity: 'O(amount · coins.length) time and O(amount) space.',
    examples: 2,
    cases: [
      { args: [[1, 2, 5], 11], expected: 3 },
      { args: [[2], 3], expected: -1 },
      { args: [[3, 4], 0], expected: 0 },
      { args: [[1, 3, 4], 6], expected: 2 },
      { args: [[2, 5, 10], 1], expected: -1 },
      { args: [[7], 21], expected: 3 }
    ]
  },
  {
    id: 'daily-temperatures', title: 'Daily Temperatures', difficulty: 'Medium', topic: 'Monotonic Stack',
    fn: 'dailyTemperatures', params: [{ name: 'temperatures', type: 'int[]' }], returns: 'int[]',
    description: 'For each day, return the number of days until the first strictly warmer day. Use 0 when no warmer day follows. Return the answers in the same order as the input.',
    constraints: ['1 ≤ temperatures.length ≤ 10⁵', '−100 ≤ temperatures[i] ≤ 100'],
    clarify: ['Does the same temperature count as warmer?', 'What should the last day return?'],
    brute: 'Scan forward separately from every day until finding a warmer one.',
    optimal: 'Keep unresolved indices in a stack and pop them when a warmer day arrives.',
    hint: 'Which earlier days can today resolve? Which of those is most recent?',
    edge: 'Try equal temperatures followed by one warmer day.',
    complexity: 'O(n) time and O(n) auxiliary space.',
    examples: 2,
    cases: [
      { args: [[73, 74, 75, 71, 69, 72, 76, 73]], expected: [1, 1, 4, 2, 1, 1, 0, 0] },
      { args: [[30, 30, 31]], expected: [2, 1, 0] },
      { args: [[20]], expected: [0] },
      { args: [[5, 4, 3, 2]], expected: [0, 0, 0, 0] },
      { args: [[-5, -3, -4, -2]], expected: [1, 2, 1, 0] }
    ]
  },
  {
    id: 'trapping-rain-water', title: 'Trapping Rain Water', difficulty: 'Hard', topic: 'Two Pointers',
    fn: 'trap', params: [{ name: 'height', type: 'int[]' }], returns: 'int',
    description: 'Each nonnegative height describes a bar one unit wide. Return the total number of water units that remain trapped between the bars after it rains.',
    constraints: ['0 ≤ height.length ≤ 2 · 10⁴', '0 ≤ height[i] ≤ 10⁴'],
    clarify: ['Are all bars one unit wide?', 'Can a bar have height zero?'],
    brute: 'For each bar, scan both sides for the tallest barriers.',
    optimal: 'Track the tallest walls seen from both ends and advance the side with the lower wall.',
    hint: 'Which of the two walls determines how high water can rise at a position?',
    edge: 'Increasing and decreasing profiles trap no water.',
    complexity: 'O(n) time and O(1) auxiliary space.',
    examples: 2,
    cases: [
      { args: [[0, 1, 0, 2, 1, 0, 1, 3, 2, 1, 2, 1]], expected: 6 },
      { args: [[4, 2, 0, 3, 2, 5]], expected: 9 },
      { args: [[]], expected: 0 },
      { args: [[1, 2, 3, 4]], expected: 0 },
      { args: [[3, 0, 3, 0, 3]], expected: 6 },
      { args: [[5, 4, 1, 2]], expected: 1 }
    ]
  },
  {
    id: 'first-missing-positive', title: 'First Missing Positive', difficulty: 'Hard', topic: 'Arrays',
    fn: 'firstMissingPositive', params: [{ name: 'nums', type: 'int[]' }], returns: 'int',
    description: 'Return the smallest positive integer absent from nums. Use O(n) time and O(1) extra space. You may rearrange the input array.',
    constraints: ['1 ≤ nums.length ≤ 10⁵', '−10⁹ ≤ nums[i] ≤ 10⁹'],
    clarify: ['Can I modify the array?', 'Can values repeat?'],
    brute: 'Try positive integers in order and scan the entire array for each one.',
    optimal: 'Move every value x in the range 1 through n to index x − 1, then find the first mismatch.',
    hint: 'If the array has n elements, how large can the answer be?',
    edge: 'A duplicate must not cause an endless cycle of swaps.',
    complexity: 'O(n) time and O(1) auxiliary space.',
    examples: 2,
    cases: [
      { args: [[1, 2, 0]], expected: 3 },
      { args: [[3, 4, -1, 1]], expected: 2 },
      { args: [[7, 8, 9, 11, 12]], expected: 1 },
      { args: [[1, 1]], expected: 2 },
      { args: [[2]], expected: 1 },
      { args: [[2, 3, 4, 1]], expected: 5 }
    ]
  },
  {
    id: 'sliding-window-maximum', title: 'Sliding Window Maximum', difficulty: 'Hard', topic: 'Sliding Window',
    fn: 'maxSlidingWindow', params: [{ name: 'nums', type: 'int[]' }, { name: 'k', type: 'int' }], returns: 'int[]',
    description: 'For each contiguous window of exactly k elements in nums, return its maximum. List the maxima from the leftmost window to the rightmost.',
    constraints: ['1 ≤ k ≤ nums.length ≤ 10⁵', '−10⁴ ≤ nums[i] ≤ 10⁴'],
    clarify: ['Does the window move one index at a time?', 'Can k equal the length of nums?'],
    brute: 'Compute the maximum from scratch for every window.',
    optimal: 'Keep indices in a decreasing deque. Remove expired indices from the front and dominated values from the back.',
    hint: 'Which smaller values can a later, larger value make irrelevant?',
    edge: 'Try equal maxima at different indices and a window of size one.',
    complexity: 'O(n) time and O(k) auxiliary space.',
    examples: 2,
    cases: [
      { args: [[1, 3, -1, -3, 5, 3, 6, 7], 3], expected: [3, 3, 5, 5, 6, 7] },
      { args: [[-1, -4, -2], 2], expected: [-1, -2] },
      { args: [[4, 4, 1, 2], 2], expected: [4, 4, 2] },
      { args: [[2, 1, 3], 1], expected: [2, 1, 3] },
      { args: [[2, 4, 1], 3], expected: [4] },
      { args: [[9, 7, 5, 3, 1], 2], expected: [9, 7, 5, 3] }
    ]
  }
];

const LANGUAGES = {
  python: { name: 'Python', ext: 'py' },
  javascript: { name: 'JavaScript', ext: 'js' },
  java: { name: 'Java', ext: 'java' },
  go: { name: 'Go', ext: 'go' }
};

const PY_TYPES = { int: 'int', string: 'str', bool: 'bool', 'int[]': 'List[int]', 'int[][]': 'List[List[int]]', 'ListNode[]': 'List[Optional[ListNode]]', ListNode: 'Optional[ListNode]' };
const JS_TYPES = { int: 'number', string: 'string', bool: 'boolean', 'int[]': 'number[]', 'int[][]': 'number[][]', 'ListNode[]': 'Array<ListNode|null>', ListNode: 'ListNode|null' };
const JAVA_TYPES = { int: 'int', string: 'String', bool: 'boolean', 'int[]': 'int[]', 'int[][]': 'int[][]', 'ListNode[]': 'ListNode[]', ListNode: 'ListNode' };
const GO_TYPES = { int: 'int', string: 'string', bool: 'bool', 'int[]': '[]int', 'int[][]': '[][]int', 'ListNode[]': '[]*ListNode', ListNode: '*ListNode' };

// The code a session starts from, with the signature the tests call.
function starter(problem, language) {
  const { fn, params, returns } = problem;
  const usesList = returns === 'ListNode' || params.some((p) => p.type.startsWith('ListNode'));
  if (language === 'python') {
    const sig = ['self', ...params.map((p) => `${p.name}: ${PY_TYPES[p.type]}`)].join(', ');
    const note = usesList ? '# ListNode has .val and .next and is already defined.\n' : '';
    return `${note}class Solution:\n    def ${fn}(${sig}) -> ${PY_TYPES[returns]}:\n        pass\n`;
  }
  if (language === 'javascript') {
    const docs = params.map((p) => ` * @param {${JS_TYPES[p.type]}} ${p.name}`).join('\n');
    const note = usesList ? '// ListNode has .val and .next and is already defined.\n' : '';
    return `${note}/**\n${docs}\n * @return {${JS_TYPES[returns]}}\n */\nvar ${fn} = function (${params.map((p) => p.name).join(', ')}) {\n    \n};\n`;
  }
  if (language === 'java') {
    const sig = params.map((p) => `${JAVA_TYPES[p.type]} ${p.name}`).join(', ');
    const note = usesList ? '// ListNode has .val and .next and is already defined.\n' : '';
    return `import java.util.*;\n\n${note}class Solution {\n    public ${JAVA_TYPES[returns]} ${fn}(${sig}) {\n        \n    }\n}\n`;
  }
  const sig = params.map((p) => `${p.name} ${GO_TYPES[p.type]}`).join(', ');
  const note = usesList ? '// ListNode has Val and Next and is already defined.\n' : '';
  return `package main\n\n${note}func ${fn}(${sig}) ${GO_TYPES[returns]} {\n    \n}\n`;
}

// "nums = [2,7], target = 9": how a case reads on screen.
function caseLabel(problem, testCase) {
  return problem.params
    .map((p, i) => `${p.name} = ${JSON.stringify(testCase.args[i])}`)
    .join(', ');
}

// What the renderer needs. Case answers are shown on purpose: this is practice,
// and the result panel displays expected and actual output side by side.
function catalog(includeCoaching) {
  return {
    languages: Object.entries(LANGUAGES).map(([id, l]) => ({ id, name: l.name, ext: l.ext })),
    problems: PROBLEMS.map((p) => ({
      id: p.id, title: p.title, difficulty: p.difficulty, topic: p.topic, minutes: MINUTES[p.difficulty],
      description: p.description, constraints: p.constraints,
      ...(includeCoaching && { clarify: p.clarify, brute: p.brute, optimal: p.optimal, hint: p.hint, edge: p.edge, complexity: p.complexity }),
      examples: p.cases.slice(0, p.examples).map((c) => ({ input: caseLabel(p, c), output: JSON.stringify(c.expected) })),
      cases: p.cases.map((c) => ({ input: caseLabel(p, c), output: JSON.stringify(c.expected) })),
      starters: Object.fromEntries(Object.keys(LANGUAGES).map((id) => [id, starter(p, id)]))
    }))
  };
}

const problemById = (id) => PROBLEMS.find((p) => p.id === id) || null;

module.exports = { PROBLEMS, LANGUAGES, catalog, problemById, starter, caseLabel };
