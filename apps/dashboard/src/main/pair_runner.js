// Runs a pair programming solution against the problem's test cases, for real,
// with the toolchain installed on this computer. Each run gets its own temp
// folder, a generated driver, no shell, a minimal environment (no keys), capped
// output and hard timeouts. The driver only prints results; pass or fail is
// decided here, by comparing them with the expected values.
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFile } = require('node:child_process');

const COMPILE_TIMEOUT_MS = 60000;
const RUN_TIMEOUT_MS = 10000;
const MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_MESSAGE_CHARS = 4000;

// Only what compilers and runtimes need. API keys and tokens stay out.
const ENV_KEEP = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'ComSpec', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'LOCALAPPDATA', 'APPDATA', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)', 'JAVA_HOME', 'GOROOT', 'GOPATH', 'GOCACHE', 'LANG', 'LC_ALL'];

function minimalEnv(extra) {
  const env = {};
  for (const k of ENV_KEEP) if (process.env[k] !== undefined) env[k] = process.env[k];
  return { ...env, ...extra };
}

function killTree(child) {
  if (process.platform === 'win32' && child.pid) {
    execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
    return;
  }
  try {
    child.kill('SIGKILL');
  } catch (_e) {}
}

// Runs one process. Never rejects: { code, stdout, stderr, timedOut, tooMuch, missing }.
function run(cmd, args, { cwd, timeoutMs, env }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { cwd, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (_e) {
      resolve({ code: -1, stdout: '', stderr: '', missing: true });
      return;
    }
    const out = [];
    const err = [];
    let bytes = 0;
    let timedOut = false;
    let tooMuch = false;
    const onData = (list) => (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) {
        if (!tooMuch) {
          tooMuch = true;
          killTree(child);
        }
        return;
      }
      list.push(chunk);
    };
    child.stdout.on('data', onData(out));
    child.stderr.on('data', onData(err));
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);
    let missing = false;
    child.on('error', (e) => {
      missing = e && e.code === 'ENOENT';
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), timedOut, tooMuch, missing });
    });
  });
}

// ------------------------------------------------------------- literals --
const intList = (v) => v.join(',');

function javaLiteral(type, v) {
  if (type === 'int') return String(v);
  if (type === 'string') return JSON.stringify(v);
  if (type === 'int[]') return `new int[]{${intList(v)}}`;
  if (type === 'int[][]') return `new int[][]{${v.map((r) => `{${intList(r)}}`).join(',')}}`;
  if (type === 'ListNode[]') return `new ListNode[]{${v.map((r) => `Driver.list(new int[]{${intList(r)}})`).join(',')}}`;
  throw new Error(`Unknown type ${type}`);
}

function goLiteral(type, v) {
  if (type === 'int') return String(v);
  if (type === 'string') return JSON.stringify(v);
  if (type === 'int[]') return `[]int{${intList(v)}}`;
  if (type === 'int[][]') return `[][]int{${v.map((r) => `{${intList(r)}}`).join(',')}}`;
  if (type === 'ListNode[]') return `[]*ListNode{${v.map((r) => `mkList([]int{${intList(r)}})`).join(',')}}`;
  throw new Error(`Unknown type ${type}`);
}

function scriptArgs(problem, testCase, mk) {
  return problem.params
    .map((p, i) => {
      const v = testCase.args[i];
      if (p.type === 'ListNode[]') return `[${v.map((r) => `${mk}(${JSON.stringify(r)})`).join(',')}]`;
      return JSON.stringify(v);
    })
    .join(', ');
}

// -------------------------------------------------------------- drivers --
function pythonFiles(problem, code, mark) {
  const calls = problem.cases.map((c, i) => `check(${i}, lambda: Solution().${problem.fn}(${scriptArgs(problem, c, 'mk')}))`).join('\n');
  return {
    'solution.py': code,
    'driver.py': `import builtins, json, sys, time, traceback
from typing import Any, Dict, List, Optional, Set, Tuple
class ListNode:
    def __init__(self, val=0, next=None):
        self.val = val
        self.next = next
for _n, _v in dict(List=List, Optional=Optional, Dict=Dict, Set=Set, Tuple=Tuple, Any=Any, ListNode=ListNode).items():
    setattr(builtins, _n, _v)
sys.setrecursionlimit(20000)
def mk(values):
    head = None
    for v in reversed(values):
        head = ListNode(v, head)
    return head
def ser(v):
    if isinstance(v, ListNode) or (v is None and ${problem.returns === 'ListNode' ? 'True' : 'False'}):
        out = []
        n = 0
        while v is not None and n < 200000:
            out.append(v.val)
            v = v.next
            n += 1
        return out
    if isinstance(v, (tuple, set)):
        return list(v)
    return v
def emit(i, ms, kind, payload):
    sys.__stdout__.write(${JSON.stringify(mark)} + " " + str(i) + " " + str(ms) + " " + kind + " " + json.dumps(payload) + "\\n")
    sys.__stdout__.flush()
try:
    from solution import Solution
except SyntaxError:
    emit(-1, 0, "COMPILE", traceback.format_exc(limit=0))
    sys.exit(0)
except BaseException:
    emit(-1, 0, "COMPILE", traceback.format_exc(limit=-1))
    sys.exit(0)
def check(i, fn):
    start = time.perf_counter()
    try:
        value = ser(fn())
        emit(i, round((time.perf_counter() - start) * 1000), "OK", value)
    except BaseException as e:
        emit(i, round((time.perf_counter() - start) * 1000), "ERR", type(e).__name__ + ": " + str(e))
${calls}
`
  };
}

