// =============================================================================
// codegrind sandbox test harness — Go
// =============================================================================
// Runs inside the ephemeral, network-less Docker container started by
// bin/run-submission. Unlike the JavaScript and Python harnesses this one has a
// COMPILE PHASE, so a single binary wears three hats:
//
//   /app/cgrun --selftest [equality-cases.json]   the conformance gate
//   /app/cgrun /work/solution.go /work/tests.json DRIVER  — compiles, then runs
//   <built binary> --harness tests.json out.json  HARNESS — reflects and grades
//
// Read javascript/runner.mjs' header first: the stdout contract, the phases and
// the sorted-key serializer are reasoned out there and not repeated here. What
// IS written out here is every place a COMPILED language forces a decision the
// interpreted ones never had to make — which is the whole reason this phase
// exists ahead of Java.
//
// ---------------------------------------------------------------------------
// THE DYNAMIC-DISPATCH PROBLEM, AND THE SHIM
// ---------------------------------------------------------------------------
// Go has no eval and no dynamic loading (the `plugin` package needs cgo, which
// alpine/musl does not give us). A harness therefore CANNOT look a function up
// by name at run time — which is exactly what every other runner does.
//
// It does not have to. `functionName` is known at GENERATION time, long before
// anything is compiled. So the driver writes a three-line file into the build
// directory:
//
//     package main
//     func cgEntry() any { return twoSum }
//
// and `go build` links runner.go + solution.go + shim.go into one binary. The
// harness then does reflect.ValueOf(cgEntry()) and proceeds exactly as the
// interpreted runners do. The user's identifier is unconstrained, so
// `functionName` keeps working and no schema change is needed.
//
// THE SAME BINARY IS BOTH HALVES. /app/cgrun is built at IMAGE build time from
// this file plus shim_stub.go (a cgEntry that returns nil), which is what lets
// --selftest check the comparator with no compile step at all. At run time
// shim_stub.go is left behind and the real shim takes its place.
//
// ---------------------------------------------------------------------------
// EVERY TOP-LEVEL NAME IN THIS FILE IS PREFIXED `cg`
// ---------------------------------------------------------------------------
// Not style — a correctness requirement. solution.go is compiled into the SAME
// package as this file, so a user helper named `serialize`, `deepEqual` or
// `emit` would be a redeclaration and the submission would fail to compile with
// a diagnostic pointing at the harness's own source. `main` is the one name
// that cannot be prefixed, which is why the authoring rules forbid writing one.
//
// ---------------------------------------------------------------------------
// TYPES COME FROM THE USER'S OWN SIGNATURE
// ---------------------------------------------------------------------------
// Args arrive as untyped JSON and Go needs static types. reflect.Type.In(i)
// supplies each parameter's type, reflect.New(t) allocates it and
// json.Unmarshal fills it — so int, []int, [][]int, []string, map[string]int
// and friends all marshal with NO type metadata authored anywhere. This is the
// exact insight Java depends on, rehearsed here at a tenth of the cost.
//
// STANDARD LIBRARY ONLY. There is no go.sum and GOPROXY is off; a dependency
// could not be fetched inside a --network none container even if one were
// wanted.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"regexp"
	"runtime/debug"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"
)

const (
	cgPhaseCompile = "compile"
	cgPhaseLoad    = "load"
	cgPhaseRun     = "run"
)

// -----------------------------------------------------------------------------
// Budgets — three of them, nested, and all distinct
// -----------------------------------------------------------------------------
// A compiled language needs a compile budget that means nothing to the others,
// and the numbers must nest strictly or the outer one fires first and every
// structured partial result is lost:
//
//	cgPerTestBudget  2s   one test hung -> that ROW gets an error, the rest run
//	cgRunBudget     10s   the suite overran -> partial results, honestly counted
//	cgCompileBudget 10s   go build wedged -> phase:"compile", not a mystery kill
//	CG_TIMEOUT[go]  30s   (bin/lib/languages.sh) the outer `timeout` around
//	                      docker run. Strictly above compile+run+slack.
//
// The compile number is generous on purpose. A build against the WARM cache
// baked into the image takes ~0.1s; a cold one (the cache missing, an image
// rebuilt badly) takes ~3s. 10 covers the bad day without letting a wedged
// toolchain eat the whole outer budget.
const (
	cgCompileBudget = 10 * time.Second
	cgRunBudget     = 10 * time.Second
	cgPerTestBudget = 2000 * time.Millisecond
	// The driver waits a little longer than the harness's own run budget so the
	// harness always wins the race and emits partial results. The driver's
	// deadline only fires when the child died in a way it cannot report —
	// a stack overflow, an os.Exit, a SIGKILL from the memory cgroup.
	cgChildGrace = 3 * time.Second
)

const (
	cgStdoutCap      = 8 * 1024
	cgMaxSafeInteger = 9007199254740991
	// Go values can be cyclic (a slice containing itself through an interface,
	// a self-referential map). JavaScript's serializer detects that with a seen
	// set; a depth cap is the cheaper equivalent and also catches the honest
	// case of an absurdly nested structure. 512 is far past any legitimate
	// return value and far short of blowing the goroutine stack.
	cgMaxDepth    = 512
	cgFloatAbsTol = 1e-9
	cgFloatRelTol = 1e-9
)

// Where the driver finds the harness source to compile alongside the user's.
// Overridable so the runner can be exercised outside its image.
func cgSrcDir() string {
	if v := os.Getenv("CG_SRC_DIR"); v != "" {
		return v
	}
	return "/app/src"
}

func cgFixturePath() string {
	if v := os.Getenv("CG_CONFORMANCE"); v != "" {
		return v
	}
	return "/app/conformance/equality-cases.json"
}

// -----------------------------------------------------------------------------
// Output
// -----------------------------------------------------------------------------
// cgRealStdout is captured before anything can swap os.Stdout, so the payload
// can never be swallowed by a capture window a panicking solution left open.
//
// cgPayloadPath is the harness's escape from a hazard the interpreted runners
// do not have: package-level `var x = mustPrint()` initializers in solution.go
// run BEFORE main, so there is no point at which the harness could have
// installed a capture. Anything they print lands in the process's real stdout.
// Rather than fight that, the harness writes its payload to a FILE and lets the
// driver fold the child's raw stdout in as payload.stdout — so an init-time
// print is reported instead of corrupting the JSON.
var (
	cgRealStdout  = os.Stdout
	cgPayloadPath string
)

type cgResultRow struct {
	Name     string  `json:"name"`
	Passed   bool    `json:"passed"`
	Expected *string `json:"expected,omitempty"`
	Actual   *string `json:"actual,omitempty"`
	Stderr   string  `json:"stderr,omitempty"`
	Stdout   string  `json:"stdout,omitempty"`
	TimeMs   float64 `json:"timeMs"`
}

