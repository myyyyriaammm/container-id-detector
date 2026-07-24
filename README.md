# Container ID Detector — Marsa Maroc

Automated container ID recognition system built during a two-month internship at Marsa Maroc (Casablanca). The system detects and reads ISO 6346 container codes from images or a live camera feed, validates them mathematically, and logs confirmed reads to a Google Sheet. A rule-based chatbot answers questions about scanned containers.

## How it works

The pipeline runs in two YOLO stages:

1. **Stage 2 — Region detection**: locates the container code panel within the full image (YOLOv11n).
2. **Stage 3 — Character recognition**: reads individual characters within the cropped region (35-class YOLO model).

Detected characters are reassembled into a container ID and validated against the **ISO 6346 check-digit standard**, which mathematically verifies the code is legitimate (not just correctly formatted) before anything is logged.

### Two detection modes

| Mode | Trigger | Behavior |
|---|---|---|
| **Single-shot** | File upload or manual "Capture" button | Commits instantly if the checksum passes — no waiting, since there's only one frame to judge. |
| **Live stream** | Continuous camera loop (~1.5s interval) | Uses majority-vote consensus across multiple frames to filter out per-character OCR noise from a handheld camera, with a bounded fallback so it never waits indefinitely. |

This distinction exists because the two inputs have fundamentally different noise profiles: a single deliberate photo doesn't benefit from frame-averaging, while a live feed needs it to avoid committing on a single unlucky misread.

## Features

- **ISO 6346 checksum validation** — computes the official mod-11 check digit and confirms it against the detected code, rejecting reads that fail the math even if they look plausible.
- **Live camera scanning** with frame-stabilization to reduce false/garbage entries.
- **Google Sheets logging** — confirmed reads are appended automatically via a service account.
- **Rule-based chatbot** — answers natural-language questions about scan history (by ID, recency, validity, counts) with zero external API cost or hallucination risk.
- **Scan history dashboard** — recent reads with validity status, ISO type, and confidence.

## Tech stack

**Backend:** FastAPI, Ultralytics YOLO, OpenCV, gspread (Google Sheets API)
**Frontend:** React, Tailwind CSS, Axios, lucide-react

## Project structure

    backend/
      main.py              — FastAPI app: detection pipeline, BIC validation, chatbot, Sheets integration
      service_account.json — Google Sheets credentials (not tracked — see Setup)
    frontend/
      src/App.js            — Main UI: upload, live scan, results, chatbot panel

## Setup

### Backend

```bash
cd backend
pip install fastapi uvicorn ultralytics opencv-python gspread python-multipart
```

1. Place your trained YOLO weights and update the paths in `main.py`:
```python
   STAGE2_MODEL = "path/to/stage2_best.pt"
   STAGE3_MODEL = "path/to/stage3_v2_best.pt"
```
2. Create a Google Cloud service account with Sheets + Drive API access, download its JSON key as `service_account.json` in the `backend/` folder, and share your target spreadsheet with the service account's email (found under `client_email` in the JSON).
3. Run the API:
```bash
   python -m uvicorn main:app --reload --port 8000
```

### Frontend

```bash
cd frontend
npm install
npm start
```

## API endpoints

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/detect?live={bool}` | Runs detection on an uploaded image. `live=true` uses multi-frame consensus; `live=false` commits instantly on a valid checksum. |
| `GET` | `/history` | Returns confirmed scan history. |
| `DELETE` | `/history` | Clears scan history. |
| `GET` | `/stats` | Returns aggregate scan statistics. |
| `POST` | `/chat` | Rule-based Q&A over scan history. |

## Known limitations

- Character recognition accuracy degrades under glare, steep angles, or partial occlusion — the checksum layer catches resulting invalid reads but cannot correct them.
- Model file paths are currently hardcoded for local development and should be moved to environment variables for portability.
- The live-stream stabilizer trades speed for robustness; a single clean manual capture is currently faster and more reliable than waiting on the continuous loop.

## Author

Maryam Biby — AI & Computer Engineering student (IAGI), ENSAM Casablanca
Built during a two-month internship at Marsa Maroc.