function javascriptFiles(problem, code, mark) {
  const calls = problem.cases.map((c, i) => `check(${i}, () => fn(${scriptArgs(problem, c, 'mk')}));`).join('\n');
  return {
    'solution.js': code,
    'driver.js': `'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
class ListNode { constructor(val = 0, next = null) { this.val = val; this.next = next; } }
globalThis.ListNode = ListNode;
const mk = (values) => values.reduceRight((next, v) => new ListNode(v, next), null);
const isList = ${problem.returns === 'ListNode'};
const ser = (v) => {
  if (v instanceof ListNode || (isList && v == null)) {
    const out = [];
    for (let n = 0; v && n < 200000; n += 1) { out.push(v.val); v = v.next; }
    return out;
  }
  return v === undefined ? null : v;
};
const emit = (i, ms, kind, payload) => process.stdout.write(${JSON.stringify(mark)} + ' ' + i + ' ' + ms + ' ' + kind + ' ' + JSON.stringify(payload) + '\\n');
let fn;
try {
  vm.runInThisContext(fs.readFileSync(path.join(__dirname, 'solution.js'), 'utf8'), { filename: 'solution.js' });
  fn = vm.runInThisContext(${JSON.stringify(problem.fn)});
  if (typeof fn !== 'function') throw new Error(${JSON.stringify(`${problem.fn} is not a function`)});
} catch (e) {
  emit(-1, 0, 'COMPILE', String((e && e.stack) || e).split('\\n').filter((l) => !l.trimStart().startsWith('at ') || l.includes('solution.js')).join('\\n'));
  process.exit(0);
}
const check = (i, call) => {
  const start = process.hrtime.bigint();
  const ms = () => Math.round(Number(process.hrtime.bigint() - start) / 1e6);
  try {
    const value = ser(call());
    emit(i, ms(), 'OK', value);
  } catch (e) {
    emit(i, ms(), 'ERR', String((e && e.message) || e));
  }
};
${calls}
`
  };
}

function javaFiles(problem, code, mark) {
  const calls = problem.cases
    .map((c, i) => `        { long t = System.nanoTime(); try { Object v = new Solution().${problem.fn}(${problem.params.map((p, k) => javaLiteral(p.type, c.args[k])).join(', ')}); emit(${i}, t, "OK", ser(v)); } catch (Throwable e) { emit(${i}, t, "ERR", quote(e.toString())); } }`)
    .join('\n');
  return {
    'Solution.java': code,
    'ListNode.java': 'class ListNode {\n    int val;\n    ListNode next;\n    ListNode() {}\n    ListNode(int val) { this.val = val; }\n    ListNode(int val, ListNode next) { this.val = val; this.next = next; }\n}\n',
    'Driver.java': `public class Driver {
    static ListNode list(int[] values) {
        ListNode head = null;
        for (int i = values.length - 1; i >= 0; i--) head = new ListNode(values[i], head);
        return head;
    }
    static String quote(String s) {
        StringBuilder b = new StringBuilder("\\"");
        for (char c : s.toCharArray()) {
            if (c == '"' || c == '\\\\') b.append('\\\\').append(c);
            else if (c < 32 || c > 126) b.append(String.format("\\\\u%04x", (int) c));
            else b.append(c);
        }
        return b.append('"').toString();
    }
    static String ser(Object v) {
        if (v == null) return ${problem.returns === 'ListNode' ? '"[]"' : '"null"'};
        if (v instanceof int[]) {
            StringBuilder b = new StringBuilder("[");
            int[] a = (int[]) v;
            for (int i = 0; i < a.length; i++) b.append(i > 0 ? "," : "").append(a[i]);
            return b.append("]").toString();
        }
        if (v instanceof ListNode) {
            StringBuilder b = new StringBuilder("[");
            ListNode n = (ListNode) v;
            for (int i = 0; n != null && i < 200000; i++, n = n.next) b.append(i > 0 ? "," : "").append(n.val);
            return b.append("]").toString();
        }
        if (v instanceof String) return quote((String) v);
        return String.valueOf(v);
    }
    static void emit(int i, long started, String kind, String payload) {
        System.out.println(${JSON.stringify(mark)} + " " + i + " " + Math.round((System.nanoTime() - started) / 1e6) + " " + kind + " " + payload);
        System.out.flush();
    }
    public static void main(String[] args) {
${calls}
    }
}
`
  };
}

