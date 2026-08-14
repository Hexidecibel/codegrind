package main

// The stand-in for the per-submission shim, used ONLY when the image builds
// /app/cgrun. runner.go references cgEntry() from harness mode, so the package
// has to define it — but at image build time there is no user function to point
// at, and the two modes that matter without one (--selftest and DRIVER) never
// call it.
//
// This file is deliberately NOT staged into the per-submission build directory:
// the driver copies runner.go and writes the real shim.go beside it, and two
// definitions of cgEntry would be a redeclaration error blamed on the user.
func cgEntry() any { return nil }
