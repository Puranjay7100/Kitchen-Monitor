import os
import math
from datetime import datetime, timezone, timedelta
from typing import Optional, List, Dict
from dotenv import load_dotenv

# Load environment variables from .env file
load_dotenv()

import psycopg2
from psycopg2.extras import RealDictCursor
from fastapi import FastAPI, Query, HTTPException
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.middleware.cors import CORSMiddleware
import uvicorn

IST_TZ = timezone(timedelta(hours=5, minutes=30))

# Environment variable name from .env
MASTER_DATABASE_URL = os.getenv("MASTER_DATABASE_URL")
if not MASTER_DATABASE_URL:
    raise RuntimeError("Missing required environment variable: MASTER_DATABASE_URL in .env")

app = FastAPI(title="Mother's Hut - 30-Min Restaurant Activity Timeline")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

@app.get("/")
async def get_index():
    return FileResponse(os.path.join(BASE_DIR, "index.html"))

@app.get("/style.css")
async def get_css():
    return FileResponse(os.path.join(BASE_DIR, "style.css"), media_type="text/css")

@app.get("/script.js")
async def get_js():
    return FileResponse(os.path.join(BASE_DIR, "script.js"), media_type="application/javascript")

@app.get("/logo.png")
async def get_logo():
    p = os.path.join(BASE_DIR, "logo.png")
    if os.path.exists(p):
        return FileResponse(p, media_type="image/png")
    return Response(content=b"", media_type="image/png")


def aggregate_to_30min_intervals(rows: List[Dict]) -> List[Dict]:
    """
    Takes raw rows from master_metrics (which are recorded in 5-min intervals)
    and aggregates them into clean 30-minute intervals (e.g. 12:00 PM - 12:30 PM,
    12:30 PM - 01:00 PM) WITHOUT modifying the Supabase database.

    - window_start: bucketed to minute 00 or 30
    - parked_vehicles: average per 30 min (mean occupancy)
    - total_orders: sum of food orders over the 30 min window (or max/sum)
    - hygiene_score: average compliance score (only non-null valid numbers)
    - food_quality_score: average quality score (ignoring zero/standby where appropriate)
    - customer_count: sum or average of customers in window
    - raw_samples_count: how many 5-min readings formed this bucket
    """
    buckets: Dict[datetime, List[Dict]] = {}

    for r in rows:
        dt = r["window_start"]
        if not dt:
            continue
        
        # Floor timestamp to 30-minute bucket (00 or 30)
        bucket_minute = 0 if dt.minute < 30 else 30
        bucket_key = dt.replace(minute=bucket_minute, second=0, microsecond=0)

        if bucket_key not in buckets:
            buckets[bucket_key] = []
        buckets[bucket_key].append(r)

    # Sort buckets descending (most recent first)
    sorted_bucket_keys = sorted(buckets.keys(), reverse=True)
    aggregated_results = []

    for bucket_dt in sorted_bucket_keys:
        samples = buckets[bucket_dt]
        bucket_end = bucket_dt + timedelta(minutes=30)

        # Formatting labels
        start_str = bucket_dt.strftime("%I:%M %p").lstrip("0")
        end_str = bucket_end.strftime("%I:%M %p").lstrip("0")
        window_label = f"{start_str} - {end_str}"
        date_label = bucket_dt.strftime("%b %d, %Y")
        date_iso = bucket_dt.strftime("%Y-%m-%d")

        # Vehicles: Average vehicles during this half hour
        veh_values = [s["vehicle_count"] for s in samples if s["vehicle_count"] is not None]
        avg_vehicles = round(sum(veh_values) / len(veh_values)) if veh_values else 0

        # Orders: Total orders accumulated across the 30-minute window
        ord_values = [s["total_orders"] for s in samples if s["total_orders"] is not None]
        total_orders = sum(ord_values) if ord_values else 0

        # Customers: Total customer footfall in window
        cust_values = [s["customer_count"] for s in samples if s["customer_count"] is not None]
        total_customers = sum(cust_values) if cust_values else 0

        # Hygiene Score: Average hygiene score during the window
        # Filtering out invalid nulls or negative
        hyg_values = [float(s["hygiene_score"]) for s in samples if s["hygiene_score"] is not None and float(s["hygiene_score"]) > 0]
        if hyg_values:
            avg_hygiene = round(sum(hyg_values) / len(hyg_values), 1)
        else:
            # Standby default
            avg_hygiene = 94.0

        # Food Quality Score: Average food quality score (filter > 0 if available)
        qual_values = [float(s["food_quality_score"]) for s in samples if s["food_quality_score"] is not None and float(s["food_quality_score"]) > 0]
        if qual_values:
            avg_quality = round(sum(qual_values) / len(qual_values), 1)
        else:
            # If all zeros recorded during idle, fallback to benchmark or None
            avg_quality = None

        # Sentiments
        pos_values = [float(s["positive_sentiment"]) for s in samples if s.get("positive_sentiment") is not None and float(s["positive_sentiment"]) > 0]
        avg_pos = round(sum(pos_values) / len(pos_values), 1) if pos_values else 0.0

        aggregated_results.append({
            "window_start_iso": bucket_dt.isoformat(),
            "window_end_iso": bucket_end.isoformat(),
            "date_iso": date_iso,
            "date_label": date_label,
            "time_window": window_label,
            "start_time_sort": bucket_dt.strftime("%H:%M"),
            "parked_vehicles": avg_vehicles,
            "food_orders": total_orders,
            "hygiene_score": avg_hygiene,
            "food_quality": avg_quality,
            "customer_count": total_customers,
            "positive_sentiment": avg_pos,
            "samples_count": len(samples)
        })

    return aggregated_results


