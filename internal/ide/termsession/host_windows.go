//go:build windows

package termsession

import (
	"context"
	"fmt"
	"os"
	"strings"
	"sync"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

const (
	procThreadAttributePseudoConsole = 0x00020016
	extendedStartupinfoPresent       = 0x00080000
)

var (
	kernel32                     = windows.NewLazySystemDLL("kernel32.dll")
	procCreatePseudoConsole      = kernel32.NewProc("CreatePseudoConsole")
	procResizePseudoConsole      = kernel32.NewProc("ResizePseudoConsole")
	procClosePseudoConsole       = kernel32.NewProc("ClosePseudoConsole")
	procInitializeProcThreadAttr = kernel32.NewProc("InitializeProcThreadAttributeList")
	procUpdateProcThreadAttr     = kernel32.NewProc("UpdateProcThreadAttribute")
	procDeleteProcThreadAttr     = kernel32.NewProc("DeleteProcThreadAttributeList")
)

type windowsHost struct{}

type windowsProcess struct {
	mu       sync.Mutex
	input    windows.Handle
	output   windows.Handle
	pseudo   windows.Handle
	job      windows.Handle
	process  windows.Handle
	attrList []byte
	closed   bool
}

type startupInfoEx struct {
	StartupInfo   windows.StartupInfo
	AttributeList uintptr
}

func newSystemHost() (Host, error) {
	if err := procCreatePseudoConsole.Find(); err != nil {
		return nil, ErrTerminalUnavailable
	}
	return windowsHost{}, nil
}

func (windowsHost) Start(_ context.Context, spec StartSpec) (Process, error) {
	if strings.TrimSpace(spec.Program) == "" || strings.TrimSpace(spec.Dir) == "" {
		return nil, ErrTerminalUnavailable
	}
	if spec.Cols == 0 {
		spec.Cols = defaultCols
	}
	if spec.Rows == 0 {
		spec.Rows = defaultRows
	}
	var inputRead, inputWrite, outputRead, outputWrite windows.Handle
	sa := windows.SecurityAttributes{InheritHandle: 1}
	sa.Length = uint32(unsafe.Sizeof(sa))
	if err := windows.CreatePipe(&inputRead, &inputWrite, &sa, 0); err != nil {
		return nil, ErrTerminalUnavailable
	}
	if err := windows.CreatePipe(&outputRead, &outputWrite, &sa, 0); err != nil {
		_ = windows.CloseHandle(inputRead)
		_ = windows.CloseHandle(inputWrite)
		return nil, ErrTerminalUnavailable
	}
	var pseudo windows.Handle
	size := uint32(spec.Cols) | uint32(spec.Rows)<<16
	status, _, callErr := procCreatePseudoConsole.Call(
		uintptr(size),
		uintptr(inputRead),
		uintptr(outputWrite),
		0,
		uintptr(unsafe.Pointer(&pseudo)),
	)
	if status != 0 {
		_ = windows.CloseHandle(inputRead)
		_ = windows.CloseHandle(inputWrite)
		_ = windows.CloseHandle(outputRead)
		_ = windows.CloseHandle(outputWrite)
		if callErr != nil {
			return nil, fmt.Errorf("%w", ErrTerminalUnavailable)
		}
		return nil, ErrTerminalUnavailable
	}
	_ = windows.CloseHandle(inputRead)
	_ = windows.CloseHandle(outputWrite)

	attrList, attrPtr, err := newPseudoConsoleAttributes(pseudo)
	if err != nil {
		_ = closePseudoConsole(pseudo)
		_ = windows.CloseHandle(inputWrite)
		_ = windows.CloseHandle(outputRead)
		return nil, ErrTerminalUnavailable
	}
	commandLine, err := windows.UTF16PtrFromString(buildCommandLine(spec.Program, spec.Args))
	if err != nil {
		deleteProcThreadAttributes(attrList)
		_ = closePseudoConsole(pseudo)
		_ = windows.CloseHandle(inputWrite)
		_ = windows.CloseHandle(outputRead)
		return nil, ErrTerminalUnavailable
	}
	dirPtr, err := windows.UTF16PtrFromString(spec.Dir)
	if err != nil {
		deleteProcThreadAttributes(attrList)
		_ = closePseudoConsole(pseudo)
		_ = windows.CloseHandle(inputWrite)
		_ = windows.CloseHandle(outputRead)
		return nil, ErrTerminalUnavailable
	}
	si := startupInfoEx{}
	si.StartupInfo.Cb = uint32(unsafe.Sizeof(si))
	si.StartupInfo.Flags = windows.STARTF_USESHOWWINDOW
	si.StartupInfo.ShowWindow = windows.SW_HIDE
	si.AttributeList = attrPtr
	var pi windows.ProcessInformation
	err = windows.CreateProcess(
		nil,
		commandLine,
		nil,
		nil,
		false,
		extendedStartupinfoPresent|windows.CREATE_UNICODE_ENVIRONMENT,
		nil,
		dirPtr,
		&si.StartupInfo,
		&pi,
	)
	deleteProcThreadAttributes(attrList)
	if err != nil {
		_ = closePseudoConsole(pseudo)
		_ = windows.CloseHandle(inputWrite)
		_ = windows.CloseHandle(outputRead)
		return nil, ErrTerminalUnavailable
	}
	_ = windows.CloseHandle(pi.Thread)
	job, err := createKillOnCloseJob(pi.Process)
	if err != nil {
		_ = windows.TerminateProcess(pi.Process, 1)
		_ = windows.CloseHandle(pi.Process)
		_ = closePseudoConsole(pseudo)
		_ = windows.CloseHandle(inputWrite)
		_ = windows.CloseHandle(outputRead)
		return nil, ErrTerminalUnavailable
	}
	return &windowsProcess{
		input:   inputWrite,
		output:  outputRead,
		pseudo:  pseudo,
		job:     job,
		process: pi.Process,
	}, nil
}

func (proc *windowsProcess) Read(p []byte) (int, error) {
	proc.mu.Lock()
	output := proc.output
	closed := proc.closed
	proc.mu.Unlock()
	if closed || output == 0 {
		return 0, os.ErrClosed
	}
	var done uint32
	err := windows.ReadFile(output, p, &done, nil)
	return int(done), err
}

func (proc *windowsProcess) Write(p []byte) (int, error) {
	proc.mu.Lock()
	input := proc.input
	closed := proc.closed
	proc.mu.Unlock()
	if closed || input == 0 {
		return 0, os.ErrClosed
	}
	var done uint32
	err := windows.WriteFile(input, p, &done, nil)
	return int(done), err
}

func (proc *windowsProcess) Resize(cols, rows uint16) error {
	proc.mu.Lock()
	pseudo := proc.pseudo
	closed := proc.closed
	proc.mu.Unlock()
	if closed || pseudo == 0 {
		return os.ErrClosed
	}
	size := uint32(cols) | uint32(rows)<<16
	status, _, err := procResizePseudoConsole.Call(uintptr(pseudo), uintptr(size))
	if status != 0 {
		if err != nil {
			return err
		}
		return ErrTerminalUnavailable
	}
	return nil
}

func (proc *windowsProcess) Interrupt() error {
	_, err := proc.Write([]byte{0x03})
	return err
}

func (proc *windowsProcess) Kill() error {
	proc.mu.Lock()
	defer proc.mu.Unlock()
	if proc.closed {
		return nil
	}
	proc.closed = true
	if proc.job != 0 {
		_ = windows.TerminateJobObject(proc.job, 1)
		_ = windows.CloseHandle(proc.job)
		proc.job = 0
	}
	if proc.process != 0 {
		_ = windows.TerminateProcess(proc.process, 1)
		_ = windows.CloseHandle(proc.process)
		proc.process = 0
	}
	if proc.pseudo != 0 {
		_ = closePseudoConsole(proc.pseudo)
		proc.pseudo = 0
	}
	if proc.input != 0 {
		_ = windows.CloseHandle(proc.input)
		proc.input = 0
	}
	if proc.output != 0 {
		_ = windows.CloseHandle(proc.output)
		proc.output = 0
	}
	return nil
}

func buildCommandLine(program string, args []string) string {
	parts := make([]string, 0, 1+len(args))
	parts = append(parts, syscall.EscapeArg(program))
	for _, arg := range args {
		parts = append(parts, syscall.EscapeArg(arg))
	}
	return strings.Join(parts, " ")
}

func closePseudoConsole(handle windows.Handle) error {
	_, _, err := procClosePseudoConsole.Call(uintptr(handle))
	if err != nil && err != windows.ERROR_SUCCESS {
		return err
	}
	return nil
}

func newPseudoConsoleAttributes(pseudo windows.Handle) ([]byte, uintptr, error) {
	var size uintptr
	_, _, err := procInitializeProcThreadAttr.Call(0, 1, 0, uintptr(unsafe.Pointer(&size)))
	if size == 0 {
		return nil, 0, err
	}
	buf := make([]byte, size)
	status, _, err := procInitializeProcThreadAttr.Call(
		uintptr(unsafe.Pointer(&buf[0])),
		1,
		0,
		uintptr(unsafe.Pointer(&size)),
	)
	if status == 0 {
		return nil, 0, err
	}
	pseudoCopy := pseudo
	status, _, err = procUpdateProcThreadAttr.Call(
		uintptr(unsafe.Pointer(&buf[0])),
		0,
		procThreadAttributePseudoConsole,
		uintptr(pseudoCopy),
		unsafe.Sizeof(pseudoCopy),
		0,
		0,
	)
	if status == 0 {
		deleteProcThreadAttributes(buf)
		return nil, 0, err
	}
	return buf, uintptr(unsafe.Pointer(&buf[0])), nil
}

func deleteProcThreadAttributes(buf []byte) {
	if len(buf) == 0 {
		return
	}
	_, _, _ = procDeleteProcThreadAttr.Call(uintptr(unsafe.Pointer(&buf[0])))
}

func createKillOnCloseJob(process windows.Handle) (windows.Handle, error) {
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return 0, err
	}
	info := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	info.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	_, err = windows.SetInformationJobObject(
		job,
		windows.JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&info)),
		uint32(unsafe.Sizeof(info)),
	)
	if err != nil {
		_ = windows.CloseHandle(job)
		return 0, err
	}
	if err := windows.AssignProcessToJobObject(job, process); err != nil {
		_ = windows.CloseHandle(job)
		return 0, err
	}
	return job, nil
}
