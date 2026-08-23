//go:build windows

package sshvault

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDPAPIProtectorHidesPlaintext(t *testing.T) {
	protector := NewDPAPIProtector()
	protected, err := protector.Protect([]byte("BEGIN OPENSSH PRIVATE KEY"))
	if err != nil {
		t.Fatalf("Protect() error = %v", err)
	}
	if bytes.Contains(protected, []byte("BEGIN OPENSSH PRIVATE KEY")) {
		t.Fatal("DPAPI ciphertext contained plaintext")
	}
	plain, err := protector.Unprotect(protected)
	if err != nil || string(plain) != "BEGIN OPENSSH PRIVATE KEY" {
		t.Fatalf("Unprotect() = (%q, %v)", plain, err)
	}
}

func TestWindowsVaultUsesDPAPIOnDisk(t *testing.T) {
	root := t.TempDir()
	privatePEM, _, _ := mustTestKey(t, "")
	store := New(root, NewDPAPIProtector())
	summary, err := store.Import(context.Background(), ImportRequest{Name: "dpapi", PrivateKey: privatePEM})
	if err != nil {
		t.Fatalf("Import() error = %v", err)
	}
	disk, err := os.ReadFile(filepath.Join(root, "keys.json"))
	if err != nil {
		t.Fatalf("ReadFile() error = %v", err)
	}
	if strings.Contains(string(disk), "BEGIN OPENSSH PRIVATE KEY") || strings.Contains(string(disk), privatePEM) {
		t.Fatalf("DPAPI vault leaked plaintext: %s", disk)
	}
	loaded, err := store.PrivateMaterial(context.Background(), summary.ID)
	if err != nil || string(loaded) != privatePEM {
		t.Fatalf("PrivateMaterial() = (%q, %v)", loaded, err)
	}
}
