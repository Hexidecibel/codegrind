#!/usr/bin/env python3
# =============================================================================
# codegrind sandbox test harness — Python
# =============================================================================
# Runs inside the ephemeral, network-less Docker container started by
# bin/run-submission. Reads the user's solution (raw Python) and a tests JSON
# blob, calls the target function once per test case, deep-equal-compares the
# return value to `expected`, and prints a SINGLE JSON blob to stdout.
#
#   python3 runner.py <solution.py> <tests.json>
#   python3 runner.py --selftest [equality-cases.json]
#
#   tests.json  { "functionName": "...", "tests": [{ name, args, expected }] }
#
#   stdout      { phase, results: [{ name, passed, expected, actual, stderr,
#                                    stdout, timeMs }], passed, total, stdout? }
#               or, when nothing could be run,
#               { phase, results: [], passed: 0, total: 0, error, stdout? }
#
# This file is the Python half of a contract whose other half is
# javascript/runner.mjs. Read that file's header first — the reasoning behind
# the stdout contract, the phases and the sorted-key serializer is written out
# there and is not repeated here. What IS written out here is every place where
# Python forces a decision JavaScript never had to make: bool-before-int, the
# recursion limit, tuples and sets, bignums, and float formatting.
#
# ZERO pip dependencies, by design. The image is `python:3.12-slim` and nothing
# is installed into it: the sandbox runs with --network none, so a dependency
# would have to be baked in, and every baked-in package is more attack surface
# and more drift between "what the image has" and "what the problem may use".

import io
import json
import os
import sys
import threading
import time

PHASE_COMPILE = "compile"
PHASE_LOAD = "load"
PHASE_RUN = "run"

# -----------------------------------------------------------------------------
# Recursion depth — not optional
# -----------------------------------------------------------------------------
# CPython's default recursion limit is 1000, and the C stack behind it is
# whatever the OS gave the main thread (8 MB here). A depth-first search over a
# 2*10^5-node path — the input size the `expert` rubric explicitly asks the
# generator to reach for — is a legitimate solution that dies at frame 1000 with
# "maximum recursion depth exceeded". The candidate reads that as their bug. It
# is not; it is the harness refusing to run their program.
#
# Raising sys.setrecursionlimit alone just moves the failure from a clean
# RecursionError to a hard segfault, because the limit is a counter and the
# stack is the real constraint. So both are raised, and the second one can only
# be raised for a NEW THREAD: threading.stack_size() sets the size of threads
# created after it, and cannot resize the already-running main thread. That is
# the whole reason every piece of user code below runs on a worker thread rather
# than inline.
RECURSION_LIMIT = 30_000
THREAD_STACK_BYTES = 64 * 1024 * 1024

sys.setrecursionlimit(RECURSION_LIMIT)
try:
    threading.stack_size(THREAD_STACK_BYTES)
except (ValueError, RuntimeError):
    # Some platforms cap or refuse the request. Losing the big stack is a
    # degradation (deep recursion will RecursionError instead of running), not a
    # reason to refuse to run anything at all.
    pass


def run_on_stack(fn):
    """Run `fn()` on a thread with the big stack; re-raise whatever it raised.

    Returns fn's value. The thread is joined with no timeout on purpose: the
    outer `timeout` in bin/run-submission owns wall-clock enforcement and kills
    the whole container, which is the only thing that can stop a tight loop in
    CPython anyway. A timeout here would leave the runaway thread alive inside a
    process that then tried to print a payload.
    """
    box = {}

    def target():
        try:
            box["value"] = fn()
        except BaseException as exc:  # noqa: BLE001 — re-raised on the caller's thread
            box["error"] = exc

    thread = threading.Thread(target=target, daemon=True)
    thread.start()
    thread.join()
    if "error" in box:
        raise box["error"]
    return box.get("value")


