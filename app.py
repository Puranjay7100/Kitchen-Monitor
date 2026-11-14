"""
Mother's Hut - AI Kitchen Monitoring & Food Portal Backend
FastAPI server serving HTML/CSS/JS frontend and real-time YOLO vision pipeline.
"""

import os
import time
import threading
import glob
import asyncio
from datetime import datetime
from typing import Optional, List
from contextlib import contextmanager

from dotenv import load_dotenv
load_dotenv()

import cv2
import numpy as np
import psycopg2
from psycopg2 import pool
import boto3
from botocore.config import Config
from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse, FileResponse, JSONResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import uvicorn

# Configuration
MODEL_PATH = "best_40.pt"
DATABASE_URL = os.getenv(
    "DATABASE_URL",
    "postgresql://postgres.lgqdpkkxvzghbrbieyct:The_Neotia_University@aws-1-ap-northeast-2.pooler.supabase.com:6543/postgres"
)

# Supabase S3 Storage Configuration
S3_ENDPOINT_URL = os.getenv("S3_ENDPOINT_URL", "https://lgqdpkkxvzghbrbieyct.storage.supabase.co/storage/v1/s3")
S3_REGION = os.getenv("S3_REGION", "ap-northeast-2")
S3_ACCESS_KEY_ID = os.getenv("S3_ACCESS_KEY_ID", "f85b8011a97b4e90b4781e5eb6ef1f51")
S3_SECRET_ACCESS_KEY = os.getenv("S3_SECRET_ACCESS_KEY", "e445ceadcb8a879fd2ce2cd90ca9e946e5b8f3eed40b41a5daabbff67dc42a7a")
S3_BUCKET_NAME = os.getenv("S3_BUCKET_NAME", "Evidence")
SUPABASE_STORAGE_PUBLIC_URL = os.getenv(
    "SUPABASE_STORAGE_PUBLIC_URL",
    f"https://lgqdpkkxvzghbrbieyct.supabase.co/storage/v1/object/public/{S3_BUCKET_NAME}"
)

s3_client = boto3.client(
    "s3",
    endpoint_url=S3_ENDPOINT_URL,
    region_name=S3_REGION,
    aws_access_key_id=S3_ACCESS_KEY_ID,
    aws_secret_access_key=S3_SECRET_ACCESS_KEY,
    config=Config(signature_version="s3v4", max_pool_connections=10)
)
EVIDENCE_DIR = "evidence"

os.makedirs(EVIDENCE_DIR, exist_ok=True)

VIOLATIONS = [
    "no_apron",
    "no_gloves",
    "no_hairnet"
]

# Thread-safe PostgreSQL Connection Pool (Supabase Transaction Pooler)
db_pool = None
pool_lock = threading.Lock()

def get_db_pool():
    global db_pool
    with pool_lock:
        if db_pool is None:
            print("Connecting to Supabase PostgreSQL Database...")
            db_pool = pool.ThreadedConnectionPool(
                minconn=1,
                maxconn=10,
                dsn=DATABASE_URL,
                connect_timeout=10
            )
        return db_pool

@contextmanager
def get_db():
    p = get_db_pool()
    conn = p.getconn()
    try:
        if conn.closed:
            p.putconn(conn, close=True)
            conn = p.getconn()
        yield conn
        conn.commit()
    except Exception:
        if not conn.closed:
            conn.rollback()
        raise
    finally:
        if not conn.closed:
            p.putconn(conn)
        else:
            p.putconn(conn, close=True)

def setup_database():
    try:
        with get_db() as conn:
            with conn.cursor() as cursor:
                cursor.execute("""
                    CREATE TABLE IF NOT EXISTS violations (
                        id BIGSERIAL PRIMARY KEY,
                        violation TEXT NOT NULL,
                        confidence REAL NOT NULL,
                        image_path TEXT,
                        timestamp TEXT NOT NULL
                    );
                    CREATE INDEX IF NOT EXISTS idx_violations_timestamp ON violations (timestamp);
                    CREATE INDEX IF NOT EXISTS idx_violations_violation ON violations (violation);
                """)
        print("[DATABASE] Supabase PostgreSQL connected and initialized successfully.")
    except Exception as e:
        print(f"[DATABASE WARNING] Failed to connect to Supabase: {e}")

setup_database()

# Global model holder (lazy-loaded on start)
model = None
model_lock = threading.Lock()

