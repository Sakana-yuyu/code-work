package sshvault

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"encoding/pem"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/crypto/ssh"
)

const testPassphrase = "super-secret-passphrase"

func TestImportPersistsProtectedKeyWithoutPlaintextSecrets(t *testing.T) {
	root := t.TempDir()
	privatePEM, publicKey, fingerprint := mustTestKey(t, "")
	store := New(root, xorProtector{key: 0xA5})
	summary, err := store.Import(context.Background(), ImportRequest{
		Name:       "github",
		PrivateKey: privatePEM,
		Passphrase: "",
	})
	if err != nil {
		t.Fatalf("Import() error = %v", err)
	}
	if summary.ID == "" || summary.Name != "github" || summary.Fingerprint != fingerprint {
		t.Fatalf("summary = %+v", summary)
	}
	if summary.PublicKey != publicKey || !strings.HasPrefix(summary.Algorithm, "ssh-") {
		t.Fatalf("public summary = %+v", summary)
	}
	assertNoSecret(t, summary, privatePEM, testPassphrase)

	disk, err := os.ReadFile(filepath.Join(root, "keys.json"))
	if err != nil {
		t.Fatalf("ReadFile() error = %v", err)
	}
	assertNoSecret(t, string(disk), privatePEM, "BEGIN OPENSSH PRIVATE KEY", "BEGIN PRIVATE KEY", testPassphrase)
	if !strings.Contains(string(disk), "protected_private_key") {
		t.Fatalf("disk store missing protected blob: %s", disk)
	}

	loaded, err := store.PrivateMaterial(context.Background(), summary.ID)
	if err != nil || string(loaded) != privatePEM {
		t.Fatalf("PrivateMaterial() = (%q, %v)", loaded, err)
	}
}

func TestImportPassphraseProtectedKeyOmitsPassphraseFromDTOAndDisk(t *testing.T) {
	root := t.TempDir()
	privatePEM, _, fingerprint := mustTestKey(t, testPassphrase)
	store := New(root, xorProtector{key: 0x3C})
	summary, err := store.Import(context.Background(), ImportRequest{
		Name:       "protected",
		PrivateKey: privatePEM,
		Passphrase: testPassphrase,
	})
	if err != nil {
		t.Fatalf("Import() error = %v", err)
	}
	if summary.Fingerprint != fingerprint {
		t.Fatalf("fingerprint = %q, want %q", summary.Fingerprint, fingerprint)
	}
	assertNoSecret(t, summary, privatePEM, testPassphrase)
	disk, err := os.ReadFile(filepath.Join(root, "keys.json"))
	if err != nil {
		t.Fatalf("ReadFile() error = %v", err)
	}
	assertNoSecret(t, string(disk), testPassphrase, "BEGIN OPENSSH PRIVATE KEY")
	if _, err := store.PrivateMaterial(context.Background(), summary.ID); err != nil {
		t.Fatalf("PrivateMaterial() error = %v", err)
	}
}

func TestGenerateAndListOmitPrivateKeys(t *testing.T) {
	store := New(t.TempDir(), xorProtector{key: 0x11})
	generated, err := store.Generate(context.Background(), "local")
	if err != nil {
		t.Fatalf("Generate() error = %v", err)
	}
	if generated.Fingerprint == "" || generated.PublicKey == "" || generated.Name != "local" {
		t.Fatalf("generated = %+v", generated)
	}
	assertNoSecret(t, generated, "BEGIN ", "PRIVATE KEY")
	items, err := store.List(context.Background())
	if err != nil || len(items) != 1 || items[0].ID != generated.ID {
		t.Fatalf("List() = (%+v, %v)", items, err)
	}
	assertNoSecret(t, items, "BEGIN ", "PRIVATE KEY", testPassphrase)
	if err := store.Remove(context.Background(), generated.ID); err != nil {
		t.Fatalf("Remove() error = %v", err)
	}
	items, err = store.List(context.Background())
	if err != nil || len(items) != 0 {
		t.Fatalf("List() after Remove = (%+v, %v)", items, err)
	}
}

func TestImportRejectsInvalidNameAndKey(t *testing.T) {
	store := New(t.TempDir(), xorProtector{key: 0x22})
	if _, err := store.Import(context.Background(), ImportRequest{Name: "../escape", PrivateKey: "not-a-key"}); err == nil {
		t.Fatal("Import(invalid name) = nil")
	}
	if _, err := store.Import(context.Background(), ImportRequest{Name: "ok", PrivateKey: "not-a-key"}); err == nil {
		t.Fatal("Import(invalid key) = nil")
	}
}

func TestSummaryJSONNeverContainsPrivateKeyFields(t *testing.T) {
	store := New(t.TempDir(), xorProtector{key: 0x44})
	privatePEM, _, _ := mustTestKey(t, "")
	summary, err := store.Import(context.Background(), ImportRequest{Name: "json", PrivateKey: privatePEM})
	if err != nil {
		t.Fatalf("Import() error = %v", err)
	}
	raw, err := json.Marshal(summary)
	if err != nil {
		t.Fatalf("Marshal() error = %v", err)
	}
	encoded := strings.ToLower(string(raw))
	for _, leaked := range []string{"privatekey", "private_key", "passphrase", "protected_private_key", "begin "} {
		if strings.Contains(encoded, leaked) {
			t.Fatalf("summary JSON leaked %q: %s", leaked, raw)
		}
	}
}

type xorProtector struct{ key byte }

func (protector xorProtector) Protect(plaintext []byte) ([]byte, error) {
	out := make([]byte, len(plaintext)+1)
	out[0] = 'X'
	for index, value := range plaintext {
		out[index+1] = value ^ protector.key
	}
	return out, nil
}

func (protector xorProtector) Unprotect(ciphertext []byte) ([]byte, error) {
	if len(ciphertext) == 0 || ciphertext[0] != 'X' {
		return nil, ErrProtectorUnavailable
	}
	out := make([]byte, len(ciphertext)-1)
	for index, value := range ciphertext[1:] {
		out[index] = value ^ protector.key
	}
	return out, nil
}

func mustTestKey(t *testing.T, passphrase string) (privatePEM, publicKey, fingerprint string) {
	t.Helper()
	_, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("GenerateKey() error = %v", err)
	}
	var block *pem.Block
	if passphrase == "" {
		block, err = ssh.MarshalPrivateKey(private, "")
	} else {
		block, err = ssh.MarshalPrivateKeyWithPassphrase(private, "", []byte(passphrase))
	}
	if err != nil {
		t.Fatalf("MarshalPrivateKey() error = %v", err)
	}
	signer, err := ssh.NewSignerFromKey(private)
	if err != nil {
		t.Fatalf("NewSignerFromKey() error = %v", err)
	}
	return string(pem.EncodeToMemory(block)), strings.TrimSpace(string(ssh.MarshalAuthorizedKey(signer.PublicKey()))), ssh.FingerprintSHA256(signer.PublicKey())
}

func assertNoSecret(t *testing.T, value any, secrets ...string) {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		raw = []byte(strings.ToLower(strings.ReplaceAll(asString(value), "\\", "/")))
	}
	encoded := strings.ToLower(string(raw) + asString(value))
	for _, secret := range secrets {
		secret = strings.TrimSpace(secret)
		if secret == "" {
			continue
		}
		if strings.Contains(encoded, strings.ToLower(secret)) {
			t.Fatalf("value leaked secret %q", secret)
		}
	}
}

func asString(value any) string {
	switch typed := value.(type) {
	case string:
		return typed
	default:
		encoded, _ := json.Marshal(typed)
		return string(encoded)
	}
}