# -----------------------------------------------------------------------------
# stdout capture
# -----------------------------------------------------------------------------
# `print` looks up sys.stdout at call time, so swapping the object catches every
# route a solution has to the payload stream. A solution that reaches around it
# with os.write(1, ...) still gets through — exactly as a JS solution that calls
# process.binding does. Both harnesses cover the route people actually take.
#
# The payload itself is written with os.write(1, ...) rather than through
# sys.stdout, so it cannot be swallowed by a capture window that a raising
# solution left open, and cannot be lost to buffering at exit.

STDOUT_CAP = 8 * 1024


class _CappedCapture(io.TextIOBase):
    """A write-only text sink that keeps at most STDOUT_CAP characters."""

    def __init__(self):
        self.parts = []
        self.size = 0
        self.truncated = False

    def writable(self):
        return True

    def write(self, text):
        if not isinstance(text, str):
            text = str(text)
        room = STDOUT_CAP - self.size
        if room > 0:
            take = text[:room]
            self.parts.append(take)
            self.size += len(take)
            if len(take) < len(text):
                self.truncated = True
        elif text:
            self.truncated = True
        # Honour the io contract: `print` and friends expect the character count.
        return len(text)

    def flush(self):
        return None

    def collect(self):
        text = "".join(self.parts)
        if self.truncated:
            text += f"\n… (output truncated at {STDOUT_CAP} bytes)"
        return text or None


class capture_stdout:
    """Context manager: `with capture_stdout() as cap: ...; cap.collect()`."""

    def __enter__(self):
        self._sink = _CappedCapture()
        self._saved = sys.stdout
        sys.stdout = self._sink
        return self._sink

    def __exit__(self, *_exc):
        sys.stdout = self._saved
        return False


# -----------------------------------------------------------------------------
# Equality — the shared spec, hand-written here
# -----------------------------------------------------------------------------
# The fixture (conformance/equality-cases.json) is the contract; this is one of
# three implementations of it. `--selftest` is what keeps them from drifting.
#
# Rules: arrays order-SENSITIVE, objects key-order-INSENSITIVE, NaN == NaN,
# fractional numbers within tolerance, no type coercion ever.

FLOAT_ABS_TOL = 1e-9
FLOAT_REL_TOL = 1e-9


def _is_number(v):
    """True for a JSON number. bool is checked FIRST — in Python `isinstance(True,
    int)` is True, so without this every `True` would be a 1 and the fixture's
    `true is not one` case would fail. This is the single most common way a
    hand-written Python comparator goes wrong."""
    return not isinstance(v, bool) and isinstance(v, (int, float))


def _is_seq(v):
    """A JSON array. A tuple is one too: it is the natural Python return type for
    "give me a pair", and rejecting it would fail correct solutions over a
    bracket shape that JSON does not even distinguish."""
    return isinstance(v, (list, tuple))


def _is_set(v):
    return isinstance(v, (set, frozenset))


def _is_integral(v):
    """True when the value has no fractional part, whatever its Python type.
    2 and 2.0 must agree about this or the exact/tolerant split below would
    depend on which literal the solution happened to write."""
    if isinstance(v, int):
        return True
    try:
        return v.is_integer()
    except (AttributeError, ValueError, OverflowError):
        return False


def _is_finite(v):
    if isinstance(v, int):
        return True
    return v == v and v not in (float("inf"), float("-inf"))


def numbers_equal(a, b):
    """`abs(a-b) <= max(1e-9, 1e-9*max(|a|,|b|))`, behind three guards.

    See conformance/equality-cases.json → encoding.floatTolerance. In short:
    NaN equals NaN; non-finite values never reach the tolerance (abs(inf - -inf)
    is inf and so is the tolerance, and inf <= inf is true, so an unguarded
    version declares the two infinities equal); and two integral values compare
    EXACTLY, because a relative 1e-9 near 2^53 is a slack of ~9 million and
    would accept a count that is off by one.
    """
    a_nan = isinstance(a, float) and a != a
    b_nan = isinstance(b, float) and b != b
    if a_nan or b_nan:
        return a_nan and b_nan
    if not _is_finite(a) or not _is_finite(b):
        # Both non-finite and same sign is the only equal case left.
        return _is_finite(a) == _is_finite(b) and a == b
    if a == b:
        return True
    if _is_integral(a) and _is_integral(b):
        return False
    tol = max(FLOAT_ABS_TOL, FLOAT_REL_TOL * max(abs(a), abs(b)))
    return abs(a - b) <= tol


