//go:build !unix

package main

// restrictUmask does nothing where there is no umask (Windows).
func restrictUmask() {}
