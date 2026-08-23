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
	} {
		if _, exists := serviceType.MethodByName(name); !exists {
			t.Fatalf("%s is missing", name)
		}
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
