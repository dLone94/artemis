import AppKit

enum RunMode {
    case normal
    case compatCheck
}

let argv = CommandLine.arguments
let mode: RunMode = argv.contains("--compat-check") ? .compatCheck : .normal

// The repo path is baked in at build time; ARTEMIS_ROOT overrides it.
let repoRoot: URL = {
    if let override = ProcessInfo.processInfo.environment["ARTEMIS_ROOT"] {
        return URL(fileURLWithPath: override)
    }
    let fromPlist = Bundle.main.object(forInfoDictionaryKey: "ArtemisRoot") as? String
    return URL(fileURLWithPath: fromPlist ?? FileManager.default.currentDirectoryPath)
}()

let config = ArtemisConfig.load(root: repoRoot)

let app = NSApplication.shared
let delegate = AppDelegate(mode: mode, url: config.initialURL)
app.setActivationPolicy(.regular)
app.delegate = delegate
app.run()
