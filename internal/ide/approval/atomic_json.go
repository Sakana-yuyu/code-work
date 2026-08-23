package approval

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

const (
	approvalDirectoryPerm = 0o700
	approvalFilePerm      = 0o600
	maxDocumentBytes      = 1 << 20
)

func joinPath(root, name string) string { return filepath.Join(root, name) }

func readDocument(path string) (approvalDocument, bool, error) {
	file, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			return approvalDocument{}, false, nil
		}
		return approvalDocument{}, false, fmt.Errorf("%w: read", ErrStoreInvalid)
	}
	defer file.Close()
	decoder := json.NewDecoder(io.LimitReader(file, maxDocumentBytes+1))
	decoder.DisallowUnknownFields()
	var document approvalDocument
	if err := decoder.Decode(&document); err != nil {
		return approvalDocument{}, false, fmt.Errorf("%w: decode", ErrStoreInvalid)
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return approvalDocument{}, false, fmt.Errorf("%w: trailing data", ErrStoreInvalid)
	}
	return document, true, nil
}

func writeDocument(path string, document approvalDocument) error {
	if err := os.MkdirAll(filepath.Dir(path), approvalDirectoryPerm); err != nil {
		return fmt.Errorf("%w: create directory", ErrStoreWrite)
	}
	if err := os.Chmod(filepath.Dir(path), approvalDirectoryPerm); err != nil {
		return fmt.Errorf("%w: secure directory", ErrStoreWrite)
	}
	data, err := json.MarshalIndent(document, "", "  ")
	if err != nil {
		return fmt.Errorf("%w: encode", ErrStoreWrite)
	}
	data = append(data, '\n')
	temporary, err := os.CreateTemp(filepath.Dir(path), ".approvals-*.tmp")
	if err != nil {
		return fmt.Errorf("%w: create temporary", ErrStoreWrite)
	}
	temporaryPath := temporary.Name()
	committed := false
	defer func() {
		if !committed {
			_ = temporary.Close()
			_ = os.Remove(temporaryPath)
		}
	}()
	if err := temporary.Chmod(approvalFilePerm); err != nil {
		return fmt.Errorf("%w: secure temporary", ErrStoreWrite)
	}
	if _, err := temporary.Write(data); err != nil {
		return fmt.Errorf("%w: write", ErrStoreWrite)
	}
	if err := temporary.Sync(); err != nil {
		return fmt.Errorf("%w: sync", ErrStoreWrite)
	}
	if err := temporary.Close(); err != nil {
		return fmt.Errorf("%w: close", ErrStoreWrite)
	}
	if err := os.Rename(temporaryPath, path); err != nil {
		return fmt.Errorf("%w: replace", ErrStoreWrite)
	}
	if err := os.Chmod(path, approvalFilePerm); err != nil {
		return fmt.Errorf("%w: secure registry", ErrStoreWrite)
	}
	committed = true
	return nil
}
