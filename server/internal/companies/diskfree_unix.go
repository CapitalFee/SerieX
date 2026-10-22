//go:build unix

package companies

import (
	"errors"
	"syscall"
)

// diskFree returns the free bytes of the file system holding dir (-1 when unknown).
func diskFree(dir string) int64 {
	var st syscall.Statfs_t
	if err := syscall.Statfs(dir, &st); err != nil {
		return -1
	}
	return int64(st.Bavail) * int64(st.Bsize)
}

func isNoSpace(err error) bool { return errors.Is(err, syscall.ENOSPC) }