type cgPayload struct {
	Phase   string        `json:"phase"`
	Results []cgResultRow `json:"results"`
	Passed  int           `json:"passed"`
	Total   int           `json:"total"`
	Error   string        `json:"error,omitempty"`
	Stdout  string        `json:"stdout,omitempty"`
}

// cgEmit writes the single JSON document that is this run's entire answer.
// In harness mode that is a file the driver reads; in driver mode it is the
// container's stdout.
func cgEmit(p cgPayload) {
	if p.Results == nil {
		p.Results = []cgResultRow{}
	}
	text, err := json.Marshal(p)
	if err != nil {
		text = []byte(`{"phase":"run","results":[],"passed":0,"total":0,"error":"runner: payload could not be encoded"}`)
	}
	if cgPayloadPath != "" {
		_ = os.WriteFile(cgPayloadPath, text, 0o644)
		return
	}
	_, _ = cgRealStdout.Write(text)
}

func cgFail(phase, message, printed string) {
	cgEmit(cgPayload{Phase: phase, Results: []cgResultRow{}, Error: message, Stdout: printed})
	os.Exit(0)
}

// =============================================================================
// Equality — the shared spec, hand-written here
// =============================================================================
// conformance/equality-cases.json is the contract; this is one of three
// implementations of it, and --selftest is what stops them drifting.
//
// Everything below operates on the CANONICAL TREE: nil, bool, float64, string,
// []any, map[string]any. Both sides get there the same way — the user's return
// value through cgNormalize (reflection), the expected value through
// encoding/json — so exactly one comparator exists rather than one per source.
// Java should do the same thing with JsonElement.

func cgIsIntegral(f float64) bool {
	return !math.IsInf(f, 0) && !math.IsNaN(f) && math.Trunc(f) == f
}

// cgNumbersEqual implements abs(a-b) <= max(1e-9, 1e-9*max(|a|,|b|)) behind the
// three guards the fixture pins:
//
//  1. NaN equals only NaN, and never reaches the tolerance.
//  2. The infinities never reach it either — abs(inf - -inf) is inf, 1e-9*inf
//     is inf, and inf <= inf is TRUE, so an unguarded tolerance would quietly
//     declare +inf and -inf equal.
//  3. Two INTEGRAL values compare exactly. A relative 1e-9 near 2^53 is a slack
//     of ~9 million, which would accept a count that is off by one.
func cgNumbersEqual(a, b float64) bool {
	if math.IsNaN(a) || math.IsNaN(b) {
		return math.IsNaN(a) && math.IsNaN(b)
	}
	if math.IsInf(a, 0) || math.IsInf(b, 0) {
		return a == b
	}
	if a == b {
		return true
	}
	if cgIsIntegral(a) && cgIsIntegral(b) {
		return false
	}
	tol := math.Max(cgFloatAbsTol, cgFloatRelTol*math.Max(math.Abs(a), math.Abs(b)))
	return math.Abs(a-b) <= tol
}

func cgDeepEqual(a, b any) bool {
	af, aNum := a.(float64)
	bf, bNum := b.(float64)
	if aNum && bNum {
		return cgNumbersEqual(af, bf)
	}
	if aNum || bNum {
		return false
	}

	ab, aBool := a.(bool)
	bb, bBool := b.(bool)
	if aBool || bBool {
		return aBool && bBool && ab == bb
	}

	if a == nil || b == nil {
		return a == nil && b == nil
	}

	as, aStr := a.(string)
	bs, bStr := b.(string)
	if aStr || bStr {
		return aStr && bStr && as == bs
	}

	aArr, aIsArr := a.([]any)
	bArr, bIsArr := b.([]any)
	if aIsArr || bIsArr {
		if !aIsArr || !bIsArr || len(aArr) != len(bArr) {
			return false
		}
		for i := range aArr {
			if !cgDeepEqual(aArr[i], bArr[i]) {
				return false
			}
		}
		return true
	}

	aMap, aIsMap := a.(map[string]any)
	bMap, bIsMap := b.(map[string]any)
	if aIsMap || bIsMap {
		if !aIsMap || !bIsMap || len(aMap) != len(bMap) {
			return false
		}
		for k, v := range aMap {
			other, ok := bMap[k]
			if !ok || !cgDeepEqual(v, other) {
				return false
			}
		}
		return true
	}

	return false
}

// =============================================================================
// Canonical serialization — STRICT JSON, keys sorted, JavaScript's number text
// =============================================================================
// encoding/json is NOT used for the structure, for three reasons the fixture
// proves:
//
//  1. NaN and ±Inf. json.Marshal returns an UnsupportedValueError rather than
//     emitting anything, so a solution that divides by zero would come back as
//     an opaque runner error instead of a wrong answer. JSON.stringify emits
//     `null`; so does this.
//  2. Key order. Go's encoder DOES sort map keys, but it sorts by Go's byte
//     (code-POINT) order while JavaScript's sort compares UTF-16 code UNITS.
//     They agree below U+10000 and disagree above it. Sorting on the utf-16-be
//     encoding is code-unit order exactly.
//  3. Number text. Go's %v for 2.0 is "2" but for 1e-5 is "1e-05"; JavaScript's
//     is "1e-5". The stored `expected` of a problem IS this text, so two
//     spellings of one value are two problems that grade differently.

// cgJSNumber renders a finite number exactly as JavaScript's String(Number)
// would. ECMA-262 Number::toString: let the value be s * 10^(n-k) where s is
// the shortest decimal digit string that round-trips, of k digits; the format
// follows from n alone. FormatFloat(…, 'e', -1, 64) supplies those shortest
// digits, and the rest is re-rendering them under JS's rules.
func cgJSNumber(f float64) string {
	if f == 0 {
		return "0" // covers -0.0: JavaScript's String(-0) is "0"
	}
	negative := f < 0
	text := strconv.FormatFloat(math.Abs(f), 'e', -1, 64)

	mantissa, exp := text, 0
	if i := strings.IndexByte(text, 'e'); i >= 0 {
		mantissa = text[:i]
		e, err := strconv.Atoi(text[i+1:])
		if err != nil {
			return text
		}
		exp = e
	}
	intPart, fracPart := mantissa, ""
	if i := strings.IndexByte(mantissa, '.'); i >= 0 {
		intPart, fracPart = mantissa[:i], mantissa[i+1:]
	}

	digits := strings.TrimLeft(intPart+fracPart, "0")
	stripped := strings.TrimRight(digits, "0")
	if stripped == "" {
		return "0"
	}
	trailing := len(digits) - len(stripped)
	k := len(stripped)
	n := exp - len(fracPart) + trailing + k

	var out string
	switch {
	case k <= n && n <= 21:
		out = stripped + strings.Repeat("0", n-k)
	case 0 < n && n <= 21:
		out = stripped[:n] + "." + stripped[n:]
	case -6 < n && n <= 0:
		out = "0." + strings.Repeat("0", -n) + stripped
	default:
		head := stripped
		if k > 1 {
			head = stripped[:1] + "." + stripped[1:]
		}
		e := n - 1
		sign := "+"
		if e < 0 {
			sign, e = "-", -e
		}
		out = head + "e" + sign + strconv.Itoa(e)
	}
	if negative {
		return "-" + out
	}
	return out
}

