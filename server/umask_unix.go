//go:build !windows

package main

import "syscall"

// Company files hold financial and payroll data: everything the server
// creates (company files, backups, temporary files) is readable by this
// user only.
func init() { syscall.Umask(0o077) }
