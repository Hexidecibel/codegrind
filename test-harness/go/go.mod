// Staged into every per-submission build directory by the driver, and used for
// the image's own build of /app/cgrun.
//
// The module name is deliberately short and boring: it is what `go build`
// prints as the "# cg" banner above a diagnostic, and cgCleanDiagnostics strips
// that line before the candidate ever sees it.
//
// There is no `require` and there never will be — GOPROXY is off and the
// container has no network, so the standard library is the whole world.
module cg

go 1.24
