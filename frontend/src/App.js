import { useState, useRef, useCallback, useEffect } from "react";
import axios from "axios";
import {
  Anchor,
  Upload,
  Camera,
  X,
  RefreshCw,
  Send,
  MessageCircle,
  CheckCircle2,
  XCircle,
  Loader2,
  ScanLine,
  Package,
  Clock,
} from "lucide-react";

const API = "http://localhost:8000";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function confidenceStyle(pct) {
  if (pct >= 90) return { bar: "bg-emerald-500", text: "text-emerald-300", label: "Très élevée" };
  if (pct >= 70) return { bar: "bg-amber-500", text: "text-amber-300", label: "Élevée" };
  if (pct >= 50) return { bar: "bg-orange-500", text: "text-orange-300", label: "Modérée" };
  return { bar: "bg-red-500", text: "text-red-300", label: "Faible" };
}

function formatId(id) {
  if (!id || id === "N/A") return id;
  return id.split("").join(" ");
}

function formatTime(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export default function App() {
  const [image, setImage] = useState(null);
  const [imageFile, setImageFile] = useState(null);
  const [annotatedImage, setAnnotatedImage] = useState(null);
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [history, setHistory] = useState([]);
  const [dragging, setDragging] = useState(false);

  const [chatOpen, setChatOpen] = useState(false);
  const [messages, setMessages] = useState([
    { role: "assistant", text: "Bonjour. Posez-moi une question sur les conteneurs scannés ou sur le système." },
  ]);
  const [chatInput, setChatInput] = useState("");
  const [chatLoading, setChatLoading] = useState(false);

  const [cameraOpen, setCameraOpen] = useState(false);
  const [stream, setStream] = useState(null);
  const [autoDetecting, setAutoDetecting] = useState(false);

  const fileInput = useRef();
  const chatBottom = useRef();
  const videoRef = useRef();
  const canvasRef = useRef();
  const detectingRef = useRef(false);
  const intervalRef = useRef(null);

  useEffect(() => {
    loadHistory();
  }, []);

  useEffect(() => {
    chatBottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      if (stream) stream.getTracks().forEach((t) => t.stop());
    };
  }, [stream]);

  useEffect(() => {
    if (!cameraOpen || !stream || !videoRef.current) return;
    const video = videoRef.current;
    video.srcObject = stream;
    video.onloadedmetadata = () => {
      video.play();
      if (intervalRef.current) clearInterval(intervalRef.current);
      intervalRef.current = setInterval(captureAndDetect, 1500);
    };
  }, [cameraOpen, stream]);

  // -- handlers ---------------------------------------------------------

  const handleFile = (file) => {
    if (!file || !file.type.startsWith("image/")) return;
    setImageFile(file);
    setImage(URL.createObjectURL(file));
    setAnnotatedImage(null);
    setResult(null);
    setError(null);
  };

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    setDragging(false);
    handleFile(e.dataTransfer.files[0]);
  }, []);

  const handleDetect = async () => {
    if (!imageFile) return;
    setLoading(true);
    setError(null);
    try {
      const formData = new FormData();
      formData.append("file", imageFile);
      const res = await axios.post(`${API}/detect`, formData);
      setResult(res.data);
      if (res.data.image) setAnnotatedImage(`data:image/jpeg;base64,${res.data.image}`);
      if (res.data.committed) loadHistory();
    } catch {
      setError("Impossible de contacter le serveur.");
      setAnnotatedImage(null);
    } finally {
      setLoading(false);
    }
  };

  const loadHistory = async () => {
    try {
      const res = await axios.get(`${API}/history`);
      setHistory([...res.data].reverse().slice(0, 8));
    } catch {}
  };

  const sendChat = async () => {
    if (!chatInput.trim() || chatLoading) return;
    const userMsg = chatInput.trim();
    setChatInput("");
    setMessages((prev) => [...prev, { role: "user", text: userMsg }]);
    setChatLoading(true);
    try {
      const context =
        history.length > 0
          ? `Derniers scans: ${history
              .slice(0, 3)
              .map((h) => `${h.container_id} (${h.timestamp?.slice(11, 16)})`)
              .join(", ")}.`
          : "Aucun scan récent.";
      const res = await axios.post(`${API}/chat`, { message: userMsg, context });
      setMessages((prev) => [...prev, { role: "assistant", text: res.data.reply }]);
    } catch {
      setMessages((prev) => [...prev, { role: "assistant", text: "Erreur de connexion au chatbot." }]);
    } finally {
      setChatLoading(false);
    }
  };

  const openCamera = async () => {
    try {
      const mediaStream = await navigator.mediaDevices.getUserMedia({ video: true });
      setStream(mediaStream);
      setCameraOpen(true);
    } catch {
      setError("Impossible d'accéder à la caméra.");
    }
  };

  const closeCamera = () => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    intervalRef.current = null;
    if (stream) stream.getTracks().forEach((t) => t.stop());
    setCameraOpen(false);
    setStream(null);
    setAutoDetecting(false);
  };

  const captureAndDetect = () => {
    if (detectingRef.current) return;
    const video = videoRef.current;
    if (!video || video.readyState !== 4) return;

    const canvas = canvasRef.current;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d").drawImage(video, 0, 0);

    canvas.toBlob(async (blob) => {
      if (!blob) return;
      const file = new File([blob], "capture.jpg", { type: "image/jpeg" });
      detectingRef.current = true;
      setAutoDetecting(true);
      try {
        const formData = new FormData();
        formData.append("file", file);
        const res = await axios.post(`${API}/detect`, formData);
        setResult(res.data);
        if (res.data.image) setAnnotatedImage(`data:image/jpeg;base64,${res.data.image}`);
        setImage(URL.createObjectURL(file));
        if (res.data.committed) loadHistory();
      } catch {
        // silencieux en scan live — pas de spam d'erreur à chaque frame
      } finally {
        detectingRef.current = false;
        setAutoDetecting(false);
      }
    }, "image/jpeg");
  };

  const conf = result?.success ? confidenceStyle(result.confidence * 100) : null;

  // -- render -------------------------------------------------------------

  return (
    <div className="min-h-screen bg-slate-50 font-sans text-slate-800">
      {/* Header */}
      <header className="sticky top-0 z-30 bg-[#0B2545] shadow-md">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-white/10">
              <Anchor className="h-5 w-5 text-white" strokeWidth={2} />
            </div>
            <div>
              <div className="text-base font-semibold tracking-tight text-white">Marsa Maroc</div>
              <div className="text-xs text-slate-300">Reconnaissance de codes conteneurs</div>
            </div>
          </div>
          <button
            onClick={() => setChatOpen((o) => !o)}
            className="flex items-center gap-2 rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-sky-500 active:scale-[0.98]"
          >
            <MessageCircle className="h-4 w-4" />
            <span className="hidden sm:inline">{chatOpen ? "Fermer l'assistant" : "Assistant IA"}</span>
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          {/* ---------------- Left: image / scan ---------------- */}
          <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
            <h2 className="mb-4 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-slate-500">
              <Package className="h-4 w-4" />
              Image du conteneur
            </h2>

            <div
              onDrop={handleDrop}
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onClick={() => fileInput.current.click()}
              className={`group relative flex min-h-[280px] cursor-pointer items-center justify-center overflow-hidden rounded-xl border-2 border-dashed transition-colors ${
                dragging ? "border-sky-500 bg-sky-50" : "border-slate-300 bg-slate-50 hover:border-slate-400"
              }`}
            >
              {image ? (
                <img
                  src={annotatedImage || image}
                  alt="Aperçu"
                  className="h-full max-h-[420px] w-full object-contain"
                />
              ) : (
                <div className="flex flex-col items-center gap-3 px-6 py-16 text-center">
                  <div className="flex h-14 w-14 items-center justify-center rounded-full bg-slate-200 text-slate-500 transition group-hover:bg-sky-100 group-hover:text-sky-600">
                    <Upload className="h-6 w-6" />
                  </div>
                  <div className="text-sm font-medium text-slate-700">Déposer une image ou cliquer</div>
                  <div className="text-xs text-slate-400">JPG, PNG — photo de conteneur</div>
                </div>
              )}
              <input
                ref={fileInput}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => handleFile(e.target.files[0])}
              />
            </div>

            <div className="mt-4 flex flex-col gap-3 sm:flex-row">
              <button
                onClick={openCamera}
                className="flex flex-1 items-center justify-center gap-2 rounded-xl border border-[#0B2545] px-4 py-3 text-sm font-semibold text-[#0B2545] transition hover:bg-[#0B2545] hover:text-white"
              >
                <Camera className="h-4 w-4" />
                Scan en direct
              </button>
              <button
                onClick={handleDetect}
                disabled={!imageFile || loading}
                className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-[#0B2545] px-4 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-[#123561] disabled:cursor-not-allowed disabled:opacity-40"
              >
                {loading ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Analyse en cours…
                  </>
                ) : (
                  <>
                    <ScanLine className="h-4 w-4" />
                    Extraire le code
                  </>
                )}
              </button>
            </div>
          </section>

          {/* ---------------- Right: result ---------------- */}
          <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
            <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-slate-500">Résultat</h2>

            {!result && !error && (
              <div className="flex min-h-[280px] flex-col items-center justify-center gap-3 text-slate-400">
                <Package className="h-10 w-10" strokeWidth={1.5} />
                <div className="text-sm">En attente d'une image</div>
              </div>
            )}

            {error && (
              <div className="flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 p-4">
                <XCircle className="mt-0.5 h-5 w-5 flex-shrink-0 text-red-500" />
                <div>
                  <div className="text-sm font-semibold text-red-700">Erreur</div>
                  <div className="text-sm text-red-600">{error}</div>
                </div>
              </div>
            )}

            {result && !result.success && (
              <div className="flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 p-4">
                <XCircle className="mt-0.5 h-5 w-5 flex-shrink-0 text-red-500" />
                <div>
                  <div className="text-sm font-semibold text-red-700">Non détecté</div>
                  <div className="text-sm text-red-600">Aucun code conteneur trouvé. Essayez une image plus nette.</div>
                </div>
              </div>
            )}

            {/* Detected but not yet stabilized/committed */}
            {result && result.success && !result.committed && (
              <div className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4">
                <Loader2 className="mt-0.5 h-5 w-5 flex-shrink-0 animate-spin text-amber-500" />
                <div>
                  <div className="text-sm font-semibold text-amber-700">
                    Lecture en cours — {formatId(result.container_id)}
                  </div>
                  <div className="text-sm text-amber-600">
                    En attente de confirmation (maintenez le code stable face à la caméra).
                  </div>
                </div>
              </div>
            )}

            {/* Fully committed and confirmed */}
            {result && result.success && result.committed && (
              <div className="animate-[fadeIn_0.25s_ease] space-y-5">
                {/* ID card */}
                <div className="rounded-xl bg-gradient-to-br from-[#0B2545] to-[#12345f] p-5 text-white shadow-sm">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium uppercase tracking-widest text-slate-300">
                      Identifiant conteneur
                    </span>
                    <span
                      className={`flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold ${
                        result.bic_validation?.valid
                          ? "bg-emerald-500/15 text-emerald-300"
                          : "bg-red-500/15 text-red-300"
                      }`}
                    >
                      {result.bic_validation?.valid ? (
                        <CheckCircle2 className="h-3.5 w-3.5" />
                      ) : (
                        <XCircle className="h-3.5 w-3.5" />
                      )}
                      {result.bic_validation?.valid ? "Code valide" : "Format non reconnu"}
                    </span>
                  </div>

                  <div className="mt-3 font-mono text-2xl font-bold tracking-[0.2em] sm:text-3xl">
                    {formatId(result.container_id)}
                  </div>

                  {result.iso_type && result.iso_type !== "N/A" && (
                    <span className="mt-3 inline-block rounded-md bg-white/10 px-2.5 py-1 font-mono text-xs tracking-wide">
                      ISO {result.iso_type}
                    </span>
                  )}

                  {/* Confidence bar */}
                  <div className="mt-5">
                    <div className="mb-1.5 flex items-center justify-between text-xs text-slate-300">
                      <span>Confiance</span>
                      <span className="font-semibold text-white">{(result.confidence * 100).toFixed(0)}%</span>
                    </div>
                    <div className="h-2 w-full overflow-hidden rounded-full bg-white/15">
                      <div
                        className={`h-full rounded-full ${conf.bar} transition-all duration-500`}
                        style={{ width: `${Math.min(100, result.confidence * 100)}%` }}
                      />
                    </div>
                    <div className={`mt-1 text-xs font-medium ${conf.text}`}>{conf.label}</div>
                  </div>
                </div>

                {/* Details grid */}
                {result.bic_validation?.valid && (
                  <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-slate-200 bg-slate-200">
                    {[
                      ["Propriétaire", result.bic_validation.owner_code],
                      ["Catégorie", result.bic_validation.category],
                      ["Numéro série", result.bic_validation.serial],
                      ["Check digit", result.bic_validation.check_digit_computed],
                    ].map(([label, val]) => (
                      <div key={label} className="bg-white p-3.5">
                        <div className="text-[11px] uppercase tracking-wide text-slate-400">{label}</div>
                        <div className="mt-0.5 font-mono text-sm font-semibold text-slate-800">{val}</div>
                      </div>
                    ))}
                  </div>
                )}

                <div className="flex items-center gap-1.5 text-xs text-slate-400">
                  <Clock className="h-3.5 w-3.5" />
                  {new Date(result.timestamp).toLocaleString("fr-FR")}
                </div>
              </div>
            )}
          </section>
        </div>

        {/* ---------------- History ---------------- */}
        <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Historique des scans</h2>
            <button
              onClick={loadHistory}
              className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-500 transition hover:border-slate-300 hover:text-slate-700"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Actualiser
            </button>
          </div>

          {history.length === 0 ? (
            <div className="py-10 text-center text-sm text-slate-400">Aucun scan enregistré</div>
          ) : (
            <>
              {/* Table on larger screens */}
              <div className="hidden overflow-hidden rounded-xl border border-slate-100 sm:block">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-100 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-400">
                      <th className="px-4 py-3 font-medium">État</th>
                      <th className="px-4 py-3 font-medium">Conteneur</th>
                      <th className="px-4 py-3 font-medium">ISO</th>
                      <th className="px-4 py-3 font-medium">Confiance</th>
                      <th className="px-4 py-3 text-right font-medium">Heure</th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.map((item, i) => (
                      <tr key={item.id ?? i} className="border-b border-slate-50 last:border-0 hover:bg-slate-50/70">
                        <td className="px-4 py-3">
                          {item.bic_valid ? (
                            <span className="inline-flex h-2.5 w-2.5 rounded-full bg-emerald-500" />
                          ) : (
                            <span className="inline-flex h-2.5 w-2.5 rounded-full bg-red-500" />
                          )}
                        </td>
                        <td className="px-4 py-3 font-mono font-medium tracking-wide text-slate-800">
                          {item.container_id}
                        </td>
                        <td className="px-4 py-3 font-mono text-slate-500">{item.iso_type}</td>
                        <td className="px-4 py-3 text-slate-500">{(item.confidence * 100).toFixed(0)}%</td>
                        <td className="px-4 py-3 text-right text-slate-400">{formatTime(item.timestamp)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Cards on small screens */}
              <div className="flex flex-col gap-2 sm:hidden">
                {history.map((item, i) => (
                  <div key={item.id ?? i} className="flex items-center justify-between rounded-xl bg-slate-50 px-4 py-3">
                    <div className="flex items-center gap-3">
                      <span
                        className={`inline-flex h-2.5 w-2.5 flex-shrink-0 rounded-full ${
                          item.bic_valid ? "bg-emerald-500" : "bg-red-500"
                        }`}
                      />
                      <div>
                        <div className="font-mono text-sm font-semibold text-slate-800">{item.container_id}</div>
                        <div className="text-xs text-slate-400">
                          ISO {item.iso_type} · {(item.confidence * 100).toFixed(0)}%
                        </div>
                      </div>
                    </div>
                    <div className="text-xs text-slate-400">{formatTime(item.timestamp)}</div>
                  </div>
                ))}
              </div>
            </>
          )}
        </section>
      </main>

      {/* ---------------- Camera modal ---------------- */}
      {cameraOpen && (
        <div className="fixed bottom-4 right-4 left-4 z-40 mx-auto w-auto max-w-sm overflow-hidden rounded-2xl bg-[#0B2545] shadow-2xl sm:left-auto sm:mx-0">
          <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
            <div className="flex items-center gap-2 text-sm font-semibold text-white">
              <ScanLine className="h-4 w-4" />
              Scan en direct
              {autoDetecting && <span className="h-2 w-2 animate-pulse rounded-full bg-amber-400" />}
            </div>
            <button onClick={closeCamera} className="rounded p-1 text-slate-300 hover:text-white">
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="relative">
            <video ref={videoRef} autoPlay className="block w-full" />
            <canvas ref={canvasRef} className="hidden" />
            <div className="pointer-events-none absolute inset-3 rounded-lg border-2 border-dashed border-amber-400/70" />
          </div>
          <div className="px-4 py-2.5 text-center text-xs">
            {autoDetecting ? (
              <span className="text-slate-300">Analyse en cours…</span>
            ) : result?.committed ? (
              <span className="font-medium text-emerald-400">✓ Code confirmé et enregistré</span>
            ) : result?.success ? (
              <span className="text-amber-400">Lecture instable — maintenez le code face caméra</span>
            ) : (
              <span className="text-slate-300">En attente — présentez le code du conteneur</span>
            )}
          </div>
        </div>
      )}

      {/* ---------------- Chat panel ---------------- */}
      {chatOpen && (
        <div className="fixed bottom-4 right-4 left-4 z-40 mx-auto flex h-[440px] w-auto max-w-sm flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl sm:left-auto sm:mx-0">
          <div className="flex items-center justify-between bg-[#0B2545] px-4 py-3">
            <div className="flex items-center gap-2 text-sm font-semibold text-white">
              <MessageCircle className="h-4 w-4" />
              Assistant IA
            </div>
            <button onClick={() => setChatOpen(false)} className="rounded p-1 text-slate-300 hover:text-white">
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="flex-1 space-y-2.5 overflow-y-auto p-4">
            {messages.map((msg, i) => (
              <div
                key={i}
                className={`max-w-[85%] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed ${
                  msg.role === "user"
                    ? "ml-auto rounded-br-sm bg-sky-600 text-white"
                    : "rounded-bl-sm bg-slate-100 text-slate-700"
                }`}
              >
                {msg.text}
              </div>
            ))}
            {chatLoading && (
              <div className="flex w-fit items-center gap-1 rounded-2xl rounded-bl-sm bg-slate-100 px-3.5 py-2.5">
                <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-400 [animation-delay:-0.3s]" />
                <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-400 [animation-delay:-0.15s]" />
                <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-400" />
              </div>
            )}
            <div ref={chatBottom} />
          </div>

          <div className="flex items-center gap-2 border-t border-slate-100 p-3">
            <input
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && sendChat()}
              placeholder="Posez une question…"
              className="flex-1 rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-2.5 text-sm text-slate-700 outline-none focus:border-sky-400 focus:bg-white"
            />
            <button
              onClick={sendChat}
              disabled={chatLoading}
              className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-sky-600 text-white transition hover:bg-sky-500 disabled:opacity-40"
            >
              <Send className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}

      {/* Floating trigger when nothing is open (mobile-friendly re-entry point) */}
      {!chatOpen && !cameraOpen && (
        <button
          onClick={() => setChatOpen(true)}
          className="fixed bottom-5 right-5 z-30 flex h-14 w-14 items-center justify-center rounded-full bg-sky-600 text-white shadow-lg transition hover:bg-sky-500 active:scale-95 sm:hidden"
        >
          <MessageCircle className="h-6 w-6" />
        </button>
      )}
    </div>
  );
}