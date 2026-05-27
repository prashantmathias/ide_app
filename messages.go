package main

import "time"

type tickMsg time.Time

type denoMsg struct {
	Kind      string
	Line      string
	Code      int
	URL       string
	Frames    []DebugCallFrame
	Variables []DebugVariable
	Err       string
}

type terminalLineMsg struct {
	Line string
}

type aiLogMsg struct {
	Text string
}

type aiDoneMsg struct {
	Reply string
	Err   error
}

type DebuggerCommand int

const (
	DebugStepOver DebuggerCommand = iota
	DebugStepInto
	DebugResume
	DebugSetBreakpoint
	DebugRemoveBreakpoint
)

type debuggerCommandMsg struct {
	Command  DebuggerCommand
	Line     int
	Filename string
}