def deep_equal(a, b):
    if _is_number(a) and _is_number(b):
        return numbers_equal(a, b)
    if isinstance(a, bool) or isinstance(b, bool):
        # bool only equals bool. Checked before every structural branch so a
        # True can never be compared as the integer 1.
        return isinstance(a, bool) and isinstance(b, bool) and a is b
    if a is None or b is None:
        return a is None and b is None
    if isinstance(a, str) or isinstance(b, str):
        return isinstance(a, str) and isinstance(b, str) and a == b

    # A set on either side makes the comparison order-INSENSITIVE for both, so
    # `{3,1,2}` matches the `[1,2,3]` that came back out of the expected JSON —
    # and matches it regardless of what order that JSON happens to be in, which
    # is the point of having returned a set.
    if _is_set(a) or _is_set(b):
        if not (_is_set(a) or _is_seq(a)) or not (_is_set(b) or _is_seq(b)):
            return False
        left = sorted(a, key=sort_key)
        right = sorted(b, key=sort_key)
        return len(left) == len(right) and all(deep_equal(x, y) for x, y in zip(left, right))

    if _is_seq(a) or _is_seq(b):
        if not _is_seq(a) or not _is_seq(b):
            return False
        return len(a) == len(b) and all(deep_equal(x, y) for x, y in zip(a, b))

    if isinstance(a, dict) or isinstance(b, dict):
        if not isinstance(a, dict) or not isinstance(b, dict):
            return False
        if len(a) != len(b):
            return False
        for k, v in a.items():
            if k not in b:
                return False
            if not deep_equal(v, b[k]):
                return False
        return True

    return a is b or a == b


def sort_key(value):
    """Total order over JSON-ish values, used to sort a set's elements.

    A three-slot tuple rather than the obvious `(rank, value)` because Python
    refuses to compare a str with a float: every rank must put the SAME type in
    each slot. Numbers sort numerically (so 9 precedes 10, unlike a text sort),
    strings by code point, everything else by its canonical JSON text, which is
    at least stable and reproducible.
    """
    if value is None:
        return (0, 0.0, "")
    if isinstance(value, bool):
        return (1, float(value), "")
    if _is_number(value):
        try:
            return (2, float(value), "")
        except (OverflowError, ValueError):
            return (2, float("inf") if value > 0 else float("-inf"), "")
    if isinstance(value, str):
        return (3, 0.0, value)
    ok, text = _try_serialize(value)
    return (4, 0.0, text if ok else repr(value))


# -----------------------------------------------------------------------------
# Canonical serialization — STRICT JSON, keys sorted, JavaScript's number text
# -----------------------------------------------------------------------------
# `json.dumps` is not used for the structure. Two reasons, both proven by the
# fixture:
#
# 1. Key order. json.dumps(sort_keys=True) sorts by Python's code-POINT order;
#    JavaScript's Array.prototype.sort compares UTF-16 code UNITS. They agree on
#    everything below U+10000 and disagree above it. Sorting on the utf-16-be
#    encoding is code-unit order exactly, so both runtimes emit one canonical
#    text for one value. Cheap insurance against a class of drift that would
#    otherwise only show up as an unexplainable diff.
#
# 2. Number text. Python's repr(2.0) is "2.0"; JavaScript's String(2) is "2".
#    Python's repr(1e-5) is "1e-05"; JavaScript's is "1e-5". The stored
#    `expected` of a problem is this text, so two spellings of one value is two
#    problems that look identical and grade differently. js_number below is
#    ECMA-262's Number::toString, reimplemented.
#
# Scalar STRING escaping does go through json.dumps: it matches JSON.stringify
# exactly (short escapes for the usual controls, \u00XX for the rest, `/` left
# alone, non-ASCII emitted literally under ensure_ascii=False), and re-deriving
# string escaping by hand is how you get a subtly wrong one.

