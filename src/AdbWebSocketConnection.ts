import type { AdbPacketData, AdbPacketInit } from "@yume-chan/adb";
import { AdbPacket } from "@yume-chan/adb";
import {
    ReadableStream,
    WritableStream,
    PushReadableStream,
    StructDeserializeStream,
    MaybeConsumable,
} from "@yume-chan/stream-extra";

export class AdbWebSocketConnection {
    private _readable: ReadableStream<AdbPacketData>;
    private _writable: WritableStream<MaybeConsumable<AdbPacketInit>>;
    private _socket: WebSocket;

    constructor(url: string) {
        this._socket = new WebSocket(url);
        this._socket.binaryType = "arraybuffer";

        // Convert WebSocket 'message' events to a ReadableStream of AdbPackets
        const rawReadable = new PushReadableStream<Uint8Array>((controller) => {
            this._socket.onmessage = (event) => {
                controller.enqueue(new Uint8Array(event.data));
            };
            this._socket.onclose = () => {
                controller.close();
            };
            this._socket.onerror = (e) => {
                controller.error(e);
            };
        });

        // Deserialize raw bytes into AdbPacket structures
        this._readable = rawReadable.pipeThrough(new StructDeserializeStream(AdbPacket));

        // Create a WritableStream that serializes AdbPackets and sends them over WebSocket
        this._writable = new MaybeConsumable.WritableStream<AdbPacketInit>({
            write: (chunk) => {
                // Serialize the packet to bytes
                const buffer = AdbPacket.serialize(chunk);
                this._socket.send(buffer);
            },
        });
    }

    get readable() {
        return this._readable;
    }

    get writable() {
        return this._writable;
    }

    // Helper to wait for connection open
    async waitForOpen(): Promise<void> {
        if (this._socket.readyState === WebSocket.OPEN) return;
        return new Promise((resolve, reject) => {
            this._socket.onopen = () => resolve();
            this._socket.onerror = () => reject(new Error("WebSocket connection failed"));
        });
    }

    close() {
        this._socket.close();
    }
}
