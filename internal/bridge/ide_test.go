package bridge

import (
	"reflect"
	"testing"
)

func TestIDEWorkspaceBridgeDoesNotAcceptHostPaths(t *testing.T) {
	serviceType := reflect.TypeOf(&ProxyService{})
	if _, exists := serviceType.MethodByName("RegisterIDEWorkspace"); exists {
		t.Fatal("RegisterIDEWorkspace must not be a Wails method")
	}
	method, exists := serviceType.MethodByName("SelectAndRegisterIDEWorkspace")
	if !exists {
		t.Fatal("SelectAndRegisterIDEWorkspace is missing")
	}
	if method.Type.NumIn() != 1 {
		t.Fatalf("SelectAndRegisterIDEWorkspace arity = %d, want receiver only", method.Type.NumIn())
	}
	for _, name := range []string{
		"ListIDEWorkspaces",
		"RemoveIDEWorkspace",
		"GetIDEWorkspaceTree",
		"ReadIDEWorkspaceText",
		"SearchIDEWorkspace",
		"PreviewIDEWorkspaceWrite",
		"ApproveIDEApproval",
		"RejectIDEApproval",
		"CancelIDEWorkspaceApprovals",
		"CommitIDEWorkspaceWrite",
		"GetIDEGitSnapshot",
		"ListIDESSHKeys",
		"ImportIDESSHKey",
		"GenerateIDESSHKey",
		"RemoveIDESSHKey",
		"ListIDEKnownHosts",
		"ProbeIDEHostKey",
		"PreviewIDEKnownHost",
		"CommitIDEKnownHost",
	} {
		if _, exists := serviceType.MethodByName(name); !exists {
			t.Fatalf("%s is missing", name)
		}
	}
	if _, exists := serviceType.MethodByName("GetIDESSHPrivateKey"); exists {
		t.Fatal("GetIDESSHPrivateKey must not be a Wails method")
	}
	if _, exists := serviceType.MethodByName("PrivateMaterial"); exists {
		t.Fatal("PrivateMaterial must not be a Wails method")
	}
	if _, exists := serviceType.MethodByName("FilePath"); exists {
		t.Fatal("FilePath must not be a Wails method")
	}
	if _, exists := serviceType.MethodByName("AppendIDEKnownHost"); exists {
		t.Fatal("AppendIDEKnownHost must not be a Wails method")
	}
}

func TestWindowServiceDirectoryPickerIsNotExported(t *testing.T) {
	if _, exists := reflect.TypeOf(&WindowService{}).MethodByName("SelectWorkspaceDirectory"); exists {
		t.Fatal("SelectWorkspaceDirectory must stay unexported so the frontend cannot receive host paths")
	}
	if _, exists := reflect.TypeOf(&WindowService{}).MethodByName("selectWorkspaceDirectory"); exists {
		t.Fatal("unexported methods should not appear in the exported method set")
	}
}