MAX_SAFE_INTEGER = 2**53 - 1


def js_number(x):
    """Render a finite number exactly as JavaScript's String(Number) would.

    ECMA-262 Number::toString: let the value be s * 10^(n-k) where s is the
    shortest decimal digit string that round-trips, of k digits. Then the
    format is chosen from n alone. Python's repr already gives the shortest
    round-tripping digits; all this does is re-render them under JS's rules.
    """
    if isinstance(x, int):
        return str(x)
    if x == 0:
        return "0"  # covers -0.0: JavaScript's String(-0) is "0"

    negative = x < 0
    text = repr(abs(float(x)))

    if "e" in text or "E" in text:
        mantissa, exponent = text.lower().split("e")
        exp = int(exponent)
    else:
        mantissa, exp = text, 0

    if "." in mantissa:
        int_part, frac_part = mantissa.split(".")
    else:
        int_part, frac_part = mantissa, ""

    raw = int_part + frac_part
    # value == int(raw) * 10 ** (exp - len(frac_part))
    digits = str(int(raw))  # drops leading zeros
    stripped = digits.rstrip("0")
    trailing = len(digits) - len(stripped)
    if not stripped:
        return "0"
    k = len(stripped)
    n = exp - len(frac_part) + trailing + k

    if k <= n <= 21:
        out = stripped + "0" * (n - k)
    elif 0 < n <= 21:
        out = stripped[:n] + "." + stripped[n:]
    elif -6 < n <= 0:
        out = "0." + "0" * (-n) + stripped
    else:
        head = stripped[0] if k == 1 else stripped[0] + "." + stripped[1:]
        e = n - 1
        out = f"{head}e{'+' if e >= 0 else '-'}{abs(e)}"

    return "-" + out if negative else out


class Unserializable(Exception):
    """Raised with a human-readable note when a value has no JSON form."""


def _object_key(key):
    """The property NAME a key becomes in JSON.

    Python dicts happily key on ints, floats, tuples and None; JSON objects key
    only on strings. JSON.stringify coerces with ToString, and this matches it,
    so `{1: "a"}` and `{"1": "a"}` are one value in both runtimes. A tuple key
    has no JS analogue at all and is refused rather than guessed at.
    """
    if isinstance(key, str):
        return key
    if isinstance(key, bool):
        return "true" if key else "false"
    if key is None:
        return "null"
    if _is_number(key):
        if isinstance(key, float) and (key != key or not _is_finite(key)):
            return "NaN" if key != key else ("Infinity" if key > 0 else "-Infinity")
        return js_number(key)
    raise Unserializable(f"object key of type {type(key).__name__} has no JSON form")


def _utf16_order(text):
    """Sort key giving UTF-16 code-UNIT order, which is what JS's sort() uses."""
    return text.encode("utf-16-be", "surrogatepass")


