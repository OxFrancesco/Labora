import AppKit
import Metal
import SceneKit

struct RenderRequest: Decodable {
    let id: Int
    let model: String
    let width: Int
    let height: Int
    let yaw: Double
    let pitch: Double
    let roll: Double?
    let lift: Double?
    let stretch: Double?
    let eyeOpen: Double?
}

struct RequestEnvelope: Decodable {
    let id: Int
    let kind: String?
}

struct RenderResponse: Encodable {
    var id: Int
    var kind: String?
    var width: Int?
    var height: Int?
    var pixels: String?
    var nodes: Int?
    var materials: [String]?
    var error: String?
    var reducedMotion: Bool?
    var applicationActive: Bool?
}

struct RenderFailure: Error, LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

final class AvatarScene {
    let renderer: SCNRenderer
    let pivot = SCNNode()
    let nodes: Int
    let materials: [String]
    private var eyes: [(node: SCNNode, scale: SCNVector3)] = []
    private var catchlights: [SCNNode] = []

    init(path: String, device: MTLDevice) throws {
        let url = URL(fileURLWithPath: path)
        guard url.pathExtension.lowercased() == "usdz" else {
            throw RenderFailure(message: "The native avatar renderer requires a USDZ model.")
        }
        let imported = try SCNScene(url: url, options: [.convertToYUp: true, .checkConsistency: true])
        let scene = SCNScene()
        scene.background.contents = NSColor.clear
        let model = SCNNode()
        for child in imported.rootNode.childNodes { model.addChildNode(child.clone()) }
        let bounds = model.boundingBox
        let extent = max(bounds.max.x - bounds.min.x, bounds.max.y - bounds.min.y, bounds.max.z - bounds.min.z)
        guard extent.isFinite && extent > 0 else { throw RenderFailure(message: "The avatar model has no visible geometry.") }
        let scale = 2 / extent
        model.scale = SCNVector3(scale, scale, scale)
        model.position = SCNVector3(
            -(bounds.min.x + bounds.max.x) * scale / 2,
            -(bounds.min.y + bounds.max.y) * scale / 2,
            -(bounds.min.z + bounds.max.z) * scale / 2
        )
        var nodeCount = 0
        var materialNames = Set<String>()
        var importedEyes: [(node: SCNNode, scale: SCNVector3)] = []
        var importedCatchlights: [SCNNode] = []
        model.enumerateChildNodes { node, _ in
            if node.name == "Eye_L" || node.name == "Eye_R" {
                importedEyes.append((node, node.scale))
            }
            if node.name == "Catchlight_L" || node.name == "Catchlight_R" {
                importedCatchlights.append(node)
            }
            if let geometry = node.geometry {
                nodeCount += 1
                for material in geometry.materials {
                    materialNames.insert(material.name ?? "Unnamed")
                    if material.name == "Blue_frosted_glass" {
                        material.roughness.contents = max((material.roughness.contents as? NSNumber)?.doubleValue ?? 0, 0.48)
                        material.transparent.contents = max((material.transparent.contents as? NSNumber)?.doubleValue ?? 0, 0.94)
                        material.transparencyMode = .singleLayer
                        material.isDoubleSided = false
                        material.clearCoat.contents = 0.05
                        material.clearCoatRoughness.contents = 0.5
                    }
                }
            }
        }
        nodes = nodeCount
        materials = materialNames.sorted()
        eyes = importedEyes
        catchlights = importedCatchlights
        guard nodes > 0 else { throw RenderFailure(message: "The avatar model has no mesh nodes.") }
        pivot.addChildNode(model)
        scene.rootNode.addChildNode(pivot)
        let camera = SCNNode()
        camera.camera = SCNCamera()
        camera.camera?.usesOrthographicProjection = true
        camera.camera?.orthographicScale = 1.22
        camera.camera?.zNear = 0.01
        camera.camera?.zFar = 100
        camera.camera?.wantsHDR = true
        camera.camera?.wantsExposureAdaptation = false
        camera.camera?.exposureOffset = 0.15
        camera.position = SCNVector3(0, 0, 5)
        scene.rootNode.addChildNode(camera)
        for (position, intensity, temperature) in [
            (SCNVector3(-3, 4, 4), 2000.0, 6500.0),
            (SCNVector3(4, -1, 4), 1500.0, 6500.0),
            (SCNVector3(1, 3, -4), 1800.0, 6500.0),
        ] {
            let light = SCNNode()
            light.light = SCNLight()
            light.light?.type = .area
            light.light?.areaExtents = SIMD3<Float>(4, 4, 0)
            light.light?.drawsArea = false
            light.light?.intensity = intensity
            light.light?.temperature = temperature
            light.position = position
            light.look(at: SCNVector3Zero)
            scene.rootNode.addChildNode(light)
        }
        let ambient = SCNNode()
        ambient.light = SCNLight()
        ambient.light?.type = .ambient
        ambient.light?.intensity = 100
        ambient.light?.color = NSColor.white
        scene.rootNode.addChildNode(ambient)
        scene.lightingEnvironment.contents = Self.environment()
        scene.lightingEnvironment.intensity = 0.85
        renderer = SCNRenderer(device: device, options: nil)
        renderer.scene = scene
        renderer.pointOfView = camera
        renderer.autoenablesDefaultLighting = false
    }

