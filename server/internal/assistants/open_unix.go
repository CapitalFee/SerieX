//go:build unix

package assistants

import "syscall"

// openNoWait opens a file without waiting for another program: opening a
// named pipe for reading would otherwise wait until something writes to it
// (it makes no difference for regular files).
const openNoWait = syscall.O_NONBLOCK