def get_model():
    global model
    with model_lock:
        if model is None:
            print(f"Loading YOLO model from {MODEL_PATH}...")
            try:
                from ultralytics import YOLO
                model = YOLO(MODEL_PATH)
                # Warm up model forward pass so live inference runs immediately in ~30ms
                dummy = np.zeros((64, 64, 3), dtype=np.uint8)
                model(dummy, verbose=False)
                print(f"Model loaded and warmed successfully with classes: {model.names}")
            except Exception as e:
                print(f"Warning: Could not load YOLO model ({e}). Will run in simulated mode.")
                model = False
    return model if model is not False else None

# Thread-safe Camera & Vision Pipeline Manager
class VisionManager:
    def __init__(self):
        self.lock = threading.Lock()
        self.running = False
        self.source = 0
        self.confidence = 0.50
        self.thread: Optional[threading.Thread] = None
        
        self.current_frame: Optional[bytes] = None
        self.active_violations: List[str] = []
        self.last_saved = {}
        self.fps = 0.0
        self.error_message: Optional[str] = None
        self.client_frame_count = 0
        self.client_start_time = time.time()

    def _create_initial_frame(self):
        try:
            sample_images = sorted(glob.glob(os.path.join(EVIDENCE_DIR, "*.jpg")))
            if sample_images:
                frame = cv2.imread(sample_images[0])
                if frame is not None:
                    h, w = frame.shape[:2]
                    cv2.putText(
                        frame,
                        "Mother's Hut AI Vision Active",
                        (20, 40),
                        cv2.FONT_HERSHEY_SIMPLEX,
                        0.7,
                        (0, 255, 0),
                        2
                    )
                    ret, buf = cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, 80])
                    if ret:
                        self.current_frame = buf.tobytes()
                        return
            blank = np.zeros((480, 640, 3), dtype=np.uint8)
            cv2.putText(
                blank,
                "Mother's Hut AI Vision Active",
                (60, 240),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.9,
                (0, 255, 0),
                2
            )
            ret, buf = cv2.imencode('.jpg', blank)
            if ret:
                self.current_frame = buf.tobytes()
        except Exception as e:
            print(f"Error creating initial frame: {e}")

    def get_current_frame(self) -> Optional[bytes]:
        with self.lock:
            return self.current_frame

    def start(self, source='auto', confidence=0.50):
        with self.lock:
            if self.running:
                return True
            self.source = source
            self.confidence = confidence
            self.running = True
            self.error_message = None
            self._create_initial_frame()
            self.thread = threading.Thread(target=self._run_pipeline, daemon=True)
            self.thread.start()
            return True

    def stop(self):
        with self.lock:
            self.running = False
        if self.thread and self.thread.is_alive():
            self.thread.join(timeout=1.5)
        self.current_frame = None
        self.active_violations = []

    def set_confidence(self, conf: float):
        with self.lock:
            self.confidence = max(0.05, min(1.0, conf))

    def process_client_frame(self, frame, conf=None):
        if conf is None:
            conf = self.confidence
        yolo_model = get_model()
        current_detected = []

        if yolo_model is not None and frame is not None:
            try:
                results = yolo_model.predict(frame, conf=conf, verbose=False)
                for result in results:
                    for box in result.boxes:
                        class_id = int(box.cls[0])
                        name = yolo_model.names.get(class_id, f"class_{class_id}")
                        score = float(box.conf[0])

                        x1, y1, x2, y2 = map(int, box.xyxy[0].tolist())
                        is_violation = (name in VIOLATIONS)
                        color = (0, 0, 255) if is_violation else (0, 255, 0)

                        cv2.rectangle(frame, (x1, y1), (x2, y2), color, 2)
                        display_name = {
                            "no_apron": "No Apron",
                            "no_hairnet": "No Hairnet",
                            "no_gloves": "No Gloves",
                            "apron": "Apron",
                            "hairnet": "Hairnet",
                            "gloves": "Gloves"
                        }.get(name, name.replace("_", " ").title())
                        label = f"{display_name}: {score:.2f}"
                        cv2.putText(
                            frame,
                            label,
                            (x1, max(22, y1 - 10)),
                            cv2.FONT_HERSHEY_SIMPLEX,
                            0.6,
                            color,
                            2
                        )

                        if is_violation:
                            current_detected.append(name)
                            now = time.time()
                            if now - self.last_saved.get(name, 0) >= 10:
                                self._save_violation_record(name, score, frame)
                                self.last_saved[name] = now
            except Exception as infer_err:
                print(f"Inference error: {infer_err}")

        with self.lock:
            self.active_violations = sorted(list(set(current_detected)))
            self.running = True

        now = time.time()
        self.client_frame_count += 1
        elapsed = now - self.client_start_time
        if elapsed >= 1.0:
            self.fps = self.client_frame_count / elapsed
            self.client_frame_count = 0
            self.client_start_time = now

        ret_encode, buffer = cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, 80])
        jpeg_bytes = buffer.tobytes() if ret_encode else b""
        with self.lock:
            self.current_frame = jpeg_bytes

        return jpeg_bytes, self.active_violations, self.fps

    def _upload_and_save_violation(self, name: str, confidence: float, frame_copy):
        try:
            timestamp_str = datetime.now().strftime("%Y%m%d_%H%M%S")
            filename = f"{name}_{timestamp_str}.jpg"
            now_formatted = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

            # Encode frame to JPEG
            ret, buf = cv2.imencode('.jpg', frame_copy, [cv2.IMWRITE_JPEG_QUALITY, 85])
            if not ret:
                return
            img_bytes = buf.tobytes()

            # Upload directly to Supabase S3 Storage Bucket
            s3_client.put_object(
                Bucket=S3_BUCKET_NAME,
                Key=filename,
                Body=img_bytes,
                ContentType="image/jpeg"
            )
            image_url = f"{SUPABASE_STORAGE_PUBLIC_URL}/{filename}"

            # Optional local cache copy
            try:
                local_path = os.path.join(EVIDENCE_DIR, filename)
                with open(local_path, "wb") as f:
                    f.write(img_bytes)
            except Exception:
                pass

            # Record in Supabase PostgreSQL
            with get_db() as conn:
                with conn.cursor() as cursor:
                    cursor.execute(
                        """INSERT INTO violations (violation, confidence, image_path, timestamp)
                           VALUES (%s, %s, %s, %s)""",
                        (
                            name,
                            float(confidence),
                            image_url,
                            now_formatted
                        )
                    )
            print(f"[VIOLATION RECORDED] {name} ({confidence:.2f}) -> Supabase Storage: {image_url}")
        except Exception as ex:
            print(f"Error saving violation to Supabase Storage: {ex}")

    def _save_violation_record(self, name: str, confidence: float, frame):
        # Asynchronously upload in background thread so live 30 FPS video never stutters
        frame_copy = frame.copy()
        threading.Thread(
            target=self._upload_and_save_violation,
            args=(name, confidence, frame_copy),
            daemon=True
        ).start()

    def _run_pipeline(self):
        print(f"Starting video capture pipeline (requested: {self.source})")
        
        cap = None
        try:
            # 1. Fast attempt to connect to physical webcam (index 0, then 1)
            for backend in [cv2.CAP_DSHOW, cv2.CAP_ANY]:
                try:
                    c = cv2.VideoCapture(0, backend)
                    if c.isOpened():
                        ret, test_frame = c.read()
                        if ret and test_frame is not None and test_frame.size > 0:
                            cap = c
                            self.source = 0
                            print(f"[LIVE WEBCAM CONNECTED] Active camera on index 0 (backend {backend})")
                            break
                        else:
                            c.release()
                except Exception:
                    pass

            if cap is None:
                try:
                    c = cv2.VideoCapture(1, cv2.CAP_DSHOW)
                    if c.isOpened():
                        ret, test_frame = c.read()
                        if ret and test_frame is not None and test_frame.size > 0:
                            cap = c
                            self.source = 1
                            print("[LIVE WEBCAM CONNECTED] Active camera on index 1")
                        else:
                            c.release()
                except Exception:
                    pass

            # 2. If no hardware webcam responded, run live simulated stream from kitchen frames
            is_simulated = (cap is None)
            sample_images = []
            sim_idx = 0
            if is_simulated:
                print("[CAMERA AUTO-STREAM] No physical webcam hardware responding. Running live AI vision inspection stream...")
                self.source = "auto-stream"
                sample_images = sorted(glob.glob(os.path.join(EVIDENCE_DIR, "*.jpg")))

            # Pre-load model once before looping
            yolo_model = get_model()

            frame_count = 0
            start_time = time.time()

            while self.running:
                if cap is not None:
                    ret, frame = cap.read()
                    if not ret or frame is None:
                        time.sleep(0.05)
                        continue
                else:
                    if sample_images:
                        frame_path = sample_images[sim_idx % len(sample_images)]
                        frame = cv2.imread(frame_path)
                        sim_idx += 1
                    else:
                        frame = np.zeros((480, 640, 3), dtype=np.uint8)
                        cv2.putText(
                            frame,
                            "Kitchen AI Vision Active",
                            (60, 240),
                            cv2.FONT_HERSHEY_SIMPLEX,
                            0.9,
                            (255, 255, 255),
                            2
                        )
                    time.sleep(0.08) # ~12 FPS for smooth playback

                current_detected = []

                # YOLO inference
                if yolo_model is not None and frame is not None:
                    try:
                        results = yolo_model.predict(frame, conf=self.confidence, verbose=False)
                        for result in results:
                            for box in result.boxes:
                                class_id = int(box.cls[0])
                                name = yolo_model.names.get(class_id, f"class_{class_id}")
                                score = float(box.conf[0])

                                x1, y1, x2, y2 = map(int, box.xyxy[0].tolist())
                                is_violation = (name in VIOLATIONS)
                                color = (0, 0, 255) if is_violation else (0, 255, 0) # Red / Green

                                cv2.rectangle(frame, (x1, y1), (x2, y2), color, 2)
                                display_name = {
                                    "no_apron": "No Apron",
                                    "no_hairnet": "No Hairnet",
                                    "no_gloves": "No Gloves",
                                    "apron": "Apron",
                                    "hairnet": "Hairnet",
                                    "gloves": "Gloves"
                                }.get(name, name.replace("_", " ").title())
                                label = f"{display_name}: {score:.2f}"
                                cv2.putText(
                                    frame,
                                    label,
                                    (x1, max(22, y1 - 10)),
                                    cv2.FONT_HERSHEY_SIMPLEX,
                                    0.6,
                                    color,
                                    2
                                )

                                if is_violation:
                                    current_detected.append(name)
                                    now = time.time()
                                    if now - self.last_saved.get(name, 0) >= 10:
                                        self._save_violation_record(name, score, frame)
                                        self.last_saved[name] = now
                    except Exception as infer_err:
                        print(f"Inference error: {infer_err}")

                with self.lock:
                    self.active_violations = sorted(list(set(current_detected)))

                # Calculate FPS
                frame_count += 1
                elapsed = time.time() - start_time
                if elapsed >= 1.0:
                    self.fps = frame_count / elapsed
                    frame_count = 0
                    start_time = time.time()

                # Encode as JPEG
                ret_encode, buffer = cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, 80])
                if ret_encode:
                    with self.lock:
                        self.current_frame = buffer.tobytes()

                time.sleep(0.01)

        except Exception as e:
            print(f"Pipeline error: {e}")
        finally:
            if cap is not None:
                cap.release()
            with self.lock:
                self.running = False
                self.current_frame = None
            print("Video capture stopped.")