// cgQuote escapes a string exactly as JSON.stringify does — short escapes for
// the usual controls, \u00XX for the rest, `/` left alone, non-ASCII emitted
// literally. Hand-written rather than delegated to encoding/json, which
// escapes <, >, & (HTML safety) and U+2028/U+2029 unconditionally; every one of
// those would be a silent divergence from the other two runners.
func cgQuote(s string) string {
	var b strings.Builder
	b.Grow(len(s) + 2)
	b.WriteByte('"')
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch c {
		case '"':
			b.WriteString(`\"`)
		case '\\':
			b.WriteString(`\\`)
		case '\b':
			b.WriteString(`\b`)
		case '\f':
			b.WriteString(`\f`)
		case '\n':
			b.WriteString(`\n`)
		case '\r':
			b.WriteString(`\r`)
		case '\t':
			b.WriteString(`\t`)
		default:
			if c < 0x20 {
				b.WriteString(fmt.Sprintf(`\u%04x`, c))
			} else {
				b.WriteByte(c)
			}
		}
	}
	b.WriteByte('"')
	return b.String()
}

// cgUTF16Key is a sort key giving UTF-16 code-UNIT order, which is what
// JavaScript's Array.prototype.sort uses on property names.
func cgUTF16Key(s string) string {
	units := utf16.Encode([]rune(s))
	b := make([]byte, 0, len(units)*2)
	for _, u := range units {
		b = append(b, byte(u>>8), byte(u))
	}
	return string(b)
}

func cgSerialize(v any, depth int) (string, error) {
	if depth > cgMaxDepth {
		return "", errors.New("structure is too deeply nested (or cyclic)")
	}
	switch t := v.(type) {
	case nil:
		return "null", nil
	case bool:
		if t {
			return "true", nil
		}
		return "false", nil
	case float64:
		// NaN and ±Infinity are not JSON. `null` is what JSON.stringify emits,
		// and matching it is what keeps a divide-by-zero a WRONG ANSWER rather
		// than an unexplained runner error.
		if math.IsNaN(t) || math.IsInf(t, 0) {
			return "null", nil
		}
		return cgJSNumber(t), nil
	case string:
		return cgQuote(t), nil
	case []any:
		parts := make([]string, len(t))
		for i, item := range t {
			s, err := cgSerialize(item, depth+1)
			if err != nil {
				return "", err
			}
			parts[i] = s
		}
		return "[" + strings.Join(parts, ",") + "]", nil
	case map[string]any:
		keys := make([]string, 0, len(t))
		for k := range t {
			keys = append(keys, k)
		}
		sort.Slice(keys, func(i, j int) bool {
			return cgUTF16Key(keys[i]) < cgUTF16Key(keys[j])
		})
		parts := make([]string, len(keys))
		for i, k := range keys {
			s, err := cgSerialize(t[k], depth+1)
			if err != nil {
				return "", err
			}
			parts[i] = cgQuote(k) + ":" + s
		}
		return "{" + strings.Join(parts, ",") + "}", nil
	default:
		return "", fmt.Errorf("value of type %T has no JSON representation", v)
	}
}

func cgCanonicalJSON(v any) (string, bool) {
	s, err := cgSerialize(v, 0)
	if err != nil {
		return "", false
	}
	return s, true
}

// =============================================================================
// Normalization — reflection down to the canonical tree
// =============================================================================
// The one place Go is genuinely MORE work than Python. Python's return value is
// already a tagged runtime object; Go's is a statically typed value that has to
// be walked with reflect before anything can be said about it.

func cgNormalize(v reflect.Value, depth int) (any, error) {
	if depth > cgMaxDepth {
		return nil, errors.New("structure is too deeply nested (or cyclic)")
	}
	if !v.IsValid() {
		return nil, nil
	}
	switch v.Kind() {
	case reflect.Interface, reflect.Pointer:
		if v.IsNil() {
			return nil, nil
		}
		return cgNormalize(v.Elem(), depth+1)

	case reflect.Bool:
		return v.Bool(), nil

	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		return cgIntToJSON(v.Int())

	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		u := v.Uint()
		if u > cgMaxSafeInteger {
			return nil, cgIntRangeError(strconv.FormatUint(u, 10))
		}
		return float64(u), nil

	case reflect.Float32, reflect.Float64:
		return v.Float(), nil

	case reflect.String:
		return v.String(), nil

	case reflect.Slice, reflect.Array:
		// A NIL SLICE BECOMES [], NOT null. This is deliberate and it is the
		// single most consequential normalization decision in the file. The
		// idiomatic Go accumulator is `var out []int` followed by appends, and
		// when nothing matches it stays nil — encoding/json would render that
		// as `null` and a correct solution would fail every empty-input edge
		// case in the suite. There is no problem in this app where "no results"
		// and "null" are meaningfully different answers.
		out := make([]any, v.Len())
		for i := 0; i < v.Len(); i++ {
			item, err := cgNormalize(v.Index(i), depth+1)
			if err != nil {
				return nil, err
			}
			out[i] = item
		}
		return out, nil

	case reflect.Map:
		out := make(map[string]any, v.Len())
		iter := v.MapRange()
		for iter.Next() {
			key, err := cgObjectKey(iter.Key())
			if err != nil {
				return nil, err
			}
			val, err := cgNormalize(iter.Value(), depth+1)
			if err != nil {
				return nil, err
			}
			out[key] = val
		}
		return out, nil

	case reflect.Struct:
		// Forbidden by the authoring rules rather than supported: a struct
		// would marshal through its exported fields and its JSON shape would
		// depend on tags the model was never told to write. The message names
		// the way out, because "unsupported type" teaches nothing.
		return nil, fmt.Errorf(
			"a struct (%s) has no place in a codegrind answer — return plain data "+
				"(a number, string, bool, slice or map) instead", v.Type())

	default:
		return nil, fmt.Errorf("value of type %s has no JSON representation", v.Type())
	}
}

func cgIntRangeError(text string) error {
	return fmt.Errorf(
		"integer %s is outside the ±(2^53-1) range JSON numbers survive; "+
			"keep results inside ±9007199254740991", text)
}

// cgIntToJSON guards the bound that Go's int makes easy to breach: it is 64-bit,
// so 2^60 computes exactly and looks perfectly correct — and then becomes a
// DIFFERENT number on the way through Node's JSON.parse, where every `expected`
// is stored. Refusing is the only outcome anyone can see.
func cgIntToJSON(i int64) (any, error) {
	if i > cgMaxSafeInteger || i < -cgMaxSafeInteger {
		return nil, cgIntRangeError(strconv.FormatInt(i, 10))
	}
	return float64(i), nil
}

