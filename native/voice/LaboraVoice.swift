import AppKit
import AVFoundation
import Speech
import Darwin

struct VoiceCommand: Decodable {
    enum Action: String, Decodable { case status, start, stop, cancel }
    let id: Int
    let action: Action
    let locale: String?
}

struct VoiceStatus: Encodable {
    let type = "status"
    let id: Int
    let locale: String
    let microphone: String
    let speech: String
    let available: Bool
    let onDevice: Bool
    let owner: String
}

struct VoiceEvent: Encodable {
    let type: String
    let id: Int
    let text: String
    let message: String
}

@MainActor final class VoiceController {
    private let engine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var recognition: SFSpeechRecognitionTask?
    private var active: Int?
    private var transcript = ""
    private var tapped = false
    private var finalizing = false
    private var deadline: Timer?
    private var finishDeadline: Timer?
    private var startup: Task<Void, Never>?

    private func emit<Value: Encodable>(_ value: Value) {
        guard var data = try? JSONEncoder().encode(value) else { return }
        data.append(10)
        FileHandle.standardOutput.write(data)
    }

    private func event(_ type: String, id: Int, text: String = "", message: String = "") {
        emit(VoiceEvent(type: type, id: id, text: text, message: message))
    }

    private func microphonePermission() -> String {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: return "authorized"
        case .notDetermined: return "not-determined"
        case .restricted: return "restricted"
        case .denied: return "denied"
        @unknown default: return "denied"
        }
    }

    private func speechPermission() -> String {
        switch SFSpeechRecognizer.authorizationStatus() {
        case .authorized: return "authorized"
        case .notDetermined: return "not-determined"
        case .restricted: return "restricted"
        case .denied: return "denied"
        @unknown default: return "denied"
        }
    }

    private func recognizer(_ language: String?) -> SFSpeechRecognizer? {
        if let language, language.count > 80 { return nil }
        return SFSpeechRecognizer(locale: language.map(Locale.init(identifier:)) ?? Locale.current)
    }

    func handle(_ command: VoiceCommand) {
        switch command.action {
        case .status:
            let speech = recognizer(command.locale)
            emit(VoiceStatus(id: command.id, locale: speech?.locale.identifier ?? command.locale ?? Locale.current.identifier,
                microphone: microphonePermission(), speech: speechPermission(),
                available: speech?.isAvailable ?? false, onDevice: speech?.supportsOnDeviceRecognition ?? false,
                owner: Bundle.main.bundleIdentifier ?? "unbundled"))
        case .start:
            start(command)
        case .stop:
            guard active == command.id else { return }
            stop()
        case .cancel:
            guard active == command.id else { return }
            cancel()
        }
    }

    private func start(_ command: VoiceCommand) {
        guard active == nil else {
            event("error", id: command.id, message: "Another dictation is already running.")
            return
        }
        guard let speech = recognizer(command.locale), speech.supportsOnDeviceRecognition else {
            event("error", id: command.id, message: "On-device dictation is unavailable for this language. Enable its Dictation language in System Settings.")
            return
        }
        guard speech.isAvailable else {
            event("error", id: command.id, message: "On-device dictation is currently unavailable. Try again after checking Dictation in System Settings.")
            return
        }
        active = command.id
        transcript = ""
        finalizing = false
        startup = Task { @MainActor [weak self] in
            guard let self, self.active == command.id, !Task.isCancelled else { return }
            await self.authorizeAndListen(command, recognizer: speech)
        }
    }

    private func authorizeAndListen(_ command: VoiceCommand, recognizer speech: SFSpeechRecognizer) async {
        event("authorizing", id: command.id)
        let microphone = await AVCaptureDevice.requestAccess(for: .audio)
        guard active == command.id, !Task.isCancelled else { return }
        guard microphone else {
            fail("Allow Microphone for Labora in System Settings > Privacy & Security.")
            return
        }
        let authorization = await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0) }
        }
        guard active == command.id, !Task.isCancelled else { return }
        guard authorization == .authorized else {
            fail("Allow Speech Recognition for Labora in System Settings > Privacy & Security.")
            return
        }
        guard speech.supportsOnDeviceRecognition, speech.isAvailable else {
            fail("On-device dictation became unavailable. Audio was not recorded.")
            return
        }
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            fail("No microphone is available. Check Sound > Input in System Settings.")
            return
        }
        let bufferRequest = SFSpeechAudioBufferRecognitionRequest()
        bufferRequest.requiresOnDeviceRecognition = true
        bufferRequest.shouldReportPartialResults = true
        bufferRequest.addsPunctuation = true
        bufferRequest.taskHint = .dictation
        request = bufferRequest
        let session = command.id
        recognition = speech.recognitionTask(with: bufferRequest) { [weak self] result, error in
            let text = result?.bestTranscription.formattedString
            let isFinal = result?.isFinal ?? false
            let failure = error?.localizedDescription
            Task { @MainActor in
                guard let self, self.active == session else { return }
                if let text {
                    self.transcript = text
                    self.event("partial", id: session, text: text)
                }
                if isFinal { self.complete() }
                else if let failure { self.fail(failure) }
            }
        }
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
            bufferRequest.append(buffer)
        }
        tapped = true
        do {
            engine.prepare()
            try engine.start()
            event("listening", id: session)
            deadline = Timer.scheduledTimer(withTimeInterval: 55, repeats: false) { [weak self] _ in
                Task { @MainActor in self?.stop() }
            }
        } catch { fail("Could not start the microphone: \(error.localizedDescription)") }
    }

    private func stopAudio() {
        if engine.isRunning { engine.stop() }
        if tapped { engine.inputNode.removeTap(onBus: 0); tapped = false }
        deadline?.invalidate()
        deadline = nil
    }

    private func stop() {
        guard let session = active, !finalizing else { return }
        guard request != nil else { cancel(); return }
        finalizing = true
        stopAudio()
        request?.endAudio()
        event("finishing", id: session, text: transcript)
        finishDeadline = Timer.scheduledTimer(withTimeInterval: 3, repeats: false) { [weak self] _ in
            Task { @MainActor in self?.complete() }
        }
    }

    private func clear() {
        active = nil
        startup?.cancel()
        startup = nil
        stopAudio()
        finishDeadline?.invalidate()
        finishDeadline = nil
        recognition?.cancel()
        recognition = nil
        request = nil
        transcript = ""
        finalizing = false
    }

    private func complete() {
        guard let session = active else { return }
        let text = transcript
        clear()
        event("final", id: session, text: text)
    }

    private func fail(_ message: String) {
        guard let session = active else { return }
        let text = transcript
        clear()
        event("error", id: session, text: text, message: message)
    }

    func cancel() {
        guard let session = active else { return }
        clear()
        event("cancelled", id: session)
    }
}

@main enum LaboraVoice {
    @MainActor static func main() {
        signal(SIGPIPE, SIG_IGN)
        let application = NSApplication.shared
        application.setActivationPolicy(.accessory)
        let controller = VoiceController()
        let (commands, continuation) = AsyncStream<VoiceCommand>.makeStream()
        let parent = getppid()
        Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { _ in
            if getppid() != parent { exit(0) }
        }
        DispatchQueue.global(qos: .userInitiated).async {
            while let line = readLine() {
                guard line.utf8.count <= 65536, let data = line.data(using: .utf8),
                      let command = try? JSONDecoder().decode(VoiceCommand.self, from: data) else {
                    FileHandle.standardError.write(Data("Invalid voice command.\n".utf8))
                    continue
                }
                continuation.yield(command)
            }
            continuation.finish()
        }
        Task { @MainActor in
            for await command in commands { controller.handle(command) }
            controller.cancel()
            application.terminate(nil)
        }
        application.run()
    }
}