    private static func environment() -> NSImage {
        let size = NSSize(width: 512, height: 256)
        return NSImage(size: size, flipped: false) { bounds in
            NSColor(white: 0.5, alpha: 1).setFill()
            bounds.fill()
            NSColor(white: 0.72, alpha: 1).setFill()
            NSRect(x: 0, y: 128, width: 512, height: 128).fill()
            NSColor.white.setFill()
            NSBezierPath(roundedRect: NSRect(x: 45, y: 105, width: 75, height: 100), xRadius: 18, yRadius: 18).fill()
            NSColor(white: 0.9, alpha: 1).setFill()
            NSBezierPath(roundedRect: NSRect(x: 330, y: 80, width: 45, height: 100), xRadius: 12, yRadius: 12).fill()
            return true
        }
    }

    func render(_ request: RenderRequest) throws -> Data {
        let stretch = request.stretch ?? 1
        let open = request.eyeOpen ?? 1
        pivot.eulerAngles = SCNVector3(request.pitch, request.yaw, request.roll ?? 0)
        pivot.position.y = CGFloat(request.lift ?? 0)
        pivot.scale = SCNVector3(1 / sqrt(stretch), stretch, 1 / sqrt(stretch))
        for eye in eyes {
            eye.node.scale = SCNVector3(eye.scale.x, eye.scale.y, eye.scale.z * CGFloat(open))
        }
        for catchlight in catchlights { catchlight.isHidden = open < 0.75 }
        let image = renderer.snapshot(atTime: 0, with: CGSize(width: request.width, height: request.height), antialiasingMode: .multisampling4X)
        guard let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
            throw RenderFailure(message: "SceneKit did not produce a rendered frame.")
        }
        var pixels = Data(count: request.width * request.height * 4)
        let rendered = pixels.withUnsafeMutableBytes { raw in
            guard let context = CGContext(
                data: raw.baseAddress, width: request.width, height: request.height,
                bitsPerComponent: 8, bytesPerRow: request.width * 4,
                space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue
            ) else { return false }
            context.draw(cgImage, in: CGRect(x: 0, y: 0, width: request.width, height: request.height))
            let bytes = raw.bindMemory(to: UInt8.self)
            for offset in stride(from: 0, to: bytes.count, by: 4) {
                let alpha = Int(bytes[offset + 3])
                if alpha > 0 && alpha < 255 {
                    for channel in 0..<3 { bytes[offset + channel] = UInt8(min(255, (Int(bytes[offset + channel]) * 255 + alpha / 2) / alpha)) }
                }
            }
            return true
        }
        guard rendered else { throw RenderFailure(message: "Could not allocate the avatar frame.") }
        return pixels
    }
}

let encoder = JSONEncoder()
let decoder = JSONDecoder()
let output = FileHandle.standardOutput
let device = MTLCreateSystemDefaultDevice()
var scenes: [String: AvatarScene] = [:]

while let line = readLine() {
    autoreleasepool {
        var response = RenderResponse(id: 0)
        do {
            let data = Data(line.utf8)
            let envelope = try decoder.decode(RequestEnvelope.self, from: data)
            response.id = envelope.id
            if envelope.kind == "environment" {
                RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.001))
                response.kind = "environment"
                response.reducedMotion = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
                response.applicationActive = NSRunningApplication(processIdentifier: getppid())?.isActive ?? true
            } else {
                let request = try decoder.decode(RenderRequest.self, from: data)
                guard let device else { throw RenderFailure(message: "A Metal device is required to render 3D avatars.") }
                guard (16...512).contains(request.width), (16...512).contains(request.height),
                      request.yaw.isFinite, request.pitch.isFinite,
                      (request.roll ?? 0).isFinite, abs(request.roll ?? 0) <= 1,
                      (request.lift ?? 0).isFinite, abs(request.lift ?? 0) <= 0.3,
                      (0.8...1.2).contains(request.stretch ?? 1),
                      (0.05...1.2).contains(request.eyeOpen ?? 1) else {
                    throw RenderFailure(message: "Invalid avatar frame dimensions or camera angle.")
                }
                let scene: AvatarScene
                if let cached = scenes[request.model] { scene = cached }
                else {
                    scene = try AvatarScene(path: request.model, device: device)
                    scenes[request.model] = scene
                }
                response.width = request.width
                response.kind = "frame"
                response.height = request.height
                response.pixels = try scene.render(request).base64EncodedString()
                response.nodes = scene.nodes
                response.materials = scene.materials
            }
        } catch { response.error = error.localizedDescription }
        do {
            var bytes = try encoder.encode(response)
            bytes.append(10)
            try output.write(contentsOf: bytes)
        } catch { exit(1) }
    }
}
