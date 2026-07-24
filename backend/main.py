from fastapi import FastAPI, File, UploadFile, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel
import cv2
import numpy as np
from ultralytics import YOLO
from datetime import datetime
import json
import os
import uuid
import base64
import re
from collections import deque
import gspread

app = FastAPI(title="Marsa Maroc Container Recognition API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── CONFIG ────────────────────────────────────────────────────────────────
STAGE2_MODEL = r"C:\Users\PC\Downloads\stage2_best.pt"
STAGE3_MODEL = r"C:\Users\PC\Downloads\stage3_v2_best.pt"
HISTORY_FILE = "history.json"

# ── LOAD MODELS ───────────────────────────────────────────────────────────
print("Loading YOLO models...")
stage2 = YOLO(STAGE2_MODEL)
stage3 = YOLO(STAGE3_MODEL)

print("\nStage 3 class mapping:")
print(stage3.names)

print("All models loaded ✅")

# ── STABILIZATION ─────────────────────────────────────────────────────────
class DetectionStabilizer:
    def __init__(self, window=5, min_frames=3, cooldown_frames=5):
        self.buffer = deque(maxlen=window)
        self.min_frames = min_frames
        self.cooldown_frames = cooldown_frames
        self.last_committed = None
        self.cooldown = 0

    def push(self, container_id, confidence):
        if self.cooldown > 0:
            self.cooldown -= 1
            return None
        if confidence < 0.80 or not container_id or container_id == "N/A":
            return None

        self.buffer.append(container_id)

        # Only vote once we have enough same-length frames to compare position by position
        same_length = [c for c in self.buffer if len(c) == 11]
        if len(same_length) < self.min_frames:
            return None

        # Majority vote per character position across the last `min_frames` same-length reads
        from collections import Counter
        voted = "".join(
            Counter(chars).most_common(1)[0][0]
            for chars in zip(*same_length[-self.min_frames:])
        )

        result = validate_bic(voted)
        if result.get("valid") and voted != self.last_committed:
            self.last_committed = voted
            self.cooldown = self.cooldown_frames
            self.buffer.clear()
            return voted, result  # return both the ID and its validation
        return None
    
stabilizer = DetectionStabilizer()

# ── HISTORY ───────────────────────────────────────────────────────────────
def load_history():
    if os.path.exists(HISTORY_FILE):
        with open(HISTORY_FILE, 'r') as f:
            return json.load(f)
    return []

def save_history(history):
    with open(HISTORY_FILE, 'w') as f:
        json.dump(history, f, indent=2)

# ── GOOGLE SHEETS ──────────────────────────────────────────────────────────
gc = gspread.service_account(filename="service_account.json")
sheet = gc.open("Marsa Maroc Scans").sheet1

def append_to_sheet(container_id, validation, iso_type, confidence, ts):
    sheet.append_row([
        container_id, validation["owner_code"], validation["category"],
        validation["serial"], validation["check_digit_computed"],
        iso_type, f"{confidence*100:.1f}%", ts
    ])

# ── BIC VALIDATION ────────────────────────────────────────────────────────
LETTER_VALUES = {
    'A':10,'B':12,'C':13,'D':14,'E':15,'F':16,'G':17,'H':18,'I':19,'J':20,
    'K':21,'L':23,'M':24,'N':25,'O':26,'P':27,'Q':28,'R':29,'S':30,'T':31,
    'U':32,'V':34,'W':35,'X':36,'Y':37,'Z':38
}

def compute_check_digit(code10: str) -> int:
    total = 0
    for i, ch in enumerate(code10):
        val = LETTER_VALUES[ch.upper()] if ch.isalpha() else int(ch)
        total += val * (2 ** i)
    remainder = total % 11
    return 0 if remainder == 10 else remainder

def validate_bic(container_id: str) -> dict:
    if len(container_id) != 11:
        return {"valid": False, "reason": "Longueur invalide (11 attendus)"}
    owner_code, category, serial, provided_check = (
        container_id[:3], container_id[3], container_id[4:10], container_id[10]
    )
    if not owner_code.isalpha() or category not in "UJZ" or not serial.isdigit():
        return {"valid": False, "reason": "Format invalide"}
    computed = compute_check_digit(container_id[:10])
    valid = str(computed) == provided_check
    return {
        "valid": valid, "owner_code": owner_code, "category": category,
        "serial": serial, "check_digit_provided": provided_check,
        "check_digit_computed": computed
    }

# ── PIPELINE ──────────────────────────────────────────────────────────────
def extract_code(crop):
    result = stage3.predict(crop, conf=0.5, verbose=False)
    debug = result[0].plot()
    boxes = result[0].boxes

    if len(boxes) == 0:
        return "N/A", "N/A", debug

    names = stage3.names
    detections = []

    for box in boxes:
        cls = int(box.cls[0])
        char = names[cls]
        x1, y1, x2, y2 = map(float, box.xyxy[0])
        cx = (x1 + x2) / 2
        cy = (y1 + y2) / 2
        conf = float(box.conf[0])
        detections.append({"char": char, "cx": cx, "cy": cy, "conf": conf})

    xs = [d["cx"] for d in detections]
    ys = [d["cy"] for d in detections]
    x_spread = max(xs) - min(xs)
    y_spread = max(ys) - min(ys)
    is_vertical = y_spread > x_spread * 1.5

    if is_vertical:
        cv2.imwrite("stage3_vert_boxes.jpg", debug)
        cv2.imwrite("stage3_vert_crop.jpg", crop)
    else:
        cv2.imwrite("stage3_hori_boxes.jpg", debug)
        cv2.imwrite("stage3_hori_crop.jpg", crop)

    print(f"Vertical = {is_vertical}")

    if not is_vertical:
        detections.sort(key=lambda d: d["cy"])
        lines = []
        current = []
        for det in detections:
            if not current:
                current.append(det)
            elif abs(det["cy"] - current[-1]["cy"]) < 30:
                current.append(det)
            else:
                lines.append(current)
                current = [det]
        if current:
            lines.append(current)
        for line in lines:
            line.sort(key=lambda d: d["cx"])

        print("\nLines:")
        for i, line in enumerate(lines):
            text = "".join(c["char"] for c in line)
            print(f"Line {i+1}: {text}")

        container_id = "".join(c["char"] for c in lines[0]) if len(lines) else ""
        iso_type = "".join(c["char"] for c in lines[1]) if len(lines) > 1 else ""

    else:
        detections.sort(key=lambda d: d["cx"])
        columns = []
        current = []
        for det in detections:
            if not current:
                current.append(det)
            elif abs(det["cx"] - current[-1]["cx"]) < 30:
                current.append(det)
            else:
                columns.append(current)
                current = [det]
        if current:
            columns.append(current)
        for col in columns:
            col.sort(key=lambda d: d["cy"])

        print("\nColumns:")
        for i, col in enumerate(columns):
            text = "".join(c["char"] for c in col)
            print(f"Column {i+1}: {text}")

        main_column = max(columns, key=len)
        container_id = "".join(c["char"] for c in main_column)
        iso_type = ""

    print("\nDetected characters:")
    for d in detections:
        print(f"{d['char']:>2}  x={d['cx']:.1f}  y={d['cy']:.1f}  conf={d['conf']:.2f}")

    return container_id, iso_type, debug

# ── CHATBOT (rule-based, no external API, no cost) ─────────────────────────
class ChatRequest(BaseModel):
    message: str
    context: str = ""

@app.post("/chat")
def chat(req: ChatRequest):
    q = req.message.lower().strip()
    history = load_history()

    if not history:
        return {"reply": "Aucun scan n'a encore été enregistré."}

    id_match = re.search(r'\b[A-Z]{3,4}\d{6,7}\b', req.message.upper())

    if id_match and any(w in q for w in ["heure", "temps", "quand"]):
        cid = id_match.group()
        matches = [h for h in history if h["container_id"] == cid]
        if matches:
            return {"reply": f"{cid} a été scanné à {matches[-1]['timestamp'][11:16]}."}
        return {"reply": f"Aucun scan trouvé pour {cid}."}

    if id_match and any(w in q for w in ["valide", "valid", "correct"]):
        cid = id_match.group()
        matches = [h for h in history if h["container_id"] == cid]
        if matches:
            valid = matches[-1].get("bic_valid")
            return {"reply": f"{cid} est {'valide' if valid else 'invalide'} selon la validation BIC."}
        return {"reply": f"Aucun scan trouvé pour {cid}."}

    if id_match and any(w in q for w in ["confiance", "score", "précision"]):
        cid = id_match.group()
        matches = [h for h in history if h["container_id"] == cid]
        if matches:
            return {"reply": f"{cid} a été détecté avec une confiance de {matches[-1]['confidence']*100:.0f}%."}
        return {"reply": f"Aucun scan trouvé pour {cid}."}

    if id_match:
        cid = id_match.group()
        matches = [h for h in history if h["container_id"] == cid]
        if matches:
            h = matches[-1]
            return {"reply": (
                f"Le conteneur {h['container_id']} a été scanné à {h['timestamp'][11:16]}, "
                f"type ISO {h['iso_type']}, confiance {h['confidence']*100:.0f}%, "
                f"validation BIC: {'valide' if h['bic_valid'] else 'invalide'}."
            )}
        return {"reply": f"Aucun scan trouvé pour {cid}."}

    if any(w in q for w in ["combien", "nombre", "total"]):
        valid = sum(1 for h in history if h.get("bic_valid"))
        return {"reply": f"{len(history)} conteneurs scannés au total, dont {valid} valides."}

    if any(w in q for w in ["dernier", "récent", "derniers"]):
        recent = history[-3:]
        lines = [f"{h['container_id']} ({h['timestamp'][11:16]})" for h in recent]
        return {"reply": "Derniers scans : " + ", ".join(lines)}

    if any(w in q for w in ["invalide", "erreur", "échec"]):
        invalid = [h for h in history if not h.get("bic_valid")]
        return {"reply": f"{len(invalid)} scans invalides sur {len(history)} au total."}

    return {"reply": (
        "Je peux répondre aux questions sur : un ID de conteneur précis (ex: 'CSQU3054383'), "
        "le nombre total de scans, les scans récents, ou les erreurs de validation."
    )}

# ── ENDPOINTS ─────────────────────────────────────────────────────────────
@app.get("/")
def root():
    return {"message": "Marsa Maroc Container Recognition API", "status": "running"}

@app.post("/detect")
async def detect_container(file: UploadFile = File(...), live: bool = False):
    contents = await file.read()
    nparr = np.frombuffer(contents, np.uint8)
    img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

    if img is None:
        raise HTTPException(status_code=400, detail="Image invalide")

    h, w = img.shape[:2]

    result2 = stage2.predict(img, conf=0.5, verbose=False)
    boxes2 = result2[0].boxes
    print(f"Stage2 detected {len(boxes2)} regions")

    if len(boxes2) == 0:
        return JSONResponse({
            "success": False,
            "message": "Aucun code conteneur détecté",
            "container_id": None,
            "iso_type": None,
            "confidence": 0,
            "timestamp": datetime.now().isoformat()
        })

    best_box = max(boxes2, key=lambda b: b.conf[0].item())
    confidence_s2 = float(best_box.conf[0].item())
    x1, y1, x2, y2 = map(int, best_box.xyxy[0].tolist())

    margin = 40
    crop_x = max(0, x1 - margin)
    crop_y = max(0, y1 - margin)
    crop = img[crop_y:min(h, y2 + margin), crop_x:min(w, x2 + margin)]
    cv2.imwrite("stage2_crop.jpg", crop)

    container_id, iso_type, debug_crop = extract_code(crop)
    img[crop_y:min(h, y2 + margin), crop_x:min(w, x2 + margin)] = debug_crop

    cv2.rectangle(img, (x1, y1), (x2, y2), (0, 255, 0), 2)
    cv2.putText(img, f"{confidence_s2:.2f}", (x1, y1 - 10),
                cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 255, 0), 2)

    _, buffer = cv2.imencode(".jpg", img)
    image_base64 = base64.b64encode(buffer).decode("utf-8")

    bic_validation = validate_bic(container_id) if container_id and container_id != "N/A" else {"valid": False}

    if live:
        # Continuous auto-scan loop: require multi-frame consensus to filter noise
        committed = stabilizer.push(container_id, confidence_s2)
    else:
        # Manual upload / manual capture button: commit instantly on one valid checksum
        if bic_validation.get("valid") and confidence_s2 >= 0.80:
            committed = (container_id, bic_validation)
        else:
            committed = None

    # DIAGNOSTIC — watch this while scanning
    print(f"ID={container_id} | conf={confidence_s2:.2f} | bic_valid={bic_validation.get('valid')} | live={live} | committed={bool(committed)}")

    entry = {
        "id": str(uuid.uuid4())[:8],
        "container_id": container_id,
        "iso_type": iso_type,
        "confidence": round(confidence_s2, 3),
        "bic_valid": bic_validation.get("valid", False),
        "filename": file.filename,
        "timestamp": datetime.now().isoformat()
    }

    if committed:
        committed_id, committed_validation = committed
        history = load_history()
        entry_committed = {
            "id": str(uuid.uuid4())[:8],
            "container_id": committed_id,
            "iso_type": iso_type,
            "confidence": round(confidence_s2, 3),
            "bic_valid": True,
            "filename": file.filename,
            "timestamp": datetime.now().isoformat()
        }
        history.append(entry_committed)
        save_history(history)
        append_to_sheet(committed_id, committed_validation, iso_type, confidence_s2, entry_committed["timestamp"])

    return JSONResponse({
        "success": True,
        "container_id": container_id,
        "iso_type": iso_type,
        "confidence": round(confidence_s2, 3),
        "bic_validation": bic_validation,
        "committed": bool(committed),
        "timestamp": entry["timestamp"],
        "image": image_base64
    })

@app.get("/history")
def get_history():
    return load_history()

@app.delete("/history")
def clear_history():
    save_history([])
    return {"message": "Historique effacé"}

@app.get("/stats")
def get_stats():
    history = load_history()
    if not history:
        return {"total": 0, "valid_bic": 0, "success_rate": 0}
    valid = sum(1 for h in history if h.get("bic_valid"))
    return {
        "total_scans": len(history),
        "valid_bic": valid,
        "success_rate": round(valid / len(history) * 100, 1)
    }