// cgObjectKey is the property NAME a Go map key becomes in JSON. Go maps key on
// anything comparable; JSON objects key only on strings. JSON.stringify coerces
// with ToString and this matches it, so map[int]string{1:"a"} and
// map[string]string{"1":"a"} are one value in both runtimes.
func cgObjectKey(k reflect.Value) (string, error) {
	switch k.Kind() {
	case reflect.String:
		return k.String(), nil
	case reflect.Bool:
		if k.Bool() {
			return "true", nil
		}
		return "false", nil
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		v, err := cgIntToJSON(k.Int())
		if err != nil {
			return "", err
		}
		return cgJSNumber(v.(float64)), nil
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		u := k.Uint()
		if u > cgMaxSafeInteger {
			return "", cgIntRangeError(strconv.FormatUint(u, 10))
		}
		return cgJSNumber(float64(u)), nil
	case reflect.Float32, reflect.Float64:
		return cgJSNumber(k.Float()), nil
	default:
		return "", fmt.Errorf("map key of type %s has no JSON form", k.Type())
	}
}

// =============================================================================
// stdout capture
// =============================================================================
// fmt.Println resolves os.Stdout at CALL time, so swapping the package variable
// catches every route a solution has to the payload stream — exactly as
// swapping sys.stdout does in Python. A solution reaching around it with
// syscall.Write(1, …) still gets through, as one calling process.binding would
// in JavaScript; both harnesses cover the route people actually take.
//
// The drain runs in its own goroutine because an os.Pipe holds only ~64KB: a
// chatty solution would block forever writing into a pipe nobody is reading.
func cgCapture(fn func()) string {
	r, w, err := os.Pipe()
	if err != nil {
		fn()
		return ""
	}
	saved := os.Stdout
	os.Stdout = w

	done := make(chan string, 1)
	go func() {
		var sb strings.Builder
		buf := make([]byte, 4096)
		truncated := false
		for {
			n, err := r.Read(buf)
			if n > 0 {
				room := cgStdoutCap - sb.Len()
				if room <= 0 {
					truncated = true
				} else {
					chunk := buf[:n]
					if n > room {
						chunk, truncated = buf[:room], true
					}
					sb.Write(chunk)
				}
			}
			if err != nil {
				break
			}
		}
		text := sb.String()
		if truncated {
			text += fmt.Sprintf("\n… (output truncated at %d bytes)", cgStdoutCap)
		}
		done <- text
	}()

	fn()

	os.Stdout = saved
	_ = w.Close()
	text := <-done
	_ = r.Close()
	return text
}

// =============================================================================
// HARNESS mode — the built binary, with the real shim linked in
// =============================================================================

type cgTestSpec struct {
	Name     string            `json:"name"`
	Args     []json.RawMessage `json:"args"`
	Expected json.RawMessage   `json:"expected"`
}

type cgSpec struct {
	FunctionName string       `json:"functionName"`
	Tests        []cgTestSpec `json:"tests"`
}

func cgHarness(testsPath, payloadPath string) {
	cgPayloadPath = payloadPath

	// GOROUTINE STACKS ARE THE FREE WIN, AND THIS IS THE ONE KNOB THEY NEED.
	//
	// Go stacks start at 8KB and grow on demand, so the recursion-depth problem
	// Python needed a 64MB thread and sys.setrecursionlimit for does not exist
	// here — 200 000 frames of a legitimate DFS complete in ~60ms and about
	// 20MB. Nothing has to be configured for that to work.
	//
	// What DOES have to be configured is the failure end. The runtime's default
	// ceiling is 1GB, which is twice the container's --memory=512m: infinite
	// recursion therefore hits the cgroup first and the kernel SIGKILLs the
	// process, so the candidate gets "killed" instead of "stack overflow" and
	// learns nothing. Capping the stack below the memory limit puts the Go
	// runtime back in front of the OOM killer, where it can name the problem.
	//
	// 128MB is the number: stacks double as they grow, so the last growth is
	// 64MB -> 128MB and peak usage stays near 192MB, comfortably inside 512m —
	// while still allowing something like a million frames, far past any
	// legitimate solution.
	debug.SetMaxStack(128 << 20)

	raw, err := os.ReadFile(testsPath)
	if err != nil {
		cgFail(cgPhaseLoad, fmt.Sprintf("runner: could not parse tests json: %v", err), "")
	}
	var spec cgSpec
	if err := json.Unmarshal(raw, &spec); err != nil {
		cgFail(cgPhaseLoad, fmt.Sprintf("runner: could not parse tests json: %v", err), "")
	}
	if spec.FunctionName == "" {
		cgFail(cgPhaseLoad, "runner: tests json missing functionName", "")
	}

	fn := reflect.ValueOf(cgEntry())
	if !fn.IsValid() || fn.Kind() != reflect.Func || fn.IsNil() {
		cgFail(cgPhaseLoad, fmt.Sprintf(
			"runner: expected a function named %q but it was not defined", spec.FunctionName), "")
	}
	ft := fn.Type()

	// SINGLE RETURN VALUE ONLY, and this check is not optional. `(result,
	// error)` is the most idiomatic thing a Go author can write and it breaks
	// the contract completely: there is no expected value to compare an error
	// against and nowhere for it to go. Left to reflect it would surface as a
	// bare "reflect: Call with too many output values" panic, which teaches
	// nobody anything.
	if ft.NumOut() != 1 {
		cgFail(cgPhaseLoad, cgArityMessage(spec.FunctionName, ft.NumOut()), "")
	}
	if ft.IsVariadic() {
		cgFail(cgPhaseLoad, fmt.Sprintf(
			"runner: %q is variadic. Tests supply a fixed argument list, so declare each "+
				"parameter explicitly (use a slice parameter if the count really varies).",
			spec.FunctionName), "")
	}

	results := make([]cgResultRow, 0, len(spec.Tests))
	passedCount := 0
	suiteStart := time.Now()
	exhausted := false

	for _, test := range spec.Tests {
		name := test.Name
		if name == "" {
			name = "test"
		}
		row := cgResultRow{Name: name}

		if exhausted || time.Since(suiteStart) > cgRunBudget {
			exhausted = true
			row.Stderr = fmt.Sprintf(
				"runner: the %ds budget for the whole suite was exhausted before this test ran",
				int(cgRunBudget/time.Second))
			results = append(results, row)
			continue
		}

		if expText, ok := cgCanonicalJSON(cgDecodeJSON(test.Expected)); ok {
			row.Expected = &expText
		}

		in, argErr := cgBindArgs(ft, test.Args)
		if argErr != nil {
			row.Stderr = argErr.Error()
			results = append(results, row)
			continue
		}

		start := time.Now()
		var out reflect.Value
		var callErr error
		printed := cgCapture(func() {
			out, callErr = cgCall(fn, in)
		})
		row.TimeMs = math.Round(float64(time.Since(start).Nanoseconds())/1e3) / 1e3
		row.Stdout = printed

		if callErr != nil {
			row.Stderr = callErr.Error()
			results = append(results, row)
			continue
		}

		actual, normErr := cgNormalize(out, 0)
		if normErr != nil {
			row.Stderr = "runner: value could not be serialized: " + normErr.Error()
			results = append(results, row)
			continue
		}
		if actText, ok := cgCanonicalJSON(actual); ok {
			row.Actual = &actText
		}
		row.Passed = cgDeepEqual(actual, cgDecodeJSON(test.Expected))
		if row.Passed {
			passedCount++
		}
		results = append(results, row)
	}

	cgEmit(cgPayload{
		Phase:   cgPhaseRun,
		Results: results,
		Passed:  passedCount,
		Total:   len(results),
	})
}

