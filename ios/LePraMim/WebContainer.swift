import SwiftUI
import UIKit
import WebKit

/// Mostra o site do Lê pra Mim e liga a página ao motor nativo de voz.
struct WebContainer: UIViewRepresentable {
    let url: URL

    func makeCoordinator() -> Coordinator { Coordinator(url: url) }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        config.allowsAirPlayForMediaPlayback = true
        config.websiteDataStore = .default()
        config.userContentController.addScriptMessageHandler(context.coordinator.bridge, contentWorld: .page, name: "lepramim")

        let web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = context.coordinator
        web.uiDelegate = context.coordinator
        web.isOpaque = false
        web.backgroundColor = .systemBackground
        web.scrollView.backgroundColor = .systemBackground
        web.scrollView.contentInsetAdjustmentBehavior = .never   // a página já trata as bordas (safe area)
        if #available(iOS 16.4, *) { web.isInspectable = true }
        context.coordinator.bridge.webView = web
        web.load(URLRequest(url: url))
        return web
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
        let url: URL
        let bridge = NativeBridge()
        private var downloads: [ObjectIdentifier: URL] = [:]

        init(url: URL) { self.url = url }

        // Links para outros sites abrem no Safari; downloads (salvar o áudio) viram arquivo para compartilhar.
        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            if action.shouldPerformDownload {
                decisionHandler(.download)
                return
            }
            if let target = action.request.url, let scheme = target.scheme?.lowercased(),
               scheme == "http" || scheme == "https", target.host != url.host, action.targetFrame?.isMainFrame ?? true {
                UIApplication.shared.open(target)
                decisionHandler(.cancel)
                return
            }
            decisionHandler(.allow)
        }

        func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
            download.delegate = self
        }

        func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
            download.delegate = self
        }

        func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String,
                      completionHandler: @escaping (URL?) -> Void) {
            let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            let file = dir.appendingPathComponent(suggestedFilename.isEmpty ? "audio.wav" : suggestedFilename)
            downloads[ObjectIdentifier(download)] = file
            completionHandler(file)
        }

        func downloadDidFinish(_ download: WKDownload) {
            guard let file = downloads.removeValue(forKey: ObjectIdentifier(download)) else { return }
            DispatchQueue.main.async { Self.share(file) }
        }

        func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
            downloads.removeValue(forKey: ObjectIdentifier(download))
        }

        static func share(_ file: URL) {
            let sheet = UIActivityViewController(activityItems: [file], applicationActivities: nil)
            guard let root = UIApplication.shared.connectedScenes.compactMap({ ($0 as? UIWindowScene)?.keyWindow }).first?.rootViewController else { return }
            var top = root
            while let presented = top.presentedViewController { top = presented }
            sheet.popoverPresentationController?.sourceView = top.view
            top.present(sheet, animated: true)
        }

        // target=_blank e window.open: abre no Safari.
        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                     for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
            if let target = action.request.url { UIApplication.shared.open(target) }
            return nil
        }

        // Sem internet na abertura: mostra um aviso com botão para tentar de novo.
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            let nsError = error as NSError
            if nsError.code == NSURLErrorCancelled { return }
            webView.loadHTMLString(Self.offlinePage(url: url), baseURL: nil)
        }

        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            webView.load(URLRequest(url: url))
        }

        static func offlinePage(url: URL) -> String {
            """
            <!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <style>
              :root { color-scheme: light dark; }
              body { font: 17px -apple-system, system-ui, sans-serif; margin: 0; padding: 48px 24px; text-align: center; }
              h1 { font-size: 22px; }
              a { display: inline-block; margin-top: 16px; padding: 12px 22px; border-radius: 999px; background: #2446D6; color: #fff; text-decoration: none; font-weight: 600; }
            </style></head><body>
            <h1>Sem conexão</h1>
            <p>O Lê pra Mim precisa de internet para abrir. A voz, depois de baixada, funciona no aparelho.</p>
            <a href="\(url.absoluteString)">Tentar de novo</a>
            </body></html>
            """
        }
    }
}

/// Recebe as mensagens da página (window.webkit.messageHandlers.lepramim.postMessage) e responde.
final class NativeBridge: NSObject, WKScriptMessageHandlerWithReply {
    weak var webView: WKWebView?
    private let engine = KokoroEngine()

    override init() {
        super.init()
        var last = Date.distantPast
        engine.onProgress = { [weak self] loaded, total in
            let now = Date()
            guard now.timeIntervalSince(last) > 0.15 || loaded == total else { return }
            last = now
            DispatchQueue.main.async {
                self?.webView?.evaluateJavaScript("window.__lpmNativeProgress && window.__lpmNativeProgress(\(loaded), \(total))")
            }
        }
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        let reply: (Result<[String: Any], Error>) -> Void = { result in
            DispatchQueue.main.async {
                switch result {
                case .success(let value): replyHandler(value, nil)
                case .failure(let error): replyHandler(nil, error.localizedDescription)
                }
            }
        }
        guard let body = message.body as? [String: Any], let type = body["type"] as? String else {
            reply(.failure(KokoroEngine.EngineError.model("Mensagem inválida.")))
            return
        }
        switch type {
        case "prepare":
            let quality = body["quality"] as? String ?? "fp32"
            let cachedOnly = body["cachedOnly"] as? Bool ?? false
            engine.prepare(quality: quality, cachedOnly: cachedOnly, completion: reply)
        case "synthesize":
            let ids = (body["ids"] as? [Any] ?? []).compactMap { ($0 as? NSNumber)?.int64Value }
            let count = (body["count"] as? NSNumber)?.intValue ?? max(ids.count - 2, 0)
            let voice = body["voice"] as? String ?? "pf_dora"
            let speed = (body["speed"] as? NSNumber)?.floatValue ?? 1
            engine.synthesize(ids: ids, count: count, voice: voice, speed: speed, completion: reply)
        default:
            reply(.failure(KokoroEngine.EngineError.model("Pedido desconhecido: \(type)")))
        }
    }
}