def serialize(value, seen):
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        # Python integers are arbitrary precision; JSON numbers, once they reach
        # Node's JSON.parse (which is where every `expected` lands), are IEEE-754
        # doubles. Emitting 2**60 would produce valid JSON that silently becomes
        # a DIFFERENT number on the other side, get stored as `expected`, and
        # then never match a correct answer again. Refusing is the only outcome
        # that is visible to anyone.
        if abs(value) > MAX_SAFE_INTEGER:
            raise Unserializable(
                f"integer {value} is outside the ±(2^53-1) range JSON numbers survive; "
                "keep results inside ±9007199254740991"
            )
        return str(value)
    if isinstance(value, float):
        # NaN and ±Infinity are not JSON. `null` is what JSON.stringify emits.
        if value != value or not _is_finite(value):
            return "null"
        return js_number(value)
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)

    if id(value) in seen:
        raise Unserializable("circular structure")

    if _is_seq(value) or _is_set(value):
        seen.add(id(value))
        try:
            # A set has no order of its own, so it is given one — sorted, so the
            # same set always renders as the same text. Sequences are NEVER
            # sorted: their order is part of the value.
            items = sorted(value, key=sort_key) if _is_set(value) else value
            out = "[" + ",".join(serialize(item, seen) for item in items) + "]"
        finally:
            seen.discard(id(value))
        return out

    if isinstance(value, dict):
        seen.add(id(value))
        try:
            pairs = []
            for key in value:
                name = _object_key(key)
                pairs.append((name, serialize(value[key], seen)))
            pairs.sort(key=lambda kv: _utf16_order(kv[0]))
            out = "{" + ",".join(
                f"{json.dumps(name, ensure_ascii=False)}:{text}" for name, text in pairs
            ) + "}"
        finally:
            seen.discard(id(value))
        return out

    # Anything else — a class instance, a generator, bytes, complex, a module.
    # JavaScript's `undefined` has no counterpart worth mimicking here: a Python
    # function that forgets to return yields None, which IS a JSON value, so an
    # unserializable return is never an innocent omission. Say so.
    raise Unserializable(f"value of type {type(value).__name__} has no JSON representation")


def _try_serialize(value):
    try:
        return True, serialize(value, set())
    except Unserializable:
        return False, ""
    except RecursionError:
        return False, ""


def canonical_json(value):
    """(ok, json_text, note). `note` is non-empty only when something genuinely
    went wrong — the caller turns that into a runner error rather than into a
    plain wrong answer."""
    try:
        return True, serialize(value, set()), ""
    except Unserializable as exc:
        return False, "", f"value could not be serialized: {exc}"
    except RecursionError:
        return False, "", "value could not be serialized: structure is too deeply nested"


# -----------------------------------------------------------------------------
# Output
# -----------------------------------------------------------------------------
def emit(payload):
    """Write the single JSON document that is this container's entire stdout."""
    text = json.dumps(payload, ensure_ascii=False, allow_nan=False)
    os.write(1, text.encode("utf-8"))


def fail(phase, message, printed=None):
    payload = {"phase": phase, "results": [], "passed": 0, "total": 0, "error": message}
    if printed:
        payload["stdout"] = printed
    emit(payload)
    sys.exit(0)


# =============================================================================
# --selftest — the conformance gate
# =============================================================================
SENTINELS = {
    "nan": float("nan"),
    "inf": float("inf"),
    "-inf": float("-inf"),
    "-zero": -0.0,
}


def decode_fixture(value):
    """Turn `{"$cg":"nan"}` back into a real NaN, recursively.

    An object carrying `$cg` AND any other key is an ordinary object that
    happens to have an awkward key — the fixture says so explicitly, and pins it
    with a case.
    """
    if isinstance(value, list):
        return [decode_fixture(v) for v in value]
    if isinstance(value, dict):
        if len(value) == 1 and "$cg" in value:
            name = value["$cg"]
            if name not in SENTINELS:
                raise ValueError(f"unknown sentinel: {name}")
            return SENTINELS[name]
        return {k: decode_fixture(v) for k, v in value.items()}
    return value