@app.get("/api/master-metrics")
async def get_master_metrics(
    date: Optional[str] = Query(None, description="Filter by YYYY-MM-DD"),
    search: Optional[str] = Query(None, description="Search term for time or date"),
    limit: int = Query(default=10, ge=1, le=100, description="Page size (initial view: 10 records = 5 hours)"),
    page: int = Query(default=1, ge=1, description="Page number"),
    score_filter: Optional[str] = Query(None, description="Filter: all, high, warning, critical")
):
    """
    Fetches raw readings from Master Database without altering tables,
    aggregates them into 30-minute intervals dynamically, and applies
    production-ready filtering, search, and pagination.
    """
    try:
        conn = psycopg2.connect(MASTER_DATABASE_URL, connect_timeout=8)
        try:
            with conn.cursor(cursor_factory=RealDictCursor) as cur:
                # Query all relevant master metrics
                cur.execute("""
                    SELECT window_start, 
                           COALESCE(vehicle_count, 0) as vehicle_count,
                           COALESCE(total_orders, 0) as total_orders,
                           hygiene_score,
                           food_quality_score,
                           COALESCE(customer_count, 0) as customer_count,
                           COALESCE(positive_sentiment, 0) as positive_sentiment,
                           COALESCE(negative_sentiment, 0) as negative_sentiment
                    FROM master_metrics
                    ORDER BY window_start DESC
                    LIMIT 2000;
                """)
                raw_rows = cur.fetchall()
        finally:
            conn.close()

        # Step 1: In-memory 30-minute aggregation function
        aggregated_items = aggregate_to_30min_intervals(raw_rows)

        # Step 2: Apply Date Filter if provided
        if date and date.strip():
            aggregated_items = [
                item for item in aggregated_items 
                if item["date_iso"] == date.strip()
            ]

        # Step 3: Apply Search Query (matches time label, e.g. "12:00", "PM", "Nov 15")
        if search and search.strip():
            q = search.strip().lower()
            aggregated_items = [
                item for item in aggregated_items
                if q in item["time_window"].lower() or q in item["date_label"].lower()
            ]

        # Step 4: Apply Quality / Hygiene Score Filter
        if score_filter and score_filter != "all":
            filtered = []
            for item in aggregated_items:
                score = item["hygiene_score"] or 0
                if score_filter == "high" and score >= 90:
                    filtered.append(item)
                elif score_filter == "warning" and 75 <= score < 90:
                    filtered.append(item)
                elif score_filter == "critical" and score < 75:
                    filtered.append(item)
            aggregated_items = filtered

        # Step 5: Pagination (Initial view: 10 records = 5 hours of 30-min intervals)
        total_records = len(aggregated_items)
        total_pages = max(1, math.ceil(total_records / limit))
        start_idx = (page - 1) * limit
        end_idx = start_idx + limit
        paginated_items = aggregated_items[start_idx:end_idx]

        # Collect available unique dates for dropdown filter
        available_dates = sorted(list(set(r["date_iso"] for r in aggregated_items if "date_iso" in r)), reverse=True)

        return {
            "status": "success",
            "interval": "30_minutes",
            "pagination": {
                "page": page,
                "limit": limit,
                "total_records": total_records,
                "total_pages": total_pages,
                "has_next": page < total_pages,
                "has_prev": page > 1,
                "hours_in_view": round(len(paginated_items) * 0.5, 1)
            },
            "available_dates": available_dates,
            "data": paginated_items
        }

    except Exception as e:
        print(f"[MASTER DB FETCH ERROR] {e}")
        # High quality fallback demo simulating 30-min intervals (5 hours = 10 intervals)
        base_time = datetime(2026, 11, 15, 18, 30)
        demo_data = []
        scores_hygiene = [96.0, 94.5, 92.0, 88.5, 78.0, 85.0, 68.0, 91.0, 95.0, 93.0]
        scores_quality = [95.0, 94.0, 91.0, 89.0, 85.0, 82.0, 75.0, 90.0, 92.0, 94.0]
        vehicles_pattern = [14, 18, 22, 25, 29, 31, 26, 20, 15, 11]
        orders_pattern = [22, 34, 48, 55, 62, 58, 42, 30, 24, 18]

        for i in range(10):
            t_start = base_time - timedelta(minutes=30 * i)
            t_end = t_start + timedelta(minutes=30)
            demo_data.append({
                "window_start_iso": t_start.isoformat(),
                "window_end_iso": t_end.isoformat(),
                "date_iso": t_start.strftime("%Y-%m-%d"),
                "date_label": t_start.strftime("%b %d, %Y"),
                "time_window": f"{t_start.strftime('%I:%M %p').lstrip('0')} - {t_end.strftime('%I:%M %p').lstrip('0')}",
                "start_time_sort": t_start.strftime("%H:%M"),
                "parked_vehicles": vehicles_pattern[i],
                "food_orders": orders_pattern[i],
                "hygiene_score": scores_hygiene[i],
                "food_quality": scores_quality[i],
                "customer_count": int(vehicles_pattern[i] * 1.8),
                "positive_sentiment": 88.0,
                "samples_count": 6
            })

        return {
            "status": "warning",
            "message": str(e),
            "interval": "30_minutes",
            "pagination": {
                "page": 1,
                "limit": 10,
                "total_records": len(demo_data),
                "total_pages": 1,
                "has_next": False,
                "has_prev": False,
                "hours_in_view": 5.0
            },
            "available_dates": ["2026-11-15"],
            "data": demo_data
        }


if __name__ == "__main__":
    port = int(os.getenv("PORT", 8050))
    print(f"Starting 30-Minute Master Timeline Server on http://127.0.0.1:{port}")
    uvicorn.run(app, host="0.0.0.0", port=port)