func cgArityMessage(name string, n int) string {
	if n == 0 {
		return fmt.Sprintf(
			"runner: %q returns nothing. A codegrind solution must return exactly one value — "+
				"the answer the tests compare against.", name)
	}
	return fmt.Sprintf(
		"runner: %q returns %d values, but a codegrind solution must return exactly ONE. "+
			"The (result, error) idiom cannot be graded: there is no expected value to compare "+
			"an error against and nowhere for it to go. Return only the result, and signal an "+
			"impossible input with a sentinel the problem defines (-1, an empty slice, and so on).",
		name, n)
}

// cgDecodeJSON turns a raw `expected` into the canonical tree. Sentinels are
// NOT decoded here — {"$cg":"nan"} is a fixture convention for --selftest only,
// and a stored problem whose expected value happened to have that exact shape
// must stay an ordinary object.
func cgDecodeJSON(raw json.RawMessage) any {
	if len(raw) == 0 {
		return nil
	}
	var v any
	if err := json.Unmarshal(raw, &v); err != nil {
		return nil
	}
	return v
}

// cgBindArgs is the whole "types come from the user's own signature" trick.
// reflect.New(ft.In(i)) allocates a value of the parameter's declared type and
// json.Unmarshal fills it — so a []int parameter gets a real []int, a
// map[string][]int gets a real map, and no type metadata was authored anywhere.
//
// The args are re-decoded from the ORIGINAL JSON for every test, which is what
// stops a solution that sorts its input in place from corrupting the next case.
// The JS runner's JSON.parse(JSON.stringify(args)) exists for the same reason.
func cgBindArgs(ft reflect.Type, args []json.RawMessage) ([]reflect.Value, error) {
	if len(args) != ft.NumIn() {
		return nil, fmt.Errorf(
			"runner: this test supplies %d argument(s) but the function declares %d",
			len(args), ft.NumIn())
	}
	in := make([]reflect.Value, ft.NumIn())
	for i := 0; i < ft.NumIn(); i++ {
		p := reflect.New(ft.In(i))
		dec := json.NewDecoder(bytes.NewReader(args[i]))
		if err := dec.Decode(p.Interface()); err != nil {
			return nil, fmt.Errorf(
				"runner: argument %d (%s) could not be decoded from the test's JSON: %v",
				i+1, ft.In(i), err)
		}
		in[i] = p.Elem()
	}
	return in, nil
}

// cgCall runs one test on its own goroutine so a single hung case costs that
// ROW rather than the whole suite.
//
// The goroutine is ABANDONED rather than killed on timeout, because Go has no
// way to kill one — and that is fine here: os.Exit does not wait for
// goroutines, the run budget bounds how many can accumulate, and the outer
// `timeout` around docker run bounds everything. Writes from an abandoned
// goroutine land on a closed pipe and return EPIPE, which fmt discards; the
// runtime only turns SIGPIPE into a crash on fds 1 and 2, and the capture pipe
// is neither.
func cgCall(fn reflect.Value, in []reflect.Value) (reflect.Value, error) {
	type outcome struct {
		v   reflect.Value
		err error
	}
	ch := make(chan outcome, 1)
	go func() {
		defer func() {
			if r := recover(); r != nil {
				ch <- outcome{err: fmt.Errorf("panic: %v", r)}
			}
		}()
		res := fn.Call(in)
		ch <- outcome{v: res[0]}
	}()

	select {
	case o := <-ch:
		return o.v, o.err
	case <-time.After(cgPerTestBudget):
		return reflect.Value{}, fmt.Errorf(
			"runner: this test exceeded the %dms budget for a single case "+
				"(usually an infinite loop or a complexity blow-up)",
			int(cgPerTestBudget/time.Millisecond))
	}
}

// =============================================================================
// DRIVER mode — compile, then run
// =============================================================================

var cgIdentRe = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

// Go's reserved words. `functionName` is interpolated verbatim into generated
// source, so it is validated before it can become anything but an identifier.
var cgKeywords = map[string]bool{
	"break": true, "case": true, "chan": true, "const": true, "continue": true,
	"default": true, "defer": true, "else": true, "fallthrough": true, "for": true,
	"func": true, "go": true, "goto": true, "if": true, "import": true,
	"interface": true, "map": true, "package": true, "range": true, "return": true,
	"select": true, "struct": true, "switch": true, "type": true, "var": true,
}

