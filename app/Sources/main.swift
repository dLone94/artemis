import AppKit

enum RunMode {
    case normal
    case compatCheck
}

let argv = CommandLine.arguments

// Hidden non-GUI modes, handled before AppKit starts so they can print and exit.
// XCTest needs Xcode, which isn't installed here, so these are how the pure
// logic gets tested — by app/test-app.sh, against the real binary.
if argv.contains("--find-node") {
    if let node = NodeLocator.find() {
        print(node.path)
        exit(0)
    }
    FileHandle.standardError.write("no node found\n".data(using: .utf8)!)
    exit(1)
}

if let i = argv.firstIndex(of: "--probe"), i + 1 < argv.count, let probeURL = URL(string: argv[i + 1]) {
    print(ServerController.probe(statusURL: probeURL).rawValue)
    exit(0)
}

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
let delegate = AppDelegate(mode: mode, url: config.initialURL, root: repoRoot, config: config)
app.setActivationPolicy(.regular)
app.delegate = delegate
app.run()