vision = VisionManager()

def ensure_sample_evidence_frames():
    os.makedirs(EVIDENCE_DIR, exist_ok=True)
    existing = glob.glob(os.path.join(EVIDENCE_DIR, "*.jpg"))
    if len(existing) < 5:
        print("[STORAGE] Local evidence folder empty. Syncing sample kitchen frames from Supabase...")
        try:
            res = s3_client.list_objects_v2(Bucket=S3_BUCKET_NAME, MaxKeys=30)
            count = 0
            for obj in res.get("Contents", []):
                key = obj["Key"]
                if key.endswith(".jpg"):
                    target_file = os.path.join(EVIDENCE_DIR, os.path.basename(key))
                    if not os.path.exists(target_file):
                        s3_client.download_file(S3_BUCKET_NAME, key, target_file)
                        count += 1
                        if count >= 15:
                            break
            print(f"[STORAGE] Synced {count} frames from Supabase Storage into local cache.")
        except Exception as e:
            print(f"[STORAGE WARNING] Could not sync frames from Supabase: {e}")

# FastAPI application
app = FastAPI(title="Kitchen Hygiene Compliance Monitoring - Mother's Hut")

@app.on_event("startup")
async def on_startup():
    print("[STARTUP] Pre-warming YOLO AI Model in background...")
    threading.Thread(target=get_model, daemon=True).start()
    threading.Thread(target=ensure_sample_evidence_frames, daemon=True).start()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Route for viewing violation photos (checks local cache first, redirects to Supabase Storage)