function goFiles(problem, code, mark) {
  const calls = problem.cases
    .map((c, i) => `\tcheck(${i}, func() any { return ${problem.fn}(${problem.params.map((p, k) => goLiteral(p.type, c.args[k])).join(', ')}) })`)
    .join('\n');
  const source = /^\s*package\s+\w+/m.test(code) ? code : `package main\n\n${code}`;
  return {
    'solution.go': source,
    'driver.go': `package main

import (
\t"encoding/json"
\t"fmt"
\t"os"
\t"time"
)

type ListNode struct {
\tVal  int
\tNext *ListNode
}

func mkList(values []int) *ListNode {
\tvar head *ListNode
\tfor i := len(values) - 1; i >= 0; i-- {
\t\thead = &ListNode{values[i], head}
\t}
\treturn head
}

func normalize(v any) any {
\tif n, ok := v.(*ListNode); ok {
\t\tout := []int{}
\t\tfor i := 0; n != nil && i < 200000; i++ {
\t\t\tout = append(out, n.Val)
\t\t\tn = n.Next
\t\t}
\t\treturn out
\t}
\treturn v
}

func emit(i int, started time.Time, kind string, payload any) {
\traw, err := json.Marshal(payload)
\tif err != nil {
\t\traw = []byte("null")
\t}
\tfmt.Fprintf(os.Stdout, "%s %d %d %s %s\\n", ${JSON.stringify(mark)}, i, time.Since(started).Milliseconds(), kind, raw)
}

func check(i int, call func() any) {
\tstarted := time.Now()
\tdefer func() {
\t\tif r := recover(); r != nil {
\t\t\temit(i, started, "ERR", fmt.Sprint(r))
\t\t}
\t}()
\tv := normalize(call())
\temit(i, started, "OK", v)
}

func main() {
${calls}
}
`
  };
}

// ---------------------------------------------------------------- steps --
async function detectPython(cwd, env) {
  for (const [cmd, args] of [['python', []], ['python3', []], ['py', ['-3']]]) {
    const r = await run(cmd, [...args, '-c', 'print(1)'], { cwd, env, timeoutMs: 15000 });
    // Windows' "python" alias for the Store exits with 9009 and prints a hint.
    if (!r.missing && r.code === 0 && r.stdout.trim() === '1') return { cmd, args };
  }
  return null;
}

