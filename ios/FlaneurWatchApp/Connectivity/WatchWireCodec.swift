import Foundation

enum WatchWireCodec {
    static func snapshot(from dictionary: [String: Any]) -> WatchSessionSnapshot? {
        if let nested = dictionary["snapshot"] {
            return decode(WatchSessionSnapshot.self, fromJSONObject: nested)
        }
        guard dictionary["sessionId"] != nil else { return nil }
        return decode(WatchSessionSnapshot.self, fromJSONObject: dictionary)
    }

    static func acknowledgement(from dictionary: [String: Any]) -> WatchCommandAcknowledgement? {
        guard dictionary["commandId"] != nil, dictionary["success"] != nil else { return nil }
        return decode(WatchCommandAcknowledgement.self, fromJSONObject: dictionary)
    }

    static func commandDictionary(for request: WatchCommandRequest) -> [String: Any] {
        var message: [String: Any] = [
            "kind": request.kind,
            "schema": request.schema,
            "commandId": request.commandId,
            "command": request.command.rawValue,
            "sessionId": request.sessionId
        ]
        if let spotId = request.spotId {
            message["spotId"] = spotId
        }
        return message
    }

    static func messageKind(in dictionary: [String: Any]) -> String? {
        dictionary["kind"] as? String
    }

    private static func decode<T: Decodable>(_ type: T.Type, fromJSONObject object: Any) -> T? {
        guard JSONSerialization.isValidJSONObject(object),
              let data = try? JSONSerialization.data(withJSONObject: object) else {
            return nil
        }
        return try? JSONDecoder().decode(type, from: data)
    }
}