@app.get("/evidence/{filename}")
async def get_evidence_image(filename: str):
    local_path = os.path.join(EVIDENCE_DIR, filename)
    if os.path.exists(local_path):
        return FileResponse(local_path)
    return RedirectResponse(f"{SUPABASE_STORAGE_PUBLIC_URL}/{filename}")

# Serve Root HTML and CSS/JS (supports GET and HEAD for Render health checks)
@app.api_route("/", methods=["GET", "HEAD"])
async def get_index():
    return FileResponse("index.html")

@app.get("/style.css")
async def get_css():
    return FileResponse("style.css", media_type="text/css")

@app.get("/script.js")
async def get_js():
    return FileResponse("script.js", media_type="application/javascript")

@app.get("/logo.png")
async def get_logo():
    path = "logo.png" if os.path.exists("logo.png") else "mothershut_logo_highres.png"
    return FileResponse(path, media_type="image/png")

@app.get("/logo_header.png")
async def get_logo_header():
    path = "logo_header.png" if os.path.exists("logo_header.png") else "logo.png"
    return FileResponse(path, media_type="image/png")

@app.get("/mothershut_logo_highres.png")
async def get_logo_highres():
    return FileResponse("mothershut_logo_highres.png", media_type="image/png")

# MJPEG Stream generator
async def generate_mjpeg_frames():
    last_frame = None
    try:
        while vision.running:
            frame_bytes = vision.get_current_frame()
            if frame_bytes and frame_bytes != last_frame:
                last_frame = frame_bytes
                yield (
                    b"--frame\r\n"
                    b"Content-Type: image/jpeg\r\n\r\n" + frame_bytes + b"\r\n"
                )
            await asyncio.sleep(0.03)
    except asyncio.CancelledError:
        pass

