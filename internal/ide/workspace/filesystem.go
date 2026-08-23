package workspace

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"unicode/utf8"
)

const (
	maxTreeEntries     = 1_000
	maxReadTextBytes   = 256 << 10
	maxSearchFiles     = 1_000
	maxSearchFileBytes = 512 << 10
	maxSearchResults   = 200
	maxSearchLineBytes = 4 << 10
	maxSearchQuerySize = 1 << 10
)

type TreeEntry struct {
	Path string `json:"path"`
	Kind string `json:"kind"`
	Size int64  `json:"size,omitempty"`
}

type TreeResult struct {
	Entries   []TreeEntry `json:"entries"`
	Truncated bool        `json:"truncated"`
}

type TextFile struct {
	Path      string `json:"path"`
	Text      string `json:"text,omitempty"`
	Version   string `json:"version,omitempty"`
	Size      int64  `json:"size"`
	Binary    bool   `json:"binary"`
	Truncated bool   `json:"truncated"`
}

type SearchRequest struct {
	Path  string `json:"path,omitempty"`
	Query string `json:"query"`
}

type SearchMatch struct {
	Path          string `json:"path"`
	Line          int    `json:"line"`
	Text          string `json:"text"`
	TextTruncated bool   `json:"textTruncated"`
}

type SearchResult struct {
	Matches      []SearchMatch `json:"matches"`
	FilesScanned int           `json:"filesScanned"`
	FilesSkipped int           `json:"filesSkipped"`
	LimitReached bool          `json:"limitReached"`
}

func (store *Store) Tree(ctx context.Context, workspaceID string, relativeDirectory string) (TreeResult, error) {
	root, relative, err := store.openRoot(ctx, workspaceID, relativeDirectory, true)
	if err != nil {
		return TreeResult{}, err
	}
	defer root.Close()
	if err := ensureNoSymlinkComponents(root, relative); err != nil {
		return TreeResult{}, err
	}
	directory, err := root.Open(relative)
	if err != nil {
		return TreeResult{}, fmt.Errorf("%w: directory unavailable", ErrWorkspaceUnavailable)
	}
	defer directory.Close()
	info, err := directory.Stat()
	if err != nil || !info.IsDir() {
		return TreeResult{}, fmt.Errorf("%w: requested path", ErrNotRegularFile)
	}
	entries, err := directory.ReadDir(maxTreeEntries + 1)
	if err != nil {
		return TreeResult{}, fmt.Errorf("%w: list directory", ErrWorkspaceUnavailable)
	}
	result := TreeResult{Entries: make([]TreeEntry, 0, min(len(entries), maxTreeEntries))}
	if len(entries) > maxTreeEntries {
		entries = entries[:maxTreeEntries]
		result.Truncated = true
	}
	for _, entry := range entries {
		if err := contextErr(ctx); err != nil {
			return TreeResult{}, err
		}
		childPath := joinRelativePath(relative, entry.Name())
		if isSensitiveRelativePath(childPath) {
			continue
		}
		kind := "other"
		if entry.Type()&os.ModeSymlink != 0 {
			kind = "symlink"
		} else if entry.IsDir() {
			kind = "directory"
		} else if entry.Type().IsRegular() {
			kind = "file"
		}
		var size int64
		if kind == "file" {
			if childInfo, statErr := entry.Info(); statErr == nil {
				size = childInfo.Size()
			}
		}
		result.Entries = append(result.Entries, TreeEntry{Path: filepath.ToSlash(childPath), Kind: kind, Size: size})
	}
	sort.Slice(result.Entries, func(left, right int) bool {
		if result.Entries[left].Kind == result.Entries[right].Kind {
			return result.Entries[left].Path < result.Entries[right].Path
		}
		return result.Entries[left].Kind == "directory"
	})
	return result, nil
}

