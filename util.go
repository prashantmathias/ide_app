package main

import (
	"fmt"
	"strings"
	"unicode/utf8"
)

func clamp(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

func itoa(v int) string {
	return fmt.Sprintf("%d", v)
}

func truncateRunes(s string, width int) string {
	if width <= 0 {
		return ""
	}
	if utf8.RuneCountInString(s) <= width {
		return s
	}
	runes := []rune(s)
	if width <= 3 {
		return string(runes[:width])
	}
	return string(runes[:width-3]) + "..."
}

func sliceRunes(s string, start, width int) string {
	runes := []rune(s)
	if start >= len(runes) || width <= 0 {
		return ""
	}
	start = clamp(start, 0, len(runes))
	end := clamp(start+width, start, len(runes))
	return string(runes[start:end])
}

func wrapPlain(s string, width int) []string {
	if width <= 0 {
		return []string{""}
	}
	var out []string
	for _, paragraph := range strings.Split(s, "\n") {
		words := strings.Fields(paragraph)
		if len(words) == 0 {
			out = append(out, "")
			continue
		}
		line := ""
		for _, word := range words {
			if utf8.RuneCountInString(word) > width {
				if line != "" {
					out = append(out, line)
					line = ""
				}
				runes := []rune(word)
				for len(runes) > width {
					out = append(out, string(runes[:width]))
					runes = runes[width:]
				}
				if len(runes) > 0 {
					line = string(runes)
				}
				continue
			}
			next := word
			if line != "" {
				next = line + " " + word
			}
			if utf8.RuneCountInString(next) > width {
				out = append(out, line)
				line = word
			} else {
				line = next
			}
		}
		if line != "" {
			out = append(out, line)
		}
	}
	if len(out) == 0 {
		return []string{""}
	}
	return out
}

func padLines(lines []string, height int) []string {
	if height < 0 {
		height = 0
	}
	if len(lines) > height {
		return lines[:height]
	}
	for len(lines) < height {
		lines = append(lines, "")
	}
	return lines
}

func tail(lines []string, height int) []string {
	if height <= 0 {
		return nil
	}
	if len(lines) <= height {
		return lines
	}
	return lines[len(lines)-height:]
}
