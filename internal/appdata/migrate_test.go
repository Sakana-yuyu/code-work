package appdata

import (
	"os"
	"path/filepath"
	"testing"
)

func TestEnsureAssistantHomeDoesNotReadOrDeleteCursorBYOKData(t *testing.T) {
	home := t.TempDir()
	t.Setenv(RootDirEnvVar, home)

	legacyConfig := filepath.Join(home, cursorBYOKAppDirName, "config.yaml")
	legacyRule := filepath.Join(home, cursorBYOKLegacyAppDirName, "rules", "legacy.md")
	if err := os.MkdirAll(filepath.Dir(legacyConfig), 0o755); err != nil {
		t.Fatalf("create legacy config directory: %v", err)
	}
	if err := os.MkdirAll(filepath.Dir(legacyRule), 0o755); err != nil {
		t.Fatalf("create legacy rule directory: %v", err)
	}
	if err := os.WriteFile(legacyConfig, []byte("modelAdapters: []\n"), 0o600); err != nil {
		t.Fatalf("write legacy config: %v", err)
	}
	if err := os.WriteFile(legacyRule, []byte("legacy rule"), 0o600); err != nil {
		t.Fatalf("write legacy rule: %v", err)
	}

	if err := EnsureAssistantHome(); err != nil {
		t.Fatalf("EnsureAssistantHome() error = %v", err)
	}

	if _, err := os.Stat(legacyConfig); err != nil {
		t.Fatalf("legacy config was modified or removed: %v", err)
	}
	if _, err := os.Stat(legacyRule); err != nil {
		t.Fatalf("legacy rule was modified or removed: %v", err)
	}
	if _, err := os.Stat(ConfigFilePath()); !os.IsNotExist(err) {
		t.Fatalf("Code Work unexpectedly imported legacy config; stat error = %v", err)
	}
}