def selftest(cases_path=None):
    path = cases_path or "/app/conformance/equality-cases.json"
    try:
        with open(path, "r", encoding="utf-8") as fh:
            spec = json.load(fh)
    except OSError as exc:
        os.write(1, f"selftest: could not read {path}: {exc}\n".encode("utf-8"))
        sys.exit(1)

    failures = []
    checks = 0

    for case in spec.get("equality", []):
        a = decode_fixture(case["a"])
        b = decode_fixture(case["b"])
        want = case.get("equal") is True
        name = case.get("name", "?")

        got = deep_equal(a, b)
        checks += 1
        if got != want:
            failures.append(f"equality/{name}: expected {want}, got {got}")

        # Symmetry and reflexivity hold for EVERY case, so asserting them here
        # triples the coverage for free — and they are the two properties a
        # hand-written comparator loses first.
        swapped = deep_equal(b, a)
        checks += 1
        if swapped != want:
            failures.append(f"equality/{name}: not symmetric — a~b {got}, b~a {swapped}")
        checks += 2
        if not deep_equal(a, a):
            failures.append(f"equality/{name}: a is not equal to itself")
        if not deep_equal(b, b):
            failures.append(f"equality/{name}: b is not equal to itself")

    for case in spec.get("serialization", []):
        name = case.get("name", "?")
        value = decode_fixture(case["value"])
        ok, text, note = canonical_json(value)
        checks += 1
        if not ok:
            failures.append(f"serialization/{name}: not serializable ({note})")
            continue
        if text != case["json"]:
            failures.append(f"serialization/{name}: expected {case['json']}, got {text}")
            continue
        checks += 1
        try:
            reparsed = json.loads(text)
        except ValueError as exc:
            failures.append(f"serialization/{name}: emitted text is not valid JSON — {exc}")
            continue
        if not deep_equal(reparsed, value):
            failures.append(f"serialization/{name}: does not survive a JSON round-trip")

    header = f"selftest: python runner vs {path} (fixture v{spec.get('version')})\n"
    if not failures:
        os.write(
            1,
            (
                header
                + f"  PASS — {checks} checks over {len(spec.get('equality', []))} equality "
                + f"and {len(spec.get('serialization', []))} serialization cases\n"
            ).encode("utf-8"),
        )
        sys.exit(0)
    os.write(
        1,
        (
            header
            + f"  FAIL — {len(failures)} of {checks} checks disagree with the shared spec:\n"
        ).encode("utf-8"),
    )
    for f in failures:
        os.write(1, f"    {f}\n".encode("utf-8"))
    sys.exit(1)


