package approval

import (
	"strings"
	"unicode"
	"unicode/utf8"
)

func sanitizeDisplayText(value string, maxRunes int) (string, error) {
	if !utf8.ValidString(value) {
		return "", ErrInvalidRequest
	}
	var builder strings.Builder
	space := false
	for _, character := range value {
		if unicode.IsControl(character) && !unicode.IsSpace(character) {
			return "", ErrInvalidRequest
		}
		if unicode.IsSpace(character) {
			space = true
			continue
		}
		if space && builder.Len() > 0 {
			builder.WriteByte(' ')
		}
		space = false
		builder.WriteRune(character)
	}
	text := strings.TrimSpace(builder.String())
	lower := strings.ToLower(text)
	if strings.Contains(lower, "-----begin") || strings.Contains(lower, "authorization:") || strings.Contains(lower, "bearer ") || strings.Contains(lower, "private key") || strings.Contains(lower, "ssh-rsa ") || strings.Contains(lower, "ssh-ed25519 ") || strings.Contains(lower, "://") || strings.Contains(text, `\`) || strings.HasPrefix(text, "/") {
		return "<redacted>", nil
	}
	runes := []rune(text)
	if len(runes) > maxRunes {
		text = string(runes[:maxRunes])
	}
	return text, nil
}
