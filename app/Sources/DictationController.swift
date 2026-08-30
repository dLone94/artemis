import AppKit
import ApplicationServices
import AVFoundation
import CoreGraphics
import Foundation
import IOKit.hid

/// Owns the system-wide hold-to-talk loop. UI state stays on the main thread;
/// audio and HTTP state are handed to one serial queue so PCM chunks cannot be
/// reordered on their way to Deepgram.
final class DictationController: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    private enum Phase {
        case idle
        case armed
        case capturing
        case finishing
    }

    private struct LiveEvent: Decodable {
        let transcript: String?
        let isFinal: Bool?
        let speechFinal: Bool?
        let done: Bool?

        private enum CodingKeys: String, CodingKey {
            case transcript = "t"
            case isFinal = "final"
            case speechFinal
            case done
        }
    }

    private static let defaultsKey = "dictationEnabled"
    private static let holdDelay: TimeInterval = 0.25
    private static let finalWait: TimeInterval = 0.8
    private static let pcmChunkBytes = 16_000 * MemoryLayout<Int16>.size / 4
    private static let sseDelimiter = Data([0x0a, 0x0a])
    private static let cookieValueCharacters = CharacterSet(
        charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()"
    )

    private let config: ArtemisConfig
    private let defaults: UserDefaults
    private let panel = DictationPanel()
    private let networkQueue = DispatchQueue(label: "com.artemis.dictation.network")
    private let eventDelegateQueue: OperationQueue
    private let loopbackDelegate: LoopbackSessionDelegate
    private let requestSession: URLSession
    private var eventSession: URLSession!

    // Main-thread state.
    private var phase = Phase.idle
    private var generation = 0
    private var fnIsDown = false
    private var holdWorkItem: DispatchWorkItem?
    private var audioEngine: AVAudioEngine?
    private var inputTapInstalled = false
    private let audioCallbackCondition = NSCondition()
    private var acceptsAudioCallbacks = false
    private var audioCallbacksInFlight = 0
    private var globalFlagsMonitor: Any?
    private var globalEscapeMonitor: Any?
    private var localMonitor: Any?
    private weak var menuItem: NSMenuItem?
    private var isEnabled: Bool
    private var clipboardGeneration = 0
    private var loggedFirstFn = false

    // networkQueue-only state. There is at most one dictation lifecycle at a
    // time; callbacks also carry the generation so late responses are inert.
    private var streamGeneration: Int?
    private var eventTask: URLSessionDataTask?
    private var eventTaskIdentifier: Int?
    private var streamSID: String?
    private var startFinished = false
    private var startFailed = false
    private var shouldStop = false
    private var streamCancelled = false
    private var stopSent = false
    private var completionDelivered = false
    private var chunkInFlight = false
    private var audioAccumulator = Data()
    private var pendingChunks: [Data] = []
    private var sseBuffer = Data()
    private var finalSegments: [String] = []
    private var sseDone = false
    private var sseClosed = false
    private var fnPoll: Timer?

    init(config: ArtemisConfig, defaults: UserDefaults = .standard) {
        self.config = config
        self.defaults = defaults
        defaults.register(defaults: [Self.defaultsKey: true])
        isEnabled = defaults.bool(forKey: Self.defaultsKey)

        let delegate = LoopbackSessionDelegate()
        loopbackDelegate = delegate
        let requestConfiguration = URLSessionConfiguration.ephemeral
        requestConfiguration.timeoutIntervalForRequest = 8
        requestSession = URLSession(configuration: requestConfiguration,
                                    delegate: delegate,
                                    delegateQueue: nil)

        let delegateQueue = OperationQueue()
        delegateQueue.name = "com.artemis.dictation.events"
        delegateQueue.maxConcurrentOperationCount = 1
        eventDelegateQueue = delegateQueue

        super.init()

        let eventConfiguration = URLSessionConfiguration.ephemeral
        eventConfiguration.timeoutIntervalForRequest = 90
        eventConfiguration.timeoutIntervalForResource = 90
        eventSession = URLSession(configuration: eventConfiguration,
                                  delegate: self,
                                  delegateQueue: eventDelegateQueue)

        if isEnabled { installMonitors() }
    }

    /// Adds the toggle to the first (application) menu. Programmatic AppKit
    /// apps do not necessarily have a main menu, so create only the missing
    /// shell rather than assuming Interface Builder did it.
    func installMenuItem() {
        let mainMenu: NSMenu
        if let existing = NSApp.mainMenu {
            mainMenu = existing
        } else {
            mainMenu = NSMenu(title: "Main")
            NSApp.mainMenu = mainMenu
        }

        let appMenu: NSMenu
        if let first = mainMenu.items.first, let existing = first.submenu {
            appMenu = existing
        } else {
            let rootItem = NSMenuItem(title: "Artemis", action: nil, keyEquivalent: "")
            appMenu = NSMenu(title: "Artemis")
            rootItem.submenu = appMenu
            mainMenu.insertItem(rootItem, at: 0)
        }

        if !appMenu.items.isEmpty { appMenu.addItem(.separator()) }
        let item = NSMenuItem(title: "Dictation (hold fn)",
                              action: #selector(toggleDictation(_:)),
                              keyEquivalent: "")
        item.target = self
        item.state = isEnabled ? .on : .off
        appMenu.addItem(item)
        menuItem = item
    }

    /// Removes event taps without changing the persisted preference. A live
    /// session still receives its stop request so an attached server is not
    /// left billing until its idle cleanup runs.
    func shutdown() {
        deactivate()
        eventSession.invalidateAndCancel()
    }

    @objc private func toggleDictation(_ sender: NSMenuItem) {
        isEnabled.toggle()
        defaults.set(isEnabled, forKey: Self.defaultsKey)
        sender.state = isEnabled ? .on : .off

        if isEnabled {
            installMonitors()
            return
        }

        deactivate()
    }

    // MARK: - Hotkey

    private func installMonitors() {
        guard globalFlagsMonitor == nil, globalEscapeMonitor == nil, localMonitor == nil else { return }

        // Global key/flag observation is gated by Input Monitoring on modern
        // macOS — Accessibility alone is NOT enough, and without it the
        // monitors below install fine and then receive nothing, ever. Ask
        // explicitly: the request registers Artemis in the Settings pane and
        // pops the system prompt instead of failing into silence. State is
        // NSLogged so `log show --predicate 'process == "Artemis"'` shows it.
        let listenAccess = IOHIDCheckAccess(kIOHIDRequestTypeListenEvent)
        NSLog("[dictation] installing monitors — inputMonitoring=%d accessibilityTrusted=%d",
              listenAccess.rawValue, AXIsProcessTrusted() ? 1 : 0)
        if listenAccess != kIOHIDAccessTypeGranted {
            _ = IOHIDRequestAccess(kIOHIDRequestTypeListenEvent)
            panel.showNotice("allow Input Monitoring for dictation")
        }
        requestPastePermissions()

        globalFlagsMonitor = NSEvent.addGlobalMonitorForEvents(matching: .flagsChanged) { [weak self] event in
            self?.handleFlagsChanged(event)
        }
        globalEscapeMonitor = NSEvent.addGlobalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard event.keyCode == 53 else { return }
            self?.handleEscape()
        }
        localMonitor = NSEvent.addLocalMonitorForEvents(matching: [.flagsChanged, .keyDown]) { [weak self] event in
            guard let self else { return event }
            if event.type == .flagsChanged {
                self.handleFlagsChanged(event)
                return event
            }
            if event.keyCode == 53, self.handleEscape() {
                return nil
            }
            return event
        }
    }

    private func removeMonitors() {
        if let monitor = globalFlagsMonitor { NSEvent.removeMonitor(monitor) }
        if let monitor = globalEscapeMonitor { NSEvent.removeMonitor(monitor) }
        if let monitor = localMonitor { NSEvent.removeMonitor(monitor) }
        globalFlagsMonitor = nil
        globalEscapeMonitor = nil
        localMonitor = nil
    }

    private func requestPastePermissions() {
        if !AXIsProcessTrusted() {
            let prompt = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
            AXIsProcessTrustedWithOptions(prompt)
        }
        if !CGPreflightPostEventAccess() {
            _ = CGRequestPostEventAccess()
        }
    }

    private func startFnPoll() {
        guard fnPoll == nil else { return }
        let timer = Timer(timeInterval: 0.15, repeats: true) { [weak self] _ in
            self?.pollFnUp()
        }
        timer.tolerance = 0.05
        RunLoop.main.add(timer, forMode: .common)
        fnPoll = timer
    }

    private func stopFnPoll() {
        fnPoll?.invalidate()
        fnPoll = nil
    }

    private func pollFnUp() {
        guard fnIsDown else { return }
        if !NSEvent.modifierFlags.contains(.function) {
            fnIsDown = false
            releaseHold()
        }
    }

    private func deactivate() {
        holdWorkItem?.cancel()
        holdWorkItem = nil
        fnIsDown = false
        stopFnPoll()
        removeMonitors()
        if phase == .capturing {
            cancelCapture()
        } else if phase == .armed {
            phase = .idle
        }
    }

    private func handleFlagsChanged(_ event: NSEvent) {
        // Other modifier changes also produce flagsChanged; keyCode 63 is the
        // physical fn key and prevents those events from perturbing the hold.
        guard isEnabled, event.keyCode == 63 else { return }
        if !loggedFirstFn {
            loggedFirstFn = true
            NSLog("[dictation] fn key observed — event flow confirmed")
        }
        let isDown = event.modifierFlags.contains(.function)
        if isDown, !fnIsDown {
            fnIsDown = true
            armHold()
        } else if !isDown, fnIsDown {
            fnIsDown = false
            releaseHold()
        }
    }

    private func armHold() {
        guard phase == .idle else { return }
        phase = .armed
        let work = DispatchWorkItem { [weak self] in
            guard let self, self.phase == .armed, self.fnIsDown, self.isEnabled else { return }
            self.holdWorkItem = nil
            self.beginCapture()
        }
        holdWorkItem = work
        startFnPoll()
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.holdDelay, execute: work)
    }

    private func releaseHold() {
        switch phase {
        case .armed:
            holdWorkItem?.cancel()
            holdWorkItem = nil
            stopFnPoll()
            phase = .idle
        case .capturing:
            finishCapture(cancelled: false)
        case .idle, .finishing:
            break
        }
    }

    @discardableResult
    private func handleEscape() -> Bool {
        guard phase == .capturing else { return false }
        cancelCapture()
        return true
    }

    // MARK: - Audio capture

    private func beginCapture() {
        phase = .capturing
        generation &+= 1
        let captureGeneration = generation
        panel.showListening(near: NSEvent.mouseLocation)
        beginStreaming(generation: captureGeneration)

        do {
            try startAudioCapture(generation: captureGeneration)
        } catch {
            // The microphone prompt/permission and missing-device failures all
            // arrive here. There is no transcript to risk losing, but a server
            // session may already exist and still must be closed.
            finishCapture(cancelled: true)
        }
    }

    private func startAudioCapture(generation captureGeneration: Int) throws {
        let engine = AVAudioEngine()
        let input = engine.inputNode
        let inputFormat = input.outputFormat(forBus: 0)
        guard inputFormat.sampleRate > 0, inputFormat.channelCount > 0,
              let outputFormat = AVAudioFormat(commonFormat: .pcmFormatInt16,
                                               sampleRate: 16_000,
                                               channels: 1,
                                               interleaved: true),
              let converter = AVAudioConverter(from: inputFormat, to: outputFormat)
        else {
            throw NSError(domain: "ArtemisDictation", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: "No usable microphone input format"])
        }

        input.installTap(onBus: 0, bufferSize: 1_024, format: inputFormat) { [weak self] buffer, _ in
            guard let self, self.beginAudioCallback() else { return }
            defer { self.endAudioCallback() }
            self.convert(buffer, using: converter, generation: captureGeneration)
        }
        inputTapInstalled = true
        setAcceptsAudioCallbacks(true)
        audioEngine = engine
        engine.prepare()
        do {
            try engine.start()
        } catch {
            setAcceptsAudioCallbacks(false)
            input.removeTap(onBus: 0)
            inputTapInstalled = false
            audioEngine = nil
            throw error
        }
    }

    private func convert(_ input: AVAudioPCMBuffer,
                         using converter: AVAudioConverter,
                         generation captureGeneration: Int) {
        let ratio = 16_000 / converter.inputFormat.sampleRate
        let capacity = max(1, AVAudioFrameCount(ceil(Double(input.frameLength) * ratio)) + 32)
        guard let output = AVAudioPCMBuffer(pcmFormat: converter.outputFormat,
                                            frameCapacity: capacity) else { return }

        var suppliedInput = false
        var conversionError: NSError?
        let status = converter.convert(to: output, error: &conversionError) { _, outStatus in
            if suppliedInput {
                outStatus.pointee = .noDataNow
                return nil
            }
            suppliedInput = true
            outStatus.pointee = .haveData
            return input
        }
        guard status != .error, conversionError == nil, output.frameLength > 0,
              let channels = output.int16ChannelData else { return }

        let byteCount = Int(output.frameLength) * MemoryLayout<Int16>.size
        let pcm = Data(bytes: channels[0], count: byteCount)
        networkQueue.async { [weak self] in
            self?.acceptPCM(pcm, generation: captureGeneration)
        }
    }

    private func stopAudioCapture() {
        guard let engine = audioEngine else { return }
        // Close the callback gate first, then wait for any conversion already
        // in flight. Each such callback enqueues its PCM before leaving, so the
        // later finish block sees and flushes every sub-8 KB remainder.
        setAcceptsAudioCallbacks(false)
        engine.stop()
        waitForAudioCallbacks()
        if inputTapInstalled { engine.inputNode.removeTap(onBus: 0) }
        inputTapInstalled = false
        audioEngine = nil
    }

    private func setAcceptsAudioCallbacks(_ accepts: Bool) {
        audioCallbackCondition.lock()
        acceptsAudioCallbacks = accepts
        audioCallbackCondition.unlock()
    }

    private func beginAudioCallback() -> Bool {
        audioCallbackCondition.lock()
        defer { audioCallbackCondition.unlock() }
        guard acceptsAudioCallbacks else { return false }
        audioCallbacksInFlight += 1
        return true
    }

    private func endAudioCallback() {
        audioCallbackCondition.lock()
        audioCallbacksInFlight -= 1
        if audioCallbacksInFlight == 0 { audioCallbackCondition.broadcast() }
        audioCallbackCondition.unlock()
    }

    private func waitForAudioCallbacks() {
        audioCallbackCondition.lock()
        while audioCallbacksInFlight > 0 { audioCallbackCondition.wait() }
        audioCallbackCondition.unlock()
    }

    private func cancelCapture() {
        finishCapture(cancelled: true)
    }

    private func finishCapture(cancelled: Bool) {
        guard phase == .capturing else { return }
        stopFnPoll()
        phase = .finishing
        stopAudioCapture()
        if cancelled {
            panel.dismiss()
        } else {
            panel.showFinalizing()
        }
        requestStreamFinish(generation: generation, cancelled: cancelled)
    }

    // MARK: - Streaming lifecycle

    private func beginStreaming(generation captureGeneration: Int) {
        networkQueue.async { [weak self] in
            guard let self else { return }
            self.resetStreamState(generation: captureGeneration)

            var request = URLRequest(url: self.endpoint(
                path: "/api/stt/live/start",
                queryItems: [
                    URLQueryItem(name: "encoding", value: "linear16"),
                    URLQueryItem(name: "sample_rate", value: "16000"),
                    URLQueryItem(name: "channels", value: "1")
                ]
            ))
            request.httpMethod = "POST"
            self.addLoopbackAuthentication(to: &request)
            let task = self.requestSession.dataTask(with: request) { [weak self] data, response, _ in
                self?.networkQueue.async { [weak self] in
                    self?.handleStart(data: data,
                                      response: response,
                                      generation: captureGeneration)
                }
            }
            task.resume()
        }
    }

    private func resetStreamState(generation captureGeneration: Int) {
        streamGeneration = captureGeneration
        eventTask = nil
        eventTaskIdentifier = nil
        streamSID = nil
        startFinished = false
        startFailed = false
        shouldStop = false
        streamCancelled = false
        stopSent = false
        completionDelivered = false
        chunkInFlight = false
        audioAccumulator.removeAll(keepingCapacity: true)
        pendingChunks.removeAll(keepingCapacity: true)
        sseBuffer.removeAll(keepingCapacity: true)
        finalSegments.removeAll(keepingCapacity: true)
        sseDone = false
        sseClosed = false
    }

    private func handleStart(data: Data?, response: URLResponse?, generation captureGeneration: Int) {
        guard streamGeneration == captureGeneration, !completionDelivered else { return }
        startFinished = true

        guard let http = response as? HTTPURLResponse, http.statusCode == 200,
              let data,
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let sid = json["sid"] as? String, !sid.isEmpty
        else {
            startFailed = true
            pendingChunks.removeAll(keepingCapacity: true)
            audioAccumulator.removeAll(keepingCapacity: true)
            if shouldStop { completeStream(generation: captureGeneration) }
            return
        }

        streamSID = sid
        if streamCancelled {
            pendingChunks.removeAll(keepingCapacity: true)
            audioAccumulator.removeAll(keepingCapacity: true)
        } else {
            startEventStream(sid: sid, generation: captureGeneration)
        }
        pumpStream(generation: captureGeneration)
    }

    private func acceptPCM(_ pcm: Data, generation captureGeneration: Int) {
        guard streamGeneration == captureGeneration, !shouldStop, !streamCancelled else { return }
        audioAccumulator.append(pcm)
        while audioAccumulator.count >= Self.pcmChunkBytes {
            pendingChunks.append(Data(audioAccumulator.prefix(Self.pcmChunkBytes)))
            audioAccumulator.removeFirst(Self.pcmChunkBytes)
        }
        pumpStream(generation: captureGeneration)
    }

    private func requestStreamFinish(generation captureGeneration: Int, cancelled: Bool) {
        networkQueue.async { [weak self] in
            guard let self, self.streamGeneration == captureGeneration, !self.completionDelivered else { return }
            self.shouldStop = true
            self.streamCancelled = self.streamCancelled || cancelled

            if self.streamCancelled {
                self.pendingChunks.removeAll(keepingCapacity: true)
                self.audioAccumulator.removeAll(keepingCapacity: true)
            } else if !self.audioAccumulator.isEmpty {
                self.pendingChunks.append(self.audioAccumulator)
                self.audioAccumulator.removeAll(keepingCapacity: true)
            }

            if self.startFailed {
                self.completeStream(generation: captureGeneration)
            } else {
                self.pumpStream(generation: captureGeneration)
            }
        }
    }

    private func pumpStream(generation captureGeneration: Int) {
        guard streamGeneration == captureGeneration, !completionDelivered,
              startFinished, !chunkInFlight else { return }
        guard let sid = streamSID else {
            if shouldStop && startFailed { completeStream(generation: captureGeneration) }
            return
        }

        if !streamCancelled, !pendingChunks.isEmpty {
            let chunk = pendingChunks.removeFirst()
            chunkInFlight = true
            var request = URLRequest(url: endpoint(
                path: "/api/stt/live/chunk",
                queryItems: [URLQueryItem(name: "sid", value: sid)]
            ))
            request.httpMethod = "POST"
            request.httpBody = chunk
            request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
            addLoopbackAuthentication(to: &request)
            requestSession.dataTask(with: request) { [weak self] _, _, _ in
                self?.networkQueue.async { [weak self] in
                    guard let self, self.streamGeneration == captureGeneration,
                          !self.completionDelivered else { return }
                    self.chunkInFlight = false
                    self.pumpStream(generation: captureGeneration)
                }
            }.resume()
            return
        }

        if shouldStop, !stopSent {
            sendStop(sid: sid, generation: captureGeneration)
        }
    }

    private func sendStop(sid: String, generation captureGeneration: Int) {
        stopSent = true
        var request = URLRequest(url: endpoint(
            path: "/api/stt/live/stop",
            queryItems: [URLQueryItem(name: "sid", value: sid)]
        ))
        request.httpMethod = "POST"
        request.timeoutInterval = 3
        addLoopbackAuthentication(to: &request)
        let task = requestSession.dataTask(with: request) { [weak self] _, _, _ in
            self?.networkQueue.async { [weak self] in
                guard let self, self.streamGeneration == captureGeneration,
                      !self.completionDelivered else { return }
                if self.streamCancelled || self.sseDone || self.sseClosed {
                    self.completeStream(generation: captureGeneration)
                }
            }
        }
        task.resume()

        // Bound the flush from the moment CloseStream is put on the wire. A
        // stalled HTTP response must not extend the user's finalization wait.
        networkQueue.asyncAfter(deadline: .now() + Self.finalWait) { [weak self] in
            guard let self, self.streamGeneration == captureGeneration,
                  !self.completionDelivered else { return }
            self.completeStream(generation: captureGeneration)
        }

        // Cancellation has no transcript to flush. The POST has been resumed,
        // so return the UI to idle without waiting for its response.
        if streamCancelled { completeStream(generation: captureGeneration) }
    }

    private func startEventStream(sid: String, generation captureGeneration: Int) {
        var request = URLRequest(url: endpoint(
            path: "/api/stt/live/events",
            queryItems: [URLQueryItem(name: "sid", value: sid)]
        ))
        request.httpMethod = "GET"
        addLoopbackAuthentication(to: &request)
        let task = eventSession.dataTask(with: request)
        eventTask = task
        eventTaskIdentifier = task.taskIdentifier
        task.resume()
    }

    private func consumeSSE(_ data: Data, generation captureGeneration: Int) {
        guard streamGeneration == captureGeneration, !completionDelivered else { return }
        sseBuffer.append(data)
        while let boundary = sseBuffer.range(of: Self.sseDelimiter) {
            let block = Data(sseBuffer[..<boundary.lowerBound])
            sseBuffer.removeSubrange(..<boundary.upperBound)
            parseSSEBlock(block, generation: captureGeneration)
        }
    }

    private func parseSSEBlock(_ data: Data, generation captureGeneration: Int) {
        guard let block = String(data: data, encoding: .utf8) else { return }
        for rawLine in block.split(separator: "\n", omittingEmptySubsequences: true) {
            let line = rawLine.trimmingCharacters(in: .whitespacesAndNewlines)
            guard line.hasPrefix("data:") else { continue }
            let payload = String(line.dropFirst(5)).trimmingCharacters(in: .whitespaces)
            guard let json = payload.data(using: .utf8),
                  let event = try? JSONDecoder().decode(LiveEvent.self, from: json) else { continue }
            if event.isFinal == true,
               let text = event.transcript?.trimmingCharacters(in: .whitespacesAndNewlines),
               !text.isEmpty {
                finalSegments.append(text)
            }
            // Deepgram has explicitly endpointed the utterance, so once stop is
            // on the wire there is no reason to consume the fixed fallback wait.
            if event.speechFinal == true, stopSent {
                completeStream(generation: captureGeneration)
                return
            }
            if event.done == true {
                sseDone = true
                if stopSent { completeStream(generation: captureGeneration) }
            }
        }
    }

    private func completeStream(generation captureGeneration: Int) {
        guard streamGeneration == captureGeneration, !completionDelivered else { return }
        completionDelivered = true
        let cancelled = streamCancelled
        let transcript = finalSegments.joined(separator: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        eventTask?.cancel()
        eventTask = nil
        eventTaskIdentifier = nil
        streamGeneration = nil

        DispatchQueue.main.async { [weak self] in
            self?.streamDidFinish(generation: captureGeneration,
                                  transcript: transcript,
                                  cancelled: cancelled)
        }
    }

    private func streamDidFinish(generation captureGeneration: Int,
                                 transcript: String,
                                 cancelled: Bool) {
        guard generation == captureGeneration, phase == .finishing else { return }
        phase = .idle
        if cancelled {
            panel.dismiss()
            return
        }
        guard !transcript.isEmpty else {
            panel.dismiss(after: 0.6)
            return
        }

        if pasteTranscript(transcript) {
            panel.showSuccess()
        } else {
            panel.showPasteFallback()
        }
    }

    // MARK: - SSE URLSession delegate

    func urlSession(_ session: URLSession,
                    didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        // Forward through the same narrowly-scoped trust implementation used by
        // ServerController rather than broadening certificate acceptance here.
        loopbackDelegate.urlSession(session,
                                    didReceive: challenge,
                                    completionHandler: completionHandler)
    }

    func urlSession(_ session: URLSession,
                    dataTask: URLSessionDataTask,
                    didReceive data: Data) {
        let identifier = dataTask.taskIdentifier
        networkQueue.async { [weak self] in
            guard let self, self.eventTaskIdentifier == identifier,
                  let captureGeneration = self.streamGeneration else { return }
            self.consumeSSE(data, generation: captureGeneration)
        }
    }

    func urlSession(_ session: URLSession,
                    task: URLSessionTask,
                    didCompleteWithError error: Error?) {
        let identifier = task.taskIdentifier
        networkQueue.async { [weak self] in
            guard let self, self.eventTaskIdentifier == identifier,
                  let captureGeneration = self.streamGeneration,
                  !self.completionDelivered else { return }
            self.sseClosed = true
            if self.stopSent { self.completeStream(generation: captureGeneration) }
        }
    }

    // MARK: - Paste insertion

    private func pasteTranscript(_ transcript: String) -> Bool {
        clipboardGeneration &+= 1
        let restoreGeneration = clipboardGeneration
        let pasteboard = NSPasteboard.general
        let previousString = pasteboard.string(forType: .string)
        pasteboard.clearContents()
        guard pasteboard.setString(transcript, forType: .string) else { return false }
        let transcriptChangeCount = pasteboard.changeCount

        requestPastePermissions()
        guard CGPreflightPostEventAccess(),
              let source = CGEventSource(stateID: .hidSystemState),
              let keyDown = CGEvent(keyboardEventSource: source, virtualKey: 9, keyDown: true),
              let keyUp = CGEvent(keyboardEventSource: source, virtualKey: 9, keyDown: false)
        else {
            panel.showNotice("allow Accessibility so dictation can paste — transcript is on the clipboard")
            return false
        }

        keyDown.flags = .maskCommand
        keyUp.flags = .maskCommand
        keyDown.post(tap: .cghidEventTap)
        keyUp.post(tap: .cghidEventTap)

        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { [weak self] in
            // Do not overwrite a clipboard the user changed during the grace
            // period; otherwise restore exactly the prior string contents.
            guard self?.clipboardGeneration == restoreGeneration,
                  pasteboard.changeCount == transcriptChangeCount,
                  pasteboard.string(forType: .string) == transcript else { return }
            pasteboard.clearContents()
            if let previousString { pasteboard.setString(previousString, forType: .string) }
        }
        return true
    }

    private func endpoint(path: String, queryItems: [URLQueryItem] = []) -> URL {
        // ArtemisConfig is the single source of truth for scheme and port. Its
        // initial URL is already loopback-only and follows .env overrides.
        var components = URLComponents(url: config.initialURL, resolvingAgainstBaseURL: false)!
        components.path = path
        components.queryItems = queryItems.isEmpty ? nil : queryItems
        components.fragment = nil
        return components.url!
    }

    private func addLoopbackAuthentication(to request: inout URLRequest) {
        // The current server requires its cookie even for a 127.0.0.1 socket
        // when ARTEMIS_HOST exposes the listener. Native URLSession traffic
        // cannot share WKWebView's cookie jar, so carry the already-loaded
        // config token directly without putting it in URLs or logs.
        guard let token = config.accessToken, !token.isEmpty,
              let encoded = token.addingPercentEncoding(
                  withAllowedCharacters: Self.cookieValueCharacters
              ) else { return }
        request.setValue("artemis_auth=\(encoded)", forHTTPHeaderField: "Cookie")
    }
}