# =============================================================================
# Main
# =============================================================================
def main(argv):
    if argv and argv[0] == "--selftest":
        selftest(argv[1] if len(argv) > 1 else None)

    if len(argv) < 2:
        fail(PHASE_LOAD, "runner: missing solution or tests path argument")
    solution_path, tests_path = argv[0], argv[1]

    try:
        with open(solution_path, "r", encoding="utf-8") as fh:
            user_code = fh.read()
    except OSError as exc:
        fail(PHASE_LOAD, f"runner: could not read solution: {exc}")

    try:
        with open(tests_path, "r", encoding="utf-8") as fh:
            spec = json.load(fh)
    except (OSError, ValueError) as exc:
        fail(PHASE_LOAD, f"runner: could not parse tests json: {exc}")

    function_name = spec.get("functionName")
    tests = spec.get("tests") if isinstance(spec.get("tests"), list) else []
    if not function_name:
        fail(PHASE_LOAD, "runner: tests json missing functionName")

    # --- compile -------------------------------------------------------------
    # compile() PARSES without executing, which splits the two failure modes
    # exactly as `new Function` does for JavaScript: a SyntaxError here means the
    # source does not parse (phase "compile" — an IndentationError is the Python
    # spelling of a javac diagnostic), while anything raised by the exec below
    # happened while the code was defining itself (phase "load").
    try:
        code_object = compile(user_code, "<solution>", "exec")
    except SyntaxError as exc:
        # IndentationError and TabError are SyntaxError subclasses, and in Python
        # they are the single most common way a correct algorithm fails to run —
        # so the line and column are part of the message, not a detail.
        where = ""
        if exc.lineno:
            where = f" (line {exc.lineno}"
            where += f", column {exc.offset})" if exc.offset else ")"
        fail(PHASE_COMPILE, f"{type(exc).__name__}: {exc.msg}{where}")
    except ValueError as exc:
        # e.g. source containing a null byte — compile() raises ValueError, not
        # SyntaxError, but it is still "this does not parse".
        fail(PHASE_COMPILE, f"ValueError: {exc}")

    # --- load ----------------------------------------------------------------
    # The namespace is a plain dict, the direct analogue of the scope `new
    # Function` creates. __name__ is deliberately NOT "__main__": a solution
    # pasted from a local file often ends with an `if __name__ == "__main__":`
    # block full of prints and sample calls, and under the real name that block
    # would run — printing into the payload window and burning the time budget
    # before a single test was called.
    # (`__builtins__` is left for exec to install, which is what gives the
    # solution the ordinary standard library namespace it is written against.)
    namespace = {"__name__": "__cg_solution__"}

    load_stdout = None
    with capture_stdout() as cap:
        try:
            run_on_stack(lambda: exec(code_object, namespace))
        except BaseException as exc:  # noqa: BLE001 — reported, never propagated
            printed = cap.collect()
            fail(PHASE_LOAD, f"runner: your code failed to load: {_describe(exc)}", printed)
        load_stdout = cap.collect()

    fn = namespace.get(function_name)
    if not callable(fn):
        fail(
            PHASE_LOAD,
            f'runner: expected a function named "{function_name}" but it was not defined',
            load_stdout,
        )

    # --- run -----------------------------------------------------------------
    results = []
    passed_count = 0

    for test in tests:
        test = test if isinstance(test, dict) else {}
        name = test["name"] if isinstance(test.get("name"), str) else "test"
        raw_args = test.get("args") if isinstance(test.get("args"), list) else []
        expected = test.get("expected")

        start = time.perf_counter()
        actual = None
        stderr = None
        passed = False

        with capture_stdout() as cap:
            try:
                # Re-parse the arguments from JSON for every case, so a solution
                # that mutates its input in place cannot corrupt the next test.
                # Same reason the JS runner does JSON.parse(JSON.stringify(args)).
                call_args = json.loads(json.dumps(raw_args))
                actual = run_on_stack(lambda: fn(*call_args))
                passed = deep_equal(actual, expected)
            except BaseException as exc:  # noqa: BLE001 — reported per test
                stderr = _describe(exc)
            printed = cap.collect()
        time_ms = (time.perf_counter() - start) * 1000.0

        exp_ok, exp_text, _ = canonical_json(expected)
        if stderr:
            act_ok, act_text, act_note = False, "", ""
        else:
            act_ok, act_text, act_note = canonical_json(actual)
        if not stderr and not act_ok and act_note:
            stderr = f"runner: {act_note}"
            passed = False

        row = {
            "name": name,
            "passed": passed,
            "timeMs": round(time_ms, 3),
        }
        if exp_ok:
            row["expected"] = exp_text
        if act_ok:
            row["actual"] = act_text
        if stderr:
            row["stderr"] = stderr
        if printed:
            row["stdout"] = printed
        results.append(row)
        if passed:
            passed_count += 1

    payload = {
        "phase": PHASE_RUN,
        "results": results,
        "passed": passed_count,
        "total": len(results),
    }
    if load_stdout:
        payload["stdout"] = load_stdout
    emit(payload)


def _describe(exc):
    """`TypeError: unsupported operand ...` — the same shape the JS runner emits.

    RecursionError gets an explicit note: at a 30_000-frame limit it almost
    always means infinite recursion rather than a legitimately deep search, and
    the default message does not say which.
    """
    if isinstance(exc, RecursionError):
        return (
            f"RecursionError: maximum recursion depth exceeded "
            f"(the limit here is {RECURSION_LIMIT} frames — this is usually a missing base case)"
        )
    message = str(exc)
    return f"{type(exc).__name__}: {message}" if message else type(exc).__name__


if __name__ == "__main__":
    main(sys.argv[1:])