func cgDriver(solutionPath, testsPath string) {
	raw, err := os.ReadFile(testsPath)
	if err != nil {
		cgFail(cgPhaseLoad, fmt.Sprintf("runner: could not parse tests json: %v", err), "")
	}
	var spec cgSpec
	if err := json.Unmarshal(raw, &spec); err != nil {
		cgFail(cgPhaseLoad, fmt.Sprintf("runner: could not parse tests json: %v", err), "")
	}
	if spec.FunctionName == "" {
		cgFail(cgPhaseLoad, "runner: tests json missing functionName", "")
	}
	if !cgIdentRe.MatchString(spec.FunctionName) || cgKeywords[spec.FunctionName] {
		cgFail(cgPhaseLoad, fmt.Sprintf(
			"runner: %q is not a usable Go function name", spec.FunctionName), "")
	}

	solution, err := os.ReadFile(solutionPath)
	if err != nil {
		cgFail(cgPhaseLoad, fmt.Sprintf("runner: could not read solution: %v", err), "")
	}

	dir, err := os.MkdirTemp("", "cgbuild")
	if err != nil {
		cgFail(cgPhaseCompile, fmt.Sprintf("runner: could not create a build directory: %v", err), "")
	}

	src := cgSrcDir()
	for _, name := range []string{"runner.go", "go.mod"} {
		data, err := os.ReadFile(filepath.Join(src, name))
		if err != nil {
			cgFail(cgPhaseCompile, fmt.Sprintf("runner: harness source is missing (%s): %v", name, err), "")
		}
		if err := os.WriteFile(filepath.Join(dir, name), data, 0o644); err != nil {
			cgFail(cgPhaseCompile, fmt.Sprintf("runner: could not stage %s: %v", name, err), "")
		}
	}
	// The user's file is copied BYTE FOR BYTE and compiled under its own name,
	// which is what makes every compiler diagnostic's line:column land on the
	// line the candidate is actually looking at. Wrapping it, indenting it into
	// a template or prepending a package clause would offset every number and
	// make the whole compile_error verdict a lie. Java must preserve this.
	if err := os.WriteFile(filepath.Join(dir, "solution.go"), solution, 0o644); err != nil {
		cgFail(cgPhaseCompile, fmt.Sprintf("runner: could not stage the solution: %v", err), "")
	}
	shim := "package main\n\n" +
		"// Generated per submission by the codegrind Go driver — see runner.go.\n" +
		"// This is how a language with no eval dispatches on a name known only at\n" +
		"// generation time: the name becomes a compile-time reference.\n" +
		"func cgEntry() any { return " + spec.FunctionName + " }\n"
	if err := os.WriteFile(filepath.Join(dir, "shim.go"), []byte(shim), 0o644); err != nil {
		cgFail(cgPhaseCompile, fmt.Sprintf("runner: could not stage the entry shim: %v", err), "")
	}

	// --- compile -------------------------------------------------------------
	ctx, cancel := context.WithTimeout(context.Background(), cgCompileBudget)
	defer cancel()
	build := exec.CommandContext(ctx, "go", "build", "-o", filepath.Join(dir, "prog"), ".")
	build.Dir = dir
	build.Env = append(os.Environ(), "CGO_ENABLED=0", "GOPROXY=off", "GOFLAGS=-mod=mod", "GOTOOLCHAIN=local")
	buildOut, buildErr := build.CombinedOutput()
	if buildErr != nil {
		if ctx.Err() != nil {
			cgFail(cgPhaseCompile, fmt.Sprintf(
				"Compilation exceeded the %ds budget.", int(cgCompileBudget/time.Second)), "")
		}
		diag := cgCleanDiagnostics(string(buildOut), dir)
		// `undefined: <name>` reported against the generated shim is not a
		// compile error the candidate can act on — it means the file simply
		// does not define the function the problem asked for. Say THAT, in the
		// same words the interpreted runners use, and at the same phase.
		if strings.Contains(diag, "shim.go") && strings.Contains(diag, "undefined: "+spec.FunctionName) {
			cgFail(cgPhaseLoad, fmt.Sprintf(
				"runner: expected a function named %q but it was not defined", spec.FunctionName), "")
		}
		// A missing package clause is the one compile error that is about the
		// SHAPE of the submission rather than about its code, so it gets a
		// sentence naming the fix. The check lives here, in the failure path,
		// rather than as a pre-flight scan: a scan could reject a file the
		// compiler would have accepted, and this cannot.
		if strings.Contains(diag, "expected 'package'") {
			diag += "\n\nEvery Go file must open with a package clause. Put `package main` " +
				"on the first line, above your imports and functions."
		}
		if strings.TrimSpace(diag) == "" {
			diag = "the Go compiler rejected this solution but produced no diagnostic"
		}
		cgFail(cgPhaseCompile, diag, "")
	}

	// --- run -----------------------------------------------------------------
	payloadPath := filepath.Join(dir, "payload.json")
	runCtx, runCancel := context.WithTimeout(context.Background(), cgRunBudget+cgChildGrace)
	defer runCancel()
	child := exec.CommandContext(runCtx, filepath.Join(dir, "prog"), "--harness", testsPath, payloadPath)
	child.Dir = dir
	var childOut, childErrBuf bytes.Buffer
	child.Stdout = &childOut
	child.Stderr = &childErrBuf
	childErr := child.Run()

	// Anything on the child's real stdout got there before main could install a
	// capture — a package-level `var _ = fmt.Println(…)` initializer in the
	// user's file. Reported rather than allowed to corrupt anything, because
	// the payload never travelled that way.
	initStdout := cgTruncate(childOut.String(), cgStdoutCap)

	payload, readErr := os.ReadFile(payloadPath)
	if readErr == nil && json.Valid(payload) {
		if initStdout != "" {
			var p cgPayload
			if json.Unmarshal(payload, &p) == nil {
				if p.Stdout == "" {
					p.Stdout = initStdout
				}
				cgEmit(p)
				return
			}
		}
		_, _ = cgRealStdout.Write(payload)
		return
	}

	// No payload: the child died in a way it could not report. A Go stack
	// overflow is the honest example — it is a runtime FATAL, not a panic, so
	// no recover() anywhere can see it.
	message := cgTruncate(strings.TrimSpace(childErrBuf.String()), 2000)
	switch {
	case runCtx.Err() != nil:
		message = fmt.Sprintf("Timed out — the suite exceeded its %ds budget and was killed.",
			int((cgRunBudget+cgChildGrace)/time.Second))
	case strings.Contains(message, "stack overflow"):
		// The runtime follows "fatal error: stack overflow" with a full dump of
		// every goroutine's stack — thousands of identical frames, which is the
		// least informative possible way to say "you recursed forever". Keep
		// the diagnosis, drop the dump.
		message = "fatal error: stack overflow — the recursion never reached a base case.\n\n" +
			cgFirstLines(message, 3)
	case message == "":
		// No stderr at all and no payload means the kernel took the process
		// away mid-flight, which under --memory=512m is essentially always a
		// runaway allocation. `signal: killed` on its own tells nobody that.
		if childErr != nil && strings.Contains(childErr.Error(), "killed") {
			message = "The sandbox killed your solution: it ran out of memory (the container has 512MB). " +
				"That is usually an allocation that grows without bound."
		} else if childErr != nil {
			message = "runner: the compiled solution exited without producing results: " + childErr.Error()
		} else {
			message = "runner: the compiled solution produced no results"
		}
	}
	cgFail(cgPhaseRun, message, initStdout)
}

// cgFirstLines keeps the head of a multi-line message and says so.
func cgFirstLines(s string, n int) string {
	lines := strings.Split(s, "\n")
	if len(lines) <= n {
		return s
	}
	return strings.Join(lines[:n], "\n") + "\n… (stack dump omitted)"
}

func cgTruncate(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max] + fmt.Sprintf("\n… (output truncated at %d bytes)", max)
}

// cgCleanDiagnostics turns `go build` output into something a candidate can
// read: the "# cg" package banner and toolchain notes go, the ./ prefix goes,
// and the build directory never appears (it is a random path that would only
// distract). Line and column are preserved exactly — they are the whole value
// of a compile_error verdict.
func cgCleanDiagnostics(out, dir string) string {
	lines := strings.Split(strings.TrimRight(out, "\n"), "\n")
	kept := make([]string, 0, len(lines))
	for _, line := range lines {
		trimmed := strings.TrimRight(line, "\r")
		if strings.HasPrefix(trimmed, "#") {
			continue
		}
		if strings.HasPrefix(strings.TrimSpace(trimmed), "note:") {
			continue
		}
		trimmed = strings.ReplaceAll(trimmed, dir+string(filepath.Separator), "")
		trimmed = strings.ReplaceAll(trimmed, dir, "")
		trimmed = strings.TrimPrefix(trimmed, "./")
		trimmed = strings.ReplaceAll(trimmed, " ./", " ")
		if strings.TrimSpace(trimmed) == "" {
			continue
		}
		kept = append(kept, trimmed)
	}
	return cgTruncate(strings.Join(kept, "\n"), 4000)
}

