import Foundation
// ONNX Runtime oficial da Microsoft, pelo CocoaPods (pod onnxruntime-objc).
#if canImport(onnxruntime_objc)
import onnxruntime_objc
#else
import OnnxRuntimeBindings
#endif

/// Gera a fala com o Kokoro-82M (ONNX) em código nativo.
///
/// A página manda os tokens já prontos (texto -> fonemas -> tokens é feito no JavaScript, igual ao
/// pacote oficial); aqui só escolhemos o estilo da voz e rodamos o modelo. Segue `kokoro.KPipeline.infer`:
/// o estilo é a linha `len(fonemas) - 1` do arquivo da voz (510 x 256 floats).
final class KokoroEngine: NSObject, URLSessionDownloadDelegate {
    enum EngineError: LocalizedError {
        case notCached
        case download(String)
        case model(String)

        var errorDescription: String? {
            switch self {
            case .notCached: return "NOT_CACHED"
            case .download(let msg): return "O download falhou (\(msg)). Confira a internet e tente de novo."
            case .model(let msg): return msg
            }
        }
    }

    static let revision = "1939ad2a8e416c0acfeecc08a694d14ef25f2231"
    static let base = URL(string: "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/\(revision)/")!
    static let modelFiles = ["q8": "onnx/model_quantized.onnx", "fp32": "onnx/model.onnx"]
    static let styleDim = 256
    static let maxPhonemes = 510

    /// Chamado durante o download do modelo (bytes baixados, total).
    var onProgress: ((Int64, Int64) -> Void)?

    private let work = DispatchQueue(label: "lepramim.kokoro", qos: .userInitiated)
    private var env: ORTEnv?
    private var session: ORTSession?
    private var loadedQuality = ""
    private var voices: [String: [Float]] = [:]
    private var threads = 1

    private var downloadSession: URLSession?
    private var downloadTarget: URL?
    private var downloadCompletion: ((Result<Void, Error>) -> Void)?
    private var downloadMoved = false

    private lazy var folder: URL = {
        var dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Kokoro", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? dir.setResourceValues(values)
        return dir
    }()

    private func localURL(_ remotePath: String) -> URL {
        folder.appendingPathComponent(remotePath.replacingOccurrences(of: "/", with: "_"))
    }

    // MARK: - Modelo

    /// Garante o modelo no aparelho e carrega a sessão. Com `cachedOnly`, não baixa nada.
    func prepare(quality: String, cachedOnly: Bool, completion: @escaping (Result<[String: Any], Error>) -> Void) {
        let q = Self.modelFiles[quality] != nil ? quality : "q8"
        let remote = Self.modelFiles[q]!
        let file = localURL(remote)
        let load = {
            self.work.async {
                do {
                    try self.loadSession(file: file, quality: q)
                    completion(.success(["quality": q, "threads": self.threads]))
                } catch {
                    completion(.failure(EngineError.model("Não consegui carregar o modelo: \(error.localizedDescription)")))
                }
            }
        }
        if FileManager.default.fileExists(atPath: file.path) {
            load()
            return
        }
        if cachedOnly {
            completion(.failure(EngineError.notCached))
            return
        }
        download(Self.base.appendingPathComponent(remote), to: file) { result in
            switch result {
            case .success: load()
            case .failure(let error): completion(.failure(error))
            }
        }
    }

    private func loadSession(file: URL, quality: String) throws {
        if session != nil && loadedQuality == quality { return }
        session = nil
        if env == nil { env = try ORTEnv(loggingLevel: .warning) }
        let options = try ORTSessionOptions()
        try options.setGraphOptimizationLevel(.all)
        threads = max(1, min(4, ProcessInfo.processInfo.activeProcessorCount))
        try options.setIntraOpNumThreads(Int32(threads))
        session = try ORTSession(env: env!, modelPath: file.path, sessionOptions: options)
        loadedQuality = quality
    }

    // MARK: - Vozes

    private func loadVoice(_ name: String, completion: @escaping (Result<[Float], Error>) -> Void) {
        let safe = name.filter { $0.isLetter || $0.isNumber || $0 == "_" }
        work.async {
            if let pack = self.voices[safe] { completion(.success(pack)); return }
            let remote = "voices/\(safe).bin"
            let file = self.localURL(remote)
            if let data = try? Data(contentsOf: file), let pack = Self.floats(data) {
                self.voices[safe] = pack
                completion(.success(pack))
                return
            }
            let url = Self.base.appendingPathComponent(remote)
            URLSession.shared.dataTask(with: url) { data, response, error in
                let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                guard error == nil, status == 200, let data = data, let pack = Self.floats(data) else {
                    completion(.failure(EngineError.download(error?.localizedDescription ?? "voz \(safe), HTTP \(status)")))
                    return
                }
                try? data.write(to: file, options: .atomic)
                self.work.async {
                    self.voices[safe] = pack
                    completion(.success(pack))
                }
            }.resume()
        }
    }

