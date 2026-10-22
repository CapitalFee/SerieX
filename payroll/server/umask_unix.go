//go:build unix

package main

import "syscall"

// restrictUmask makes the files and folders this process creates readable
// and writable only by the user running it (0600 files, 0700 folders).
func restrictUmask() { syscall.Umask(0o077) }