// =============================================================================
// --selftest — the conformance gate
// =============================================================================
// Runs in the BAKED binary. The fixture half needs no compile step at all — it
// exercises the comparator and the serializer, neither of which needs the
// user's shim — which keeps the post-build gate in bin/build-runner-image fast
// and keeps it honest about testing the IMAGE rather than the working tree.
//
// The second half, cgSelftestCacheTrim below, DOES compile, because the thing
// it proves (that a >24h-old image can still trim its build cache) has no
// cheaper witness. It costs the gate about a third of a second.

var cgSentinels = map[string]float64{
	"nan":   math.NaN(),
	"inf":   math.Inf(1),
	"-inf":  math.Inf(-1),
	"-zero": math.Copysign(0, -1),
}

// cgDecodeFixture turns {"$cg":"nan"} back into a real NaN, recursively. An
// object carrying $cg AND any other key is an ordinary object that happens to
// have an awkward key — the fixture says so explicitly and pins it with a case.
func cgDecodeFixture(v any) (any, error) {
	switch t := v.(type) {
	case []any:
		out := make([]any, len(t))
		for i, item := range t {
			d, err := cgDecodeFixture(item)
			if err != nil {
				return nil, err
			}
			out[i] = d
		}
		return out, nil
	case map[string]any:
		if len(t) == 1 {
			if name, ok := t["$cg"].(string); ok {
				value, known := cgSentinels[name]
				if !known {
					return nil, fmt.Errorf("unknown sentinel: %s", name)
				}
				return value, nil
			}
		}
		out := make(map[string]any, len(t))
		for k, item := range t {
			d, err := cgDecodeFixture(item)
			if err != nil {
				return nil, err
			}
			out[k] = d
		}
		return out, nil
	default:
		return v, nil
	}
}

type cgFixture struct {
	Version  int `json:"version"`
	Equality []struct {
		Name  string `json:"name"`
		A     any    `json:"a"`
		B     any    `json:"b"`
		Equal bool   `json:"equal"`
	} `json:"equality"`
	Serialization []struct {
		Name  string `json:"name"`
		Value any    `json:"value"`
		JSON  string `json:"json"`
	} `json:"serialization"`
}

// -----------------------------------------------------------------------------
// The build-cache trim probe — the half of the gate that tests the IMAGE
// -----------------------------------------------------------------------------
// Everything above tests what the harness COMPUTES. This tests what the image
// IS, and it exists because of a failure the fixture could never have caught:
// `go build` rewrites $GOCACHE/trim.txt once every 24 hours and base.Fatalf()s
// if it cannot, so a Go image was correct for exactly one day and then rejected
// every COMPILING submission for the rest of its life. The whole incident, the
// toolchain source it turns on, and the fix are written out in
// test-harness/go/Dockerfile; this is the part that keeps it fixed.
//
// It has to FORCE the aged condition. Which branch Trim() takes is decided by
// comparing the stamp against the clock, so a probe that just compiled would
// pass on a fresh image and on a broken one alike — which is precisely how the
// bug shipped. Writing a 2001 timestamp first is what makes the toolchain do
// the thing that used to be fatal.
//
// bin/build-runner-image runs --selftest with the production sandbox flags
// (--read-only, USER nobody, no network), so a Dockerfile edit that loses the
// writable trim path fails the BUILD rather than the server, 24 hours later.

// The stamp go compares against time.Now(): 2001-09-09, older than trimInterval
// by two decades, so Trim() always takes the scan-and-rewrite branch.
const cgStaleTrimStamp = 1000000000

// cgCountCacheEntries counts the files in the 256 two-hex-digit subdirectories
// of a GOCACHE. A trim that could reach the baked cache would change this.
func cgCountCacheEntries(cacheDir string) (int, error) {
	subdirs, err := os.ReadDir(cacheDir)
	if err != nil {
		return 0, err
	}
	total := 0
	for _, sub := range subdirs {
		if !sub.IsDir() || len(sub.Name()) != 2 {
			continue
		}
		entries, err := os.ReadDir(filepath.Join(cacheDir, sub.Name()))
		if err != nil {
			return 0, err
		}
		total += len(entries)
	}
	return total, nil
}

func cgSelftestCacheTrim() (checks int, failures []string, note string) {
	cacheDir := os.Getenv("GOCACHE")
	if cacheDir == "" {
		return 1, []string{"cachetrim: GOCACHE is unset, so this image has no baked build cache"}, ""
	}
	stamp := filepath.Join(cacheDir, "trim.txt")

	before, err := cgCountCacheEntries(cacheDir)
	if err != nil {
		return 1, []string{fmt.Sprintf("cachetrim: could not read %s: %v", cacheDir, err)}, ""
	}

	// 1. The write that used to be impossible. This is the check that fails on
	//    an image built before the fix, and it fails for the same reason and
	//    through the same syscall the toolchain would have.
	checks++
	if err := os.WriteFile(stamp, []byte(strconv.Itoa(cgStaleTrimStamp)), 0o644); err != nil {
		return checks, []string{fmt.Sprintf(
			"cachetrim: %s is not writable as uid %d (%v)\n"+
				"      `go build` rewrites that file once every 24h and dies if it cannot, so this\n"+
				"      image would compile today and fail every compiling submission tomorrow.\n"+
				"      Restore the `ln -s /tmp/... /gocache/trim.txt` line in test-harness/go/Dockerfile.",
			stamp, os.Getuid(), err)}, ""
	}

	// 2. A real compile with the stamp a quarter-century stale, so Trim() runs.
	//    go.mod is copied from the harness's own rather than written here: it
	//    already declares a `go` directive this toolchain is known to accept.
	dir, err := os.MkdirTemp("", "cgtrim")
	if err != nil {
		return checks, []string{fmt.Sprintf("cachetrim: could not create a build directory: %v", err)}, ""
	}
	defer os.RemoveAll(dir)
	mod, err := os.ReadFile(filepath.Join(cgSrcDir(), "go.mod"))
	if err != nil {
		return checks, []string{fmt.Sprintf("cachetrim: harness go.mod is missing: %v", err)}, ""
	}
	if err := os.WriteFile(filepath.Join(dir, "go.mod"), mod, 0o644); err != nil {
		return checks, []string{fmt.Sprintf("cachetrim: could not stage go.mod: %v", err)}, ""
	}
	if err := os.WriteFile(filepath.Join(dir, "main.go"), []byte("package main\n\nfunc main() {}\n"), 0o644); err != nil {
		return checks, []string{fmt.Sprintf("cachetrim: could not stage main.go: %v", err)}, ""
	}
	build := exec.Command("go", "build", "-o", filepath.Join(dir, "prog"), ".")
	build.Dir = dir
	build.Env = append(os.Environ(), "CGO_ENABLED=0", "GOPROXY=off", "GOFLAGS=-mod=mod", "GOTOOLCHAIN=local")
	started := time.Now()
	out, buildErr := build.CombinedOutput()
	elapsed := time.Since(started)
	checks++
	if buildErr != nil {
		return checks, []string{fmt.Sprintf(
			"cachetrim: `go build` failed with a 24h-stale trim stamp (%v):\n      %s",
			buildErr, strings.TrimSpace(string(out)))}, ""
	}

	// 3. The trim must actually have HAPPENED — a build that skipped it would
	//    prove nothing, and the stamp is go's own record that it ran.
	checks++
	written, err := os.ReadFile(stamp)
	if err != nil {
		failures = append(failures, fmt.Sprintf("cachetrim: could not read back %s: %v", stamp, err))
	} else if t, convErr := strconv.ParseInt(strings.TrimSpace(string(written)), 10, 64); convErr != nil {
		failures = append(failures, fmt.Sprintf("cachetrim: %s is not a timestamp after the build: %q", stamp, written))
	} else if t <= cgStaleTrimStamp {
		failures = append(failures, fmt.Sprintf(
			"cachetrim: the build did not rewrite %s (still %d) — the trim never ran, so this proves nothing", stamp, t))
	}

	// 4. And it must not have been able to EVICT anything. Every entry in the
	//    baked cache is older than trimLimit on any image more than five days
	//    old, so the only thing standing between the warm cache and the trim's
	//    unlink() is the read-only rootfs. Assert it is still standing.
	checks++
	after, err := cgCountCacheEntries(cacheDir)
	if err != nil {
		failures = append(failures, fmt.Sprintf("cachetrim: could not re-read %s: %v", cacheDir, err))
	} else if after != before {
		failures = append(failures, fmt.Sprintf(
			"cachetrim: the trim removed %d of %d cache entries — the warm cache is not read-only",
			before-after, before))
	}

	note = fmt.Sprintf("a build with a 24h-stale trim stamp compiled in %dms and left all %d cache entries in place",
		elapsed.Milliseconds(), before)
	return checks, failures, note
}

