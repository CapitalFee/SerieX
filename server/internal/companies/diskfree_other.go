//go:build !unix

package companies

// diskFree returns -1: free space is not checked on this system.
func diskFree(dir string) int64 { return -1 }

func isNoSpace(err error) bool { return false }