@app.get("/video_feed")
async def video_feed():
    return StreamingResponse(
        generate_mjpeg_frames(),
        media_type="multipart/x-mixed-replace; boundary=frame"
    )

# API Schemas
class StartRequest(BaseModel):
    source: Optional[object] = 0
    confidence: Optional[float] = 0.50

class ConfRequest(BaseModel):
    confidence: float

@app.post("/api/start")
async def api_start(req: StartRequest):
    src = req.source if req.source is not None else 0
    conf = req.confidence if req.confidence is not None else 0.50
    success = vision.start(source=src, confidence=conf)
    return {"status": "started" if success else "failed", "running": vision.running}

@app.post("/api/stop")
async def api_stop():
    vision.stop()
    return {"status": "stopped", "running": False}

@app.post("/api/set_confidence")
async def api_set_confidence(req: ConfRequest):
    vision.set_confidence(req.confidence)
    return {"status": "ok", "confidence": vision.confidence}

@app.post("/api/process_frame")
async def api_process_frame(request: Request, conf: float = 0.50):
    body = await request.body()
    if not body:
        return Response(status_code=400, content=b"Empty frame")

    nparr = np.frombuffer(body, np.uint8)
    frame = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    if frame is None:
        return Response(status_code=400, content=b"Invalid image format")

    annotated_jpeg, detected, fps = vision.process_client_frame(frame, conf=conf)
    return Response(
        content=annotated_jpeg,
        media_type="image/jpeg",
        headers={
            "X-FPS": f"{fps:.1f}",
            "X-Violations": ",".join(detected)
        }
    )

# In-memory cache for status statistics to avoid repetitive remote Supabase queries
_status_cache = None
_status_cache_time = 0.0
_status_cache_lock = threading.Lock()