    private static func floats(_ data: Data) -> [Float]? {
        guard data.count == maxPhonemes * styleDim * MemoryLayout<Float>.size else { return nil }
        return data.withUnsafeBytes { Array($0.bindMemory(to: Float.self)) }
    }

    // MARK: - Fala

    /// ids: tokens com o 0 do começo e do fim; count: número de caracteres dos fonemas.
    /// Devolve o áudio em PCM 16 bits, 24 kHz, mono, em base64.
    func synthesize(ids: [Int64], count: Int, voice: String, speed: Float,
                    completion: @escaping (Result<[String: Any], Error>) -> Void) {
        loadVoice(voice) { result in
            switch result {
            case .failure(let error):
                completion(.failure(error))
            case .success(let pack):
                self.work.async {
                    do {
                        completion(.success(try self.run(ids: ids, count: count, pack: pack, speed: speed)))
                    } catch {
                        completion(.failure(EngineError.model("A geração falhou: \(error.localizedDescription)")))
                    }
                }
            }
        }
    }

    private func run(ids: [Int64], count: Int, pack: [Float], speed: Float) throws -> [String: Any] {
        guard let session = session else { throw EngineError.model("O modelo ainda não foi carregado.") }
        let row = min(max(count - 1, 0), Self.maxPhonemes - 1)
        let style = Array(pack[(row * Self.styleDim)..<((row + 1) * Self.styleDim)])
        let start = Date()

        let idsData = ids.withUnsafeBufferPointer { NSMutableData(data: Data(buffer: $0)) }
        let styleData = style.withUnsafeBufferPointer { NSMutableData(data: Data(buffer: $0)) }
        let speedData = [speed].withUnsafeBufferPointer { NSMutableData(data: Data(buffer: $0)) }
        let inputs: [String: ORTValue] = [
            "input_ids": try ORTValue(tensorData: idsData, elementType: .int64, shape: [1, NSNumber(value: ids.count)]),
            "style": try ORTValue(tensorData: styleData, elementType: .float, shape: [1, NSNumber(value: Self.styleDim)]),
            "speed": try ORTValue(tensorData: speedData, elementType: .float, shape: [1]),
        ]
        let outputs = try session.run(withInputs: inputs, outputNames: ["waveform"], runOptions: nil)
        guard let wave = outputs["waveform"] else { throw EngineError.model("O modelo não devolveu áudio.") }
        let raw = try wave.tensorData() as Data
        let samples = raw.withUnsafeBytes { Array($0.bindMemory(to: Float.self)) }

        var pcm = [Int16](repeating: 0, count: samples.count)
        for i in 0..<samples.count {
            let v = max(-1, min(1, samples[i]))
            pcm[i] = Int16(v < 0 ? v * 32768 : v * 32767)
        }
        let audio = pcm.withUnsafeBufferPointer { Data(buffer: $0) }.base64EncodedString()
        let ms = Date().timeIntervalSince(start) * 1000
        return ["audio": audio, "ms": ms, "samples": samples.count]
    }

    // MARK: - Download do modelo, com progresso

    private func download(_ url: URL, to target: URL, completion: @escaping (Result<Void, Error>) -> Void) {
        downloadTarget = target
        downloadCompletion = completion
        downloadMoved = false
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForResource = 60 * 60
        let session = URLSession(configuration: config, delegate: self, delegateQueue: nil)
        downloadSession = session
        session.downloadTask(with: url).resume()
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData bytesWritten: Int64,
                    totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
        onProgress?(totalBytesWritten, totalBytesExpectedToWrite)
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        guard let target = downloadTarget else { return }
        let status = (downloadTask.response as? HTTPURLResponse)?.statusCode ?? 0
        guard status == 200 else { return }
        try? FileManager.default.removeItem(at: target)
        do {
            try FileManager.default.moveItem(at: location, to: target)
            downloadMoved = true
        } catch {
            downloadMoved = false
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        let completion = downloadCompletion
        downloadCompletion = nil
        session.finishTasksAndInvalidate()
        downloadSession = nil
        if let error = error {
            completion?(.failure(EngineError.download(error.localizedDescription)))
        } else if !downloadMoved {
            let status = (task.response as? HTTPURLResponse)?.statusCode ?? 0
            completion?(.failure(EngineError.download("HTTP \(status)")))
        } else {
            completion?(.success(()))
        }
    }
}