func cgSelftest(path string) {
	raw, err := os.ReadFile(path)
	if err != nil {
		fmt.Fprintf(cgRealStdout, "selftest: could not read %s: %v\n", path, err)
		os.Exit(1)
	}
	var spec cgFixture
	if err := json.Unmarshal(raw, &spec); err != nil {
		fmt.Fprintf(cgRealStdout, "selftest: could not parse %s: %v\n", path, err)
		os.Exit(1)
	}

	var failures []string
	checks := 0

	for _, c := range spec.Equality {
		a, err := cgDecodeFixture(c.A)
		if err != nil {
			failures = append(failures, fmt.Sprintf("equality/%s: %v", c.Name, err))
			continue
		}
		b, err := cgDecodeFixture(c.B)
		if err != nil {
			failures = append(failures, fmt.Sprintf("equality/%s: %v", c.Name, err))
			continue
		}

		got := cgDeepEqual(a, b)
		checks++
		if got != c.Equal {
			failures = append(failures, fmt.Sprintf("equality/%s: expected %v, got %v", c.Name, c.Equal, got))
		}
		// Symmetry and reflexivity hold for EVERY case, so asserting them here
		// triples the coverage for free — and they are the two properties a
		// hand-written comparator loses first.
		swapped := cgDeepEqual(b, a)
		checks++
		if swapped != c.Equal {
			failures = append(failures, fmt.Sprintf("equality/%s: not symmetric — a~b %v, b~a %v", c.Name, got, swapped))
		}
		checks += 2
		if !cgDeepEqual(a, a) {
			failures = append(failures, fmt.Sprintf("equality/%s: a is not equal to itself", c.Name))
		}
		if !cgDeepEqual(b, b) {
			failures = append(failures, fmt.Sprintf("equality/%s: b is not equal to itself", c.Name))
		}
	}

	for _, c := range spec.Serialization {
		value, err := cgDecodeFixture(c.Value)
		if err != nil {
			failures = append(failures, fmt.Sprintf("serialization/%s: %v", c.Name, err))
			continue
		}
		text, err := cgSerialize(value, 0)
		checks++
		if err != nil {
			failures = append(failures, fmt.Sprintf("serialization/%s: not serializable (%v)", c.Name, err))
			continue
		}
		if text != c.JSON {
			failures = append(failures, fmt.Sprintf("serialization/%s: expected %s, got %s", c.Name, c.JSON, text))
			continue
		}
		checks++
		var reparsed any
		if err := json.Unmarshal([]byte(text), &reparsed); err != nil {
			failures = append(failures, fmt.Sprintf("serialization/%s: emitted text is not valid JSON — %v", c.Name, err))
			continue
		}
		if !cgDeepEqual(reparsed, value) {
			failures = append(failures, fmt.Sprintf("serialization/%s: does not survive a JSON round-trip", c.Name))
		}
	}

	// The image-level probe. It compiles, so it is deliberately LAST: a runner
	// that disagrees with the fixture should say so without waiting on a build.
	trimChecks, trimFailures, trimNote := cgSelftestCacheTrim()
	checks += trimChecks
	failures = append(failures, trimFailures...)

	fmt.Fprintf(cgRealStdout, "selftest: go runner vs %s (fixture v%d)\n", path, spec.Version)
	if trimNote != "" {
		fmt.Fprintf(cgRealStdout, "  build cache: %s\n", trimNote)
	}
	if len(failures) == 0 {
		fmt.Fprintf(cgRealStdout, "  PASS — %d checks over %d equality and %d serialization cases, plus the build-cache trim\n",
			checks, len(spec.Equality), len(spec.Serialization))
		os.Exit(0)
	}
	fmt.Fprintf(cgRealStdout, "  FAIL — %d of %d checks disagree with the shared spec:\n", len(failures), checks)
	for _, f := range failures {
		fmt.Fprintf(cgRealStdout, "    %s\n", f)
	}
	os.Exit(1)
}

// =============================================================================
// Main
// =============================================================================
func main() {
	args := os.Args[1:]
	switch {
	case len(args) > 0 && args[0] == "--selftest":
		path := cgFixturePath()
		if len(args) > 1 {
			path = args[1]
		}
		cgSelftest(path)
	case len(args) > 0 && args[0] == "--harness":
		if len(args) < 3 {
			cgFail(cgPhaseLoad, "runner: --harness needs a tests path and a payload path", "")
		}
		cgHarness(args[1], args[2])
	case len(args) >= 2:
		cgDriver(args[0], args[1])
	default:
		cgFail(cgPhaseLoad, "runner: missing solution or tests path argument", "")
	}
}
