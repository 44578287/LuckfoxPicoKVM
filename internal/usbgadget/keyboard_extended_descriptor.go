package usbgadget

// Extend the boot-keyboard usage range from Keyboard Application (0x65)
// through F24 (0x73). This keeps the existing 8-byte boot-keyboard report
// format while allowing MCP to emit F13..F24 usages that hosts can accept.
func init() {
	for i := 0; i+1 < len(keyboardReportDesc); i++ {
		if (keyboardReportDesc[i] == 0x25 || keyboardReportDesc[i] == 0x29) && keyboardReportDesc[i+1] == 0x65 {
			keyboardReportDesc[i+1] = 0x73
		}
	}
	keyboardConfig.reportDesc = keyboardReportDesc
}
