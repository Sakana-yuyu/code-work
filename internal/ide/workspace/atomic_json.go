package workspace

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

const (
	registryDirectoryPerm = 0o700
	registryFilePerm      = 0o600
	maxRegistryJSONBytes  = 1 << 20
)

func readRegistry(path string) (registryDocument, bool, error) {
	file, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			return registryDocument{}, false, nil
		}
		return registryDocument{}, false, fmt.Errorf("%w: read registry", ErrRegistryInvalid)
	}
	defer file.Close()
	decoder := json.NewDecoder(io.LimitReader(file, maxRegistryJSONBytes+1))
	decoder.DisallowUnknownFields()
	var document registryDocument
	if err := decoder.Decode(&document); err != nil {
		return registryDocument{}, false, fmt.Errorf("%w: decode registry", ErrRegistryInvalid)
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return registryDocument{}, false, fmt.Errorf("%w: registry has trailing data", ErrRegistryInvalid)
	}
	return document, true, nil
}

func validateRegistry(document registryDocument) error {
	if document.SchemaVersion != registryVersion || len(document.Workspaces) > maxRegistryRecords {
		return fmt.Errorf("%w: unsupported registry schema", ErrRegistryInvalid)
	}
	ids := make(map[string]struct{}, len(document.Workspaces))
	roots := make(map[string]struct{}, len(document.Workspaces))
	for _, record := range document.Workspaces {
		if _, err := uuidParse(record.ID); err != nil || strings.TrimSpace(record.Name) == "" || strings.TrimSpace(record.Root) == "" || !filepath.IsAbs(record.Root) || record.RegisteredAt.IsZero() {
			return fmt.Errorf("%w: invalid workspace record", ErrRegistryInvalid)
		}
		if _, exists := ids[record.ID]; exists {
			return fmt.Errorf("%w: duplicate workspace ID", ErrRegistryInvalid)
		}
		rootKey := canonicalRegistryRootKey(record.Root)
		if _, exists := roots[rootKey]; exists {
			return fmt.Errorf("%w: duplicate workspace root", ErrRegistryInvalid)
		}
		ids[record.ID] = struct{}{}
		roots[rootKey] = struct{}{}
	}
	return nil
}

func writeRegistryAtomically(path string, document registryDocument) error {
	if err := os.MkdirAll(filepath.Dir(path), registryDirectoryPerm); err != nil {
		return fmt.Errorf("%w: create registry directory", ErrRegistryInvalid)
	}
	if err := os.Chmod(filepath.Dir(path), registryDirectoryPerm); err != nil {
		return fmt.Errorf("%w: secure registry directory", ErrRegistryInvalid)
	}
	data, err := json.MarshalIndent(document, "", "  ")
	if err != nil {
		return fmt.Errorf("%w: encode registry", ErrRegistryInvalid)
	}
	data = append(data, '\n')
	temporary, err := os.CreateTemp(filepath.Dir(path), ".workspaces-*.tmp")
	if err != nil {
		return fmt.Errorf("%w: create registry temporary file", ErrRegistryInvalid)
	}
	temporaryPath := temporary.Name()
	committed := false
	defer func() {
		if !committed {
			_ = temporary.Close()
			_ = os.Remove(temporaryPath)
		}
	}()
	if err := temporary.Chmod(registryFilePerm); err != nil {
		return fmt.Errorf("%w: secure registry temporary file", ErrRegistryInvalid)
	}
	if _, err := temporary.Write(data); err != nil {
		return fmt.Errorf("%w: write registry", ErrRegistryInvalid)
	}
	if err := temporary.Sync(); err != nil {
		return fmt.Errorf("%w: sync registry", ErrRegistryInvalid)
	}
	if err := temporary.Close(); err != nil {
		return fmt.Errorf("%w: close registry", ErrRegistryInvalid)
	}
	if err := os.Rename(temporaryPath, path); err != nil {
		return fmt.Errorf("%w: replace registry", ErrRegistryInvalid)
	}
	if err := os.Chmod(path, registryFilePerm); err != nil {
		return fmt.Errorf("%w: secure registry", ErrRegistryInvalid)
	}
	committed = true
	return nil
}

func uuidParse(value string) (string, error) {
	if len(value) != 36 {
		return "", fmt.Errorf("invalid UUID")
	}
	for index, character := range value {
		if index == 8 || index == 13 || index == 18 || index == 23 {
			if character != '-' {
				return "", fmt.Errorf("invalid UUID")
			}
			continue
		}
		if !((character >= '0' && character <= '9') || (character >= 'a' && character <= 'f') || (character >= 'A' && character <= 'F')) {
			return "", fmt.Errorf("invalid UUID")
		}
	}
	return strings.ToLower(value), nil
}

func canonicalRegistryRootKey(root string) string {
	if samePath(root, strings.ToUpper(root)) {
		return strings.ToLower(filepath.Clean(root))
	}
	return filepath.Clean(root)
}
