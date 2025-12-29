import asyncio

from starlette.routing import WebSocketRoute
from starlette.websockets import WebSocket, WebSocketDisconnect


async def forward_ws_to_tcp(websocket: WebSocket, writer: asyncio.StreamWriter) -> None:
    """Reads from WebSocket and writes to TCP socket."""
    try:
        while True:
            data = await websocket.receive_bytes()
            if not data:
                break
            writer.write(data)
            await writer.drain()
    except (WebSocketDisconnect, asyncio.IncompleteReadError):
        # WebSocket closed or stream ended
        pass
    except Exception as e:
        print(f"Error forwarding WS to TCP: {e}")
    finally:
        # Close the TCP writer if WS closes
        if not writer.is_closing():
            writer.close()


async def forward_tcp_to_ws(websocket: WebSocket, reader: asyncio.StreamReader) -> None:
    """Reads from TCP socket and writes to WebSocket."""
    try:
        while True:
            data = await reader.read(4096)
            if not data:
                # TCP connection closed by server
                break
            await websocket.send_bytes(data)
    except Exception as e:
        # Handle connection errors (e.g. WS closed while sending)
        print(f"Error forwarding TCP to WS: {e}")
    finally:
        # Close the WebSocket if TCP closes
        try:
            await websocket.close()
        except Exception:
            pass


async def websockify(websocket: WebSocket, port: int) -> None:
    # Simple subprotocol negotiation (prefer 'binary' if requested)
    client_subprotocols = websocket.headers.get("sec-websocket-protocol", "").split(",")
    selected_subprotocol = None
    for proto in client_subprotocols:
        proto = proto.strip()
        if proto == "binary":
            selected_subprotocol = "binary"
            break

    # Accept the WebSocket connection
    await websocket.accept(subprotocol=selected_subprotocol)
    print(
        f"Client connected. Proxying to localhost:{port} (Subprotocol: {selected_subprotocol})"
    )

    try:
        # Connect to the target TCP server
        reader, writer = await asyncio.open_connection("localhost", port)
    except OSError as e:
        print(f"Could not connect to localhost:{port}: {e}")
        await websocket.close(code=1011)  # Internal Error
        return

    # Run both forwarding tasks concurrently
    task_ws_to_tcp = asyncio.create_task(forward_ws_to_tcp(websocket, writer))
    task_tcp_to_ws = asyncio.create_task(forward_tcp_to_ws(websocket, reader))

    # Wait for either task to finish (connection closed from either side)
    done, pending = await asyncio.wait(
        [task_ws_to_tcp, task_tcp_to_ws], return_when=asyncio.FIRST_COMPLETED
    )

    # Cancel the remaining task
    for task in pending:
        task.cancel()

    # Ensure TCP connection is fully closed
    try:
        await writer.wait_closed()
    except Exception:
        pass

    print(f"Connection to localhost:{port} closed")


async def websocket_endpoint(websocket: WebSocket) -> None:
    port = int(websocket.path_params["port"])
    await websockify(websocket, port)


if __name__ == "__main__":
    import uvicorn
    from starlette.applications import Starlette
    from starlette.staticfiles import StaticFiles

    app = Starlette(routes=[WebSocketRoute("/ws/{port}", websocket_endpoint)])
    app.mount("/", StaticFiles(directory="dist", html=True), name="static")
    uvicorn.run(app, host="localhost", port=22273)
