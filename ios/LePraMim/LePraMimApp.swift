import SwiftUI
import AVFoundation

@main
struct LePraMimApp: App {
    /// A interface vem do site publicado: correções na tela chegam sem reinstalar o app.
    static let siteURL = URL(string: "https://lampraster.github.io/le-pra-mim/")!

    init() {
        // Toca mesmo com o iPhone no modo silencioso e continua com a tela bloqueada.
        let audio = AVAudioSession.sharedInstance()
        try? audio.setCategory(.playback, mode: .spokenAudio, options: [])
        try? audio.setActive(true)
    }

    var body: some Scene {
        WindowGroup {
            WebContainer(url: Self.siteURL)
                .ignoresSafeArea()
                .background(Color(uiColor: .systemBackground))
        }
    }
}
