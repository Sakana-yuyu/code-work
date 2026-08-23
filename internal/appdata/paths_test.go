package appdata

import (
	"path/filepath"
	"testing"
)

func TestIDEWorkspaceRootPathUsesDataRoot(t *testing.T) {
	override := t.TempDir()
	t.Setenv(RootDirEnvVar, override)
	want := filepath.Join(override, appDirName, "data", "ide-workspaces")
	if got := IDEWorkspaceRootPath(); got != want {
		t.Fatalf("IDEWorkspaceRootPath() = %q, want %q", got, want)
	}
}

func TestIDEApprovalRootPathUsesDataRoot(t *testing.T) {
	override := t.TempDir()
	t.Setenv(RootDirEnvVar, override)
	want := filepath.Join(override, appDirName, "data", "ide-approvals")
	if got := IDEApprovalRootPath(); got != want {
		t.Fatalf("IDEApprovalRootPath() = %q, want %q", got, want)
	}
}

func TestIDESSHVaultRootPathUsesDataRoot(t *testing.T) {
	override := t.TempDir()
	t.Setenv(RootDirEnvVar, override)
	want := filepath.Join(override, appDirName, "data", "ide-ssh-vault")
	if got := IDESSHVaultRootPath(); got != want {
		t.Fatalf("IDESSHVaultRootPath() = %q, want %q", got, want)
	}
}
