package kvm

func init() {
	rpcHandlers["getEncodedRecordingStatus"] = RPCHandler{Func: rpcGetEncodedRecordingStatus}
	rpcHandlers["startEncodedRecording"] = RPCHandler{Func: rpcStartEncodedRecording, Params: []string{"filename"}}
	rpcHandlers["stopEncodedRecording"] = RPCHandler{Func: rpcStopEncodedRecording}
}

func rpcGetEncodedRecordingStatus() (EncodedRecordingStatus, error) {
	return getEncodedRecordingStatus(), nil
}

func rpcStartEncodedRecording(filename string) (EncodedRecordingStatus, error) {
	return startEncodedRecording(filename)
}

func rpcStopEncodedRecording() (EncodedRecordingStatus, error) {
	return stopEncodedRecording(), nil
}