def get_cached_status_stats():
    global _status_cache, _status_cache_time
    now = time.time()
    with _status_cache_lock:
        if _status_cache is not None and (now - _status_cache_time < 3.0):
            return _status_cache

    counts = {"all": 0}
    today_cnt = 0
    hourly_data = []

    try:
        with get_db() as conn:
            with conn.cursor() as cursor:
                # 1 single query for all category counts
                cursor.execute("""
                    SELECT violation, count(*) 
                    FROM violations 
                    WHERE violation IN ('no_apron', 'no_gloves', 'no_hairnet')
                    GROUP BY violation;
                """)
                for row in cursor.fetchall():
                    v_name, cnt = row[0], row[1]
                    counts[v_name] = cnt
                    counts["all"] += cnt
                for v in VIOLATIONS:
                    if v not in counts:
                        counts[v] = 0

                # Today's count
                placeholders = ",".join(["%s"] * len(VIOLATIONS))
                cursor.execute(f"""
                    SELECT count(*) FROM violations 
                    WHERE violation IN ({placeholders}) 
                    AND substr(timestamp, 1, 10) = (SELECT substr(max(timestamp), 1, 10) FROM violations);
                """, tuple(VIOLATIONS))
                row = cursor.fetchone()
                today_cnt = row[0] if row else 0

                # Hourly trend
                cursor.execute(f"""
                    SELECT substr(timestamp, 12, 2) as hr, count(*) 
                    FROM violations 
                    WHERE violation IN ({placeholders}) 
                    GROUP BY hr 
                    ORDER BY max(timestamp) DESC 
                    LIMIT 6;
                """, tuple(VIOLATIONS))
                hourly_rows = cursor.fetchall()
                hourly_rows.reverse()
                hourly_data = [{"hour": f"{r[0]}:00", "count": r[1]} for r in hourly_rows]

        with _status_cache_lock:
            _status_cache = (counts, today_cnt, hourly_data)
            _status_cache_time = now
    except Exception as e:
        print(f"Error reading status from Supabase: {e}")
        with _status_cache_lock:
            if _status_cache is not None:
                return _status_cache

    return counts, today_cnt, hourly_data

@app.get("/api/status")
async def api_status():
    counts, today_cnt, hourly_data = get_cached_status_stats()

    return {
        "running": vision.running,
        "source": vision.source,
        "confidence": vision.confidence,
        "active_violations": vision.active_violations,
        "fps": round(vision.fps, 1),
        "total_violations": counts["all"],
        "counts": counts,
        "today_violations": today_cnt,
        "hourly_data": hourly_data,
        "model": MODEL_PATH,
        "error": vision.error_message
    }

@app.get("/api/violations")
async def api_violations(filter: str = "all", limit: int = 48):
    counts = {"all": 0}
    items = []

    try:
        with get_db() as conn:
            with conn.cursor() as cursor:
                # Calculate category counts across all recorded violations
                for v in VIOLATIONS:
                    cursor.execute("SELECT count(*) FROM violations WHERE violation = %s;", (v,))
                    cnt = cursor.fetchone()[0]
                    counts[v] = cnt
                    counts["all"] += cnt

                if filter and filter != "all":
                    cursor.execute("""
                        SELECT id, violation, confidence, timestamp, image_path
                        FROM violations
                        WHERE violation = %s
                        ORDER BY id DESC
                        LIMIT %s;
                    """, (filter, limit))
                    rows = cursor.fetchall()
                else:
                    placeholders = ",".join(["%s"] * len(VIOLATIONS))
                    cursor.execute(f"""
                        SELECT id, violation, confidence, timestamp, image_path
                        FROM violations
                        WHERE violation IN ({placeholders})
                        ORDER BY id DESC
                        LIMIT %s;
                    """, (*VIOLATIONS, limit))
                    rows = cursor.fetchall()

                for r in rows:
                    img_p = r[4].replace("\\", "/") if r[4] else ""
                    items.append({
                        "id": r[0],
                        "violation": r[1],
                        "confidence": round(r[2], 2) if r[2] is not None else 0.0,
                        "timestamp": r[3],
                        "image_path": img_p
                    })
    except Exception as e:
        print(f"Error fetching violations from Supabase: {e}")

    return {"counts": counts, "items": items}

if __name__ == "__main__":
    import socket
    local_ip = "127.0.0.1"
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        local_ip = s.getsockname()[0]
        s.close()
    except Exception:
        pass

    print("\n" + "="*60)
    print(" Kitchen Hygiene Compliance Monitoring - Mother's Hut")
    port = int(os.getenv("PORT", 8000))
    print(f" Local (PC):   http://127.0.0.1:{port}")
    print(f" Mobile / LAN: http://{local_ip}:{port}")
    print("="*60 + "\n")
    uvicorn.run(app, host="0.0.0.0", port=port, log_level="info")