const PLANS = {
  python: async (dir, env) => {
    const py = await detectPython(dir, env);
    if (!py) return { missing: 'Python' };
    return { files: pythonFiles, exec: [py.cmd, [...py.args, 'driver.py'], { ...env, PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8' }] };
  },
  javascript: async (_dir, env) => ({
    files: javascriptFiles,
    exec: [process.execPath, ['--max-old-space-size=256', 'driver.js'], { ...env, ELECTRON_RUN_AS_NODE: '1' }]
  }),
  java: async (_dir, env) => ({
    files: javaFiles,
    compile: { tool: 'Java (JDK)', cmd: 'javac', args: ['-encoding', 'UTF-8', '-nowarn', 'Solution.java', 'ListNode.java', 'Driver.java'], env },
    exec: ['java', ['-Xmx256m', '-Xss16m', '-cp', '.', 'Driver'], env]
  }),
  go: async (dir, env) => {
    const bin = path.join(dir, process.platform === 'win32' ? 'solution.exe' : 'solution');
    return {
      files: goFiles,
      compile: { tool: 'Go', cmd: 'go', args: ['build', '-o', bin, 'solution.go', 'driver.go'], env: { ...env, GO111MODULE: 'off' } },
      exec: [bin, [], env]
    };
  }
};

function cleanMessage(text, dir) {
  const noPaths = String(text || '').split(dir + path.sep).join('').split(dir).join('');
  return noPaths.length > MAX_MESSAGE_CHARS ? `${noPaths.slice(0, MAX_MESSAGE_CHARS)}…` : noPaths;
}

function sameValue(actual, expected, anyOrder) {
  if (anyOrder && Array.isArray(actual) && Array.isArray(expected)) {
    const sort = (a) => [...a].sort((x, y) => x - y);
    return JSON.stringify(sort(actual)) === JSON.stringify(sort(expected));
  }
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function parseResults(stdout, mark) {
  const results = new Map();
  const userLines = [];
  let compileError = null;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.startsWith(`${mark} `)) {
      if (line) userLines.push(line);
      continue;
    }
    const m = /^(-?\d+) (\d+) (OK|ERR|COMPILE) ([\s\S]*)$/.exec(line.slice(mark.length + 1));
    if (!m) continue;
    let payload = null;
    try {
      payload = JSON.parse(m[4]);
    } catch (_e) {
      payload = m[4];
    }
    if (m[3] === 'COMPILE') compileError = String(payload);
    else results.set(Number(m[1]), { kind: m[3], ms: Number(m[2]), payload });
  }
  return { results, compileError, userOutput: userLines.join('\n') };
}

// Worst outcome wins: a compile error or missing toolchain never gets here.
function overallStatus(cases) {
  if (cases.every((c) => c.ok)) return 'accepted';
  if (cases.some((c) => c.state === 'timeout')) return 'timeout';
  if (cases.some((c) => c.state === 'runtime')) return 'runtime';
  return 'wrong';
}

async function runSolution({ problem, language, code, label }) {
  const plan = PLANS[language];
  if (!plan) return { status: 'error', message: 'Unknown language.', cases: [] };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lipcue-pair-'));
  const mark = `@@${crypto.randomBytes(9).toString('hex')}@@`;
  const started = Date.now();
  const describe = label || ((c) => JSON.stringify(c.args));
  try {
    const env = minimalEnv();
    const p = await plan(dir, env);
    if (p.missing) return { status: 'missing_toolchain', tool: p.missing, cases: [] };
    for (const [name, content] of Object.entries(p.files(problem, code, mark))) {
      fs.writeFileSync(path.join(dir, name), content, 'utf8');
    }
    if (p.compile) {
      const c = await run(p.compile.cmd, p.compile.args, { cwd: dir, env: p.compile.env, timeoutMs: COMPILE_TIMEOUT_MS });
      if (c.missing) return { status: 'missing_toolchain', tool: p.compile.tool, cases: [] };
      if (c.timedOut) return { status: 'compile', message: 'The build took too long.', cases: [] };
      if (c.code !== 0) return { status: 'compile', message: cleanMessage(c.stderr || c.stdout, dir), cases: [] };
    }
    const [cmd, args, runEnv] = p.exec;
    const r = await run(cmd, args, { cwd: dir, env: runEnv, timeoutMs: RUN_TIMEOUT_MS });
    if (r.missing) return { status: 'missing_toolchain', tool: language === 'java' ? 'Java (JDK)' : language, cases: [] };
    const { results, compileError, userOutput } = parseResults(r.stdout, mark);
    if (compileError) return { status: 'compile', message: cleanMessage(compileError, dir), cases: [] };

    const crash = cleanMessage(r.stderr, dir).trim();
    const cases = problem.cases.map((c, i) => {
      const base = { index: i, input: describe(c), expected: JSON.stringify(c.expected) };
      const res = results.get(i);
      if (!res) {
        const state = r.timedOut ? 'timeout' : 'runtime';
        const note = r.timedOut ? 'Time limit exceeded.' : r.tooMuch ? 'The program printed too much output.' : crash || 'The program stopped before this case.';
        return { ...base, ok: false, state, output: null, ms: null, error: note };
      }
      if (res.kind === 'ERR') return { ...base, ok: false, state: 'runtime', output: null, ms: res.ms, error: cleanMessage(res.payload, dir) };
      const value = problem.returns === 'int[]' && res.payload === null ? [] : res.payload;
      const ok = sameValue(value, c.expected, problem.anyOrder);
      return { ...base, ok, state: ok ? 'passed' : 'wrong', output: JSON.stringify(value), ms: res.ms };
    });
    const passed = cases.filter((c) => c.ok).length;
    return {
      status: overallStatus(cases), passed, total: cases.length, cases,
      ms: cases.reduce((sum, c) => sum + (c.ms || 0), 0),
      elapsedMs: Date.now() - started,
      stdout: cleanMessage(userOutput, dir)
    };
  } finally {
    fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }, () => {});
  }
}

module.exports = { runSolution, sameValue, parseResults, overallStatus };
