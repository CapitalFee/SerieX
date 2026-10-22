//go:build !windows

package seriexmcp

import (
	"errors"
	"syscall"
)

// ProcessRunning reports whether a process with this number exists.
func ProcessRunning(pid int) bool {
	if pid <= 0 {
		return false
	}
	err := syscall.Kill(pid, 0)
	return err == nil || errors.Is(err, syscall.EPERM)
}
