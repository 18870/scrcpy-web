import { useRef, useState, useEffect } from 'react';
import { Adb, AdbDaemonTransport } from '@yume-chan/adb';
import AdbWebCredentialStore from '@yume-chan/adb-credential-web';
import { AdbScrcpyClient, AdbScrcpyOptionsLatest } from '@yume-chan/adb-scrcpy';
import {
  AndroidKeyCode,
  AndroidKeyEventAction,
  AndroidMotionEventAction,
  ScrcpyVideoCodecId,
} from '@yume-chan/scrcpy';
import { TinyH264Decoder } from '@yume-chan/scrcpy-decoder-tinyh264';
import { WebCodecsVideoDecoder, WebGLVideoFrameRenderer } from '@yume-chan/scrcpy-decoder-webcodecs';
import { Consumable, ReadableStream } from '@yume-chan/stream-extra';
import { AdbWebSocketConnection } from './AdbWebSocketConnection';

function App() {
  const [wsUrl, setWsUrl] = useState(`ws://${window.location.hostname}:${window.location.port}/ws/16417`);
  const [adb, setAdb] = useState<Adb | null>(null);

  const [scrcpyClient, setScrcpyClient] = useState<AdbScrcpyClient<AdbScrcpyOptionsLatest<boolean>> | null>(null);
  const [status, setStatus] = useState<string>('');
  const [videoSize, setVideoSize] = useState<{ width: number; height: number } | null>(null);
  const [logs, setLogs] = useState<string[]>([]);

  // Settings state
  const [showSettings, setShowSettings] = useState(false);
  const [maxSize, setMaxSize] = useState(1280);
  const [videoBitRate, setVideoBitRate] = useState(256_000);
  const [maxFps, setMaxFps] = useState(60);
  const [audio, setAudio] = useState(false);
  const [videoCodec, setVideoCodec] = useState<"h264" | "h265" | "av1">("h264");
  const [decoderName, setDecoderName] = useState<"tinyh264" | "webcodecs">("webcodecs");

  const canvasRef = useRef<HTMLCanvasElement>(null);

  const addLog = (msg: string) => {
    setLogs(prev => [...prev.slice(-4), msg]);
    console.log(msg);
  };
  const connectionRef = useRef<AdbWebSocketConnection | null>(null);
  const connectingRef = useRef(false);

  const [isRunning, setIsRunning] = useState(false);

  // Combined Start/Stop handler
  const handleToggle = async () => {
    if (isRunning) {
      await handleStop();
    } else {
      await handleStart();
    }
  };

  const handleStart = async (url?: string) => {
    if (connectingRef.current) return;
    connectingRef.current = true;

    try {
      // 1. Connect ADB
      setStatus('Connecting...');
      const connection = new AdbWebSocketConnection(url || wsUrl);
      await connection.waitForOpen();
      connectionRef.current = connection;

      const CredentialStore = new AdbWebCredentialStore();
      const transport = await AdbDaemonTransport.authenticate({
        serial: 'websocket',
        connection,
        credentialStore: CredentialStore,
      });

      const adbInstance = new Adb(transport);
      setAdb(adbInstance);
      setStatus('ADB Connected');

      // 2. Push Server
      setStatus('Fetching server...');
      const response = await fetch('/scrcpy-server');
      if (!response.ok) throw new Error('Failed to fetch server file');
      const buffer = await response.arrayBuffer();
      const content = new Uint8Array(buffer);

      setStatus('Pushing server...');
      const sync = await adbInstance.sync();
      try {
        await sync.write({
          filename: '/data/local/tmp/scrcpy-server.jar',
          file: new ReadableStream({
            start(controller) {
              controller.enqueue(new Consumable(content));
              controller.close();
            }
          }),
        });
      } finally {
        sync.dispose();
      }
      setStatus('Server pushed');

      // 3. Start Scrcpy
      setStatus('Starting Scrcpy...');
      const options = new AdbScrcpyOptionsLatest<boolean>({
        maxSize,
        videoBitRate,
        maxFps,
        audio,
        videoCodec,
      });

      const client = await AdbScrcpyClient.start(
        adbInstance,
        '/data/local/tmp/scrcpy-server.jar',
        options
      );

      setScrcpyClient(client);

      const videoStream = await client.videoStream;
      if (!videoStream) {
        setStatus('No video stream');
        return;
      }

      setVideoSize({ width: videoStream.width, height: videoStream.height });
      addLog(`Initial Video size: ${videoStream.width}x${videoStream.height}`);

      videoStream.sizeChanged((size) => {
        setVideoSize(size);
        addLog(`Video size changed: ${size.width}x${size.height}`);
      });

      let decoder;
      if (decoderName === 'webcodecs') {
        const codecId = videoCodec === 'h264' ? ScrcpyVideoCodecId.H264 :
          videoCodec === 'h265' ? ScrcpyVideoCodecId.H265 :
            ScrcpyVideoCodecId.AV1;

        decoder = new WebCodecsVideoDecoder({
          codec: codecId,
          renderer: new WebGLVideoFrameRenderer(canvasRef.current!),
        });
      } else {
        decoder = new TinyH264Decoder({
          canvas: canvasRef.current!,
        });
      }

      videoStream.stream
        .pipeTo(decoder.writable)
        .catch((e) => {
          console.error("Video stream error:", e);
          setStatus("Video stream error: " + e);
        });

      setStatus(`Running`);
      setIsRunning(true);

    } catch (error) {
      console.error("Start failed:", error);
      setStatus('Start failed: ' + error);
      await handleStop();
    } finally {
      connectingRef.current = false;
    }
  };

  const handleStop = async () => {
    if (scrcpyClient) {
      try {
        await scrcpyClient.close();
      } catch (e) { console.error(e); }
    }
    if (adb) {
      try {
        await adb.close();
      } catch (e) { console.error(e); }
    }
    if (connectionRef.current) {
      connectionRef.current.close();
    }

    setScrcpyClient(null);
    setAdb(null);
    setVideoSize(null);
    setIsRunning(false);
    setStatus('Stopped');
  };

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const urlParam = params.get('url') || params.get('ws');
    if (urlParam) {
      setWsUrl(urlParam);
      // Use a timeout to allow the component to fully mount and avoid strict mode double-invocation issues
      // or simply rely on the connectingRef lock.
      handleStart(urlParam);
    }
  }, []);

  const handlePointer = async (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!scrcpyClient || !scrcpyClient.controller || !videoSize || !canvasRef.current) return;

    const { offsetX, offsetY, buttons } = e.nativeEvent;
    const { clientWidth, clientHeight } = canvasRef.current;

    // Map pointer events to Android motion events
    let action: AndroidMotionEventAction;
    switch (e.type) {
      case 'pointerdown':
        action = AndroidMotionEventAction.Down;
        break;
      case 'pointerup':
        action = AndroidMotionEventAction.Up;
        break;
      case 'pointermove':
        action = AndroidMotionEventAction.Move;
        break;
      case 'pointerleave':
        action = AndroidMotionEventAction.Up;
        break;
      default:
        return;
    }

    // Only process move events if a button is pressed
    if (e.type === 'pointermove' && buttons === 0) return;

    // Scale coordinates to device resolution
    const x = Math.round((offsetX / clientWidth) * videoSize.width);
    const y = Math.round((offsetY / clientHeight) * videoSize.height);

    // Map DOM button to Android button
    // DOM: 0:Left, 1:Middle, 2:Right
    // Android: 1:Primary, 2:Secondary, 4:Tertiary
    const BUTTON_MAP = [1, 4, 2];
    let actionButton = 0;
    if (action === AndroidMotionEventAction.Down || action === AndroidMotionEventAction.Up) {
      actionButton = BUTTON_MAP[e.button] || 0;
    }

    // DOM buttons bitmask matches Android buttons bitmask for Left/Right/Middle
    // DOM: 1:Left, 2:Right, 4:Middle
    // Android: 1:Primary, 2:Secondary, 4:Tertiary

    // Use a fixed pointerId for mouse to simulate a single finger
    // For real touch events, we might want to use e.pointerId
    const pointerId = e.pointerType === 'mouse' ? BigInt(0) : BigInt(e.pointerId);

    try {
      await scrcpyClient.controller.injectTouch({
        action,
        pointerId,
        pointerX: x,
        pointerY: y,
        videoWidth: videoSize.width,
        videoHeight: videoSize.height,
        pressure: action === AndroidMotionEventAction.Up ? 0 : (e.pressure || 1),
        actionButton: actionButton,
        buttons: buttons,
      });
    } catch (error) {
      console.error('Inject touch failed:', error);
      addLog(`Touch error: ${error}`);
    }
  };

  const handleNavigation = async (keyCode: AndroidKeyCode) => {
    if (!scrcpyClient || !scrcpyClient.controller) return;
    try {
      await scrcpyClient.controller.injectKeyCode({
        action: AndroidKeyEventAction.Down,
        keyCode,
        metaState: 0,
        repeat: 0,
      });
      await scrcpyClient.controller.injectKeyCode({
        action: AndroidKeyEventAction.Up,
        keyCode,
        metaState: 0,
        repeat: 0,
      });
    } catch (error) {
      console.error('Inject key failed:', error);
    }
  };

  return (
    <div style={{
      height: '100vh',
      display: 'flex',
      flexDirection: 'column',
      fontFamily: 'sans-serif',
      overflow: 'hidden'
    }}>
      {/* Top Bar */}
      <div style={{
        padding: 10,
        borderBottom: '1px solid #ccc',
        display: 'flex',
        alignItems: 'center',
        background: '#f8f9fa'
      }}>
        <input
          type="text"
          value={wsUrl}
          onChange={(e) => setWsUrl(e.target.value)}
          placeholder={`ws://${window.location.hostname}:${window.location.port}/ws/<port>`}
          style={{ flex: 1, marginRight: 10, padding: '5px 10px' }}
          disabled={isRunning}
        />
        <button
          onClick={() => setShowSettings(!showSettings)}
          style={{
            padding: '5px 10px',
            marginRight: 10,
            background: '#6c757d',
            color: 'white',
            border: 'none',
            borderRadius: 4,
            cursor: 'pointer'
          }}
        >
          Settings
        </button>
        <button
          onClick={handleToggle}
          style={{
            padding: '5px 20px',
            background: isRunning ? '#dc3545' : '#28a745',
            color: 'white',
            border: 'none',
            borderRadius: 4,
            cursor: 'pointer'
          }}
        >
          {isRunning ? 'Stop' : 'Start'}
        </button>
      </div>

      {/* Middle Container */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden', position: 'relative' }}>
        {/* Main Content (Canvas) */}
        <div style={{
          flex: 1,
          background: '#000',
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          overflow: 'hidden',
          position: 'relative'
        }}>
          <canvas
            ref={canvasRef}
            style={{
              maxWidth: '100%',
              maxHeight: '100%',
              display: 'block',
              touchAction: 'none',
              outline: 'none'
            }}
            onPointerDown={handlePointer}
            onPointerMove={handlePointer}
            onPointerUp={handlePointer}
            onPointerLeave={handlePointer}
            tabIndex={0}
          />

          {/* Status Overlay */}
          <div style={{
            position: 'absolute',
            top: 10,
            left: 10,
            color: 'rgba(255,255,255,0.7)',
            pointerEvents: 'none',
            fontSize: '0.8em'
          }}>
            {status}
          </div>
        </div>

        {/* Settings Panel */}
        {showSettings && (
          <div style={{
            width: 300,
            background: '#fff',
            borderLeft: '1px solid #ccc',
            padding: 20,
            overflowY: 'auto',
            display: 'flex',
            flexDirection: 'column',
            gap: 4
          }}>
            <h3>Settings</h3>
            <div style={{ fontSize: '0.8em', color: '#666', marginTop: 10 }}>
              Changes will take effect on next connection.
            </div>
            <div>
              <label style={{ display: 'block', marginBottom: 5 }}>Max Size</label>
              <input type="number" value={maxSize} onChange={e => setMaxSize(Number(e.target.value))} disabled={isRunning} style={{ width: '100%', padding: 5 }} />
            </div>

            <div>
              <label style={{ display: 'block', marginBottom: 5 }}>Video Codec</label>
              <select value={videoCodec} onChange={e => setVideoCodec(e.target.value as any)} disabled={isRunning} style={{ width: '100%', padding: 5 }}>
                <option value="h264">H.264</option>
                <option value="h265">H.265</option>
                <option value="av1">AV1</option>
              </select>
            </div>

            <div>
              <label style={{ display: 'block', marginBottom: 5 }}>Bit Rate</label>
              <input type="number" value={videoBitRate} onChange={e => setVideoBitRate(Number(e.target.value))} disabled={isRunning} style={{ width: '100%', padding: 5 }} />
            </div>

            <div>
              <label style={{ display: 'block', marginBottom: 5 }}>Max FPS</label>
              <input type="number" value={maxFps} onChange={e => setMaxFps(Number(e.target.value))} disabled={isRunning} style={{ width: '100%', padding: 5 }} />
            </div>

            <div>
              <label style={{ display: 'block', marginBottom: 5 }}>Decoder</label>
              <select value={decoderName} onChange={e => setDecoderName(e.target.value as any)} disabled={isRunning} style={{ width: '100%', padding: 5 }}>
                <option value="tinyh264">TinyH264 (Software)</option>
                <option value="webcodecs">WebCodecs (Hardware)</option>
              </select>
            </div>

            <div>
              <label style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <input type="checkbox" checked={audio} onChange={e => setAudio(e.target.checked)} disabled={isRunning} />
                Audio
              </label>
            </div>
          </div>
        )}
      </div>

      {/* Bottom Navigation Bar */}
      <div style={{
        height: 50,
        background: '#000',
        display: 'flex',
        justifyContent: 'space-around',
        alignItems: 'center',
        borderTop: '1px solid #333'
      }}>
        <button
          onClick={() => handleNavigation(AndroidKeyCode.AndroidBack)}
          style={navButtonStyle}
          disabled={!isRunning}
        >
          ◀
        </button>
        <button
          onClick={() => handleNavigation(AndroidKeyCode.AndroidHome)}
          style={navButtonStyle}
          disabled={!isRunning}
        >
          ●
        </button>
        <button
          onClick={() => handleNavigation(AndroidKeyCode.AndroidAppSwitch)}
          style={navButtonStyle}
          disabled={!isRunning}
        >
          ■
        </button>
      </div>

      {/* Logs (Hidden by default or small overlay) */}
      <div style={{
        position: 'absolute',
        bottom: 60,
        right: 10,
        background: 'rgba(0,0,0,0.5)',
        color: '#fff',
        fontSize: '0.7em',
        padding: 5,
        pointerEvents: 'none',
        maxHeight: 100,
        overflow: 'hidden'
      }}>
        {logs.map((log, i) => <div key={i}>{log}</div>)}
      </div>
    </div>
  );
}

const navButtonStyle = {
  background: 'transparent',
  border: 'none',
  color: '#fff',
  fontSize: '1.5em',
  cursor: 'pointer',
  padding: '0 20px',
  width: '100%',
  height: '100%'
};

export default App;
