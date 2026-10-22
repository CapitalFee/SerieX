//go:build !unix

package assistants

// openNoWait: no extra flag is needed to open files here (see open_unix.go).
const openNoWait = 0
