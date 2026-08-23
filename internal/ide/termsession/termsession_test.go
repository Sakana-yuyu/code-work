package termsession

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestListProfilesExposesNamesWithoutHostPaths(t *testing.T) {
	profiles := ListProfiles()
	if len(profiles) != 2 || profiles[0].ID != ProfilePowerShell || profiles[1].ID != ProfileCmd {
		t.Fatalf("profiles = %#v", profiles)
	}
	raw, err := json.Marshal(profiles)
	if err != nil {
		t.Fatal(err)
	}
	encoded := strings.ToLower(string(raw))
	if strings.Contains(encoded, `c:`) || strings.Contains(encoded, `\windows`) || strings.Contains(encoded, "/usr/") {
		t.Fatalf("profiles leaked host path: %s", raw)
	}
}

func TestOpenRejectsUnknownProfileAndDoesNotStartHost(t *testing.T) {
	host := newFakeHost()
	manager := New(func(context.Context, string) (string, error) {
		return `C:\secret-root`, nil
	}, host)
	manager.SetLookPath(func(name string) (string, error) {
		return `C:\Windows\System32\` + name + ".exe", nil
	})
	if _, err := manager.Open(context.Background(), "ws-1", "bash -c calc", 80, 24); err == nil {
		t.Fatal("Open(unknown profile) = nil")
	}
	host.mu.Lock()
	defer host.mu.Unlock()
	if len(host.starts) != 0 {
		t.Fatalf("host started = %#v", host.starts)
	}
}

func TestSessionLifecycleUsesWorkspaceRootAndKillsProcess(t *testing.T) {
	host := newFakeHost()
	root := t.TempDir()
	manager := New(func(context.Context, string) (string, error) {
		return root, nil
	}, host)
	manager.SetLookPath(func(name string) (string, error) {
		return `C:\Windows\System32\` + name + ".exe", nil
	})
	var events []Event
	manager.SetEmitter(func(event Event) {
		events = append(events, event)
	})
	info, err := manager.Open(context.Background(), "11111111-1111-4111-8111-111111111111", ProfileCmd, 80, 24)
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	if info.ProfileID != ProfileCmd || info.WorkspaceID != "11111111-1111-4111-8111-111111111111" {
		t.Fatalf("info = %#v", info)
	}
	encoded := string(mustJSON(t, info))
	if strings.Contains(strings.ToLower(encoded), `c:\`) || strings.Contains(encoded, root) {
		t.Fatalf("session leaked host path: %s", encoded)
	}
	waitForOutput(t, manager, info.ID, "ready")
	if err := manager.Write(context.Background(), info.ID, "dir\r"); err != nil {
		t.Fatalf("Write() error = %v", err)
	}
	waitForOutput(t, manager, info.ID, "echo:dir")
	if err := manager.Resize(context.Background(), info.ID, 120, 40); err != nil {
		t.Fatalf("Resize() error = %v", err)
	}
	if err := manager.Interrupt(context.Background(), info.ID); err != nil {
		t.Fatalf("Interrupt() error = %v", err)
	}
	host.mu.Lock()
	start := host.starts[0]
	proc := host.lastProcess
	host.mu.Unlock()
	if start.Dir != root {
		t.Fatalf("start dir = %q, want workspace root", start.Dir)
	}
	if start.Program != `C:\Windows\System32\cmd.exe` {
		t.Fatalf("program = %q", start.Program)
	}
	if strings.Join(start.Args, " ") != "/K" {
		t.Fatalf("args = %v", start.Args)
	}
	proc.mu.Lock()
	if proc.cols != 120 || proc.rows != 40 || !proc.interrupted {
		t.Fatalf("proc = cols=%d rows=%d interrupted=%v", proc.cols, proc.rows, proc.interrupted)
	}
	proc.mu.Unlock()
	if err := manager.Close(context.Background(), info.ID); err != nil {
		t.Fatalf("Close() error = %v", err)
	}
	proc.mu.Lock()
	killed := proc.killed
	proc.mu.Unlock()
	if !killed {
		t.Fatal("Close() did not kill process")
	}
	if err := manager.Write(context.Background(), info.ID, "x"); err == nil {
		t.Fatal("Write after close = nil")
	}
	if _, err := manager.Snapshot(info.ID); err == nil {
		t.Fatal("Snapshot after close = nil")
	}
}

func waitForOutput(t *testing.T, manager *Manager, sessionID, want string) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		snapshot, err := manager.Snapshot(sessionID)
		if err == nil && strings.Contains(snapshot.Data, want) {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	snapshot, _ := manager.Snapshot(sessionID)
	t.Fatalf("output %q does not contain %q", snapshot.Data, want)
}

func mustJSON(t *testing.T, value any) []byte {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("Marshal() error = %v", err)
	}
	return raw
}
