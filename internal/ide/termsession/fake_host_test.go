package termsession

import (
	"bytes"
	"context"
	"io"
	"sync"
)

type fakeHost struct {
	mu          sync.Mutex
	starts      []StartSpec
	lastProcess *fakeProcess
}

type fakeProcess struct {
	mu          sync.Mutex
	reader      *io.PipeReader
	writer      *io.PipeWriter
	input       bytes.Buffer
	cols        uint16
	rows        uint16
	interrupted bool
	killed      bool
}

func newFakeHost() *fakeHost {
	return &fakeHost{}
}

func (host *fakeHost) Start(_ context.Context, spec StartSpec) (Process, error) {
	reader, writer := io.Pipe()
	proc := &fakeProcess{reader: reader, writer: writer, cols: spec.Cols, rows: spec.Rows}
	host.mu.Lock()
	host.starts = append(host.starts, spec)
	host.lastProcess = proc
	host.mu.Unlock()
	go func() {
		_, _ = writer.Write([]byte("ready\r\n"))
	}()
	return proc, nil
}

func (proc *fakeProcess) Read(p []byte) (int, error) {
	return proc.reader.Read(p)
}

func (proc *fakeProcess) Write(p []byte) (int, error) {
	proc.mu.Lock()
	proc.input.Write(p)
	proc.mu.Unlock()
	_, _ = proc.writer.Write(append([]byte("echo:"), p...))
	return len(p), nil
}

func (proc *fakeProcess) Resize(cols, rows uint16) error {
	proc.mu.Lock()
	defer proc.mu.Unlock()
	proc.cols = cols
	proc.rows = rows
	return nil
}

func (proc *fakeProcess) Interrupt() error {
	proc.mu.Lock()
	defer proc.mu.Unlock()
	proc.interrupted = true
	_, _ = proc.writer.Write([]byte("^C\r\n"))
	return nil
}

func (proc *fakeProcess) Kill() error {
	proc.mu.Lock()
	proc.killed = true
	proc.mu.Unlock()
	_ = proc.writer.Close()
	_ = proc.reader.Close()
	return nil
}
