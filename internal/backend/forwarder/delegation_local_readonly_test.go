package forwarder

import (
	"encoding/json"
	"testing"
)

func TestFilterDelegatedToolsEnforcesReadonlyAllowlist(t *testing.T) {
	tools := []json.RawMessage{
		json.RawMessage(`{"function":{"name":"Read"}}`),
		json.RawMessage(`{"function":{"name":"Grep"}}`),
		json.RawMessage(`{"function":{"name":"Write"}}`),
		json.RawMessage(`{"function":{"name":"CallMcpTool"}}`),
	}
	filtered, err := filterDelegatedTools(tools, nil, nil, []string{"Read", "Grep", "Write", "CallMcpTool"}, true)
	if err != nil {
		t.Fatalf("filterDelegatedTools() error = %v", err)
	}
	if len(filtered) != 2 {
		t.Fatalf("readonly filtered tools = %d, want 2", len(filtered))
	}
	for _, raw := range filtered {
		name, err := extractToolName(raw)
		if err != nil {
			t.Fatalf("extractToolName() error = %v", err)
		}
		if !delegatedReadonlyToolAllowed(name) {
			t.Fatalf("readonly filter retained unsafe tool %q", name)
		}
	}
}

func TestDelegatedToolWhitelistRejectsUnadvertisedInvocation(t *testing.T) {
	if delegatedToolWhitelisted([]string{"Read"}, "Write") {
		t.Fatal("unadvertised Write must not pass the whitelist")
	}
	if !delegatedToolWhitelisted([]string{"Read"}, "Read") {
		t.Fatal("whitelisted Read must be allowed")
	}
}