func (store *Store) ReadText(ctx context.Context, workspaceID string, relativeFile string) (TextFile, error) {
	root, relative, err := store.openRoot(ctx, workspaceID, relativeFile, false)
	if err != nil {
		return TextFile{}, err
	}
	defer root.Close()
	if err := ensureNoSymlinkComponents(root, relative); err != nil {
		return TextFile{}, err
	}
	file, err := root.Open(relative)
	if err != nil {
		return TextFile{}, fmt.Errorf("%w: file unavailable", ErrWorkspaceUnavailable)
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return TextFile{}, fmt.Errorf("%w: requested path", ErrNotRegularFile)
	}
	data, err := io.ReadAll(io.LimitReader(file, maxReadTextBytes+1))
	if err != nil {
		return TextFile{}, fmt.Errorf("%w: read file", ErrWorkspaceUnavailable)
	}
	truncated := len(data) > maxReadTextBytes
	if truncated {
		data = data[:maxReadTextBytes]
	}
	binary := bytesAppearBinary(data)
	result := TextFile{
		Path:      filepath.ToSlash(relative),
		Version:   fileVersion(info),
		Size:      info.Size(),
		Binary:    binary,
		Truncated: truncated,
	}
	if !binary {
		result.Text = string(data)
	}
	return result, nil
}

func (store *Store) Search(ctx context.Context, workspaceID string, request SearchRequest) (SearchResult, error) {
	query := request.Query
	if query == "" || len([]byte(query)) > maxSearchQuerySize || !utf8.ValidString(query) {
		return SearchResult{}, fmt.Errorf("%w: search query", ErrInvalidPath)
	}
	root, relative, err := store.openRoot(ctx, workspaceID, request.Path, true)
	if err != nil {
		return SearchResult{}, err
	}
	defer root.Close()
	if err := ensureNoSymlinkComponents(root, relative); err != nil {
		return SearchResult{}, err
	}
	result := SearchResult{Matches: make([]SearchMatch, 0)}
	var walk func(string) error
	walk = func(directory string) error {
		if err := contextErr(ctx); err != nil {
			return err
		}
		dir, err := root.Open(directory)
		if err != nil {
			return fmt.Errorf("%w: search directory", ErrWorkspaceUnavailable)
		}
		entries, readErr := dir.ReadDir(-1)
		_ = dir.Close()
		if readErr != nil {
			return fmt.Errorf("%w: search directory", ErrWorkspaceUnavailable)
		}
		for _, entry := range entries {
			if err := contextErr(ctx); err != nil {
				return err
			}
			child := joinRelativePath(directory, entry.Name())
			if isSensitiveRelativePath(child) || entry.Type()&os.ModeSymlink != 0 {
				result.FilesSkipped++
				continue
			}
			if entry.IsDir() {
				if err := walk(child); err != nil {
					return err
				}
				if result.LimitReached {
					return nil
				}
				continue
			}
			if !entry.Type().IsRegular() {
				result.FilesSkipped++
				continue
			}
			if result.FilesScanned >= maxSearchFiles {
				result.LimitReached = true
				return nil
			}
			result.FilesScanned++
			if err := appendSearchMatches(root, child, query, &result); err != nil {
				if errorsIsSensitive(err) {
					result.FilesSkipped++
					continue
				}
				return err
			}
			if result.LimitReached {
				return nil
			}
		}
		return nil
	}
	if err := walk(relative); err != nil {
		return SearchResult{}, err
	}
	return result, nil
}

func appendSearchMatches(root *os.Root, relativeFile, query string, result *SearchResult) error {
	file, err := root.Open(relativeFile)
	if err != nil {
		return fmt.Errorf("%w: search file", ErrWorkspaceUnavailable)
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, maxSearchFileBytes+1))
	if err != nil {
		return fmt.Errorf("%w: search file", ErrWorkspaceUnavailable)
	}
	if len(data) > maxSearchFileBytes || bytesAppearBinary(data) {
		result.FilesSkipped++
		return nil
	}
	for lineNumber, line := range strings.Split(string(data), "\n") {
		if !strings.Contains(line, query) {
			continue
		}
		text, truncated := truncateSearchLine(line)
		result.Matches = append(result.Matches, SearchMatch{Path: filepath.ToSlash(relativeFile), Line: lineNumber + 1, Text: text, TextTruncated: truncated})
		if len(result.Matches) >= maxSearchResults {
			result.LimitReached = true
			return nil
		}
	}
	return nil
}