/// Non-activating status HUD used by DictationController. It never becomes key
/// or receives clicks, so the insertion target remains the app the user chose.
private final class DictationPanel: NSPanel {
    private let dot = NSView(frame: NSRect(x: 12, y: 9, width: 10, height: 10))
    private let label = NSTextField(labelWithString: "")
    private var pulseGeneration = 0
    private var fadeWorkItem: DispatchWorkItem?

    init() {
        super.init(contentRect: NSRect(x: 0, y: 0, width: 132, height: 28),
                   styleMask: [.borderless, .nonactivatingPanel],
                   backing: .buffered,
                   defer: false)
        level = .statusBar
        isOpaque = false
        backgroundColor = .clear
        hasShadow = true
        ignoresMouseEvents = true
        hidesOnDeactivate = false
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        isReleasedWhenClosed = false

        let container = NSView(frame: NSRect(x: 0, y: 0, width: 132, height: 28))
        container.wantsLayer = true
        container.layer?.backgroundColor = NSColor(calibratedWhite: 0.08, alpha: 0.92).cgColor
        container.layer?.cornerRadius = 8

        dot.wantsLayer = true
        dot.layer?.backgroundColor = NSColor(calibratedRed: 0.1, green: 0.9, blue: 1, alpha: 1).cgColor
        dot.layer?.cornerRadius = 5
        container.addSubview(dot)

        label.frame = NSRect(x: 29, y: 5, width: 95, height: 18)
        label.font = .monospacedSystemFont(ofSize: 11, weight: .medium)
        label.textColor = .white
        label.alignment = .left
        label.lineBreakMode = .byClipping
        container.addSubview(label)
        contentView = container
    }

    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }

    func showListening(near point: NSPoint) {
        resize(width: 132)
        present("listening", near: point, pulse: true)
    }

    /// Center-screen advisory ("allow Input Monitoring…") — wider than the
    /// dictation pill, self-dismissing, and just as unable to steal focus.
    func showNotice(_ text: String) {
        let screen = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 800, height: 600)
        resize(width: 280)
        present(text, near: NSPoint(x: screen.midX - 140, y: screen.midY), pulse: false)
        dismiss(after: 5)
    }

    private func resize(width: CGFloat) {
        var frame = self.frame
        frame.size.width = width
        setFrame(frame, display: false)
        contentView?.frame = NSRect(x: 0, y: 0, width: width, height: 28)
        label.frame = NSRect(x: 29, y: 5, width: width - 37, height: 18)
    }

    func showFinalizing() {
        update("…", pulse: false)
    }

    func showSuccess() {
        update("✓", pulse: false)
        dismiss(after: 0.6)
    }

    func showPasteFallback() {
        update("⌘V to paste", pulse: false)
        dismiss(after: 0.6)
    }

    func dismiss(after delay: TimeInterval = 0) {
        fadeWorkItem?.cancel()
        pulseGeneration &+= 1
        let fadeGeneration = pulseGeneration
        let work = DispatchWorkItem { [weak self] in
            guard let self, self.pulseGeneration == fadeGeneration else { return }
            NSAnimationContext.runAnimationGroup { context in
                context.duration = 0.16
                self.animator().alphaValue = 0
            } completionHandler: { [weak self] in
                guard let self, self.pulseGeneration == fadeGeneration else { return }
                self.orderOut(nil)
            }
        }
        fadeWorkItem = work
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
    }

    private func present(_ text: String, near point: NSPoint, pulse: Bool) {
        fadeWorkItem?.cancel()
        position(near: point)
        alphaValue = 1
        orderFrontRegardless()
        update(text, pulse: pulse)
    }

    private func update(_ text: String, pulse: Bool) {
        fadeWorkItem?.cancel()
        label.stringValue = text
        pulseGeneration &+= 1
        dot.alphaValue = 1
        if pulse { animatePulse(generation: pulseGeneration, dim: true) }
    }

    private func animatePulse(generation: Int, dim: Bool) {
        guard generation == pulseGeneration, isVisible else { return }
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.52
            context.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
            dot.animator().alphaValue = dim ? 0.25 : 1
        } completionHandler: { [weak self] in
            self?.animatePulse(generation: generation, dim: !dim)
        }
    }

    private func position(near point: NSPoint) {
        let screen = NSScreen.screens.first(where: { $0.frame.contains(point) }) ?? NSScreen.main
        guard let frame = screen?.visibleFrame else { return }
        let size = self.frame.size
        let x = min(max(point.x + 14, frame.minX + 6), frame.maxX - size.width - 6)
        let y = min(max(point.y + 14, frame.minY + 6), frame.maxY - size.height - 6)
        setFrameOrigin(NSPoint(x: x, y: y))
    }
}