func (store *Store) openRoot(ctx context.Context, workspaceID, relativePath string, allowRoot bool) (*os.Root, string, error) {
	rootPath, err := store.canonicalRootForID(ctx, workspaceID)
	if err != nil {
		return nil, "", err
	}
	relative, err := validateRelativePath(relativePath, allowRoot)
	if err != nil {
		return nil, "", err
	}
	if isSensitiveRelativePath(relative) {
		return nil, "", fmt.Errorf("%w: requested path", ErrSensitivePath)
	}
	root, err := os.OpenRoot(rootPath)
	if err != nil {
		return nil, "", fmt.Errorf("%w: open workspace", ErrWorkspaceUnavailable)
	}
	return root, relative, nil
}

func ensureNoSymlinkComponents(root *os.Root, relative string) error {
	if relative == "." {
		return nil
	}
	current := ""
	for _, component := range strings.Split(filepath.ToSlash(relative), "/") {
		current = joinRelativePath(current, component)
		info, err := root.Lstat(current)
		if err != nil {
			return fmt.Errorf("%w: requested path", ErrWorkspaceUnavailable)
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("%w: requested path", ErrSymlinkNotAllowed)
		}
	}
	return nil
}

// ValidateRelativeDisplayPath validates a non-root, workspace-relative path for safe DTO display.
func ValidateRelativeDisplayPath(value string) (string, error) {
	relative, err := validateRelativePath(value, false)
	if err != nil {
		return "", err
	}
	if isSensitiveRelativePath(relative) {
		return "", fmt.Errorf("%w: requested path", ErrSensitivePath)
	}
	return filepath.ToSlash(relative), nil
}

func validateRelativePath(value string, allowRoot bool) (string, error) {
	if value == "" {
		if allowRoot {
			return ".", nil
		}
		return "", fmt.Errorf("%w: empty path", ErrInvalidPath)
	}
	if strings.Contains(value, "\\") || strings.IndexByte(value, 0) >= 0 || strings.HasPrefix(value, "/") || strings.HasPrefix(value, "//") || isWindowsAbsoluteForm(value) {
		return "", fmt.Errorf("%w: path form", ErrInvalidPath)
	}
	parts := strings.Split(value, "/")
	for _, part := range parts {
		if part == "" || part == "." || part == ".." {
			return "", fmt.Errorf("%w: path component", ErrInvalidPath)
		}
	}
	return filepath.FromSlash(value), nil
}

func isWindowsAbsoluteForm(value string) bool {
	if len(value) >= 2 && value[1] == ':' && ((value[0] >= 'A' && value[0] <= 'Z') || (value[0] >= 'a' && value[0] <= 'z')) {
		return true
	}
	return strings.HasPrefix(value, `\\?\`) || strings.HasPrefix(value, `\\.\`)
}

func isSensitiveRelativePath(relative string) bool {
	if relative == "." || relative == "" {
		return false
	}
	for _, part := range strings.Split(filepath.ToSlash(relative), "/") {
		name := strings.ToLower(strings.TrimSpace(part))
		if isSensitiveName(name) {
			return true
		}
	}
	return false
}

func isSensitiveAbsolutePath(path string) bool {
	return isSensitiveRelativePath(filepath.ToSlash(path))
}

func isSensitiveName(name string) bool {
	if name == ".git" || name == ".hg" || name == ".svn" || name == ".ssh" || name == ".gnupg" || name == ".aws" || name == ".kube" || name == ".env" || name == ".git-credentials" || name == "id_rsa" || name == "id_ed25519" || name == "known_hosts" {
		return true
	}
	if strings.HasPrefix(name, ".env.") {
		return true
	}
	for _, extension := range []string{".pem", ".key", ".p12", ".pfx", ".kdbx"} {
		if strings.HasSuffix(name, extension) {
			return true
		}
	}
	return false
}

func fileVersion(info os.FileInfo) string {
	if info == nil {
		return ""
	}
	return fmt.Sprintf("%x-%x", info.ModTime().UnixNano(), info.Size())
}

func bytesAppearBinary(data []byte) bool {
	return strings.IndexByte(string(data), 0) >= 0 || !utf8.Valid(data)
}

func truncateSearchLine(line string) (string, bool) {
	if len(line) <= maxSearchLineBytes {
		return line, false
	}
	return line[:maxSearchLineBytes], true
}

func joinRelativePath(parent, child string) string {
	if parent == "" || parent == "." {
		return child
	}
	return filepath.Join(parent, child)
}

func errorsIsSensitive(err error) bool {
	return errors.Is(err, ErrSensitivePath)
}
